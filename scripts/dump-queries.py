"""Print every GraphQL document inzVrGenerate can send, for one server's schema.

The config query is composed at runtime from whichever fields the server
exposes, so it cannot be read out of the source -- the plugin has to build it.
check-graphql.mjs pipes the server's field names in and validates what comes back.

    echo '{"src": "...", "fields": {...}}' | python dump-queries.py
"""

import json
import sys

request = json.load(sys.stdin)
sys.path.insert(0, request["src"])

import vrstash  # noqa: E402  (only importable once src is on the path)

fields = request["fields"]

# Representative variables, so the check also covers input object shapes.
# validate() cannot see those: they arrive as variables, not in the query text.
COVER = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

documents = {
    "SCHEMA_QUERY": (vrstash.SCHEMA_QUERY, {}),
    "config_query": (vrstash.config_query(set(fields["ConfigGeneralResult"])), {}),
    "SCENES_BY_ID": (vrstash.SCENES_BY_ID, {"ids": ["1", "2"]}),
    "SCENES_PAGE": (vrstash.SCENES_PAGE,
                    {"path": {"value": "/media/vr", "modifier": "INCLUDES"},
                     "page": 1, "per": 100}),
    "SCENE_UPDATE": (vrstash.SCENE_UPDATE,
                     {"input": {"id": "1", "cover_image": COVER}}),
}

json.dump(
    {name: {"query": query, "variables": variables}
     for name, (query, variables) in documents.items()},
    sys.stdout,
)
