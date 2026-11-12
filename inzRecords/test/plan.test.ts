import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildDictionaries,
  buildJobs,
  buildPlans,
  collectMisses,
  emptyUiState,
  nodeStatus,
  parseSettings,
  recordPath,
  resolveNodes,
  toEntity,
  type Base,
  type Entity,
  type PlanNode,
  type UiState,
} from "../src/plan";
import type { CatalogRecord } from "../src/records";

const dicts = buildDictionaries({
  studios: [{ id: "s1", name: "Studio A" }],
  tags: [
    { id: "t1", name: "Red" },
    { id: "t2", name: "Blue" },
  ],
  performers: [{ id: "p1", name: "Ann" }],
});
const label = (field: string) => field;
const on = { source: true };

const entity: Entity = toEntity("scene", {
  id: 1,
  details: "old",
  tags: [{ id: "t1", name: "Red" }],
  files: [{ basename: "a.mp4" }],
});

const record: CatalogRecord = {
  id: "https://site.com/v/abc",
  title: "Rec title",
  studio: "Studio A",
  tags: ["Red", "Blue"],
  performers: [{ name: "Ann" }, { name: "Bob" }],
  downloads: [
    { slot: "v", group: "video", kind: "video", xName: "a.mp4", sourceUrl: "https://cdn/a.mp4", savedAt: "x" },
    { slot: "p", group: "photos", kind: "photo", xName: "a.zip", sourceUrl: "https://cdn/a.zip", savedAt: "x" },
  ],
};

const entry = { site: "s", key: "k", url: record.id, record, download: record.downloads[0] };
const node: PlanNode = { entity, candidates: [], entry, related: [] };

const st = (o: Partial<UiState> = {}): UiState => ({ ...emptyUiState(), ...o });
const edits = (pairs: [string, string][]) => new Map(pairs.map(([k, v]) => [`scene:1|${k}`, v]));
const checks = (pairs: [string, boolean][]) => new Map(pairs.map(([k, v]) => [`scene:1|${k}`, v]));

describe("buildPlans", () => {
  test("every editable row, then what the record adds", () => {
    const rows = buildPlans([node], dicts, label, on).get("scene:1")!.rows;
    assert.deepEqual(
      rows.map((r) => [r.field, r.proposed]),
      [
        ["title", true],
        ["code", true],
        ["date", false],
        ["details", false],
        ["urls", true],
        ["studio_id", true],
        ["performer_ids", true],
        ["tag_ids", true],
        ["custom_fields", true],
      ]
    );
  });

  test("an unknown performer is skipped, not created", () => {
    const plan = buildPlans([node], dicts, label, on).get("scene:1")!;
    assert.deepEqual(plan.skipped, [{ kind: "performers", name: "Bob", status: "missing" }]);
  });
});

describe("buildJobs", () => {
  for (const source of [true, false]) {
    test(`the source field follows the setting (${source})`, () => {
      const plans = buildPlans([node], dicts, label, { source });
      const [job] = buildJobs([node], plans, st());
      assert.equal(job.input.title, "Rec title");
      assert.deepEqual(job.input.tag_ids, ["t1", "t2"]);
      assert.equal(job.input.details, undefined, "an unchanged field is not sent");
      assert.equal(!!job.input.custom_fields, source);
    });
  }

  const plans = buildPlans([node], dicts, label, on);

  test("edits: trimmed title, a filled-in date, cleared details, urls by line", () => {
    const [job] = buildJobs(
      [node],
      plans,
      st({
        edits: edits([
          ["title", "  Fixed  "],
          ["date", "2026-01-02"],
          ["details", ""],
          ["urls", "https://a\n\n https://b "],
        ]),
      })
    );
    assert.equal(job.input.title, "Fixed");
    assert.equal(job.input.date, "2026-01-02");
    assert.equal(job.input.details, "");
    assert.deepEqual(job.input.urls, ["https://a", "https://b"]);
  });

  test("switches: a field, one tag, the studio", () => {
    const [job] = buildJobs(
      [node],
      plans,
      st({
        checks: checks([
          ["title", false],
          ["tag_ids|t2", false],
          ["studio_id", false],
        ]),
      })
    );
    assert.equal(job.input.title, undefined);
    assert.equal(job.input.tag_ids, undefined, "no tag left to add");
    assert.equal(job.input.studio_id, undefined);
  });

  test("the source line alone is no job", () => {
    const off = ["title", "code", "urls", "studio_id", "tag_ids|t2", "performer_ids|p1"].map(
      (f) => [f, false] as [string, boolean]
    );
    assert.equal(buildJobs([node], plans, st({ checks: checks(off) })).length, 0);
  });

  test("an up-to-date entity becomes a job once edited", () => {
    const done: Entity = {
      ...entity,
      title: "Rec title",
      code: "abc",
      urls: ["https://site.com/v/abc"],
      studio: { id: "s1", name: "Studio A" },
      performers: [{ id: "p1", name: "Ann" }],
      tags: [
        { id: "t1", name: "Red" },
        { id: "t2", name: "Blue" },
      ],
      custom_fields: { source: "https://cdn/a.mp4" },
    };
    const current: PlanNode = { ...node, entity: done };
    const p = buildPlans([current], dicts, label, on);
    assert.equal(buildJobs([current], p, st()).length, 0);
    assert.equal(nodeStatus(current, p, st()), "current");
    const [job] = buildJobs([current], p, st({ edits: edits([["title", "Better"]]) }));
    assert.deepEqual(job.input, { id: "1", title: "Better" });
  });

  test("an excluded entity is left out", () => {
    assert.equal(buildJobs([node], plans, st({ excluded: new Set(["scene:1"]) })).length, 0);
  });
});

describe("resolveNodes", () => {
  const gallery = toEntity("gallery", { id: 7, files: [{ basename: "A.zip" }] });

  function base(): Base {
    const hit = { site: "s", key: "k", record, download: record.downloads[0] };
    return { targets: [entity], hits: new Map([["a.mp4", [hit]]]), related: new Map() };
  }

  test("finds the gallery of the same record, offers the link and its fields", async () => {
    const asked: string[] = [];
    const find = async (kind: string, names: string[]) => {
      asked.push(`${kind}:${names.join(",")}`);
      return new Map([["a.zip", [gallery]]]);
    };
    const b = base();
    const [n] = await resolveNodes(b, new Map(), find);
    assert.deepEqual(asked, ["gallery:a.zip"]);
    assert.equal(n.related.length, 1);
    const rel = n.related[0];
    assert.deepEqual(rel.link, { scene: "1", gallery: "7" });
    assert.equal(rel.owner, true);
    assert.equal(rel.entry.download?.slot, "p");

    // cached: a second pass asks nothing
    await resolveNodes(b, new Map(), find);
    assert.equal(asked.length, 1);

    const plans = buildPlans([n], dicts, label, on);
    const jobs = buildJobs([n], plans, st());
    const scene = jobs.find((j) => j.kind === "scene")!;
    assert.deepEqual(scene.input.gallery_ids, ["7"]);
    assert.equal(scene.links, 1);
    assert.ok(jobs.some((j) => j.kind === "gallery" && j.input.title === "Rec title"));
  });

  test("two records for one file: no entry until chosen", async () => {
    const b = base();
    const other = { site: "t", key: "k2", record: { ...record, id: "https://t/v/2" }, download: null };
    b.hits.get("a.mp4")!.push(other);
    const none = async () => new Map();
    const [n] = await resolveNodes(b, new Map(), none);
    assert.equal(n.entry, null);
    assert.equal(nodeStatus(n, new Map(), st()), "conflict");
    const [chosen] = await resolveNodes(b, new Map([["scene:1", "t\nk2"]]), none);
    assert.equal(chosen.entry?.site, "t");
  });
});

test("collectMisses counts a name once per entity and keeps performer URLs", () => {
  const withUrl: CatalogRecord = { ...record, performers: [{ name: "Bob", url: "https://site.com/p/bob" }] };
  const n: PlanNode = { ...node, entry: { ...entry, record: withUrl } };
  const plans = buildPlans([n], dicts, label, on);
  assert.deepEqual(collectMisses([n], plans, st()), [
    { kind: "performers", name: "Bob", status: "missing", count: 1, candidates: [], urls: ["https://site.com/p/bob"] },
  ]);
});

test("parseSettings: the source field is on unless skipSource", () => {
  assert.deepEqual(parseSettings({}), { source: true });
  assert.deepEqual(parseSettings({ skipSource: true }), { source: false });
});

test("recordPath encodes site and key", () => {
  assert.equal(
    recordPath({ site: "a b", key: "https://x/y?z=1#item=2" }),
    "/inz-records?site=a+b&key=https%3A%2F%2Fx%2Fy%3Fz%3D1%23item%3D2"
  );
});
