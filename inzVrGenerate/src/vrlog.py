"""Log and progress messages in the format Stash's plugin logger expects.

Messages travel over stderr prefixed with SOH, a level character, then STX.
Stash reads stderr line by line, so progress updates are rate limited: a flood
of them stalls the pipe and slows the plugin down more than the work does.
"""

import sys
import threading
import time

_SOH = b"\x01"
_STX = b"\x02"

_lock = threading.Lock()
_last_progress = [0.0]


def _log(level_char, message):
    prefix = (_SOH + level_char + _STX).decode()
    # Stash reads stderr a line at a time and looks for the level prefix at the
    # start of each one, so a multi-line message has to be tagged line by line.
    # Left alone, everything after the first newline would arrive at the
    # plugin's errLog level instead -- a debug traceback as a stack of errors.
    # Blank lines are dropped: detectLogLevel needs a character after the
    # prefix, and Stash ignores empty lines anyway.
    lines = [line for line in str(message).splitlines() if line.strip()] or ["(empty)"]
    with _lock:
        for line in lines:
            print(prefix + line, file=sys.stderr, flush=True)


def debug(message):
    # Not gated behind a verbose switch: these go out tagged as debug and the
    # server's own log level decides whether anyone sees them, which is one
    # fewer thing for a run to have to be told.
    _log(b"d", message)


def info(message):
    _log(b"i", message)


def warning(message):
    _log(b"w", message)


def error(message):
    _log(b"e", message)


# Worded like the descriptions Stash puts on its own generate subtasks, so a VR
# run reads the same as a native one -- and so the plugin's UI can pick these
# lines back out of the log stream, which is the only channel it has for saying
# what is going on. Change one of these and change the pattern in the tsx.
_ARTIFACT_TEXT = {
    "cover": "cover",
    "preview": "preview",
    "webp": "animated preview",
    "sprite": "sprites",
}


def generating(artifact, path):
    info("Generating %s for %s" % (_ARTIFACT_TEXT.get(artifact, artifact), path))


def finished(path):
    # Stash has no equivalent -- it drops the subtask instead -- but a readout
    # built from a log has to be told, or a scene sits on it after its last
    # artifact is written.
    info("Finished generating for %s" % path)


def progress(fraction, force=False):
    fraction = min(max(0.0, float(fraction)), 1.0)
    now = time.monotonic()
    with _lock:
        if not force and now - _last_progress[0] < 1.0:
            return
        _last_progress[0] = now
    _log(b"p", repr(fraction))


# How long each artifact takes relative to a whole scene. The preview dominates
# and the cover is a single frame, so counting scenes would leave the bar
# motionless through the only part that takes any time.
WEIGHTS = {"cover": 0.05, "preview": 0.45, "webp": 0.10, "sprite": 0.30}


class Progress:
    """Whole-run progress, in "scenes worth of work".

    Scenes are processed concurrently, so the accumulator is shared and each
    worker tops its own scene up to a whole unit when it finishes.
    """

    def __init__(self, total_scenes):
        self.total = max(1, int(total_scenes))
        self._acc = 0.0
        self._lock = threading.Lock()

    def _add(self, amount, force=False):
        with self._lock:
            self._acc += amount
            value = self._acc / self.total
        progress(value, force=force)

    def scene(self):
        return SceneProgress(self)


class SceneProgress:
    """One scene's view of the run, tracking what it has already been credited."""

    def __init__(self, run):
        self._run = run
        self._credited = 0.0

    def step(self, artifact):
        weight = WEIGHTS.get(artifact, 0.0)
        self._credited += weight
        self._run._add(weight)

    def done(self):
        self._run._add(max(0.0, 1.0 - self._credited), force=True)
