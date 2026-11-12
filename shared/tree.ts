/**
 * Editing a rendered element tree.
 *
 * Stash's … menus are not patchable components, but they are built by an
 * ancestor that is, and sit in the element tree it returns before anything
 * renders them. So: find one element in that tree and swap it for an edited
 * copy. The walk runs on every render of a large component, so it stays
 * shallow, stops at the first hit, and a patch around it never throws: a patch
 * that throws takes the page with it.
 */

import { React } from "./stash";

const MAX_DEPTH = 24;

/**
 * The tree with the first element `match` returns a replacement for swapped.
 * Descends children and props.tree: that is where a wrapper of another plugin
 * keeps the tree it was handed.
 */
export function replaceElement(node: any, match: (el: any) => any | null, depth = 0): { node: any; found: boolean } {
  if (depth > MAX_DEPTH || node === null || node === undefined || typeof node !== "object") {
    return { node, found: false };
  }

  if (Array.isArray(node)) {
    let found = false;
    const next = node.map((child) => {
      if (found) return child;
      const result = replaceElement(child, match, depth + 1);
      found = found || result.found;
      return result.node;
    });
    return found ? { node: next, found } : { node, found: false };
  }

  if (!React.isValidElement(node)) return { node, found: false };

  const replacement = match(node);
  if (replacement) return { node: replacement, found: true };

  const props = (node as any).props ?? {};
  const children = replaceElement(props.children, match, depth + 1);
  if (children.found) return { node: React.cloneElement(node as any, undefined, children.node), found: true };

  if (props.tree) {
    const tree = replaceElement(props.tree, match, depth + 1);
    if (tree.found) return { node: React.cloneElement(node as any, { tree: tree.node }), found: true };
  }

  return { node, found: false };
}

/** fn(), or the fallback with a console warning when it throws */
export function safely<T>(tag: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.warn(`${tag}: patch skipped`, e);
    return fallback;
  }
}

/**
 * The tree with `item` inserted after the child keyed `key`: a scene page's
 * operations Dropdown.Menu is found by the item Stash keys "generate". Keys
 * survive on elements taken straight out of props.children.
 */
export function insertAfterKey(tree: any, key: string, item: any): any {
  return replaceElement(tree, (el) => {
    const children = el.props?.children;
    if (!Array.isArray(children)) return null;
    const at = children.findIndex((c: any) => React.isValidElement(c) && c.key === key);
    if (at < 0) return null;
    const next = children.slice();
    next.splice(at + 1, 0, item);
    return React.cloneElement(el, undefined, next);
  }).node;
}

/** One entry of a list's … menu (ListOperations' operations prop) */
export interface Operation {
  text: string;
  onClick: () => void;
  isDisplayed?: () => boolean;
  icon?: unknown;
}

/** `entry` after the one titled `after` (Stash's "Generate…"), else last */
export function insertOperation(existing: Operation[], entry: Operation, after: string): Operation[] {
  const at = existing.findIndex((o) => o?.text === after);
  const next = existing.slice();
  next.splice(at < 0 ? next.length : at + 1, 0, entry);
  return next;
}

/**
 * The tree with FilteredListToolbar's … menu element replaced. The toolbar
 * carries both halves a list operation needs: the selection and that element.
 */
export function replaceListMenu(tree: any, make: (menu: any, selectedIds: Set<string>) => any): any {
  return replaceElement(tree, (el) => {
    const props = el.props;
    const menu = props?.operationComponent;
    if (!props?.listSelect || !React.isValidElement(menu)) return null;
    return React.cloneElement(el, {
      operationComponent: make(menu, props.listSelect.selectedIds ?? new Set()),
    });
  }).node;
}
