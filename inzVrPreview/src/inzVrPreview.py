"""Stash plugin: rebuild VR scene artifacts from a single eye.

Stash generates every preview, sprite and cover from the whole frame, which for
a VR file is a stereo pair — so the library grid and the scrubber show a
squashed double image. Generation happens in Go with no extension point and
there is no post-generation hook to react to, so this plugin runs its own
ffmpeg and replaces the finished files. Stash serves them straight off disk, so
a replacement is live immediately; the cover is the exception and goes back
through the API.

Read on stdin as JSON, answer on stdout as JSON, log on stderr.
"""

import concurrent.futures
import json
import os
import re
import sys
import threading
import traceback

import vrartifacts
import vrlayout
import vrlog
import vrmedia
import vrstash
import vrstate

HASH_RE = re.compile(r"/scene/([0-9a-fA-F]+)_sprite\.jpg")

ARTIFACTS = ("preview", "webp", "sprite", "markers", "cover")

# What Stash used before the marker preview durations became configurable.
LEGACY_MARKER_SECONDS = 20


class Skip(Exception):
    """A scene that is deliberately left alone."""


def _or_default(value, default):
    """Distinguish a missing setting from one deliberately set to zero."""
    return default if value is None else value


def _flag(args, key):
    """A boolean argument, whether it arrived as JSON or as a defaultArgs string.

    args_map carries real types, but a task's defaultArgs are strings only, so
    "false" has to mean what it says rather than merely being non-empty.
    """
    value = args.get(key)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _number(args, key):
    try:
        return max(0, int(float(args.get(key) or 0)))
    except (TypeError, ValueError):
        vrlog.warning("%s=%r is not a number, ignoring it" % (key, args.get(key)))
        return 0


def _string_list(args, key):
    """A list argument, sent either as a JSON list or as one item per line."""
    value = args.get(key)
    if value is None:
        return []
    if isinstance(value, str):
        value = value.splitlines()
    return [str(item).strip() for item in value if str(item).strip()]


# Argument name -> the artifact it turns on. These deliberately match the field
# names of Stash's own GenerateMetadataInput, so the UI can hand the options a
# person ticked in the Generate dialog straight through to us.
ARTIFACT_ARGS = (
    ("covers", "cover"),
    ("previews", "preview"),
    ("imagePreviews", "webp"),
    ("sprites", "sprite"),
    ("markers", "markers"),
)


class RunOptions:
    """What this particular run was asked to do.

    Everything here describes one invocation rather than the library, so it
    arrives as task arguments — from a task's defaultArgs, or from the plugin's
    own dialog through args_map — instead of living in the settings.
    """

    def __init__(self, args):
        self.mode = str(args.get("mode") or "process").strip()
        self.overwrite = _flag(args, "overwrite")
        self.force = self.mode == "force" or self.overwrite
        self.dry_run = self.mode == "dryrun"
        self.detect_only = self.mode == "detect"
        self.verbose = _flag(args, "verbose")
        self.limit = _number(args, "limit")
        self.paths = _string_list(args, "paths")

        ids = args.get("sceneIds")
        if isinstance(ids, str):
            ids = ids.replace(",", " ").split()
        self.scene_ids = [str(i).strip() for i in (ids or []) if str(i).strip()]

        # Nothing asked for means everything, which is what a run with no
        # arguments at all did before the artifacts became selectable.
        self.wanted = {name for arg, name in ARTIFACT_ARGS if _flag(args, arg)}
        if not self.wanted:
            self.wanted = {name for _, name in ARTIFACT_ARGS}

    @property
    def known_mode(self):
        return self.mode in ("process", "force", "dryrun", "detect", "prune")


class Context:
    """Everything a worker needs, resolved once at startup."""

    def __init__(self, stash, schema, config, settings, options):
        self.stash = stash
        self.schema = schema
        self.settings = settings
        self.run_options = options
        self.force = options.force
        self.dry_run = options.dry_run
        self.wanted = options.wanted
        self.ui = config.get("ui") or {}

        general = config["general"]
        self.parallel_tasks = general.get("parallelTasks") or 0
        if self.parallel_tasks <= 0:
            # GetParallelTasksWithAutoDetection's formula, not NumCPU.
            self.parallel_tasks = (os.cpu_count() or 4) // 4 + 1
        self.generated = general["generatedPath"]
        if not self.generated:
            raise RuntimeError("stash has no generated path configured")
        self.paths = vrartifacts.Paths(self.generated)
        self.store = vrstate.Store(self.generated)

        tmp_dir = self.paths.tmp
        os.makedirs(tmp_dir, exist_ok=True)

        self.options = {
            "preset": general.get("previewPreset") or "slow",
            "segments": general.get("previewSegments") or 12,
            "segment_duration": general.get("previewSegmentDuration") or 0.75,
            "exclude_start": general.get("previewExcludeStart") or "0",
            "exclude_end": general.get("previewExcludeEnd") or "0",
            "audio": general.get("previewAudio", True),
            # Before these became settings, Stash capped marker previews at a
            # hardcoded 20 seconds, so that is the fallback when the server is
            # old enough not to expose them. A configured 0 means uncapped.
            "max_marker": _or_default(general.get("maxMarkerPreviewDuration"), LEGACY_MARKER_SECONDS),
            "default_marker": general.get("defaultMarkerPreviewDuration") or LEGACY_MARKER_SECONDS,
            "cell_size": general.get("spriteScreenshotSize") or 160,
            "custom_interval": bool(general.get("useCustomSpriteInterval")),
            "interval": general.get("spriteInterval") or 0,
            "minimum_sprites": general.get("minimumSprites") or 10,
            "maximum_sprites": general.get("maximumSprites") or 500,
            "input_args": list(general.get("transcodeInputArgs") or []),
            "output_args": list(general.get("transcodeOutputArgs") or []),
            "threads": vrstash.FFMPEG_THREADS,
            "tmp_dir": tmp_dir,
            "still_width": 1920,
            "cover_at": 0,
            "timeout": None,
        }

        # Filled in by collect_scenes, and only consulted for a run that named
        # its scenes outright — see _fallback_allowed.
        self.vr_tag_names = set()

        self.render_fingerprint = settings.render_fingerprint()
        self.detect_fingerprint = settings.detect_fingerprint()
        self.counts = {
            "processed": 0, "skipped": 0, "failed": 0, "mono": 0,
            "sbs": 0, "tb": 0,
        }
        self.generated_counts = dict.fromkeys(ARTIFACTS, 0)
        self._lock = threading.Lock()

    def tally(self, key, amount=1):
        with self._lock:
            if key in self.counts:
                self.counts[key] += amount
            else:
                self.generated_counts[key] = self.generated_counts.get(key, 0) + amount


def scene_hash(scene):
    """The generation hash, taken from the sprite URL Stash builds for us.

    That URL is literally GetSpriteURL(scene.GetHash(algorithm)), so it settles
    the md5-versus-oshash question without reading the config or the file's
    fingerprints.
    """
    match = HASH_RE.search((scene.get("paths") or {}).get("sprite") or "")
    return match.group(1) if match else None


def primary_file(scene):
    files = scene.get("files") or []
    return files[0] if files else None


def process_scene(context, scene, run_progress):
    progress = vrlog.SceneProgress(run_progress)
    settings = context.settings
    label = scene.get("title") or "scene %s" % scene.get("id")

    try:
        video_file = primary_file(scene)
        if not video_file or not video_file.get("path"):
            raise Skip("no video file")

        digest = scene_hash(scene)
        if not digest:
            raise Skip("no generation hash — the scene has no primary file")

        source = video_file["path"]
        if not os.path.isfile(source):
            raise Skip("source is not readable at %s" % source)

        record = {} if context.force else context.store.load(digest)
        probe = vrmedia.probe(source)
        signature = vrstate.source_signature(video_file, probe)

        # A different file behind the same scene invalidates everything. The
        # two settings digests invalidate their own half: retuning a detection
        # threshold re-examines the picture but keeps artifacts whose verdict
        # did not move, and changing the geometry re-encodes without re-probing.
        if record.get("source") != signature:
            record = {}
        if record.get("detect") != context.detect_fingerprint:
            record.pop("layout", None)
            record.pop("projection", None)
        if record.get("render") != context.render_fingerprint:
            record.pop("artifacts", None)

        layout = record.get("layout")
        projection = record.get("projection")
        signal = record.get("signal")
        if not layout:
            layout, projection, detail = vrlayout.decide(
                scene, video_file, probe, settings, _fallback_allowed(context, scene)
            )
            signal = detail.get("signal")
            vrlog.info("%s: %s (%s)" % (label, layout, _describe(detail)))
            progress.step("detect")

        context.tally(layout if layout in ("sbs", "tb") else "mono")
        if layout == vrlayout.MONO:
            _remember(context, digest, scene, layout, projection, signal, signature, record)
            raise Skip("not stereo, leaving it alone")

        geometry = vrlayout.Geometry(layout, projection, probe["width"], probe["height"], settings)
        # Written now rather than only after a successful build, so that a
        # scene with nothing to do still records the verdict it just reached —
        # otherwise a retuned threshold would re-probe every up-to-date scene
        # on every subsequent run.
        _remember(context, digest, scene, layout, projection, signal, signature, record)
        artifacts = record.setdefault("artifacts", {})

        todo = _outstanding(context, digest, scene, artifacts)
        if not todo:
            context.tally("skipped")
            vrlog.debug("%s: up to date" % label)
            return

        if context.dry_run:
            vrlog.info("%s: would regenerate %s" % (label, ", ".join(sorted(todo))))
            context.tally("processed")
            return

        try:
            _build(context, scene, digest, source, geometry, probe, artifacts, todo, progress, label)
        finally:
            # Saved even when a later artifact blows up, so a run that dies
            # half way through a scene does not throw away the encodes that
            # did land — on a library of hour-long VR files that is the
            # difference between resuming and starting over.
            context.store.save(digest, record)
        context.tally("processed")

    except Skip as exc:
        context.tally("skipped")
        vrlog.debug("%s: %s" % (label, exc))
    except Exception as exc:  # one bad scene must not end the run
        context.tally("failed")
        vrlog.error("%s: %s" % (label, exc))
        vrlog.debug(traceback.format_exc())
    finally:
        progress.done()


def _describe(detail):
    parts = [detail.get("signal", "?")]
    for key in ("s_lr", "s_lrm", "s_tb", "s_tbm"):
        if key in detail:
            parts.append("%s=%.3f" % (key[2:], detail[key]))
    return " ".join(parts)


def _remember(context, digest, scene, layout, projection, signal, signature, record, save=True):
    """Stamp a verdict onto the record so the next run does not probe again."""
    record.update({
        "scene_id": scene.get("id"),
        "layout": layout,
        "projection": projection,
        # Kept so a cached verdict can say how it was reached — which matters
        # for the ones that fell back rather than being read off the picture.
        "signal": signal,
        "source": signature,
        "detect": context.detect_fingerprint,
        "render": context.render_fingerprint,
    })
    if save and not context.dry_run:
        context.store.save(digest, record)


def _outstanding(context, digest, scene, artifacts):
    """Which artifacts are missing, or no longer the ones we wrote."""
    wanted, paths = context.wanted, context.paths
    todo = set()

    def check(name, path):
        if os.path.isfile(path) and vrstate.matches(path, artifacts.get(name)):
            return
        todo.add(name)

    if "preview" in wanted:
        check("preview", paths.preview(digest))
    if "webp" in wanted:
        check("webp", paths.webp(digest))
    if "sprite" in wanted:
        check("sprite", paths.sprite(digest))
        check("thumbs", paths.thumbs(digest))
    if "markers" in wanted and scene.get("scene_markers"):
        for marker in scene["scene_markers"]:
            for extension in ("mp4", "webp", "jpg"):
                check(
                    "marker_%s_%s" % (int(float(marker.get("seconds") or 0)), extension),
                    paths.marker(digest, marker.get("seconds") or 0, extension),
                )
    if "cover" in wanted and "cover" not in artifacts:
        todo.add("cover")

    # The sprite image and its vtt describe each other, so they are rebuilt as
    # a pair — a stale vtt against a fresh sprite misplaces every thumbnail.
    if "thumbs" in todo:
        todo.add("sprite")
    if "sprite" in todo:
        todo.add("thumbs")
    return todo


def _build(context, scene, digest, source, geometry, probe, artifacts, todo, progress, label):
    paths, options = context.paths, context.options
    preview_path = paths.preview(digest)

    if "preview" in todo:
        vrlog.debug("%s: preview" % label)
        artifacts["preview"] = vrartifacts.generate_preview(
            source, geometry, preview_path, options, probe
        )
        progress.step("preview")

    if "webp" in todo:
        # The webp is encoded from the preview, so it is only single-eye if the
        # preview on disk is ours. Build a throwaway one when it is not.
        temporary = None
        if not os.path.isfile(preview_path) or not vrstate.matches(preview_path, artifacts.get("preview")):
            vrlog.debug("%s: preview is not ours, encoding one for the webp" % label)
            # Carries the temp marker so Prune state can sweep it if we are
            # killed between writing it and removing it.
            temporary = os.path.join(
                options["tmp_dir"], "%s.webpsrc%s.mp4" % (digest, vrstate.TMP_SUFFIX)
            )
            vrartifacts.generate_preview(source, geometry, temporary, options, probe)
        try:
            vrlog.debug("%s: animated webp" % label)
            artifacts["webp"] = vrartifacts.generate_webp(
                temporary or preview_path, paths.webp(digest), options
            )
        finally:
            if temporary:
                vrartifacts.discard(temporary)
        progress.step("webp")

    if "sprite" in todo:
        vrlog.debug("%s: sprite and vtt" % label)
        sprite_stamp, vtt_stamp = vrartifacts.generate_sprite(
            source, geometry, paths.sprite(digest), paths.thumbs(digest), options, probe
        )
        artifacts["sprite"], artifacts["thumbs"] = sprite_stamp, vtt_stamp
        progress.step("sprite")

    markers = [m for m in (scene.get("scene_markers") or [])
               if any(k.startswith("marker_%s_" % int(float(m.get("seconds") or 0))) for k in todo)]
    if markers:
        vrlog.debug("%s: %d marker(s)" % (label, len(markers)))
        for marker in markers:
            stamps = vrartifacts.generate_marker(
                source, geometry, paths, digest, marker, options, probe
            )
            seconds = int(float(marker.get("seconds") or 0))
            for extension, value in stamps.items():
                artifacts["marker_%s_%s" % (seconds, extension)] = value
            context.tally("markers")
        progress.step("markers")

    if "cover" in todo:
        vrlog.debug("%s: cover" % label)
        data_url = vrartifacts.generate_cover(source, geometry, options, probe)
        context.stash.call(
            vrstash.SCENE_UPDATE, {"input": {"id": scene["id"], "cover_image": data_url}}
        )
        artifacts["cover"] = {"set": True}
        progress.step("cover")

    for name in ("preview", "webp", "sprite", "cover"):
        if name in todo:
            context.tally(name)


def _fallback_allowed(context, scene):
    """Whether a scene may be guessed at when nothing identifies its layout.

    Guessing side-by-side is only defensible for something already declared to
    be VR. A tag-scoped run is all VR by construction; one that named its scenes
    outright — a selection in the scene list, say — is not, so those are checked
    against the configured tags. findScenes ignores scene_filter once ids are
    given, so this cannot be pushed onto the server.
    """
    if not context.run_options.scene_ids or not context.vr_tag_names:
        return True
    return any(
        (tag.get("name") or "").casefold() in context.vr_tag_names
        for tag in (scene.get("tags") or [])
    )


def collect_scenes(context, options):
    """The scenes to consider, either an explicit list or everything VR-tagged."""
    stash, settings = context.stash, context.settings
    ui_tag = (context.ui or {}).get("vrTag")
    names = settings.tag_names(ui_tag)
    context.vr_tag_names = {name.casefold() for name in names}

    if options.scene_ids:
        return vrstash.scenes_by_id(stash, context.schema, options.scene_ids)

    if not names:
        raise RuntimeError(
            "no VR tag configured — set one in Settings > Interface > VR tag, "
            "or add one to this plugin's extraTagNames setting"
        )
    include = vrstash.resolve_tag_ids(stash, names)
    if not include:
        raise RuntimeError("none of the configured VR tags exist: %s" % ", ".join(names))
    exclude = vrstash.resolve_tag_ids(stash, settings.exclude_names())

    vrlog.info("looking for scenes tagged %s" % ", ".join(names))
    if not options.paths:
        return list(
            vrstash.iter_scenes(stash, context.schema, include, exclude, limit=options.limit)
        )

    # One query per path rather than an OR chain: OR in SceneFilterType composes
    # the whole sibling group, so { tags: T, path: a, OR: { path: b } } would
    # drop the tag constraint from the second branch. A handful of extra round
    # trips is nothing next to getting that wrong.
    vrlog.info("restricted to %s" % ", ".join(options.paths))
    seen, scenes = set(), []
    for path in options.paths:
        for scene in vrstash.iter_scenes(stash, context.schema, include, exclude, path=path):
            if scene["id"] in seen:
                continue
            seen.add(scene["id"])
            scenes.append(scene)
            if options.limit and len(scenes) >= options.limit:
                return scenes
    return scenes


def prune(context):
    """Drop state for scenes that no longer exist, and old temporary files."""
    known = set()
    for scene in vrstash.iter_all_scene_paths(context.stash):
        digest = scene_hash(scene)
        if digest:
            known.add(digest)

    removed = 0
    for digest in context.store.hashes():
        if digest not in known and context.store.forget(digest):
            removed += 1

    swept = vrstate.sweep_temp_files(
        context.paths.screenshots, context.paths.vtt, context.paths.markers,
        context.paths.tmp, context.store.root,
    )
    return {"state_removed": removed, "temp_removed": swept}


def run(context, options):
    scenes = collect_scenes(context, options)
    if not scenes:
        return {"scenes": 0, "message": "no VR scenes matched"}

    vrlog.info("%d scene(s) to consider" % len(scenes))
    run_progress = vrlog.Progress(len(scenes))

    # Follows the server's Parallel Tasks setting, the same budget Stash spends
    # on its own generation.
    workers = max(1, min(int(context.parallel_tasks), 16))
    vrlog.info("using %d worker(s)" % workers)

    # Threads rather than processes: every unit of work is an ffmpeg call, so
    # the GIL is released for the whole of it.
    work = _detect_only if options.detect_only else process_scene
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(lambda s: work(context, s, run_progress), scenes))

    summary = {"scenes": len(scenes)}
    summary.update(context.counts)
    summary["artifacts"] = {k: v for k, v in context.generated_counts.items() if v}
    return summary


def _detect_only(context, scene, run_progress):
    progress = vrlog.SceneProgress(run_progress)
    label = scene.get("title") or "scene %s" % scene.get("id")
    try:
        video_file = primary_file(scene)
        digest = scene_hash(scene)
        if not video_file or not digest or not os.path.isfile(video_file.get("path") or ""):
            raise Skip("no readable video file")

        probe = vrmedia.probe(video_file["path"])
        layout, projection, detail = vrlayout.decide(
            scene, video_file, probe, context.settings, _fallback_allowed(context, scene)
        )
        vrlog.info("%s: %s/%s (%s)" % (label, layout, projection, _describe(detail)))
        context.tally(layout if layout in ("sbs", "tb") else "mono")

        if not context.dry_run:
            record = context.store.load(digest)
            _remember(
                context, digest, scene, layout, projection, detail.get("signal"),
                vrstate.source_signature(video_file, probe), record,
            )
    except Skip as exc:
        context.tally("skipped")
        vrlog.debug("%s: %s" % (label, exc))
    except Exception as exc:
        context.tally("failed")
        vrlog.error("%s: %s" % (label, exc))
    finally:
        progress.done()


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError as exc:
        print(json.dumps({"error": "could not parse the plugin input: %s" % exc}))
        return

    options = RunOptions(payload.get("args") or {})
    vrlog.set_debug(options.verbose)
    if not options.known_mode:
        print(json.dumps({"error": "unknown mode %r" % options.mode}))
        return

    try:
        connection = payload.get("server_connection") or {}
        stash = vrstash.Stash(connection)
        # Ask the server what it supports before asking it anything else: the
        # generation settings differ between Stash releases and the plugin is
        # installed onto whichever one the user happens to run.
        schema = vrstash.get_schema(stash)
        config = vrstash.get_config(stash, schema)
        settings = vrstash.Settings((config.get("plugins") or {}).get(vrstash.PLUGIN_ID))

        vrmedia.resolve_binaries(config["general"], connection.get("Dir"))

        context = Context(stash, schema, config, settings, options)
        vrlog.debug("run options: %s" % json.dumps({
            "mode": options.mode, "artifacts": sorted(options.wanted),
            "paths": options.paths, "sceneIds": options.scene_ids,
            "limit": options.limit,
        }))

        if options.mode == "prune":
            output = prune(context)
        else:
            output = run(context, options)

        vrlog.info("done: %s" % json.dumps(output))
        print(json.dumps({"error": None, "output": output}))

    except Exception as exc:
        vrlog.debug(traceback.format_exc())
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
