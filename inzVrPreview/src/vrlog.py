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
_debug_enabled = False
_last_progress = [0.0]


def set_debug(enabled):
    global _debug_enabled
    _debug_enabled = bool(enabled)


def _log(level_char, message):
    prefix = (_SOH + level_char + _STX).decode()
    # Stash reads stderr a line at a time and looks for the level prefix at the
    # start of each one, so a multi-line message has to be tagged line by line.
    # Left alone, everything after the first newline would arrive at the
    # plugin's errLog level instead — a debug traceback as a stack of errors.
    # Blank lines are dropped: detectLogLevel needs a character after the
    # prefix, and Stash ignores empty lines anyway.
    lines = [line for line in str(message).splitlines() if line.strip()] or ["(empty)"]
    with _lock:
        for line in lines:
            print(prefix + line, file=sys.stderr, flush=True)


def trace(message):
    if _debug_enabled:
        _log(b"t", message)


def debug(message):
    if _debug_enabled:
        _log(b"d", message)


def info(message):
    _log(b"i", message)


def warning(message):
    _log(b"w", message)


def error(message):
    _log(b"e", message)


def progress(fraction, force=False):
    fraction = min(max(0.0, float(fraction)), 1.0)
    now = time.monotonic()
    with _lock:
        if not force and now - _last_progress[0] < 1.0:
            return
        _last_progress[0] = now
    _log(b"p", repr(fraction))


WEIGHTS = {
    "detect": 0.05,
    "preview": 0.45,
    "webp": 0.10,
    "sprite": 0.30,
    "markers": 0.07,
    "cover": 0.03,
}


class Progress:
    """Whole-run progress, weighted by how long each artifact actually takes.

    The unit is "scenes worth of work". Each artifact adds its weight, so the
    bar keeps moving during the long preview encode instead of jumping once per
    scene. Scenes may be processed concurrently, so the accumulator is global
    and each worker tops its scene up to a whole unit when it finishes.
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

    def step(self, artifact):
        self._add(WEIGHTS.get(artifact, 0.0))

    def scene_done(self, credited):
        """Credit the part of the scene that was skipped or failed."""
        self._add(max(0.0, 1.0 - credited), force=True)


class SceneProgress:
    """Per-scene view of the run progress, tracking what has been credited."""

    def __init__(self, run):
        self._run = run
        self._credited = 0.0

    def step(self, artifact):
        if self._run is None:
            return
        self._credited += WEIGHTS.get(artifact, 0.0)
        self._run.step(artifact)

    def done(self):
        if self._run is None:
            return
        self._run.scene_done(self._credited)
