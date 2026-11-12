/**
 * Record -> *UpdateInput, ported from the stash CLI.
 *
 * Sources: stash/ops/lookup.mjs (normalizeName, matchName, loadIndexes) and
 * stash/ops/records.mjs (buildInput, recordCode, recordUrls, recordSource,
 * wantedPerformers). A change there has to be repeated here.
 *
 * Same behaviour: lists are topped up, an ambiguous name is skipped, nothing is
 * created. One addition: an ambiguous match also reports its candidates, so the
 * dialog can name them.
 *
 * The record types mirror ../../../shared/records.d.ts; that file is outside
 * this repository, so it cannot be referenced here.
 */

namespace InzRecords {
  export interface Download {
    slot: string;
    group: string;
    kind: string;
    sourceUrl: string;
    xName?: string;
    savedName?: string;
    savedAt?: string;
    [field: string]: unknown;
  }

  export interface Performer {
    name: string;
    url?: string;
    ignored?: boolean;
  }

  export interface CatalogRecord {
    id: string;
    title?: string;
    studio?: string;
    date?: string;
    description?: string;
    performers?: Performer[];
    tags?: string[];
    downloads: Download[];
    [field: string]: unknown;
  }

  export interface Entry {
    url: string;
    record: CatalogRecord;
    download?: Download | null;
  }

  export interface Named {
    id: string;
    name: string;
    aliases?: string[];
    alias_list?: string[];
  }

  export type DictKind = "studios" | "tags" | "performers";

  export interface NameIndex {
    kind: DictKind;
    count: number;
    byName: Map<string, Named[]>;
    byAlias: Map<string, Named[]>;
  }

  export type Indexes = Record<DictKind, NameIndex>;

  export type Match =
    | { status: "ok"; item: Named; via: "name" | "alias" }
    | { status: "missing"; item: null; via: null }
    | { status: "ambiguous"; item: null; via: null; candidates: Named[] };

  export interface Skipped {
    kind: DictKind;
    name: string;
    status: "missing" | "ambiguous";
    candidates?: Named[];
  }

  /** The entity fields buildInput reads */
  export interface Item {
    id: string;
    tags?: { id: string }[];
    performers?: { id: string }[];
    custom_fields?: Record<string, unknown> | null;
  }

  export type Input = Record<string, unknown> & { id: string };

  /* -- lookup.mjs ---------------------------------------------------------- */

  /** Letters and digits only: "naughtymag" = "Naughty Mag" */
  export function normalizeName(value: unknown): string {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function addTo(map: Map<string, Named[]>, key: string, item: Named) {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }

  /** loadIndex without the fetch: the UI queries, this builds */
  export function buildIndex(kind: DictKind, items: Named[]): NameIndex {
    const byName = new Map<string, Named[]>();
    const byAlias = new Map<string, Named[]>();
    for (const item of items) {
      addTo(byName, normalizeName(item.name), item);
      for (const alias of item.aliases ?? item.alias_list ?? []) {
        addTo(byAlias, normalizeName(alias), item);
      }
    }
    return { kind, count: items.length, byName, byAlias };
  }

  export function matchName(index: NameIndex, name: string): Match {
    const key = normalizeName(name);
    if (!key) return { status: "missing", item: null, via: null };

    for (const [via, map] of [
      ["name", index.byName],
      ["alias", index.byAlias],
    ] as const) {
      const found = map.get(key);
      if (!found) continue;
      // Two candidates for one name: no guessing
      if (found.length > 1) return { status: "ambiguous", item: null, via: null, candidates: found };
      return { status: "ok", item: found[0], via };
    }

    return { status: "missing", item: null, via: null };
  }

  /* -- records.mjs --------------------------------------------------------- */

  export function parseUrl(url: string): URL | null {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  /** Last path segment of the record url - also the scene code */
  export function recordCode(url: URL): string | null {
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length ? segments[segments.length - 1] : null;
  }

  /** The record page link, without the service suffix */
  export function recordUrls(url: URL): string[] {
    return [`${url.origin}${url.pathname}${url.search}`];
  }

  /** Direct file link for custom_fields: the file the entity was found by */
  export function recordSource(record: CatalogRecord, download?: Download | null): string | null {
    if (download?.sourceUrl) return download.sourceUrl;
    return (record.downloads ?? []).find((item) => item.kind === "video")?.sourceUrl ?? null;
  }

  /** `ignored` marks performers left out on purpose */
  export function wantedPerformers(record: CatalogRecord): Performer[] {
    return (record.performers ?? []).filter((performer) => performer && !performer.ignored);
  }

  /** The name a file landed under on disk (record.js diskName in site-scripts) */
  export function diskName(download: Download): string {
    return download.savedName || download.xName || "";
  }

  const uniq = <T>(list: T[]) => Array.from(new Set(list));

  export function buildInput(
    item: Item,
    entry: Entry,
    indexes: Indexes
  ): { input: Input; skipped: Skipped[] } {
    const { record, url, download } = entry;
    const input: Input = { id: item.id };
    const skipped: Skipped[] = [];

    if (record.title) input.title = record.title;
    if (record.date) input.date = record.date;
    if (record.description) input.details = record.description;

    const link = parseUrl(url);
    if (link) {
      const code = recordCode(link);
      if (code) input.code = code;
      input.urls = recordUrls(link);
    }

    const source = recordSource(record, download);
    // full rewrites the whole map - carry over what was there
    if (source) input.custom_fields = { full: { ...(item.custom_fields ?? {}), source } };

    if (record.studio) {
      const hit = matchName(indexes.studios, record.studio);
      if (hit.status === "ok") input.studio_id = hit.item.id;
      else skipped.push(skip("studios", record.studio, hit));
    }

    const lists: [DictKind, string[], { id: string }[]][] = [
      ["tags", record.tags ?? [], item.tags ?? []],
      ["performers", wantedPerformers(record).map((p) => p.name), item.performers ?? []],
    ];
    for (const [kind, names, current] of lists) {
      if (!names.length) continue;

      const ids: string[] = [];
      for (const name of names) {
        const hit = matchName(indexes[kind], name);
        if (hit.status === "ok") ids.push(hit.item.id);
        else skipped.push(skip(kind, name, hit));
      }

      // The list is replaced wholesale, so top up what is there
      if (ids.length) {
        input[kind === "tags" ? "tag_ids" : "performer_ids"] = uniq([
          ...current.map((x) => x.id),
          ...ids,
        ]);
      }
    }

    return { input, skipped };
  }

  function skip(kind: DictKind, name: string, hit: Match): Skipped {
    return hit.status === "ambiguous"
      ? { kind, name, status: "ambiguous", candidates: hit.candidates }
      : { kind, name, status: "missing" };
  }
}
