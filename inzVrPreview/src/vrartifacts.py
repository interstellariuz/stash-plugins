"""Regenerating each artifact from a single eye.

Every command here mirrors the one Stash builds in pkg/scene/generate, with the
crop prepended to the filter chain and the output size pinned to exact even
integers. Matching Stash matters: these files sit next to ones it generated and
have to behave identically in the UI.
"""

import base64
import math
import os
import tempfile

import vrlog
import vrmedia
import vrstate

PREVIEW_WIDTH = 640
PREVIEW_AUDIO_BITRATE = "128k"
MARKER_AUDIO_BITRATE = "64k"
MIN_SEGMENT_DURATION = 0.75
WEBP_FPS = 12
MARKER_WEBP_SECONDS = 5
COVER_POSITION = 0.2

# DefaultSpriteAmount: what Stash uses when the sprite interval settings are
# left off, and the source of the historical 9x9 grid.
DEFAULT_SPRITE_AMOUNT = 81

# fallbackMinSlowSeek: how much of the seek the retry decodes rather than skips.
SLOW_SEEK_MIN = 20.0

# Below this reported frame rate Stash assumes a misread variable frame rate
# file and switches the preview to -vsync 2.
VFR_FRAME_RATE = 0.01

# Above this, raw sprite cells go to a scratch file rather than being held in
# memory. The default 81 cells of 160x90 are 3.5 MB; 500 cells at 480 wide
# would be nearly 200 MB.
MAX_SPRITE_MEMORY = 128 * 1024 * 1024

# Preview chunks are encoded into a scratch directory under <generated>/tmp.
# Carries the temp marker so a killed run leaves a sweepable trail.
CHUNK_DIR_PREFIX = "inzvr" + vrstate.TMP_SUFFIX + "-"

_WEBP_ARGS = [
    "-lossless", "1",
    "-q:v", "70",
    "-compression_level", "6",
    "-preset", "default",
    "-loop", "0",
    "-threads", "4",
]


class Paths:
    """Where Stash looks for each generated file."""

    def __init__(self, generated_path):
        self.screenshots = os.path.join(generated_path, "screenshots")
        self.vtt = os.path.join(generated_path, "vtt")
        self.markers = os.path.join(generated_path, "markers")
        self.tmp = os.path.join(generated_path, "tmp")

    def preview(self, h):
        return os.path.join(self.screenshots, h + ".mp4")

    def webp(self, h):
        return os.path.join(self.screenshots, h + ".webp")

    def sprite(self, h):
        return os.path.join(self.vtt, h + "_sprite.jpg")

    def thumbs(self, h):
        return os.path.join(self.vtt, h + "_thumbs.vtt")

    def marker(self, h, seconds, extension):
        return os.path.join(self.markers, h, "%d.%s" % (int(seconds), extension))


def _tmp_beside(target):
    """A scratch path in the destination directory, so os.replace stays atomic.

    The target's extension is kept on the end: ffmpeg picks its muxer from the
    output filename, which is why Stash's own temp files are patterned "*.mp4".
    """
    os.makedirs(os.path.dirname(target), exist_ok=True)
    handle, path = tempfile.mkstemp(
        dir=os.path.dirname(target),
        prefix=os.path.basename(target) + ".",
        suffix=vrstate.TMP_SUFFIX + os.path.splitext(target)[1],
    )
    os.close(handle)
    return path


def discard(path):
    try:
        os.remove(path)
    except OSError:
        pass


# --------------------------------------------------------------------------
# preview video
# --------------------------------------------------------------------------

def _exclude_value(duration, raw):
    """Parse preview_exclude_start/end, which accepts "30" or "5%"."""
    text = str(raw or "0").strip()
    try:
        if text.endswith("%") and len(text) > 1:
            return float(text[:-1]) / 100.0 * duration
        return float(text)
    except ValueError:
        return 0.0


def preview_segments(duration, options):
    """The (start, length) of each preview chunk, as PreviewOptions computes them."""
    segments = max(1, int(options["segments"]))
    segment_duration = float(options["segment_duration"])

    # Stash collapses a video shorter than the total preview into one chunk
    # covering the whole thing, rather than emitting overlapping slices.
    if duration <= 0 or duration < segment_duration * segments:
        return [(0.0, duration)]

    exclude_start = _exclude_value(duration, options["exclude_start"])
    exclude_end = _exclude_value(duration, options["exclude_end"])
    usable, offset = duration, 0.0
    if duration > exclude_start + exclude_end:
        usable = duration - exclude_start - exclude_end
        offset = exclude_start

    step = usable / segments
    length = max(segment_duration, MIN_SEGMENT_DURATION)
    return [(offset + index * step, length) for index in range(segments)]


def _chunk_args(source, start, length, target, video_filter, audio, options, fallback, vsync2):
    """One preview segment, as transcoder.Transcode assembles it.

    Fast seek puts -ss before the input, which is quick but lands on the
    nearest keyframe. The fallback moves the last stretch of the seek after
    the input so ffmpeg decodes into position instead — slower, but it is what
    rescues the avi and wmv files that decode green blocks otherwise. -xerror
    goes with the first attempt only, so the retry is not tripped by the same
    warning that failed it.
    """
    fast, slow = start, 0.0
    if fallback:
        if start > SLOW_SEEK_MIN:
            fast, slow = start - SLOW_SEEK_MIN, SLOW_SEEK_MIN
        else:
            fast, slow = 0.0, start

    args = ["-v", "error", "-y"]
    args += options["input_args"]
    if not fallback:
        args += ["-xerror"]
    if fast > 0:
        args += ["-ss", "%.3f" % fast]
    args += ["-i", source]
    if slow > 0:
        args += ["-ss", "%.3f" % slow]
    args += [
        "-t", "%.3f" % length,
        "-max_muxing_queue_size", "1024",
        "-c:v", "libx264",
        "-vf", video_filter,
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-level", "4.2",
        "-preset", options["preset"],
        "-crf", "21",
        "-threads", str(options["threads"]),
        "-strict", "-2",
    ]
    if vsync2:
        args += ["-vsync", "2"]
    args += ["-c:a", "aac", "-b:a", PREVIEW_AUDIO_BITRATE] if audio else ["-an"]
    args += options["output_args"]
    args += [target]
    return args


def generate_preview(source, geometry, target, options, probe):
    """The preview video, retried with slow seek exactly as Stash retries it."""
    try:
        return _preview_attempt(source, geometry, target, options, probe, fallback=False)
    except vrmedia.FfmpegError as exc:
        vrlog.warning("preview failed (%s), retrying with slow seek" % _one_line(exc))
        return _preview_attempt(source, geometry, target, options, probe, fallback=True)


def _preview_attempt(source, geometry, target, options, probe, fallback):
    chunks = preview_segments(probe["duration"], options)
    video_filter = geometry.vf(width=PREVIEW_WIDTH)
    audio = options["audio"] and probe["has_audio"]
    # A frame rate this low is almost always a misread of a variable frame rate
    # file, where the default vsync drops the preview to a handful of frames.
    vsync2 = probe["frame_rate"] <= VFR_FRAME_RATE

    # The marker is in the directory name so that a run killed mid-encode
    # leaves something Prune state recognises as ours.
    with tempfile.TemporaryDirectory(prefix=CHUNK_DIR_PREFIX, dir=options["tmp_dir"]) as workdir:
        names = []
        for index, (start, length) in enumerate(chunks):
            name = "chunk_%03d.mp4" % index
            vrmedia.run(
                _chunk_args(source, start, length, os.path.join(workdir, name),
                            video_filter, audio, options, fallback, vsync2),
                timeout=options["timeout"],
            )
            names.append(name)

        # The concat demuxer runs in safe mode, which is why the list holds bare
        # basenames and lives in the same directory as the chunks.
        listing = os.path.join(workdir, "concat.txt")
        with open(listing, "w", encoding="utf-8") as handle:
            handle.write("".join("file '%s'\n" % name for name in names))

        tmp = _tmp_beside(target)
        try:
            vrmedia.run(
                ["-v", "error", "-f", "concat", "-i", listing, "-y",
                 "-c:v", "copy", "-c:a", "copy", tmp],
                timeout=options["timeout"],
            )
            vrmedia.replace_atomically(tmp, target)
        except Exception:
            discard(tmp)
            raise
    return vrstate.stamp(target)


def _one_line(exc, limit=300):
    """An ffmpeg failure squashed onto one line, for a message that has room."""
    text = " ".join(part.strip() for part in str(exc).splitlines() if part.strip())
    if not text:
        return exc.__class__.__name__
    return text if len(text) <= limit else text[:limit - 3] + "..."


# --------------------------------------------------------------------------
# animated webp
# --------------------------------------------------------------------------

def generate_webp(preview_path, target, options):
    """Built from the cropped preview, so it inherits the crop for free."""
    tmp = _tmp_beside(target)
    try:
        args = ["-v", "error", "-y"]
        args += options["input_args"]
        args += [
            "-i", preview_path,
            "-max_muxing_queue_size", "1024",
            "-c:v", "libwebp",
            "-vf", "scale=%d:-2,fps=%d" % (PREVIEW_WIDTH, WEBP_FPS),
        ] + _WEBP_ARGS + ["-an"]
        args += options["output_args"]
        args += [tmp]
        vrmedia.run(args, timeout=options["timeout"])
        vrmedia.replace_atomically(tmp, target)
    except Exception:
        discard(tmp)
        raise
    return vrstate.stamp(target)


# --------------------------------------------------------------------------
# scrubber sprite and its vtt
# --------------------------------------------------------------------------

def sprite_grid(duration, options):
    """Cell count and grid size, replicating NewSpriteGenerator."""
    if not options["custom_interval"]:
        # The default config pins both bounds to 81, giving the historical 9x9.
        interval = duration / DEFAULT_SPRITE_AMOUNT
    else:
        minimum = max(1, int(options["minimum_sprites"]))
        maximum = int(options["maximum_sprites"])
        interval = float(options["interval"])
        if interval <= 0:
            # calculateSpriteInterval returns here, before the bounds are
            # applied — the interval it just derived already satisfies them.
            interval = duration / minimum
        else:
            count = int(math.ceil(duration / interval))
            if maximum > 0 and count > maximum:
                interval = duration / maximum
            if count < minimum:
                interval = duration / minimum

    count = int(math.ceil(duration / interval)) if interval > 0 else 1
    # Rounded up to a perfect square so the grid has no empty cells.
    grid = max(1, int(math.ceil(math.sqrt(max(1, count)))))
    return grid * grid, grid


def vtt_time(seconds):
    """hh:mm:ss.mmm — truncating the milliseconds, as utils.GetVTTTime does."""
    if seconds < 0 or math.isnan(seconds) or math.isinf(seconds):
        return "00:00:00.000"
    msec = int(seconds * 1000)
    sec, msec = divmod(msec, 1000)
    mnt, sec = divmod(sec, 60)
    hour, mnt = divmod(mnt, 60)
    return "%02d:%02d:%02d.%03d" % (hour, mnt, sec, msec)


def generate_sprite(source, geometry, sprite_target, vtt_target, options, probe):
    duration = probe["duration"]
    count, grid = sprite_grid(duration, options)

    # Portrait is decided on the cropped eye, not the source. A top/bottom VR
    # file is near-square as stored but each eye is landscape, and using the
    # source dimensions would produce cells in the wrong orientation.
    size = int(options["cell_size"])
    if geometry.eye_h > geometry.eye_w:
        cell_w, cell_h = geometry.output_size(height=size)
    else:
        cell_w, cell_h = geometry.output_size(width=size)

    video_filter = geometry.vf(size=(cell_w, cell_h))
    frame_bytes = cell_w * cell_h * 3
    step = duration / count

    frames = []
    for index in range(count):
        timestamp = index * step
        raw = _capture_cell(source, timestamp, video_filter, frame_bytes, options)
        if raw is None:
            # Keep the grid aligned: a missing cell must not shift every later
            # thumbnail by one position.
            vrlog.warning("sprite cell %d at %.1fs could not be read" % (index, timestamp))
            raw = frames[-1] if frames else b"\x00" * frame_bytes
        frames.append(raw)

    # tile pads a short sequence with black instead of failing, which would
    # silently shift every thumbnail, so the count is checked rather than
    # trusted.
    if len(frames) != count:
        raise vrmedia.FfmpegError("captured %d of %d sprite cells" % (len(frames), count))

    tmp = _tmp_beside(sprite_target)
    montage = [
        "-v", "error", "-y",
        "-f", "rawvideo", "-pixel_format", "rgb24",
        "-video_size", "%dx%d" % (cell_w, cell_h), "-framerate", "1",
    ]
    tail = [
        "-vf", "tile=%dx%d" % (grid, grid),
        "-frames:v", "1", "-q:v", "2",
        "-f", "image2", "-c:v", "mjpeg", tmp,
    ]
    try:
        total = count * frame_bytes
        if total > MAX_SPRITE_MEMORY:
            # Large cells at a high sprite count would mean holding hundreds of
            # megabytes of raw frames in memory; spill them to disk instead.
            # The name has to be unique: scenes are processed concurrently, and
            # two workers sharing one scratch file would interleave their
            # frames into each other's sprites.
            handle, spill = tempfile.mkstemp(
                dir=options["tmp_dir"], prefix="sprite.", suffix=vrstate.TMP_SUFFIX + ".rgb"
            )
            try:
                with os.fdopen(handle, "wb") as sink:
                    for frame in frames:
                        sink.write(frame)
                frames = None
                vrmedia.run(montage + ["-i", spill] + tail, timeout=options["timeout"])
            finally:
                discard(spill)
        else:
            vrmedia.run(
                montage + ["-i", "-"] + tail,
                stdin_data=b"".join(frames),
                timeout=options["timeout"],
            )
        vrmedia.replace_atomically(tmp, sprite_target)
    except Exception:
        discard(tmp)
        raise

    _write_vtt(vtt_target, sprite_target, count, grid, cell_w, cell_h, probe)
    return vrstate.stamp(sprite_target), vrstate.stamp(vtt_target)


def _capture_cell(source, timestamp, video_filter, frame_bytes, options):
    """One raw RGB frame. rgb24 has no row padding, so the size is exact."""
    seek = ["-ss", "%.3f" % timestamp]
    tail = [
        "-frames:v", "1",
        "-vf", video_filter,
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ]
    # Fast seek first; on failure fall back to seeking after the input, which
    # is accurate but decodes everything up to the timestamp. Same two-step as
    # SpriteScreenshot.
    attempts = (
        ["-v", "error", "-y"] + seek + ["-i", source] + tail,
        ["-v", "error", "-y", "-i", source] + seek + tail,
    )
    for args in attempts:
        try:
            raw = vrmedia.run(args, capture_stdout=True, timeout=options["timeout"])
        except vrmedia.FfmpegError as exc:
            vrlog.debug("cell capture failed at %.1fs: %s" % (timestamp, exc))
            continue
        if len(raw) >= frame_bytes:
            return raw[:frame_bytes]
    return None


def _write_vtt(target, sprite_target, count, grid, cell_w, cell_h, probe):
    # Stash labels the cues off the frame count rather than the duration, and
    # the two disagree slightly. Reproducing its arithmetic keeps the scrubber
    # consistent with every non-VR scene in the library.
    frames = probe["frames"] or int(probe["frame_rate"] * probe["duration"])
    rate = probe["frame_rate"]
    step = 0.0
    if frames > 0 and rate > 0:
        step = (frames // count) / rate
    if step <= 0:
        # Fewer frames than cells makes NthFrame zero and every cue
        # zero-length, which leaves the scrubber with nothing to show. Stash
        # switches to its frame-seeking path here; falling back to the duration
        # gets the same monotonic cues without a second capture strategy.
        step = probe["duration"] / count if count > 0 else 0.0

    name = os.path.basename(sprite_target)
    lines = ["WEBVTT", ""]
    for index in range(count):
        x = cell_w * (index % grid)
        y = cell_h * (index // grid)
        lines.append("%s --> %s" % (vtt_time(index * step), vtt_time((index + 1) * step)))
        lines.append("%s#xywh=%d,%d,%d,%d" % (name, x, y, cell_w, cell_h))
        lines.append("")

    tmp = _tmp_beside(target)
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines))
        vrmedia.replace_atomically(tmp, target)
    except Exception:
        discard(tmp)
        raise


# --------------------------------------------------------------------------
# markers
# --------------------------------------------------------------------------

def marker_duration(seconds, end_seconds, max_duration, default_duration):
    """Port of markerPreviewDuration, including its non-positive interval case."""
    duration = float(default_duration)
    if end_seconds is not None:
        interval = float(end_seconds) - float(seconds)
        if interval <= 0:
            vrlog.debug("marker at %.2fs has a non-positive interval, using the default" % seconds)
        elif max_duration <= 0 or interval <= max_duration:
            duration = interval
        else:
            duration = float(max_duration)
    return duration if duration > 0 else None


def generate_marker(source, geometry, paths, scene_hash, marker, options, probe):
    seconds = float(marker.get("seconds") or 0)
    end = marker.get("end_seconds")
    length = marker_duration(seconds, end, options["max_marker"], options["default_marker"])
    if length is None:
        return {}

    video_filter = geometry.vf(width=PREVIEW_WIDTH)
    audio = probe["has_audio"]
    stamps = {}

    # Marker previews are the one generator Stash does not pass the configured
    # transcode input/output args to, so they are absent here too.
    target = paths.marker(scene_hash, seconds, "mp4")
    tmp = _tmp_beside(target)
    try:
        args = [
            "-v", "error", "-y",
            "-ss", "%.3f" % seconds, "-i", source, "-t", "%.3f" % length,
            "-max_muxing_queue_size", "1024",
            "-c:v", "libx264",
            "-vf", video_filter,
            "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.2",
            "-preset", "veryslow", "-crf", "24",
            "-movflags", "+faststart",
            "-threads", str(options["threads"]),
            "-sws_flags", "lanczos", "-strict", "-2",
        ]
        args += ["-c:a", "aac", "-b:a", MARKER_AUDIO_BITRATE] if audio else ["-an"]
        args += [tmp]
        vrmedia.run(args, timeout=options["timeout"])
        vrmedia.replace_atomically(tmp, target)
        stamps["mp4"] = vrstate.stamp(target)
    except Exception:
        discard(tmp)
        raise

    target = paths.marker(scene_hash, seconds, "webp")
    tmp = _tmp_beside(target)
    try:
        args = [
            "-v", "error", "-y",
            "-ss", "%.3f" % seconds, "-i", source, "-t", str(MARKER_WEBP_SECONDS),
            "-max_muxing_queue_size", "1024",
            "-c:v", "libwebp",
            "-vf", geometry.vf(width=PREVIEW_WIDTH, tail=("fps=%d" % WEBP_FPS,)),
        ] + _WEBP_ARGS + ["-an", tmp]
        vrmedia.run(args, timeout=options["timeout"])
        vrmedia.replace_atomically(tmp, target)
        stamps["webp"] = vrstate.stamp(target)
    except Exception:
        discard(tmp)
        raise

    # Stash takes the marker screenshot at native resolution. The cropped eye
    # of an 8K VR file is still 3840 wide, so it is capped here — a deliberate
    # departure that keeps the still a sensible size and, when dewarping, keeps
    # the v360 remap from running at full resolution for a thumbnail.
    target = paths.marker(scene_hash, seconds, "jpg")
    tmp = _tmp_beside(target)
    try:
        vrmedia.run(
            ["-v", "error", "-y", "-ss", "%.3f" % seconds, "-i", source,
             "-frames:v", "1", "-q:v", "2",
             "-vf", geometry.vf(width=min(geometry.eye_w, options["still_width"])),
             "-f", "image2", tmp],
            timeout=options["timeout"],
        )
        vrmedia.replace_atomically(tmp, target)
        stamps["jpg"] = vrstate.stamp(target)
    except Exception:
        discard(tmp)
        raise

    return stamps


# --------------------------------------------------------------------------
# cover
# --------------------------------------------------------------------------

def generate_cover(source, geometry, options, probe):
    """The cover is a blob, not a file — this returns a data URL for sceneUpdate."""
    at = options["cover_at"] or probe["duration"] * COVER_POSITION
    data = vrmedia.run(
        ["-v", "error", "-y", "-ss", "%.3f" % at, "-i", source,
         "-frames:v", "1", "-q:v", "2",
         "-vf", geometry.vf(width=min(geometry.eye_w, options["still_width"])),
         "-f", "image2pipe", "-c:v", "mjpeg", "-"],
        capture_stdout=True,
        timeout=options["timeout"],
    )
    if not data:
        raise vrmedia.FfmpegError("cover frame was empty")
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")
