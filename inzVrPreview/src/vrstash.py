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


# Hosts stash reports when it is listening on every interface. Connecting to
# these is either meaningless or, on Windows, outright refused.
_WILDCARD_HOSTS = ("", "0.0.0.0", "::", "[::]", "*")

# Seconds to wait on an address that has not proved itself, and on one that has.
PROBE_TIMEOUT = 5
CALL_TIMEOUT = 60


class Stash:
    def __init__(self, connection):
        scheme = connection.get("Scheme") or "http"
        port = connection.get("Port") or 9999

        # Host is config.GetHost(), which is 0.0.0.0 on a default install — a
        # bind address, not somewhere to connect. The plugin runs on the
        # server, so loopback is the answer there. But an install bound to one
        # specific interface is not listening on loopback at all, so a
        # configured host has to be tried first and kept if it answers.
        #
        # 127.0.0.1 ahead of "localhost" on purpose. Where localhost resolves
        # to ::1 first — the default on Windows and on a good many Linux
        # setups — and stash is bound to 0.0.0.0, every request pays a full
        # connect timeout before falling back to IPv4. Measured at two seconds
        # each, on every call, which a run makes hundreds of.
        host = str(connection.get("Host") or "").strip()
        candidates = [] if host.lower() in _WILDCARD_HOSTS else [host]
        candidates += ["127.0.0.1", "localhost", "[::1]"]

        self._endpoints = []
        for candidate in candidates:
            endpoint = "%s://%s:%s/graphql" % (scheme, candidate, port)
            if endpoint not in self._endpoints:
                self._endpoints.append(endpoint)
        self.endpoint = self._endpoints[0]

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
        payload = self._post(body)
        if payload.get("errors"):
            raise StashError("graphql: %s" % json.dumps(payload["errors"])[:400])
        return payload.get("data") or {}

    def _post(self, body):
        """POST to the endpoint, moving on to the next host if it is not there.

        Only connection failures fall through. An HTTP error means we found
        stash and it disagreed with us, which no other address will fix.
        """
        unreachable = []
        while True:
            request = urllib.request.Request(self.endpoint, data=body, headers=self.headers)
            # While there is somewhere else to try, give up on an address
            # quickly: a configured host that has gone away would otherwise
            # burn the full timeout at the start of every run. Once one has
            # answered it is the only candidate left and gets the long timeout,
            # which the heavier queries need.
            timeout = PROBE_TIMEOUT if len(self._endpoints) > 1 else CALL_TIMEOUT
            try:
                with urllib.request.urlopen(
                    request, context=self.ssl_context, timeout=timeout
                ) as response:
                    self._endpoints = [self.endpoint]  # it answered; stop looking
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                raise StashError("graphql http %s: %s" % (exc.code, exc.read()[:400])) from exc
            except urllib.error.URLError as exc:
                unreachable.append("%s (%s)" % (self.endpoint, exc.reason))
                self._endpoints.pop(0)
                if not self._endpoints:
                    raise StashError("cannot reach stash at %s" % ", ".join(unreachable)) from exc
                self.endpoint = self._endpoints[0]
                vrlog.debug("%s did not answer, trying %s" % (unreachable[-1], self.endpoint))


SCHEMA_QUERY = """
query InzVrSchema {
  cfg: __type(name: "ConfigGeneralResult") { fields { name } }
  scene: __type(name: "Scene") { fields { name } }
  marker: __type(name: "SceneMarker") { fields { name } }
}
"""

# Everything the plugin would like to know about the server's generation
# settings. Stash gains and renames these between releases and the plugin is
# installed from an index onto whatever version someone happens to run, so the
# query is assembled from whichever of them the server actually has and the
# rest fall back to the documented defaults.
WANTED_CONFIG_FIELDS = (
    "generatedPath",
    "ffmpegPath",
    "ffprobePath",
    "videoFileNamingAlgorithm",
    "parallelTasks",
    "previewPreset",
    "previewSegments",
    "previewSegmentDuration",
    "previewExcludeStart",
    "previewExcludeEnd",
    "previewAudio",
    "maxMarkerPreviewDuration",
    "defaultMarkerPreviewDuration",
    "spriteScreenshotSize",
    "useCustomSpriteInterval",
    "spriteInterval",
    "minimumSprites",
    "maximumSprites",
    "transcodeInputArgs",
    "transcodeOutputArgs",
)

# Without generatedPath there is nowhere to write, so that one is not optional.
REQUIRED_CONFIG_FIELDS = ("generatedPath",)


class Schema:
    """Which optional fields this particular Stash understands."""

    def __init__(self, config_fields, scene_fields, marker_fields):
        self.config_fields = config_fields
        self.scene_fields = scene_fields
        self.marker_fields = marker_fields

        missing = [f for f in REQUIRED_CONFIG_FIELDS if f not in config_fields]
        if missing:
            raise StashError(
                "this stash does not expose %s — it is too old for this plugin"
                % ", ".join(missing)
            )

        self.config_selection = [f for f in WANTED_CONFIG_FIELDS if f in config_fields]
        skipped = [f for f in WANTED_CONFIG_FIELDS if f not in config_fields]
        if skipped:
            vrlog.debug(
                "this stash has no %s, using the defaults for them" % ", ".join(skipped)
            )

        self.has_custom_fields = "custom_fields" in scene_fields
        self.has_marker_end = "end_seconds" in marker_fields

    @property
    def config_query(self):
        return """
query InzVrConfig {
  configuration {
    general { %s }
    ui
    plugins(include: ["%s"])
  }
}
""" % ("\n      ".join(self.config_selection), PLUGIN_ID)

    @property
    def scene_fragment(self):
        optional = []
        if self.has_custom_fields:
            optional.append("custom_fields")
        marker_fields = "id seconds end_seconds" if self.has_marker_end else "id seconds"
        return """
fragment InzVrScene on Scene {
  id
  title
  %s
  files { path size mod_time width height duration frame_rate }
  paths { sprite }
  tags { id name }
  scene_markers { %s }
}
""" % ("\n  ".join(optional), marker_fields)

    @property
    def scenes_query(self):
        return SCENES_QUERY_BODY + self.scene_fragment

    @property
    def scenes_by_id_query(self):
        return SCENES_BY_ID_BODY + self.scene_fragment


def get_schema(stash):
    data = stash.call(SCHEMA_QUERY)

    def names(key):
        node = data.get(key) or {}
        return {field["name"] for field in (node.get("fields") or [])}

    return Schema(names("cfg"), names("scene"), names("marker"))

# StringCriterionInput only carries a single `value`, so there is no way to ask
# for several names at once. Rather than one round trip per name, fetch the tag
# list and match here — it is id and name only, and it lets the match be
# case-insensitive, which an EQUALS criterion is not.
TAG_QUERY = """
query InzVrTags($page: Int!, $per: Int!) {
  findTags(filter: { page: $page, per_page: $per, sort: "id", direction: ASC }) {
    tags { id name }
  }
}
"""

SCENES_QUERY_BODY = """
query InzVrScenes($include: [ID!], $exclude: [ID!], $page: Int!, $per: Int!) {
  findScenes(
    scene_filter: { tags: { value: $include, excludes: $exclude, modifier: INCLUDES, depth: -1 } }
    filter: { page: $page, per_page: $per, sort: "id", direction: ASC }
  ) {
    scenes { ...InzVrScene }
  }
}
"""

SCENES_BY_ID_BODY = """
query InzVrScenesById($ids: [ID!]) {
  findScenes(ids: $ids, filter: { per_page: -1 }) {
    scenes { ...InzVrScene }
  }
}
"""

ALL_HASHES_QUERY = """
query InzVrAllHashes($page: Int!, $per: Int!) {
  findScenes(filter: { page: $page, per_page: $per, sort: "id", direction: ASC }) {
    scenes { id paths { sprite } }
  }
}
"""

SCENE_UPDATE = """
mutation InzVrSceneUpdate($input: SceneUpdateInput!) {
  sceneUpdate(input: $input) { id }
}
"""


def get_config(stash, schema):
    return stash.call(schema.config_query)["configuration"]


def resolve_tag_ids(stash, names, per_page=1000):
    """Map tag names to ids, warning about names that match nothing."""
    names = [n for n in names if n]
    if not names:
        return []

    found = {}
    page = 1
    while True:
        tags = stash.call(TAG_QUERY, {"page": page, "per": per_page})["findTags"]["tags"]
        if not tags:
            break
        for tag in tags:
            found.setdefault(tag["name"].casefold(), tag["id"])
        page += 1

    ids = []
    for name in names:
        tag_id = found.get(name.casefold())
        if tag_id is None:
            vrlog.warning("tag %r does not exist, ignoring it" % name)
        else:
            ids.append(tag_id)
    return ids


def iter_scenes(stash, schema, include_ids, exclude_ids, limit=0, per_page=100):
    """Page through the VR scenes."""
    page = 1
    seen = 0
    while True:
        scenes = stash.call(
            schema.scenes_query,
            {"include": include_ids, "exclude": exclude_ids, "page": page, "per": per_page},
        )["findScenes"]["scenes"]
        if not scenes:
            return
        for scene in scenes:
            yield scene
            seen += 1
            if limit > 0 and seen >= limit:
                return
        page += 1


def scenes_by_id(stash, schema, ids):
    result = stash.call(schema.scenes_by_id_query, {"ids": ids})["findScenes"]
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
#
# NUMBER is whole numbers only. Stash's NumberSetting field runs the typed
# value through Number.parseInt, so "0.75" reaches the plugin as 0 and
# "1.7778" as 1 — a fraction cannot survive the round trip. Settings that need
# one are declared STRING in the manifest and parsed here; _FRACTIONS lists
# them, since the type of the default no longer says so.
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
    "stereoThreshold": "0.75",
    "layoutMargin": "0.06",
    "useSecondEye": False,
    "dewarp": False,
    "dewarpHFov": 104,
    "dewarpAspect": "16:9",
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

# key -> (low, high) the parsed fraction has to land in.
_FRACTIONS = {
    "stereoThreshold": (0.0, 1.0),
    "layoutMargin": (0.0, 1.0),
    "dewarpAspect": (0.1, 10.0),
}


def parse_ratio(text):
    """A fraction written as "0.75", "16:9" or "16/9". None if it is neither."""
    text = str(text).strip()
    for separator in (":", "/"):
        if separator in text:
            left, _, right = text.partition(separator)
            try:
                numerator, denominator = float(left), float(right)
            except ValueError:
                return None
            return numerator / denominator if denominator else None
    try:
        return float(text)
    except ValueError:
        return None


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
            elif key in _FRACTIONS:
                value = self._fraction(key, value, default)
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

    @staticmethod
    def _fraction(key, value, default):
        low, high = _FRACTIONS[key]
        fallback = parse_ratio(default)
        text = str(value or "").strip()
        if not text:
            return fallback

        parsed = parse_ratio(text)
        if parsed is None:
            vrlog.warning("setting %s=%r is not a number, using %s" % (key, value, default))
            return fallback
        if not low < parsed <= high:
            vrlog.warning(
                "setting %s=%s is outside %g-%g, using %s" % (key, text, low, high, default)
            )
            return fallback
        return parsed

    def tag_names(self, ui_vr_tag):
        include = [n.strip() for n in self.extraTagNames.split(",")]
        include.insert(0, self.vrTagName or ui_vr_tag or "")
        return [n for n in include if n]

    def exclude_names(self):
        return [n.strip() for n in self.excludeTagNames.split(",") if n.strip()]

    # Two fingerprints, because the two halves of the work go stale
    # independently. Retuning a detection threshold should re-examine the
    # picture without re-encoding scenes whose verdict did not move; changing
    # the geometry should re-encode without re-probing.
    _RENDER_KEYS = (
        "useSecondEye",
        "dewarp",
        "dewarpHFov",
        "dewarpAspect",
        "defaultProjection",
        "ffmpegThreads",
    )
    _DETECT_KEYS = (
        "layoutDetection",
        "layoutSamples",
        "stereoThreshold",
        "layoutMargin",
        "defaultProjection",
    )

    def _digest(self, keys):
        import hashlib

        blob = json.dumps({k: getattr(self, k) for k in keys}, sort_keys=True)
        return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]

    def render_fingerprint(self):
        """Digest of the settings that change the generated bytes."""
        return self._digest(self._RENDER_KEYS)

    def detect_fingerprint(self):
        """Digest of the settings that change which layout a scene is given."""
        return self._digest(self._DETECT_KEYS)
