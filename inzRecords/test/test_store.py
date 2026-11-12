"""The record store: every op against a scratch database, and the stdin/stdout protocol."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
sys.path.insert(0, SRC)

import backend as store  # noqa: E402


def record(url, *downloads, **fields):
    return dict({"id": url, "downloads": list(downloads)}, **fields)


def video(name, saved=None, saved_at="2026-11-01T00:00:00Z"):
    d = {"slot": "video", "kind": "video", "xName": name, "sourceUrl": "https://cdn/" + name}
    if saved:
        d["savedName"] = saved
    if saved_at:
        d["savedAt"] = saved_at
    return d


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = store.connect(os.path.join(self.dir.name, "inzRecords", "records.sqlite"))

    def tearDown(self):
        self.db.close()
        self.dir.cleanup()

    def put(self, site, key, rec):
        return store.op_put(self.db, {"site": site, "key": key, "record": rec})

    def test_put_indexes_both_names(self):
        result = self.put("s", "k", record("https://s/v/1", video("A.mp4", saved="Renamed.mp4")))
        self.assertEqual(result["names"], 2)
        hits = store.op_lookup(self.db, {"names": ["a.MP4", "renamed.mp4", "none.mp4"]})["hits"]
        self.assertEqual(sorted(hits), ["a.mp4", "renamed.mp4"])
        self.assertEqual(hits["a.mp4"][0]["download"]["xName"], "A.mp4")

    def test_put_replaces_the_record_and_its_names(self):
        self.put("s", "k", record("https://s/v/1", video("old.mp4")))
        self.put("s", "k", record("https://s/v/1", video("new.mp4")))
        hits = store.op_lookup(self.db, {"names": ["old.mp4", "new.mp4"]})["hits"]
        self.assertEqual(list(hits), ["new.mp4"])
        self.assertEqual(store.op_stats(self.db, {}), {"records": 1, "sites": {"s": 1}})

    def test_lookup_orders_conflicts(self):
        self.put("t", "k2", record("https://t/2", video("same.mp4")))
        self.put("s", "k1", record("https://s/1", video("same.mp4")))
        hits = store.op_lookup(self.db, {"names": ["same.mp4"]})["hits"]["same.mp4"]
        self.assertEqual([(h["site"], h["key"]) for h in hits], [("s", "k1"), ("t", "k2")])

    def test_get(self):
        self.put("s", "k", record("https://s/v/1", title="T"))
        got = store.op_get(self.db, {"site": "s", "key": "k"})
        self.assertEqual(got["record"]["title"], "T")
        self.assertIsNone(store.op_get(self.db, {"site": "s", "key": "missing"}))

    def test_delete_records_and_site(self):
        self.put("s", "k1", record("https://s/1", video("one.mp4")))
        self.put("s", "k2", record("https://s/2", video("two.mp4")))
        self.put("t", "k3", record("https://t/3", video("three.mp4")))

        deleted = store.op_delete(self.db, {"records": [{"site": "s", "key": "k1"}, {"site": "s", "key": "gone"}]})
        self.assertEqual(deleted, {"deleted": 1})
        self.assertEqual(store.op_lookup(self.db, {"names": ["one.mp4"]})["hits"], {})

        self.assertEqual(store.op_delete(self.db, {"site": "s"}), {"deleted": 1})
        self.assertEqual(store.op_stats(self.db, {}), {"records": 1, "sites": {"t": 1}})
        names = self.db.execute("SELECT name FROM names").fetchall()
        self.assertEqual(names, [("three.mp4",)])

    def test_delete_needs_a_target(self):
        with self.assertRaises(ValueError):
            store.op_delete(self.db, {})

    def test_summary_lists_saved_files_and_the_last_record(self):
        self.put("s", "k1", record("https://s/1", video("one.mp4"), video("link.mp4", saved_at=None),
                                   title="One", studio="St", date="2026-01-01"))
        self.put("s", "k2", record("https://s/2", video("two.mp4", saved="Two.mp4")))
        summary = store.op_summary(self.db, {})
        first, second = summary["records"]
        self.assertEqual(first["files"], [{"name": "one.mp4", "kind": "video"}])
        self.assertEqual((first["title"], first["studio"], first["date"]), ("One", "St", "2026-01-01"))
        self.assertEqual(second["files"], [{"name": "Two.mp4", "kind": "video"}])
        self.assertEqual(summary["last"]["key"], "k2")

    def test_put_validates(self):
        with self.assertRaises(ValueError):
            store.op_put(self.db, {"site": "", "key": "k", "record": {}})
        with self.assertRaises(ValueError):
            store.op_put(self.db, {"site": "s", "key": "k", "record": []})


class ProtocolTest(unittest.TestCase):
    """One process per call, as Stash runs it"""

    def call(self, directory, args):
        payload = {"server_connection": {"Dir": directory}, "args": args}
        out = subprocess.run(
            [sys.executable, os.path.join(SRC, "backend.py")],
            input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8", check=True,
        )
        return json.loads(out.stdout)

    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            rec = record("https://s/1", video("Ünï.mp4"), title="Ünïcode")
            self.assertIsNone(self.call(directory, {"op": "put", "site": "s", "key": "k", "record": rec})["error"])
            hits = self.call(directory, {"op": "lookup", "names": ["ünï.mp4"]})["output"]["hits"]
            self.assertEqual(hits["ünï.mp4"][0]["record"]["title"], "Ünïcode")
            self.assertTrue(os.path.exists(os.path.join(directory, "inzRecords", "records.sqlite")))

    def test_errors_are_answered(self):
        with tempfile.TemporaryDirectory() as directory:
            answer = self.call(directory, {"op": "nope"})
            self.assertIn("unknown op", answer["error"])
            self.assertNotIn("output", answer)


if __name__ == "__main__":
    unittest.main()
