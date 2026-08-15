"""Stash plugin: generate covers, previews and sprites for VR scenes from one eye.

Stash builds every generated artifact from the whole video frame. For a VR file
that frame is a stereo pair, so the library grid, the hover preview and the
scrubber all show a squashed double image. Generation happens in Go with no
extension point and there is no post-generation hook to react to, so this plugin
runs its own ffmpeg and writes the same files. Stash serves them straight off
disk, so a replacement is live immediately; the cover is the exception and goes
back through the API.

Read on stdin as JSON, answer on stdout as JSON, log on stderr.
"""

import concurrent.futures
import json
import os
import re
import sys
import threading
import traceback

import vrformat
import vrgen
import vrlog
import vrstash

HASH_RE = re.compile(r"/scene/([0-9a-fA-F]+)_sprite\.jpg")

# Argument name -> the artifact it turns on. These deliberately match the field
# names of Stash's own GenerateMetadataInput, so the options someone ticked can
# be handed over without translation.
ARTIFACT_ARGS = (
    ("covers", "cover"),
    ("previews", "preview"),
    ("imagePreviews", "webp"),
    ("sprites", "sprite"),
)

ARTIFACTS = tuple(name for _, name in ARTIFACT_ARGS)


class Skip(Exception):
    """A scene that is deliberately left alone."""


def _flag(args, key):
    """A boolean argument, whether it arrived as JSON or as a defaultArgs string.

    args_map carries real types, but a task's defaultArgs are strings only, so
    "false" has to mean what it says rather than merely being non-empty.
    """
    value = args.get(key)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _string_list(args, key):
    """A list argument, sent either as a JSON list or as one item per line."""
    value = args.get(key)
    if value is None:
        return []
    if isinstance(value, str):
        value = value.splitlines()
    return [str(item).strip() for item in value if str(item).strip()]


def _number(args, key, default):
    value = args.get(key)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        vrlog.warning("%s=%r is not a number, using %r" % (key, value, default))
        return default


class RunOptions:
    """What this particular invocation was asked to do."""

    def __init__(self, args):
        self.wanted = {name for arg, name in ARTIFACT_ARGS if _flag(args, arg)}
        # The animated preview is encoded from the video preview, which is why
        # Stash makes it a sub-setting of it and skips it outright when previews
        # are off (task_generate.go: `if j.input.Previews`).
        if "preview" not in self.wanted:
            self.wanted.discard("webp")

        self.overwrite = _flag(args, "overwrite")
        self.format = str(args.get("format") or vrformat.AUTO).strip() or vrformat.AUTO
        self.paths = _string_list(args, "paths")

        ids = args.get("sceneIds")
        if isinstance(ids, str):
            ids = ids.replace(",", " ").split()
        self.scene_ids = [str(i).strip() for i in (ids or []) if str(i).strip()]

        # Present only when someone opened "Override preview generation
        # options"; absent means the server's own settings stand.
        self.preview_overrides = {
            key: args[key]
            for key in ("previewSegments", "previewSegmentDuration",
                        "previewExcludeStart", "previewExcludeEnd")
            if args.get(key) not in (None, "")
        }

    def resolve_format(self):
        """The chosen format, or None for auto. Raises on a name that is not one."""
        if self.format == vrformat.AUTO:
            return None
        return vrformat.resolve(self.format)


class Context:
    """Everything a worker needs, resolved once at startup."""

    def __init__(self, stash, general, options):
        self.stash = stash
        self.run_options = options
        self.wanted = options.wanted

        generated = general.get("generatedPath")
        if not generated:
            raise RuntimeError("stash has no generated path configured")
        self.paths = vrgen.Paths(generated)
        os.makedirs(self.paths.tmp, exist_ok=True)

        self.parallel_tasks = general.get("parallelTasks") or 0
        if self.parallel_tasks <= 0:
            # GetParallelTasksWithAutoDetection's formula, not NumCPU.
            self.parallel_tasks = (os.cpu_count() or 4) // 4 + 1

        self.options = {
            "preset": general.get("previewPreset") or "slow",
            "segments": general.get("previewSegments") or 12,
            "segment_duration": general.get("previewSegmentDuration") or 0.75,
            "exclude_start": general.get("previewExcludeStart") or "0",
            "exclude_end": general.get("previewExcludeEnd") or "0",
            "audio": general.get("previewAudio", True),
            "cell_size": general.get("spriteScreenshotSize") or 160,
            "custom_interval": bool(general.get("useCustomSpriteInterval")),
            "interval": general.get("spriteInterval") or 0,
            "minimum_sprites": general.get("minimumSprites") or 10,
            "maximum_sprites": general.get("maximumSprites") or 500,
            "input_args": list(general.get("transcodeInputArgs") or []),
            "output_args": list(general.get("transcodeOutputArgs") or []),
            "threads": vrstash.FFMPEG_THREADS,
            "tmp_dir": self.paths.tmp,
            "timeout": None,
        }
        self._apply_preview_overrides(options.preview_overrides)

        self.counts = {"processed": 0, "skipped": 0, "failed": 0}
        self.built = dict.fromkeys(ARTIFACTS, 0)
        self._lock = threading.Lock()

    def _apply_preview_overrides(self, overrides):
        if not overrides:
            return
        self.options["segments"] = max(1, int(
            _number(overrides, "previewSegments", self.options["segments"])))
        self.options["segment_duration"] = _number(
            overrides, "previewSegmentDuration", self.options["segment_duration"])
        for key, target in (("previewExcludeStart", "exclude_start"),
                            ("previewExcludeEnd", "exclude_end")):
            if key in overrides:
                self.options[target] = str(overrides[key])
        vrlog.debug("preview options overridden: %s" % json.dumps(overrides))

    def tally(self, key, amount=1):
        with self._lock:
            if key in self.counts:
                self.counts[key] += amount
            else:
                self.built[key] = self.built.get(key, 0) + amount


def scene_hash(scene):
    """The generation hash, taken from the sprite URL Stash builds for us.

    That URL is literally GetSpriteURL(scene.GetHash(algorithm)), so it settles
    the md5-versus-oshash question without reading the config or the file's
    fingerprints.
    """
    match = HASH_RE.search((scene.get("paths") or {}).get("sprite") or "")
    return match.group(1) if match else None


def process_scene(context, scene, progress):
    step = progress.scene()
    label = scene.get("title") or "scene %s" % scene.get("id")

    try:
        files = scene.get("files") or []
        source = (files[0].get("path") if files else None) or ""
        if not source:
            raise Skip("no video file")

        digest = scene_hash(scene)
        if not digest:
            raise Skip("no generation hash -- the scene has no primary file")
        if not os.path.isfile(source):
            raise Skip("source is not readable at %s" % source)

        fmt = context.run_options.resolve_format()
        if fmt is None:
            fmt = vrformat.from_filename(source)
        if fmt is None:
            raise Skip(
                "nothing in the filename says which VR format this is -- "
                "choose one instead of Auto to generate it anyway"
            )

        info = vrgen.probe(source)
        if not info["width"] or not info["height"]:
            raise Skip("could not read the frame size")

        geometry = vrformat.Geometry(fmt, info["width"], info["height"])
        todo = _outstanding(context, digest)
        if not todo:
            context.tally("skipped")
            vrlog.debug("%s: up to date" % label)
            return

        vrlog.info("%s: %s, rebuilding %s"
                   % (label, geometry.describe(), ", ".join(sorted(todo))))
        _build(context, scene, digest, source, geometry, info, todo, step, label)
        context.tally("processed")

    except Skip as exc:
        context.tally("skipped")
        vrlog.debug("%s: %s" % (label, exc))
    except Exception as exc:  # one bad scene must not end the run
        context.tally("failed")
        vrlog.error("%s: %s" % (label, exc))
        vrlog.debug(traceback.format_exc())
    finally:
        step.done()


def _outstanding(context, digest):
    """Which of the wanted artifacts are missing, or are being overwritten.

    The same rule Stash applies: a generator early-returns when its output
    already exists, unless the run says to overwrite. Covers are the exception --
    there is no way to ask over GraphQL whether a scene has one, and a scene that
    does has the squashed cover Stash made, which is the thing being fixed.
    """
    wanted, paths, overwrite = context.wanted, context.paths, context.run_options.overwrite
    todo = set()

    def check(name, *targets):
        if name in wanted and (overwrite or not all(os.path.isfile(t) for t in targets)):
            todo.add(name)

    if "cover" in wanted:
        todo.add("cover")
    check("preview", paths.preview(digest))
    check("webp", paths.webp(digest))
    # The sprite image and its vtt describe each other, so they are a pair: a
    # stale vtt against a fresh sprite misplaces every thumbnail.
    check("sprite", paths.sprite(digest), paths.thumbs(digest))
    return todo


def _build(context, scene, digest, source, geometry, info, todo, step, label):
    paths, options = context.paths, context.options

    if "cover" in todo:
        vrlog.debug("%s: cover" % label)
        vrstash.set_cover(
            context.stash, scene["id"],
            vrgen.generate_cover(source, geometry, options, info),
        )
        context.tally("cover")
        step.step("cover")

    preview_path = paths.preview(digest)
    if "preview" in todo:
        vrlog.debug("%s: preview" % label)
        vrgen.generate_preview(source, geometry, preview_path, options, info)
        context.tally("preview")
        step.step("preview")

    if "webp" in todo:
        # Built from the video preview on disk, which is what Stash's own
        # PreviewWebp does. There is always one by this point: the animated
        # preview is only ever wanted alongside the video one, so either it was
        # just encoded or it was already there.
        vrlog.debug("%s: animated preview" % label)
        vrgen.generate_webp(preview_path, paths.webp(digest), options)
        context.tally("webp")
        step.step("webp")

    if "sprite" in todo:
        vrlog.debug("%s: sprite and vtt" % label)
        vrgen.generate_sprite(
            source, geometry, paths.sprite(digest), paths.thumbs(digest), options, info
        )
        context.tally("sprite")
        step.step("sprite")


def collect_scenes(context, options):
    """The scenes to consider: an explicit list, some folders, or everything."""
    stash = context.stash

    if options.scene_ids:
        return vrstash.scenes_by_id(stash, options.scene_ids)

    if not options.paths:
        return list(vrstash.iter_scenes(stash))

    # One query per path rather than an OR chain: OR in SceneFilterType composes
    # the whole sibling group, so { path: a, OR: { path: b } } does not mean
    # what it looks like. A handful of extra round trips is nothing next to
    # getting that wrong.
    vrlog.info("restricted to %s" % ", ".join(options.paths))
    seen, scenes = set(), []
    for path in options.paths:
        for scene in vrstash.iter_scenes(stash, path=path):
            if scene["id"] not in seen:
                seen.add(scene["id"])
                scenes.append(scene)
    return scenes


def run(context, options):
    scenes = collect_scenes(context, options)
    if not scenes:
        return {"scenes": 0, "message": "no scenes matched"}

    vrlog.info("%d scene(s) to consider" % len(scenes))
    progress = vrlog.Progress(len(scenes))

    # Follows the server's Parallel Tasks setting, the same budget Stash spends
    # on its own generation. Threads rather than processes: every unit of work
    # is an ffmpeg call, so the GIL is released for the whole of it.
    workers = max(1, min(int(context.parallel_tasks), 16))
    vrlog.info("using %d worker(s)" % workers)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(lambda scene: process_scene(context, scene, progress), scenes))

    summary = {"scenes": len(scenes)}
    summary.update(context.counts)
    summary["artifacts"] = {k: v for k, v in context.built.items() if v}
    return summary


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError as exc:
        print(json.dumps({"error": "could not parse the plugin input: %s" % exc}))
        return

    try:
        options = RunOptions(payload.get("args") or {})
        if not options.wanted:
            raise RuntimeError("nothing was selected to generate")
        options.resolve_format()  # fail on a bad name before touching anything

        connection = payload.get("server_connection") or {}
        stash = vrstash.Stash(connection)
        general = vrstash.get_config(stash)
        vrgen.resolve_binaries(general, connection.get("Dir"))

        context = Context(stash, general, options)
        vrlog.debug("run: %s" % json.dumps({
            "artifacts": sorted(options.wanted),
            "format": options.format,
            "overwrite": options.overwrite,
            "paths": options.paths,
            "sceneIds": options.scene_ids,
        }))
        # Anything left behind by a run that was killed mid-write, from any
        # previous invocation. Cheap, and it saves having a task for it.
        vrgen.sweep_temp_files(context.paths.screenshots, context.paths.vtt, context.paths.tmp)

        output = run(context, options)
        vrlog.info("done: %s" % json.dumps(output))
        print(json.dumps({"error": None, "output": output}))

    except Exception as exc:
        vrlog.debug(traceback.format_exc())
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
