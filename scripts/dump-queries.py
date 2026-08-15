"""Print every GraphQL document inzVrPreview can send, for one server's schema.

Two of the plugin's documents are composed at runtime from whichever fields the
server exposes, so they cannot be read out of the source — the plugin has to
build them. check-graphql.mjs pipes the server's field names in and validates
what comes back.

    echo '{"src": "...", "fields": {...}}' | python dump-queries.py
"""

import json
import sys

request = json.load(sys.stdin)
sys.path.insert(0, request["src"])

import vrstash  # noqa: E402  (only importable once src is on the path)

fields = request["fields"]
schema = vrstash.Schema(
    set(fields["ConfigGeneralResult"]),
    set(fields["Scene"]),
    set(fields["SceneMarker"]),
)

# Representative variables, so the check also covers input object shapes.
# validate() cannot see those: they arrive as variables, not in the query text.
COVER = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

documents = {
    "SCHEMA_QUERY": (vrstash.SCHEMA_QUERY, {}),
    "config_query": (schema.config_query, {}),
    "TAG_QUERY": (vrstash.TAG_QUERY, {"page": 1, "per": 1000}),
    "scenes_query": (schema.scenes_query,
                     {"include": ["10"], "exclude": ["11"],
                      "path": {"value": "/media/vr", "modifier": "INCLUDES"},
                      "page": 1, "per": 100}),
    "scenes_by_id_query": (schema.scenes_by_id_query, {"ids": ["1", "2"]}),
    "ALL_HASHES_QUERY": (vrstash.ALL_HASHES_QUERY, {"page": 1, "per": 500}),
    "SCENE_UPDATE": (vrstash.SCENE_UPDATE,
                     {"input": {"id": "1", "cover_image": COVER}}),
}

json.dump(
    {name: {"query": query, "variables": variables}
     for name, (query, variables) in documents.items()},
    sys.stdout,
)
