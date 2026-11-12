/** Plain helpers with no Stash or DOM dependency, so tests can import them. */

export const uniq = <T>(list: T[]): T[] => Array.from(new Set(list));

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** A copy of the set with `key` flipped */
export function toggled<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** {name} placeholders; an unknown one stays as written */
export function fill(template: string, values?: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (all, name) => (values && name in values ? String(values[name]) : all));
}
