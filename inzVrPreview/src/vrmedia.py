"""ffmpeg and ffprobe primitives."""

import json
import os
import shutil
import subprocess

import vrlog

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# A probe is a handful of reads at the head of the file; anything longer than
# this means unreadable media or a stalled network mount, and one such file
# must not hold up the whole run.
PROBE_TIMEOUT = 120

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class FfmpegError(Exception):
    pass


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


def run(args, stdin_data=None, capture_stdout=False, timeout=None, want_stderr=False):
    """Run ffmpeg. Returns stdout bytes, or stderr text when want_stderr.

    stdin is closed off unless we are piping frames in. ffmpeg reads stdin for
    interactive keystrokes, and the stdin this process inherits is the pipe
    Stash sends the plugin input down — several ffmpegs racing to read it is a
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

    stderr = proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        tail = "\n".join(stderr.strip().splitlines()[-12:])
        raise FfmpegError("ffmpeg exited %s:\n%s" % (proc.returncode, tail))
    if want_stderr:
        return stderr
    return proc.stdout if capture_stdout else b""


def probe(path, timeout=PROBE_TIMEOUT):
    """Video stream facts, derived the way pkg/ffmpeg/ffprobe.go derives them."""
    try:
        proc = subprocess.run(
            [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise FfmpegError("ffprobe timed out after %ss for %s" % (exc.timeout, path)) from exc

    if proc.returncode != 0:
        raise FfmpegError("ffprobe failed for %s: %s" % (path, proc.stderr.decode("utf-8", "replace")[:300]))

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

    fmt_duration = as_float((data.get("format") or {}).get("duration"))
    duration = as_float(video.get("duration"))
    if duration <= 0:
        duration = round(fmt_duration * 100) / 100

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


def even(value):
    """Round to a positive even integer — libx264 and yuv420p require it."""
    return max(2, int(round(value / 2.0)) * 2)


def replace_atomically(tmp_path, target):
    """Move a finished file into place, mirroring Stash's SafeMove.

    Nothing must ever be written straight to the destination: Stash stops a
    plugin with SIGKILL, and a truncated artifact served to the UI is worse
    than a missing one.
    """
    if os.path.getsize(tmp_path) == 0:
        raise FfmpegError("produced an empty file")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    os.replace(tmp_path, target)
