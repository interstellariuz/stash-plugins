"""GraphQL client and server configuration.

Standard library only -- the official stash image is alpine with no pip, so
anything beyond urllib would have to be vendored.
"""

import json
import ssl
import urllib.error
import urllib.request

import vrlog

PLUGIN_ID = "inzVrGenerate"

# Threads per ffmpeg process. Stash hardcodes 4 in pkg/scene/generate, and there
# is no reason to disagree with it.
FFMPEG_THREADS = 4

# Hosts stash reports when it is listening on every interface. Connecting to
# these is either meaningless or, on Windows, outright refused.
_WILDCARD_HOSTS = ("", "0.0.0.0", "::", "[::]", "*")

# Seconds to wait on an address that has not proved itself, and on one that has.
PROBE_TIMEOUT = 5
CALL_TIMEOUT = 60


class StashError(Exception):
    pass


class Stash:
    def __init__(self, connection):
        scheme = connection.get("Scheme") or "http"
        port = connection.get("Port") or 9999

        # Host is config.GetHost(), which is 0.0.0.0 on a default install -- a
        # bind address, not somewhere to connect. The plugin runs on the server,
        # so loopback is the answer there. But an install bound to one specific
        # interface is not listening on loopback at all, so a configured host has
        # to be tried first and kept if it answers.
        #
        # 127.0.0.1 ahead of "localhost" on purpose. Where localhost resolves to
        # ::1 first -- the default on Windows and on a good many Linux setups --
        # and stash is bound to 0.0.0.0, every request pays a full connect
        # timeout before falling back to IPv4, on every one of the hundreds of
        # calls a run makes.
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
            self.headers["Cookie"] = "%s=%s" % (cookie.get("Name") or "session", cookie["Value"])

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
            # quickly: a configured host that has gone away would otherwise burn
            # the full timeout at the start of every run. Once one has answered
            # it is the only candidate left and gets the long timeout, which the
            # heavier queries need.
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
}
"""

# Everything the plugin would like to know about the server's generation
# settings. Stash gains and renames these between releases and the plugin is
# installed from an index onto whatever version someone happens to run, so the
# query is assembled from whichever of them the server actually has and the rest
# fall back to the documented defaults.
WANTED_CONFIG_FIELDS = (
    "generatedPath",
    "ffmpegPath",
    "ffprobePath",
    "parallelTasks",
    "previewPreset",
    "previewSegments",
    "previewSegmentDuration",
    "previewExcludeStart",
    "previewExcludeEnd",
    "previewAudio",
    "spriteScreenshotSize",
    "useCustomSpriteInterval",
    "spriteInterval",
    "minimumSprites",
    "maximumSprites",
    "transcodeInputArgs",
    "transcodeOutputArgs",
)

SCENE_FRAGMENT = """
fragment InzVrScene on Scene {
  id
  title
  files { path }
  paths { sprite }
}
"""

SCENES_BY_ID = """
query InzVrScenesById($ids: [ID!]) {
  findScenes(ids: $ids, filter: { per_page: -1 }) { scenes { ...InzVrScene } }
}
""" + SCENE_FRAGMENT

# One query serves both "everything" and "under this folder": an unset path
# criterion is simply not applied.
SCENES_PAGE = """
query InzVrScenes($path: StringCriterionInput, $page: Int!, $per: Int!) {
  findScenes(
    scene_filter: { path: $path }
    filter: { page: $page, per_page: $per, sort: "id", direction: ASC }
  ) { scenes { ...InzVrScene } }
}
""" + SCENE_FRAGMENT

SCENE_UPDATE = """
mutation InzVrSceneUpdate($input: SceneUpdateInput!) {
  sceneUpdate(input: $input) { id }
}
"""


def config_query(fields):
    """The config query for a server exposing exactly `fields`.

    Stash gains and renames generation settings between releases and returns
    HTTP 422 for a field it does not have -- which surfaces as a plugin-wide
    failure rather than one missing value -- so nothing is selected off
    ConfigGeneralResult before the type has been introspected.
    """
    if "generatedPath" not in fields:
        raise StashError(
            "this stash does not expose generatedPath -- it is too old for this plugin"
        )
    selection = [f for f in WANTED_CONFIG_FIELDS if f in fields]
    skipped = [f for f in WANTED_CONFIG_FIELDS if f not in fields]
    if skipped:
        vrlog.debug("this stash has no %s, using the defaults for them" % ", ".join(skipped))
    return "query InzVrConfig { configuration { general { %s } } }" % "\n      ".join(selection)


def get_config(stash):
    """The server's generation settings."""
    fields = {
        field["name"]
        for field in ((stash.call(SCHEMA_QUERY).get("cfg") or {}).get("fields") or [])
    }
    return stash.call(config_query(fields))["configuration"]["general"]


def scenes_by_id(stash, ids):
    return stash.call(SCENES_BY_ID, {"ids": ids})["findScenes"]["scenes"]


def iter_scenes(stash, path=None, per_page=100):
    """Page through every scene, or every scene whose path contains `path`.

    The value is wrapped in quotes because an unquoted path criterion is split
    on whitespace and the words are OR'd together -- getPathSearchClauseMany,
    "used for backwards compatibility for the includes/excludes modifiers". A
    folder called `D:\\My Videos` would otherwise match every scene with "my" or
    "videos" anywhere in its path, which is most of a library. Trimming the
    quotes back off and matching the remainder as one phrase is that function's
    own escape hatch, and behaves the same on every release the plugin supports.

    Even quoted this is a substring of the whole path rather than a parent
    directory, so `/videos` still brings back `/videos.old`; the caller checks
    what comes back.
    """
    criterion = {"value": '"%s"' % path, "modifier": "INCLUDES"} if path else None
    page = 1
    while True:
        scenes = stash.call(
            SCENES_PAGE, {"path": criterion, "page": page, "per": per_page}
        )["findScenes"]["scenes"]
        if not scenes:
            return
        for scene in scenes:
            yield scene
        page += 1


def set_cover(stash, scene_id, data_url):
    stash.call(SCENE_UPDATE, {"input": {"id": scene_id, "cover_image": data_url}})
