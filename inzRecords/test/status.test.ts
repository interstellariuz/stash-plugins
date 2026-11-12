import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatus, entitiesOf, summaryNames, type NamedEntity, type Summary } from "../src/status";

const summary: Summary = {
  records: [
    {
      site: "s",
      key: "k1",
      title: "One",
      url: "https://s/v/1",
      updatedAt: "2026-11-01T00:00:00Z",
      files: [
        { name: "one.mp4", kind: "video" },
        { name: "one.zip", kind: "photo" },
      ],
    },
    {
      site: "s",
      key: "k2",
      title: "Two",
      url: "https://s/v/2",
      updatedAt: "2026-11-02T00:00:00Z",
      files: [{ name: "two.mp4", kind: "video" }],
    },
    {
      site: "t",
      key: "k3",
      title: "Three",
      url: "https://t/v/3",
      updatedAt: "2026-11-03T00:00:00Z",
      files: [{ name: "three.mp4", kind: "video" }],
    },
    {
      site: "t",
      key: "k4",
      title: "Four",
      url: "https://t/v/4?x=1",
      updatedAt: "2026-11-04T00:00:00Z",
      files: [{ name: "four.mp4", kind: "video" }],
    },
  ],
  last: { site: "t", key: "k4", title: "Four", updatedAt: "2026-11-04T00:00:00Z" },
};

const inStash = new Map<string, NamedEntity[]>([
  ["one.mp4", [{ kind: "scene", id: "10", urls: ["https://s/v/1"] }]],
  ["one.zip", [{ kind: "gallery", id: "20", urls: [] }]],
  ["two.mp4", [{ kind: "scene", id: "11", urls: [] }]],
  // the page URL keeps the query
  ["four.mp4", [{ kind: "scene", id: "12", urls: ["https://t/v/4?x=1"] }]],
]);

test("summaryNames: every file name once, lower case", () => {
  assert.deepEqual(summaryNames({ records: [{ ...summary.records![0], files: [{ name: "A.mp4", kind: "video" }, { name: "a.mp4", kind: "video" }] }] }), ["a.mp4"]);
});

test("buildStatus: states, counts, sites", () => {
  const status = buildStatus(summary, inStash, 5);
  assert.deepEqual(
    status.records.map((r) => [r.key, r.state]),
    [
      ["k1", "ready"],
      ["k2", "ready"],
      ["k3", "missing"],
      ["k4", "imported"],
    ]
  );
  assert.deepEqual(status.counts, { missing: 1, ready: 2, imported: 1 });
  assert.deepEqual(status.bySite, [
    { site: "s", records: 2, missing: 0, ready: 2, imported: 0 },
    { site: "t", records: 2, missing: 1, ready: 0, imported: 1 },
  ]);
  assert.equal(status.files, 5);
  assert.equal(status.sites, 2);
  assert.equal(status.checkedAt, 5);
  assert.equal(status.last?.key, "k4");
  assert.ok(status.records[0].haystack.includes("one.zip"));
});

test("entitiesOf: ready ones only, or all", () => {
  const { records } = buildStatus(summary, inStash);
  assert.deepEqual(entitiesOf(records, false), { scenes: ["11"], galleries: ["20"] });
  assert.deepEqual(entitiesOf(records, true), { scenes: ["10", "11", "12"], galleries: ["20"] });
});
