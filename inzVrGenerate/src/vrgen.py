"""ffmpeg, and the four artifacts rebuilt from one eye.

Every command here mirrors the one Stash builds in pkg/scene/generate, with the
VR crop prepended to the filter chain and the output size pinned to exact even
integers. Matching Stash matters: these files sit next to ones it generated for
every non-VR scene in the same library and have to behave identically in the UI.
"""

import base64
import ctypes
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import vrlog

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# A probe is a handful of reads at the head of the file; anything longer means
# unreadable media or a stalled network mount, and one such file must not hold
# up the whole run.
PROBE_TIMEOUT = 120

# ffmpeg has no way of saying that it is stuck rather than slow, so every call
# gets a budget instead: large enough that a healthy encode on slow storage
# finishes, small enough that one unreadable file cannot hold a worker for the
# rest of the run. Most of these are fixed, because most of the work is bounded
# by -frames:v or by -t rather than by how long the file is.
PREVIEW_TIMEOUT = 600.0        # one preview chunk
PREVIEW_ENCODE_FACTOR = 20.0   # ...unless someone set a very long segment
STILL_TIMEOUT = 300.0          # cover: a single frame, fast seek only
WEBP_TIMEOUT = 300.0           # re-encodes the finished preview, seconds long
CONCAT_TIMEOUT = 300.0         # stream copy of the chunks
MONTAGE_TIMEOUT = 600.0        # tiles the captured cells into one jpeg
CELL_TIMEOUT = 120.0           # sprite cell, fast seek

# The one call that really does cost in proportion to where it lands: the sprite
# cell's retry seeks after the input, so ffmpeg decodes the file from the start
# to the timestamp. The factor assumes it manages at least twice real time.
SEEK_TIMEOUT_FACTOR = 0.5
CELL_SLOW_TIMEOUT_MAX = 600.0

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


class FfmpegTimeout(FfmpegError):
    """Told apart from a failure: a retry that decodes more cannot rescue it."""


def _budget(floor, seconds, cap=None):
    """A timeout for a call that has to decode `seconds` of the source."""
    try:
        scaled = float(seconds or 0.0) * SEEK_TIMEOUT_FACTOR
    except (TypeError, ValueError):
        scaled = 0.0
    value = max(float(floor), scaled)
    return min(value, float(cap)) if cap else value


# --------------------------------------------------------------------------
# keeping ffmpeg from outliving us
# --------------------------------------------------------------------------

# Stash stops a plugin with a hard kill -- SIGKILL on POSIX, TerminateProcess on
# Windows -- so there is no signal to handle and no chance to tidy up. Left
# alone, up to parallel_tasks encoders carry on burning CPU and filling the
# scratch directory with nobody to collect them. Both halves below hand that job
# to the OS instead.

_PR_SET_PDEATHSIG = 1


def _resolve_prctl():
    if not sys.platform.startswith("linux"):
        return None
    try:
        # dlopen(NULL) rather than a named libc: the plugin's own platform is
        # alpine, where the library is libc.musl-$arch.so.1 and "libc.so.6" does
        # not exist at all.
        return ctypes.CDLL(None, use_errno=True).prctl
    except (OSError, AttributeError):
        return None


_PRCTL = _resolve_prctl()


def _preexec():
    """The preexec_fn for one spawn, or None where prctl is not available.

    The pid is read here, in the live process, rather than once at import: a
    death signal is only as good as knowing who it is for, and a pid captured at
    import belongs to whoever imported the module.
    """
    if _PRCTL is None:
        return None

    parent = os.getpid()

    def die_with_parent():
        # Runs in the child between fork and exec. Deliberately two calls and
        # nothing else: this side of a fork from a process with a worker pool in
        # it, anything that takes a lock can deadlock. The call's own timeout is
        # what bounds that if it ever happens.
        _PRCTL(_PR_SET_PDEATHSIG, signal.SIGKILL)
        # The plugin may have died while we were forking, in which case the
        # signal has already been and gone. Check by hand rather than linger as
        # exactly the orphan this exists to prevent.
        if os.getppid() != parent:
            os._exit(1)

    return die_with_parent


_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9
_job_handle = None


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),  # ULONG_PTR
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def guard_child_processes():
    """Put this process in a job object that takes its children down with it.

    Windows only, and the Windows half of what PR_SET_PDEATHSIG does elsewhere.
    A child joins its parent's job automatically, so every ffmpeg started later
    is in this one without run() having to know; when stash terminates the
    plugin, the last handle to the job closes and KILL_ON_JOB_CLOSE ends the
    whole tree. Nested jobs work from Windows 8 on, so a stash that is itself in
    one is fine. Best effort: a failure here costs cleanliness, not the run.
    """
    global _job_handle
    if os.name != "nt" or _job_handle is not None:
        return

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise OSError(ctypes.get_last_error(), "CreateJobObject failed")

        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
                job, _JobObjectExtendedLimitInformation,
                ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

        if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")

        # Held for the life of the process on purpose: closing this handle is
        # the very event the job is configured to react to.
        _job_handle = job
        vrlog.debug("child processes will be killed with this one")
    except Exception as exc:
        vrlog.debug("could not guard child processes: %s" % exc)


# --------------------------------------------------------------------------
# running ffmpeg
# --------------------------------------------------------------------------

def resolve_binaries(config_general, stash_dir):
    """Locate ffmpeg/ffprobe the same way Stash does.

    RefreshFFMpeg (internal/manager/init.go) takes the configured path if there
    is one, and otherwise calls ResolveFFMpeg(configDirectory, stashHomeDir):
    the directory config.yml lives in -- which is exactly the Dir stash sends a
    plugin -- then PATH, then ~/.stash, where the copy it downloads for itself
    ends up. The same order is followed here so the plugin encodes with the
    binary the rest of the library was generated with.
    """
    global FFMPEG, FFPROBE

    # The plugin is a child of the server, so ~ is the server's own home.
    home = os.path.join(os.path.expanduser("~"), ".stash")

    def within(directory, name):
        if not directory:
            return []
        # Both spellings, in that order, because os.path.isfile("...\\ffmpeg")
        # is false on Windows while shutil.which finds ffmpeg.exe by itself.
        return [os.path.join(directory, name), os.path.join(directory, name + ".exe")]

    def pick(configured, name):
        for candidate in [configured] + within(stash_dir, name):
            if candidate and os.path.isfile(candidate):
                return candidate
        found = shutil.which(name)
        if found:
            return found
        for candidate in within(home, name):
            if os.path.isfile(candidate):
                return candidate
        return None

    FFMPEG = pick(config_general.get("ffmpegPath"), "ffmpeg")
    FFPROBE = pick(config_general.get("ffprobePath"), "ffprobe")
    missing = [n for n, p in (("ffmpeg", FFMPEG), ("ffprobe", FFPROBE)) if not p]
    if missing:
        raise FfmpegError("could not find %s" % " or ".join(missing))
    vrlog.debug("using ffmpeg=%s ffprobe=%s" % (FFMPEG, FFPROBE))


def run(args, timeout, stdin_data=None, capture_stdout=False):
    """Run ffmpeg, returning stdout when asked for it.

    The timeout is required rather than defaulted: an unbounded ffmpeg holds its
    worker for the rest of the run, so a call site that has not thought about
    its budget should not compile away into one.

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
            preexec_fn=_preexec(),
        )
    except subprocess.TimeoutExpired as exc:
        raise FfmpegTimeout("ffmpeg timed out after %ss" % exc.timeout) from exc

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
            preexec_fn=_preexec(),
        )
    except subprocess.TimeoutExpired as exc:
        raise FfmpegTimeout(
            "ffprobe timed out after %ss for %s" % (exc.timeout, path)) from exc

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
        timeout=STILL_TIMEOUT,
        capture_stdout=True,
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
    except FfmpegTimeout:
        # Not retried: the fallback moves part of the seek after the input so
        # ffmpeg decodes into position, which is strictly more work than the
        # attempt that has just run out of time.
        raise
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

    # A chunk's work is bounded by -t rather than by the length of the file, and
    # the fallback decodes at most SLOW_SEEK_MIN before it, so this grows only
    # with a segment duration someone has set very high.
    chunk_timeout = max(PREVIEW_TIMEOUT,
                        max(length for _, length in chunks) * PREVIEW_ENCODE_FACTOR)

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
                timeout=chunk_timeout,
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
                timeout=CONCAT_TIMEOUT)
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
        run(args, timeout=WEBP_TIMEOUT)
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
        raw = _capture_cell(source, timestamp, video_filter, frame_bytes)
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
                run(montage + ["-i", spill] + tail, timeout=MONTAGE_TIMEOUT)
            finally:
                discard(spill)
        else:
            run(montage + ["-i", "-"] + tail,
                timeout=MONTAGE_TIMEOUT,
                stdin_data=b"".join(frames))
        replace_atomically(tmp, sprite_target)
    except Exception:
        discard(tmp)
        raise

    _write_vtt(vtt_target, sprite_target, count, grid, cell_w, cell_h, info)


def _capture_cell(source, timestamp, video_filter, frame_bytes):
    """One raw RGB frame. rgb24 has no row padding, so the size is exact."""
    seek = ["-ss", "%.3f" % timestamp]
    tail = [
        "-frames:v", "1",
        "-vf", video_filter,
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ]
    # Fast seek first; on failure fall back to seeking after the input, which is
    # accurate but decodes everything up to the timestamp. Same two-step as
    # SpriteScreenshot. The second attempt gets a budget that grows with the
    # timestamp for that reason, and a cell that runs out of it is skipped
    # rather than allowed to hold the scene: 81 of these make up one sprite.
    attempts = (
        (["-v", "error", "-y"] + seek + ["-i", source] + tail, CELL_TIMEOUT),
        (["-v", "error", "-y", "-i", source] + seek + tail,
         _budget(CELL_TIMEOUT, timestamp, CELL_SLOW_TIMEOUT_MAX)),
    )
    for args, budget in attempts:
        try:
            raw = run(args, timeout=budget, capture_stdout=True)
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
