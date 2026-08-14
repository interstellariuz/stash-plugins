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


class Context:
    """Everything a worker needs, resolved once at startup."""

    def __init__(self, stash, schema, config, settings, force, dry_run):
        self.stash = stash
        self.schema = schema
        self.settings = settings
        self.force = force
        self.dry_run = dry_run
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
            "threads": settings.ffmpegThreads,
            "tmp_dir": tmp_dir,
            "still_width": 1920,
            "cover_at": 0,
            "timeout": None,
        }

        self.fingerprint = settings.fingerprint()
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

        stale = (
            record.get("source") != signature
            or record.get("options") != context.fingerprint
        )
        if stale:
            record = {}

        layout = record.get("layout")
        projection = record.get("projection")
        if not layout:
            layout, projection, detail = vrlayout.decide(scene, video_file, probe, settings)
            vrlog.info("%s: %s (%s)" % (label, layout, _describe(detail)))
            progress.step("detect")

        context.tally(layout if layout in ("sbs", "tb") else "mono")
        if layout == vrlayout.MONO:
            _remember(context, digest, scene, layout, projection, signature, record)
            raise Skip("not stereo, leaving it alone")

        geometry = vrlayout.Geometry(layout, projection, probe["width"], probe["height"], settings)
        record.update({
            "scene_id": scene.get("id"),
            "layout": layout,
            "projection": projection,
            "source": signature,
            "options": context.fingerprint,
        })
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

        _build(context, scene, digest, source, geometry, probe, artifacts, todo, progress, label)
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


def _remember(context, digest, scene, layout, projection, signature, record):
    """Cache a verdict so the next run does not probe the file again."""
    if context.dry_run:
        return
    record.update({
        "scene_id": scene.get("id"),
        "layout": layout,
        "projection": projection,
        "source": signature,
        "options": context.fingerprint,
    })
    context.store.save(digest, record)


def _outstanding(context, digest, scene, artifacts):
    """Which artifacts are missing, or no longer the ones we wrote."""
    settings, paths = context.settings, context.paths
    todo = set()

    def check(name, path):
        if os.path.isfile(path) and vrstate.matches(path, artifacts.get(name)):
            return
        todo.add(name)

    if not settings.skipPreview:
        check("preview", paths.preview(digest))
    if not settings.skipWebp:
        check("webp", paths.webp(digest))
    if not settings.skipSprite:
        check("sprite", paths.sprite(digest))
        check("thumbs", paths.thumbs(digest))
    if not settings.skipMarkers and scene.get("scene_markers"):
        for marker in scene["scene_markers"]:
            for extension in ("mp4", "webp", "jpg"):
                check(
                    "marker_%s_%s" % (int(float(marker.get("seconds") or 0)), extension),
                    paths.marker(digest, marker.get("seconds") or 0, extension),
                )
    if not settings.skipCover and "cover" not in artifacts:
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
            temporary = os.path.join(options["tmp_dir"], "%s.webpsrc.mp4" % digest)
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


def collect_scenes(context, args):
    """The scenes to consider, either an explicit list or everything VR-tagged."""
    stash, settings = context.stash, context.settings
    raw_ids = str(args.get("sceneIds") or "").strip()
    if raw_ids:
        ids = [part.strip() for part in raw_ids.replace(",", " ").split() if part.strip()]
        return vrstash.scenes_by_id(stash, context.schema, ids)

    ui_tag = (context.ui or {}).get("vrTag")
    names = settings.tag_names(ui_tag)
    if not names:
        raise RuntimeError(
            "no VR tag configured — set one in Settings > Interface > VR tag, "
            "or in this plugin's vrTagName setting"
        )
    include = vrstash.resolve_tag_ids(stash, names)
    if not include:
        raise RuntimeError("none of the configured VR tags exist: %s" % ", ".join(names))
    exclude = vrstash.resolve_tag_ids(stash, settings.exclude_names())

    vrlog.info("looking for scenes tagged %s" % ", ".join(names))
    return [scene for _, scene in
            vrstash.iter_scenes(stash, context.schema, include, exclude, settings.sceneLimit)]


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


def run(context, args, detect_only):
    scenes = collect_scenes(context, args)
    if not scenes:
        return {"scenes": 0, "message": "no VR scenes matched"}

    vrlog.info("%d scene(s) to consider" % len(scenes))
    run_progress = vrlog.Progress(len(scenes))

    workers = context.settings.maxWorkers or context.parallel_tasks
    workers = max(1, min(int(workers), 16))
    if not detect_only and workers * context.settings.ffmpegThreads > 2 * (os.cpu_count() or 4):
        vrlog.warning(
            "%d workers x %d ffmpeg threads will oversubscribe this machine"
            % (workers, context.settings.ffmpegThreads)
        )
    vrlog.info("using %d worker(s)" % workers)

    # Threads rather than processes: every unit of work is an ffmpeg call, so
    # the GIL is released for the whole of it.
    work = _detect_only if detect_only else process_scene
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
        layout, projection, detail = vrlayout.decide(scene, video_file, probe, context.settings)
        vrlog.info("%s: %s/%s (%s)" % (label, layout, projection, _describe(detail)))
        context.tally(layout if layout in ("sbs", "tb") else "mono")

        if not context.dry_run:
            record = context.store.load(digest)
            _remember(
                context, digest, scene, layout, projection,
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

    args = payload.get("args") or {}
    mode = args.get("mode") or "process"

    try:
        connection = payload.get("server_connection") or {}
        stash = vrstash.Stash(connection)
        # Ask the server what it supports before asking it anything else: the
        # generation settings differ between Stash releases and the plugin is
        # installed onto whichever one the user happens to run.
        schema = vrstash.get_schema(stash)
        config = vrstash.get_config(stash, schema)
        settings = vrstash.Settings((config.get("plugins") or {}).get(vrstash.PLUGIN_ID))
        vrlog.set_debug(settings.debugLog)

        vrmedia.resolve_binaries(config["general"], connection.get("Dir"))

        context = Context(
            stash, schema, config, settings,
            force=mode == "force",
            dry_run=mode == "dryrun",
        )

        if mode == "prune":
            output = prune(context)
        elif mode in ("process", "force", "dryrun", "detect"):
            output = run(context, args, detect_only=mode == "detect")
        else:
            raise RuntimeError("unknown mode %r" % mode)

        vrlog.info("done: %s" % json.dumps(output))
        print(json.dumps({"error": None, "output": output}))

    except Exception as exc:
        vrlog.debug(traceback.format_exc())
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
