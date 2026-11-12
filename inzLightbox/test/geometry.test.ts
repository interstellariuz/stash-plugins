import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampScale,
  clampView,
  defaultScale,
  fromNorm,
  scrollAxis,
  stepScale,
  toNorm,
  visibleCenter,
  zoomAt,
} from "../src/geometry";

const img = { w: 2000, h: 1000 };
const box = { w: 1000, h: 800 };

test("defaultScale follows Stash's display modes", () => {
  assert.equal(defaultScale(img, box, "FIT_XY", true), 0.5);
  assert.equal(defaultScale(img, box, "FIT_X", true), 0.5);
  assert.equal(defaultScale(img, box, "ORIGINAL", true), 1);
  // smaller than the box and no scale-up: natural size
  assert.equal(defaultScale({ w: 100, h: 100 }, box, "FIT_XY", false), 1);
  assert.equal(defaultScale({ w: 100, h: 100 }, box, "FIT_XY", true), 8);
});

test("clampScale keeps zoom between a tenth of fit and 16x", () => {
  assert.equal(clampScale(0.001, img, box), 0.05);
  assert.equal(clampScale(100, img, box), 16);
  assert.equal(clampScale(2, img, box), 2);
});

test("clampView: strict centres a smaller image and allows no empty band", () => {
  assert.deepEqual(clampView({ s: 0.25, x: 0, y: 0 }, img, box), { s: 0.25, x: 250, y: 275 });
  assert.deepEqual(clampView({ s: 1, x: 50, y: -900 }, img, box), { s: 1, x: 0, y: -200 });
});

test("clampView: free keeps a strip on screen", () => {
  const v = clampView({ s: 1, x: 5000, y: 0 }, img, box, true);
  assert.equal(v.x, 1000 - 100);
});

test("zoomAt keeps the point under the anchor", () => {
  const v = zoomAt({ s: 1, x: 0, y: 0 }, 2, 100, 50);
  assert.deepEqual(v, { s: 2, x: -100, y: -50 });
});

test("stepScale stops at 100% when crossing it", () => {
  assert.equal(stepScale(0.9, 1.2), 1);
  assert.equal(stepScale(1.1, 0.8), 1);
  assert.equal(stepScale(1, 2), 2);
});

test("scrollAxis stops at the edge and does not jump back", () => {
  assert.equal(scrollAxis(0, 50, 2000, 1000), 0);
  assert.equal(scrollAxis(-950, -100, 2000, 1000), -1000);
  assert.equal(scrollAxis(-1200, -10, 2000, 1000), -1200);
});

test("toNorm and fromNorm round-trip", () => {
  const v = { s: 1.5, x: -300, y: -100 };
  const back = fromNorm(toNorm(v, img, box), img, box);
  assert.ok(Math.abs(back.x - v.x) < 1e-9 && Math.abs(back.y - v.y) < 1e-9 && back.s === v.s);
});

test("visibleCenter: the box centre when nothing is visible", () => {
  assert.deepEqual(visibleCenter({ s: 1, x: 5000, y: 5000 }, img, box), { x: 500, y: 400 });
  assert.deepEqual(visibleCenter({ s: 1, x: 0, y: 0 }, { w: 500, h: 400 }, box), { x: 250, y: 200 });
});
