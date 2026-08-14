"""GraphQL client and settings resolution.

Standard library only — the official stash image is alpine with no pip, so
anything beyond urllib would have to be vendored.
"""

import json
import ssl
import urllib.error
import urllib.request

import vrlog

PLUGIN_ID = "inzVrPreview"


class StashError(Exception):
    pass


class Stash:
    def __init__(self, connection):
        scheme = connection.get("Scheme") or "http"
        port = connection.get("Port") or 9999
        # Host is config.GetHost(), which is 0.0.0.0 on a default install and
        # not connectable. The plugin always runs on the server, so localhost
        # is both correct and cheaper than the real hostname.
        self.base = "%s://localhost:%s" % (scheme, port)
        self.endpoint = self.base + "/graphql"

        self.headers = {"Content-Type": "application/json"}
        cookie = connection.get("SessionCookie")
        if cookie and cookie.get("Value"):
            self.headers["Cookie"] = "%s=%s" % (
                cookie.get("Name") or "session",
                cookie["Value"],
            )

        self.ssl_context = None
        if scheme == "https":
            # Stash's own certificate is self-signed and issued for the
            # configured host, not for localhost.
            self.ssl_context = ssl.create_default_context()
            self.ssl_context.check_hostname = False
            self.ssl_context.verify_mode = ssl.CERT_NONE

    def call(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        request = urllib.request.Request(self.endpoint, data=body, headers=self.headers)
        try:
            with urllib.request.urlopen(request, context=self.ssl_context, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise StashError("graphql http %s: %s" % (exc.code, exc.read()[:400])) from exc
        except urllib.error.URLError as exc:
            raise StashError("cannot reach stash at %s: %s" % (self.endpoint, exc.reason)) from exc

        if payload.get("errors"):
            raise StashError("graphql: %s" % json.dumps(payload["errors"])[:400])
        return payload.get("data") or {}

    def fetch(self, path):
        """GET a path relative to the server root, returning raw bytes."""
        request = urllib.request.Request(self.base + path, headers=self.headers)
        with urllib.request.urlopen(request, context=self.ssl_context, timeout=120) as response:
            return response.read()


CONFIG_QUERY = """
query InzVrConfig {
  configuration {
    general {
      generatedPath
      ffmpegPath
      ffprobePath
      videoFileNamingAlgorithm
      parallelTasks
      previewPreset
      previewSegments
      previewSegmentDuration
      previewExcludeStart
      previewExcludeEnd
      previewAudio
      maxMarkerPreviewDuration
      defaultMarkerPreviewDuration
      spriteScreenshotSize
      useCustomSpriteInterval
      spriteInterval
      minimumSprites
      maximumSprites
      transcodeInputArgs
      transcodeOutputArgs
    }
    ui
    plugins(include: ["%s"])
  }
}
""" % PLUGIN_ID

TAG_QUERY = """
query InzVrTags($names: [String!]) {
  findTags(tag_filter: { name: { value_list: $names, modifier: EQUALS } },
           filter: { per_page: -1 }) {
    tags { id name }
  }
}
"""

SCENE_FRAGMENT = """
fragment InzVrScene on Scene {
  id
  title
  custom_fields
  files { path size mod_time width height duration frame_rate }
  paths { sprite }
  tags { id name }
  scene_markers { id seconds end_seconds }
}
"""

SCENES_QUERY = """
query InzVrScenes($include: [ID!], $exclude: [ID!], $page: Int!, $per: Int!) {
  findScenes(
    scene_filter: { tags: { value: $include, excludes: $exclude, modifier: INCLUDES, depth: -1 } }
    filter: { page: $page, per_page: $per, sort: "id", direction: ASC }
  ) {
    count
    scenes { ...InzVrScene }
  }
}
""" + SCENE_FRAGMENT

SCENES_BY_ID_QUERY = """
query InzVrScenesById($ids: [ID!]) {
  findScenes(ids: $ids, filter: { per_page: -1 }) {
    count
    scenes { ...InzVrScene }
  }
}
""" + SCENE_FRAGMENT

ALL_HASHES_QUERY = """
query InzVrAllHashes($page: Int!, $per: Int!) {
  findScenes(filter: { page: $page, per_page: $per, sort: "id", direction: ASC }) {
    count
    scenes { id paths { sprite } }
  }
}
"""

SCENE_UPDATE = """
mutation InzVrSceneUpdate($input: SceneUpdateInput!) {
  sceneUpdate(input: $input) { id }
}
"""


def get_config(stash):
    return stash.call(CONFIG_QUERY)["configuration"]


def resolve_tag_ids(stash, names):
    """Map tag names to ids, warning about names that match nothing."""
    names = [n for n in names if n]
    if not names:
        return []
    tags = stash.call(TAG_QUERY, {"names": names})["findTags"]["tags"]
    found = {tag["name"].casefold(): tag["id"] for tag in tags}
    ids = []
    for name in names:
        tag_id = found.get(name.casefold())
        if tag_id is None:
            vrlog.warning("tag %r does not exist, ignoring it" % name)
        else:
            ids.append(tag_id)
    return ids


def iter_scenes(stash, include_ids, exclude_ids, limit=0, per_page=100):
    """Page through the VR scenes, yielding (total_count, scene)."""
    page = 1
    seen = 0
    while True:
        result = stash.call(
            SCENES_QUERY,
            {"include": include_ids, "exclude": exclude_ids, "page": page, "per": per_page},
        )["findScenes"]
        total = result["count"]
        if limit > 0:
            total = min(total, limit)
        scenes = result["scenes"]
        if not scenes:
            return
        for scene in scenes:
            yield total, scene
            seen += 1
            if limit > 0 and seen >= limit:
                return
        page += 1


def scenes_by_id(stash, ids):
    result = stash.call(SCENES_BY_ID_QUERY, {"ids": ids})["findScenes"]
    return result["scenes"]


def iter_all_scene_paths(stash, per_page=500):
    """Every scene, with just enough to recover its generation hash."""
    page = 1
    while True:
        scenes = stash.call(ALL_HASHES_QUERY, {"page": page, "per": per_page})["findScenes"]["scenes"]
        if not scenes:
            return
        for scene in scenes:
            yield scene
        page += 1


# Stash has no concept of a default value for a plugin setting: an unset
# setting is simply absent, and the UI writes 0 / false / "" for a cleared
# one. So every default has to be expressible as "the falsy value means use
# the default", which is why the artifact toggles are phrased as skipX.
DEFAULTS = {
    "vrTagName": "",
    "extraTagNames": "",
    "excludeTagNames": "",
    "layoutDetection": "auto",
    "layoutSamples": 7,
    # Real stereo pairs land around 0.85-0.98; the threshold sits well below
    # that but high enough to reject self-similar 2D footage. Erring towards
    # mono is the safe direction: it leaves the scene alone, whereas a false
    # stereo verdict crops away half of a perfectly good 2D picture.
    "stereoThreshold": 0.75,
    "layoutMargin": 0.06,
    "useSecondEye": False,
    "dewarp": False,
    "dewarpHFov": 104.0,
    "dewarpAspect": 16.0 / 9.0,
    "defaultProjection": "auto",
    "skipPreview": False,
    "skipWebp": False,
    "skipSprite": False,
    "skipMarkers": False,
    "skipCover": False,
    "maxWorkers": 0,
    "ffmpegThreads": 4,
    "sceneLimit": 0,
    "debugLog": False,
}

_CHOICES = {
    "layoutDetection": ("auto", "filename", "content", "aspect"),
    "defaultProjection": ("auto", "hequirect", "equirect", "fisheye190", "fisheye200", "fisheye220"),
}


class Settings:
    """Plugin settings merged over the defaults.

    Settings are not delivered on stdin — buildPluginInput only merges a task's
    defaultArgs into args — so they have to be read back over GraphQL.
    """

    def __init__(self, raw):
        raw = raw or {}
        for key, default in DEFAULTS.items():
            value = raw.get(key)
            if isinstance(default, bool):
                value = bool(value)
            elif isinstance(default, str):
                value = (value or "").strip() or default
                choices = _CHOICES.get(key)
                if choices and value not in choices:
                    vrlog.warning(
                        "setting %s=%r is not one of %s, using %r"
                        % (key, value, "/".join(choices), default)
                    )
                    value = default
            else:
                try:
                    value = type(default)(value) if value else default
                except (TypeError, ValueError):
                    vrlog.warning("setting %s=%r is not a number, using %r" % (key, value, default))
                    value = default
                if value <= 0:
                    value = default
            setattr(self, key, value)

    def tag_names(self, ui_vr_tag):
        include = [n.strip() for n in self.extraTagNames.split(",")]
        include.insert(0, self.vrTagName or ui_vr_tag or "")
        return [n for n in include if n]

    def exclude_names(self):
        return [n.strip() for n in self.excludeTagNames.split(",") if n.strip()]

    def fingerprint(self):
        """Digest of the settings that change the generated bytes.

        A change here makes every artifact stale, which is how a settings
        tweak gets picked up without a forced run.
        """
        import hashlib

        keys = (
            "useSecondEye",
            "dewarp",
            "dewarpHFov",
            "dewarpAspect",
            "defaultProjection",
            "ffmpegThreads",
        )
        blob = json.dumps({k: getattr(self, k) for k in keys}, sort_keys=True)
        return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]
