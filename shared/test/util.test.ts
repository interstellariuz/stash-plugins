import assert from "node:assert/strict";
import { test } from "node:test";

import { chunks, errorText, escapeRegExp, fill, toggled, uniq } from "../util";

test("fill: known placeholders only", () => {
  assert.equal(fill("{count} of {total} {missing}", { count: 2, total: 5 }), "2 of 5 {missing}");
  assert.equal(fill("plain"), "plain");
});

test("chunks", () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([], 3), []);
});

test("toggled copies", () => {
  const set = new Set(["a"]);
  assert.deepEqual([...toggled(set, "b")], ["a", "b"]);
  assert.deepEqual([...toggled(set, "a")], []);
  assert.deepEqual([...set], ["a"]);
});

test("escapeRegExp makes a literal", () => {
  const name = "a+b (1).mp4";
  assert.ok(new RegExp(`^${escapeRegExp(name)}$`).test(name));
});

test("uniq and errorText", () => {
  assert.deepEqual(uniq([1, 1, 2]), [1, 2]);
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain"), "plain");
});
