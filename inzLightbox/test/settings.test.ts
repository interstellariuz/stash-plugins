import assert from "node:assert/strict";
import { test } from "node:test";

import { keyCode, parseSettings } from "../src/settings";

test("keyCode: letters, digits, aliases, F-keys, codes as given", () => {
  assert.equal(keyCode("z"), "KeyZ");
  assert.equal(keyCode("5"), "Digit5");
  assert.equal(keyCode(" up "), "ArrowUp");
  assert.equal(keyCode("plus"), "Equal");
  assert.equal(keyCode("f11"), "F11");
  assert.equal(keyCode("NumpadAdd"), "NumpadAdd");
  assert.equal(keyCode(""), null);
});

test("parseSettings: defaults", () => {
  const s = parseSettings({});
  assert.equal(s.remember, true);
  assert.equal(s.autoFullscreen, false);
  assert.equal(s.preloadAhead, 2);
  assert.equal(s.preloadBehind, 1);
  assert.equal(s.keys.get("Space"), "fill");
  assert.equal(s.keys.get("KeyZ"), "original");
});

test("parseSettings: key lists, none, first action wins, counts clamped", () => {
  const s = parseSettings({ keyFill: "none", keyZoomIn: "w, ArrowUp", keyZoomOut: "w", preloadAhead: 9, preloadBehind: -1 });
  assert.equal(s.keys.has("Space"), false);
  assert.equal(s.keys.get("KeyW"), "zoomIn");
  assert.equal(s.keys.get("ArrowUp"), "zoomIn");
  assert.equal(s.preloadAhead, 5);
  assert.equal(s.preloadBehind, 0);
});
