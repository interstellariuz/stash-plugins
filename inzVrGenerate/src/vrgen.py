"""ffmpeg, and the four artifacts rebuilt from one eye.

Every command here mirrors the one Stash builds in pkg/scene/generate, with the
VR crop prepended to the filter chain and the output size pinned to exact even
integers. Matching Stash matters: these files sit next to ones it generated for
every non-VR scene in the same library and have to behave identically in the UI.
"""

import base64
import json
import math
import os
import shutil
import subprocess
import tempfile
import time

import vrlog

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# A probe is a handful of reads at the head of the file; anything longer means
# unreadable media or a stalled network mount, and one such file must not hold
# up the whole run.
PROBE_TIMEOUT = 120

PREVIEW_WIDTH = 640
PREVIEW_AUDIO_BITRATE = "128k"
MIN_SEGMENT_DURATION = 0.75
WEBP_FPS = 12
COVER_POSITION = 0.2

# Covers are capped at this width. Stash uses the native resolution, which for
# the cropped eye of an 8K VR file is still 3840 -- a multi-megabyte still for
# something displayed as a thumbnail.
STILL_WIDTH = 1920

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

# Marks everything this plugin writes before it is finished, so that a run
# stopped with SIGKILL leaves a recognisable trail for sweep_temp_files.
TMP_SUFFIX = ".inzvrgen.tmp"

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_WEBP_ARGS = [
    "-lossless", "1",
    "-q:v", "70",
    "-compression_level", "6",
    "-preset", "default",
    "-loop", "0",
    "-threads", "4",
]


class FfmpegError(Exception):
    pass


# --------------------------------------------------------------------------
# running ffmpeg
# --------------------------------------------------------------------------

def resolve_binaries(config_general, stash_dir):
    """Locate ffmpeg/ffprobe the same way Stash does.

    Stash prefers its configured path, then the copy it downloads next to
    config.yml, then PATH.
    """
    global FFMPEG, FFPROBE

    def pick(configured, name):
        candidates = [configured]
        if stash_dir:
            candidates.append(os.path.join(stash_dir, name))
            candidates.append(os.path.join(stash_dir, name + ".exe"))
        for candidate in candidates:
            if candidate and os.path.isfile(candidate):
                return candidate
        return shutil.which(name)

    FFMPEG = pick(config_general.get("ffmpegPath"), "ffmpeg")
    FFPROBE = pick(config_general.get("ffprobePath"), "ffprobe")
    missing = [n for n, p in (("ffmpeg", FFMPEG), ("ffprobe", FFPROBE)) if not p]
    if missing:
        raise FfmpegError("could not find %s" % " or ".join(missing))
    vrlog.debug("using ffmpeg=%s ffprobe=%s" % (FFMPEG, FFPROBE))


def run(args, stdin_data=None, capture_stdout=False, timeout=None):
    """Run ffmpeg, returning stdout when asked for it.

    stdin is closed off unless we are piping frames in. ffmpeg reads stdin for
    interactive keystrokes, and the stdin this process inherits is the pipe
    Stash sends the plugin input down -- several ffmpegs racing to read it is a
    good way to lose data or wedge.
    """
    command = [FFMPEG, "-nostdin"] if stdin_data is None else [FFMPEG]
    try:
        proc = subprocess.run(
            command + args,
            input=stdin_data,
            stdin=None if stdin_data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise FfmpegError("ffmpeg timed out after %ss" % exc.timeout) from exc

    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace")
        tail = "\n".join(stderr.strip().splitlines()[-12:])
        raise FfmpegError("ffmpeg exited %s:\n%s" % (proc.returncode, tail))
    return proc.stdout if capture_stdout else b""


def probe(path, timeout=PROBE_TIMEOUT):
    """Video stream facts, derived the way pkg/ffmpeg/ffprobe.go derives them."""
    try:
        proc = subprocess.run(
            [FFPROBE, "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", path],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise FfmpegError("ffprobe timed out after %ss for %s" % (exc.timeout, path)) from exc

    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace")[:300]
        raise FfmpegError("ffprobe failed for %s: %s" % (path, detail))

    data = json.loads(proc.stdout.decode("utf-8", "replace"))
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise FfmpegError("no video stream in %s" % path)

    def as_float(value, default=0.0):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    duration = as_float(video.get("duration"))
    if duration <= 0:
        duration = round(as_float((data.get("format") or {}).get("duration")) * 100) / 100

    frame_rate = 0.0
    for key in ("avg_frame_rate", "r_frame_rate"):
        parts = str(video.get(key) or "").split("/")
        if len(parts) == 2 and as_float(parts[1]) > 0:
            frame_rate = as_float(parts[0]) / as_float(parts[1])
            if frame_rate > 0:
                break
    frame_rate = round(frame_rate * 100) / 100

    frames = int(as_float(video.get("nb_frames")) or as_float(video.get("nb_read_frames")))
    if frames <= 0 and frame_rate > 0:
        frames = int(frame_rate * duration)

    return {
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "duration": duration,
        "frame_rate": frame_rate,
        "frames": frames,
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
    }


# --------------------------------------------------------------------------
# writing files
# --------------------------------------------------------------------------

class Paths:
    """Where Stash looks for each generated file."""

    def __init__(self, generated_path):
        self.screenshots = os.path.join(generated_path, "screenshots")
        self.vtt = os.path.join(generated_path, "vtt")
        self.tmp = os.path.join(generated_path, "tmp")

    def preview(self, h):
        return os.path.join(self.screenshots, h + ".mp4")

    def webp(self, h):
        return os.path.join(self.screenshots, h + ".webp")

    def sprite(self, h):
        return os.path.join(self.vtt, h + "_sprite.jpg")

    def thumbs(self, h):
        return os.path.join(self.vtt, h + "_thumbs.vtt")


def _tmp_beside(target):
    """A scratch path in the destination directory, so os.replace stays atomic.

    The target's extension is kept on the end: ffmpeg picks its muxer from the
    output filename, which is why Stash's own temp files are patterned "*.mp4".
    """
    os.makedirs(os.path.dirname(target), exist_ok=True)
    handle, path = tempfile.mkstemp(
        dir=os.path.dirname(target),
        prefix=os.path.basename(target) + ".",
        suffix=TMP_SUFFIX + os.path.splitext(target)[1],
    )
    os.close(handle)
    return path


def discard(path):
    try:
        os.remove(path)
    except OSError:
        pass


def replace_atomically(tmp_path, target):
    """Move a finished file into place, mirroring Stash's SafeMove.

    Nothing is ever written straight to its destination: Stash stops a plugin
    with SIGKILL, and a truncated artifact served to the UI is worse than a
    missing one.
    """
    if os.path.getsize(tmp_path) == 0:
        raise FfmpegError("produced an empty file")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    os.replace(tmp_path, target)


def sweep_temp_files(*directories):
    """Remove leftovers from a run that was killed mid-write.

    Only entries older than a day, so this cannot pull the rug out from under a
    run happening at the same time. Preview chunks go into a whole scratch
    directory, so marked directories are removed as a unit.
    """
    cutoff = time.time() - 24 * 3600
    removed = 0

    def stale(path):
        try:
            return os.path.getmtime(path) < cutoff
        except OSError:
            return False

    for directory in directories:
        for root, subdirs, names in os.walk(directory, topdown=False):
            for name in names:
                full = os.path.join(root, name)
                if TMP_SUFFIX in name and stale(full):
                    try:
                        os.remove(full)
                        removed += 1
                    except OSError:
                        pass
            for name in subdirs:
                full = os.path.join(root, name)
                if TMP_SUFFIX in name and stale(full):
                    try:
                        shutil.rmtree(full)
                        removed += 1
                    except OSError:
                        pass

    if removed:
        vrlog.debug("removed %d stale temporary file(s)" % removed)
    return removed


# --------------------------------------------------------------------------
# cover
# --------------------------------------------------------------------------

def generate_cover(source, geometry, options, info):
    """The cover is a blob, not a file -- this returns a data URL for sceneUpdate."""
    at = info["duration"] * COVER_POSITION
    data = run(
        ["-v", "error", "-y", "-ss", "%.3f" % at, "-i", source,
         "-frames:v", "1", "-q:v", "2",
         "-vf", geometry.vf(width=min(geometry.width, STILL_WIDTH)),
         "-f", "image2pipe", "-c:v", "mjpeg", "-"],
        capture_stdout=True,
        timeout=options["timeout"],
    )
    if not data:
        raise FfmpegError("cover frame was empty")
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


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
    nearest keyframe. The fallback moves the last stretch of the seek after the
    input so ffmpeg decodes into position instead -- slower, but it is what
    rescues the files that decode green blocks otherwise. -xerror goes with the
    first attempt only, so the retry is not tripped by the warning that failed it.
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


def generate_preview(source, geometry, target, options, info):
    """The preview video, retried with slow seek exactly as Stash retries it."""
    try:
        return _preview_attempt(source, geometry, target, options, info, fallback=False)
    except FfmpegError as exc:
        vrlog.warning("preview failed (%s), retrying with slow seek" % _one_line(exc))
        return _preview_attempt(source, geometry, target, options, info, fallback=True)


def _preview_attempt(source, geometry, target, options, info, fallback):
    chunks = preview_segments(info["duration"], options)
    video_filter = geometry.vf(width=PREVIEW_WIDTH)
    audio = options["audio"] and info["has_audio"]
    # A frame rate this low is almost always a misread of a variable frame rate
    # file, where the default vsync drops the preview to a handful of frames.
    vsync2 = info["frame_rate"] <= VFR_FRAME_RATE

    # The marker is in the directory name so a run killed mid-encode leaves
    # something the next run's sweep recognises as ours.
    prefix = "chunks" + TMP_SUFFIX + "-"
    with tempfile.TemporaryDirectory(prefix=prefix, dir=options["tmp_dir"]) as workdir:
        names = []
        for index, (start, length) in enumerate(chunks):
            name = "chunk_%03d.mp4" % index
            run(
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
            run(["-v", "error", "-f", "concat", "-i", listing, "-y",
                 "-c:v", "copy", "-c:a", "copy", tmp],
                timeout=options["timeout"])
            replace_atomically(tmp, target)
        except Exception:
            discard(tmp)
            raise


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
    """Built from the finished preview, so it inherits the crop for free."""
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
        run(args, timeout=options["timeout"])
        replace_atomically(tmp, target)
    except Exception:
        discard(tmp)
        raise


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
            # applied -- the interval it just derived already satisfies them.
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
    """hh:mm:ss.mmm -- truncating the milliseconds, as utils.GetVTTTime does."""
    if seconds < 0 or math.isnan(seconds) or math.isinf(seconds):
        return "00:00:00.000"
    msec = int(seconds * 1000)
    sec, msec = divmod(msec, 1000)
    mnt, sec = divmod(sec, 60)
    hour, mnt = divmod(mnt, 60)
    return "%02d:%02d:%02d.%03d" % (hour, mnt, sec, msec)


def generate_sprite(source, geometry, sprite_target, vtt_target, options, info):
    duration = info["duration"]
    count, grid = sprite_grid(duration, options)

    size = int(options["cell_size"])
    if geometry.height > geometry.width:
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
    # silently shift every thumbnail, so the count is checked rather than trusted.
    if len(frames) != count:
        raise FfmpegError("captured %d of %d sprite cells" % (len(frames), count))

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
        if count * frame_bytes > MAX_SPRITE_MEMORY:
            # Large cells at a high sprite count would mean holding hundreds of
            # megabytes of raw frames in memory; spill them to disk instead. The
            # name has to be unique: scenes are processed concurrently, and two
            # workers sharing one scratch file would interleave their frames
            # into each other's sprites.
            handle, spill = tempfile.mkstemp(
                dir=options["tmp_dir"], prefix="sprite.", suffix=TMP_SUFFIX + ".rgb"
            )
            try:
                with os.fdopen(handle, "wb") as sink:
                    for frame in frames:
                        sink.write(frame)
                frames = None
                run(montage + ["-i", spill] + tail, timeout=options["timeout"])
            finally:
                discard(spill)
        else:
            run(montage + ["-i", "-"] + tail,
                stdin_data=b"".join(frames),
                timeout=options["timeout"])
        replace_atomically(tmp, sprite_target)
    except Exception:
        discard(tmp)
        raise

    _write_vtt(vtt_target, sprite_target, count, grid, cell_w, cell_h, info)


def _capture_cell(source, timestamp, video_filter, frame_bytes, options):
    """One raw RGB frame. rgb24 has no row padding, so the size is exact."""
    seek = ["-ss", "%.3f" % timestamp]
    tail = [
        "-frames:v", "1",
        "-vf", video_filter,
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ]
    # Fast seek first; on failure fall back to seeking after the input, which is
    # accurate but decodes everything up to the timestamp. Same two-step as
    # SpriteScreenshot.
    attempts = (
        ["-v", "error", "-y"] + seek + ["-i", source] + tail,
        ["-v", "error", "-y", "-i", source] + seek + tail,
    )
    for args in attempts:
        try:
            raw = run(args, capture_stdout=True, timeout=options["timeout"])
        except FfmpegError as exc:
            vrlog.debug("cell capture failed at %.1fs: %s" % (timestamp, exc))
            continue
        if len(raw) >= frame_bytes:
            return raw[:frame_bytes]
    return None


def _write_vtt(target, sprite_target, count, grid, cell_w, cell_h, info):
    # Stash labels the cues off the frame count rather than the duration, and
    # the two disagree slightly. Reproducing its arithmetic keeps the scrubber
    # consistent with every non-VR scene in the library.
    frames = info["frames"] or int(info["frame_rate"] * info["duration"])
    rate = info["frame_rate"]
    step = 0.0
    if frames > 0 and rate > 0:
        step = (frames // count) / rate
    if step <= 0:
        # Fewer frames than cells makes NthFrame zero and every cue
        # zero-length, which leaves the scrubber with nothing to show. Stash
        # switches to its frame-seeking path here; falling back to the duration
        # gets the same monotonic cues without a second capture strategy.
        step = info["duration"] / count if count > 0 else 0.0

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
        replace_atomically(tmp, target)
    except Exception:
        discard(tmp)
        raise
