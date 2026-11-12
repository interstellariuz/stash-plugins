import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, buildInput, matchName, normalizeName, recordCode, type Indexes } from "../src/records";

test("normalizeName keeps letters and digits only", () => {
  assert.equal(normalizeName("Naughty Mag!"), "naughtymag");
  assert.equal(normalizeName("Émilie-2"), "émilie2");
  assert.equal(normalizeName(null), "");
});

test("matchName: name before alias, two candidates are ambiguous", () => {
  const index = buildIndex("tags", [
    { id: "1", name: "Red", aliases: ["Crimson"] },
    { id: "2", name: "Blue" },
    { id: "3", name: "Navy", aliases: ["Blue"] },
    { id: "4", name: "Twin" },
    { id: "5", name: "twin" },
  ]);
  assert.deepEqual(matchName(index, "crimson"), { status: "ok", item: index.byName.get("red")![0], via: "alias" });
  assert.equal(matchName(index, "Blue").status, "ok");
  assert.equal((matchName(index, "Blue") as any).item.id, "2");
  assert.equal(matchName(index, "TWIN").status, "ambiguous");
  assert.equal(matchName(index, "green").status, "missing");
  assert.equal(matchName(index, "").status, "missing");
});

test("recordCode is the last path segment", () => {
  assert.equal(recordCode(new URL("https://s.com/v/abc/")), "abc");
  assert.equal(recordCode(new URL("https://s.com/")), null);
});

test("buildInput tops lists up and carries custom fields over", () => {
  const indexes: Indexes = {
    studios: buildIndex("studios", []),
    tags: buildIndex("tags", [{ id: "t2", name: "Blue" }]),
    performers: buildIndex("performers", []),
  };
  const { input, skipped } = buildInput(
    { id: "9", tags: [{ id: "t1" }], custom_fields: { rating: 5 } },
    {
      url: "https://s.com/v/abc?ref=1",
      record: {
        id: "https://s.com/v/abc",
        title: "T",
        studio: "Nowhere",
        tags: ["Blue"],
        downloads: [{ slot: "v", group: "video", kind: "video", sourceUrl: "https://cdn/v.mp4" }],
      },
    },
    indexes
  );
  assert.deepEqual(input, {
    id: "9",
    title: "T",
    code: "abc",
    urls: ["https://s.com/v/abc?ref=1"],
    custom_fields: { full: { rating: 5, source: "https://cdn/v.mp4" } },
    tag_ids: ["t1", "t2"],
  });
  assert.deepEqual(skipped, [{ kind: "studios", name: "Nowhere", status: "missing" }]);
});
