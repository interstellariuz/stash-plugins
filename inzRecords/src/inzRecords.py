"""Stash plugin backend: the store of download records the site userscripts push.

Called through runPluginOperation; args.op picks the operation:

    put      {site, key, record}  upsert one record and re-index its file names
    lookup   {names: [...]}       every record that has a file of that name
    get      {site, key}          one record, or null
    delete   {records: [{site, key}]} or {site}
                                  drop records with their file names
    stats    {}                   record counts per site
    summary  {}                   per-record digest for the records page

The UI does the matching and the editing; this side only stores and finds.
Reads JSON on stdin, answers JSON on stdout, logs on stderr.
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    site       TEXT NOT NULL,
    key        TEXT NOT NULL,
    record     TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (site, key)
);
CREATE TABLE IF NOT EXISTS names (
    name TEXT NOT NULL,
    site TEXT NOT NULL,
    key  TEXT NOT NULL,
    slot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS names_by_name ON names (name);
CREATE INDEX IF NOT EXISTS names_by_record ON names (site, key);
"""

# SQLite builds before 3.32 cap bound parameters at 999
CHUNK = 500


def log(level, message):
    """Stash's level prefix: SOH, level char, STX."""
    try:
        print("\x01%s\x02%s" % (level, message), file=sys.stderr, flush=True)
    except Exception:
        pass


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def db_path(connection):
    # Outside the plugin directory: reinstalling the plugin wipes that one
    base = connection.get("Dir")
    if not base:
        raise RuntimeError("server_connection.Dir is missing; cannot place the record store")
    return os.path.join(base, "inzRecords", "records.sqlite")


def connect(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    # Several pushes can land at once, each in its own process
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    return db


def disk_name(download):
    """The name the file landed under: savedName when the panel changed it."""
    return download.get("savedName") or download.get("xName") or ""


def file_names(record):
    """(lower-case name, slot) for every name a file of this record may carry.

    Both names are indexed: xName is what an untouched download is called, and
    savedName what a hand-edited one landed under.
    """
    seen = set()
    for download in record.get("downloads") or []:
        if not isinstance(download, dict):
            continue
        slot = str(download.get("slot") or "")
        for name in (download.get("xName"), download.get("savedName")):
            if isinstance(name, str) and name:
                pair = (name.lower(), slot)
                if pair not in seen:
                    seen.add(pair)
                    yield pair


def need_str(args, key):
    value = args.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError("%s must be a non-empty string" % key)
    return value


def op_put(db, args):
    site = need_str(args, "site")
    key = need_str(args, "key")
    record = args.get("record")
    if not isinstance(record, dict):
        raise ValueError("record must be an object")

    names = list(file_names(record))
    with db:
        db.execute(
            "INSERT INTO records (site, key, record, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (site, key) DO UPDATE SET record = excluded.record, "
            "updated_at = excluded.updated_at",
            (site, key, json.dumps(record, ensure_ascii=False), now()),
        )
        db.execute("DELETE FROM names WHERE site = ? AND key = ?", (site, key))
        db.executemany(
            "INSERT INTO names (name, site, key, slot) VALUES (?, ?, ?, ?)",
            [(name, site, key, slot) for name, slot in names],
        )

    log("d", "stored %s %s (%d file names)" % (site, key, len(names)))
    return {"site": site, "key": key, "names": len(names)}


def op_lookup(db, args):
    names = args.get("names")
    if not isinstance(names, list):
        raise ValueError("names must be a list")
    wanted = sorted({str(n).lower() for n in names if isinstance(n, str) and n})

    hits = {}
    for i in range(0, len(wanted), CHUNK):
        chunk = wanted[i:i + CHUNK]
        rows = db.execute(
            "SELECT DISTINCT names.name, records.site, records.key, records.record, "
            "records.updated_at FROM names JOIN records "
            "ON records.site = names.site AND records.key = names.key "
            "WHERE names.name IN (%s)" % ",".join("?" * len(chunk)),
            chunk,
        ).fetchall()
        for name, site, key, raw, updated_at in rows:
            record = json.loads(raw)
            download = next(
                (d for d in record.get("downloads") or []
                 if isinstance(d, dict) and name in (
                     str(d.get("xName") or "").lower(), str(d.get("savedName") or "").lower())),
                None,
            )
            hits.setdefault(name, []).append({
                "site": site,
                "key": key,
                "record": record,
                "download": download,
                "updatedAt": updated_at,
            })

    # Stable order, so a conflict lists its records the same way every time
    for found in hits.values():
        found.sort(key=lambda h: (h["site"], h["key"]))
    return {"hits": hits}


def op_get(db, args):
    site = need_str(args, "site")
    key = need_str(args, "key")
    row = db.execute(
        "SELECT record, updated_at FROM records WHERE site = ? AND key = ?", (site, key)
    ).fetchone()
    if row is None:
        return None
    return {"site": site, "key": key, "record": json.loads(row[0]), "updatedAt": row[1]}


def op_delete(db, args):
    if args.get("site") is not None:
        site = need_str(args, "site")
        with db:
            db.execute("DELETE FROM names WHERE site = ?", (site,))
            deleted = db.execute("DELETE FROM records WHERE site = ?", (site,)).rowcount
        log("i", "deleted %d records of %s" % (deleted, site))
        return {"deleted": deleted}

    items = args.get("records")
    if not isinstance(items, list):
        raise ValueError("records must be a list of {site, key}, or site a string")
    pairs = [(need_str(i, "site"), need_str(i, "key")) for i in items if isinstance(i, dict)]
    deleted = 0
    with db:
        for site, key in pairs:
            db.execute("DELETE FROM names WHERE site = ? AND key = ?", (site, key))
            deleted += db.execute(
                "DELETE FROM records WHERE site = ? AND key = ?", (site, key)).rowcount
    log("i", "deleted %d records" % deleted)
    return {"deleted": deleted}


def op_stats(db, _args):
    sites = dict(db.execute("SELECT site, COUNT(*) FROM records GROUP BY site ORDER BY site"))
    return {"records": sum(sites.values()), "sites": sites}


def op_summary(db, _args):
    records = []
    last = None
    for site, key, raw, updated_at in db.execute(
            "SELECT site, key, record, updated_at FROM records ORDER BY site, key"):
        record = json.loads(raw)
        files = [
            {"name": disk_name(d), "kind": d.get("kind") or ""}
            for d in record.get("downloads") or []
            if isinstance(d, dict) and d.get("savedAt") and disk_name(d)
        ]
        entry = {
            "site": site,
            "key": key,
            "title": record.get("title") or "",
            "url": record.get("id") or key,
            "date": record.get("date") or "",
            "studio": record.get("studio") or "",
            "updatedAt": updated_at,
            "files": files,
        }
        records.append(entry)
        if last is None or updated_at > last["updatedAt"]:
            last = {k: entry[k] for k in ("site", "key", "title", "updatedAt")}
    return {"records": records, "last": last}


OPS = {
    "put": op_put,
    "lookup": op_lookup,
    "get": op_get,
    "delete": op_delete,
    "stats": op_stats,
    "summary": op_summary,
}


def main():
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass

    try:
        payload = json.loads(sys.stdin.read() or "{}")
        args = payload.get("args") or {}
        op = OPS.get(args.get("op"))
        if op is None:
            raise ValueError("unknown op %r; expected one of %s" % (args.get("op"), ", ".join(OPS)))

        db = connect(db_path(payload.get("server_connection") or {}))
        try:
            output = op(db, args)
        finally:
            db.close()
        print(json.dumps({"error": None, "output": output}, ensure_ascii=False))
    except Exception as exc:
        log("e", "inzRecords: %s" % exc)
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
