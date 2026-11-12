import assert from "node:assert/strict";
import { before, test } from "node:test";

import * as React from "react";

// shared/stash reads PluginApi when first imported
(globalThis as any).window = {
  PluginApi: {
    React,
    utils: { StashService: {} },
    libraries: { Bootstrap: {}, ReactRouterDOM: {}, Intl: { useIntl: () => ({}) } },
  },
};

let tree: typeof import("../tree");
before(async () => {
  tree = await import("../tree");
});

const h = React.createElement;
const keys = (el: any) => React.Children.toArray(el.props.children).map((c: any) => String(c.key).replace(/^\.\$/, ""));

function scenePage() {
  const menu = h("div", { className: "menu" }, [h("a", { key: "rescan" }), h("a", { key: "generate" }), h("a", { key: "delete" })]);
  return h("section", null, h("header", null, menu));
}

test("insertAfterKey puts the item after the keyed child", () => {
  const out = tree.insertAfterKey(scenePage(), "generate", h("a", { key: "mine" }));
  const menu = out.props.children.props.children;
  assert.deepEqual(keys(menu), ["rescan", "generate", "mine", "delete"]);
});

test("insertAfterKey finds the menu inside another plugin's wrapper", () => {
  const Wrapper = () => null;
  const wrapped = h(Wrapper, { tree: scenePage() });
  const out = tree.insertAfterKey(wrapped, "generate", h("a", { key: "mine" }));
  assert.equal(out.type, Wrapper);
  assert.deepEqual(keys(out.props.tree.props.children.props.children), ["rescan", "generate", "mine", "delete"]);
});

test("insertAfterKey leaves a tree without the key as it was", () => {
  const page = h("section", null, h("p"));
  assert.equal(tree.insertAfterKey(page, "generate", h("a")), page);
});

test("replaceListMenu hands over the selection and the menu", () => {
  const Ops = () => null;
  const toolbar = h("div", { listSelect: { selectedIds: new Set(["4"]) }, operationComponent: h(Ops, { operations: [] }) });
  let seen: Set<string> | null = null;
  const out = tree.replaceListMenu(h("main", null, toolbar), (menu, ids) => {
    seen = ids;
    return React.cloneElement(menu, { operations: [{ text: "x", onClick() {} }] });
  });
  assert.deepEqual([...seen!], ["4"]);
  assert.equal(out.props.children.props.operationComponent.props.operations[0].text, "x");
});

test("insertOperation goes after Generate…, else last", () => {
  const op = (text: string) => ({ text, onClick() {} });
  const entry = op("Mine…");
  assert.deepEqual(
    tree.insertOperation([op("A"), op("Generate…"), op("B")], entry, "Generate…").map((o) => o.text),
    ["A", "Generate…", "Mine…", "B"]
  );
  assert.deepEqual(tree.insertOperation([op("A")], entry, "Generate…").map((o) => o.text), ["A", "Mine…"]);
});

test("safely falls back when the patch throws", () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(
      tree.safely("t", () => {
        throw new Error("x");
      }, "fallback"),
      "fallback"
    );
  } finally {
    console.warn = warn;
  }
});
