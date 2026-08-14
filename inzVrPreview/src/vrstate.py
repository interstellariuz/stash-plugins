"""Per-scene record of what this plugin generated, so re-runs are cheap.

One file per scene rather than a single index: scenes are processed
concurrently and the plugin is stopped with SIGKILL, so independent writes are
both simpler and safer than locking a shared document.

The state deliberately lives under the generated directory. It describes files
in there and should die with them — someone who clears their generated content
expects the next run to rebuild everything.
"""

import json
import os
import time

import vrlog

VERSION = 1
DIRNAME = "inzVrPreview"
TMP_SUFFIX = ".inzvr.tmp"


class Store:
    def __init__(self, generated_path):
        self.root = os.path.join(generated_path, DIRNAME, "state")

    def path_for(self, scene_hash):
        return os.path.join(self.root, "%s.json" % scene_hash)

    def load(self, scene_hash):
        try:
            with open(self.path_for(scene_hash), "r", encoding="utf-8") as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            return {}
        if record.get("v") != VERSION:
            return {}
        return record

    def save(self, scene_hash, record):
        record["v"] = VERSION
        record["at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        target = self.path_for(scene_hash)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + TMP_SUFFIX
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=1, sort_keys=True)
        os.replace(tmp, target)

    def forget(self, scene_hash):
        try:
            os.remove(self.path_for(scene_hash))
            return True
        except OSError:
            return False

    def hashes(self):
        try:
            names = os.listdir(self.root)
        except OSError:
            return []
        return [n[:-5] for n in names if n.endswith(".json")]


def stamp(path):
    """The identity of a file we wrote: size plus modification time."""
    info = os.stat(path)
    return {"size": info.st_size, "mtime_ns": info.st_mtime_ns}


def matches(path, recorded):
    """True when the file on disk is still the one we put there."""
    if not recorded:
        return False
    try:
        return stamp(path) == {"size": recorded.get("size"), "mtime_ns": recorded.get("mtime_ns")}
    except OSError:
        return False


def source_signature(video_file, probe):
    """Identity of the source video, so a replaced file forces a re-detect."""
    return {
        "path": video_file.get("path"),
        "size": _as_int(video_file.get("size")),
        "width": probe["width"],
        "height": probe["height"],
        "duration": round(probe["duration"], 3),
    }


def _as_int(value):
    # size comes back through the Int64 scalar, which may serialise as a string.
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def sweep_temp_files(*directories):
    """Remove leftovers from a run that was killed mid-write.

    Only files older than a day, so a sweep cannot pull the rug out from under
    a run happening at the same time.
    """
    cutoff = time.time() - 24 * 3600
    removed = 0
    for directory in directories:
        # Markers live one directory deeper, under a per-scene folder.
        for root, _, names in os.walk(directory):
            for name in names:
                if TMP_SUFFIX not in name:
                    continue
                full = os.path.join(root, name)
                try:
                    if os.path.getmtime(full) < cutoff:
                        os.remove(full)
                        removed += 1
                except OSError:
                    pass
    if removed:
        vrlog.info("removed %d stale temporary file(s)" % removed)
    return removed
