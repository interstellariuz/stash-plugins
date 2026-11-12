/**
 * What the records page and the navbar badge show: every record with the
 * state of its files in Stash. Built from the backend's summary and the
 * scenes and galleries those file names find; no Stash calls here.
 */

import { uniq } from "../../shared/util";
import { recordId, type Kind } from "./plan";
import * as R from "./records";

export type FileState = "missing" | "ready" | "imported";

/** One entry of the backend's summary op */
export interface SummaryRecord {
  site: string;
  key: string;
  title: string;
  url: string;
  date?: string;
  studio?: string;
  updatedAt: string;
  files: { name: string; kind: string }[];
}

export interface Summary {
  records?: SummaryRecord[];
  last?: Status["last"];
}

/** A scene or gallery a file name finds, with the URLs it carries */
export interface NamedEntity {
  kind: Kind;
  id: string;
  urls: string[];
}

export interface FoundEntity {
  kind: Kind;
  id: string;
  imported: boolean;
}

export interface FileRow {
  name: string;
  kind: string;
  found: FoundEntity[];
}

export interface RecordRow {
  id: string;
  site: string;
  key: string;
  title: string;
  url: string;
  date: string;
  studio: string;
  updatedAt: string;
  state: FileState;
  files: FileRow[];
  // lower-cased text the search runs on
  haystack: string;
}

export interface SiteRow {
  site: string;
  records: number;
  missing: number;
  ready: number;
  imported: number;
}

export interface Status {
  records: RecordRow[];
  files: number;
  sites: number;
  last: { site: string; title: string; key: string; updatedAt: string } | null;
  counts: Record<FileState, number>;
  bySite: SiteRow[];
  checkedAt: number;
}

/** Lower-case file names of the summary, to look up in Stash */
export function summaryNames(summary: Summary): string[] {
  return uniq((summary.records ?? []).flatMap((r) => r.files.map((f) => f.name.toLowerCase())));
}

/**
 * A record is imported once every file Stash has carries its page URL, ready
 * while one does not, missing while Stash has none of its files.
 */
export function buildStatus(summary: Summary, inStash: Map<string, NamedEntity[]>, now = Date.now()): Status {
  const counts: Record<FileState, number> = { missing: 0, ready: 0, imported: 0 };
  const sites = new Map<string, SiteRow>();
  const rows: RecordRow[] = [];
  let files = 0;

  for (const record of summary.records ?? []) {
    const link = R.parseUrl(record.url);
    const page = link ? R.recordUrls(link)[0] : null;
    let ready = false;
    let found = 0;
    let imported = 0;
    const fileRows: FileRow[] = [];

    for (const file of record.files) {
      files += 1;
      const entities = inStash.get(file.name.toLowerCase()) ?? [];
      const hits = entities.map((e) => ({ kind: e.kind, id: e.id, imported: !!page && e.urls.includes(page) }));
      fileRows.push({ name: file.name, kind: file.kind, found: hits });
      if (!hits.length) continue;
      found += 1;
      if (hits.some((h) => !h.imported)) ready = true;
      else imported += 1;
    }

    const state: FileState = ready ? "ready" : found && imported === found ? "imported" : "missing";
    counts[state] += 1;
    const site = sites.get(record.site) ?? { site: record.site, records: 0, missing: 0, ready: 0, imported: 0 };
    site.records += 1;
    site[state] += 1;
    sites.set(record.site, site);

    rows.push({
      id: recordId(record),
      site: record.site,
      key: record.key,
      title: record.title,
      url: record.url,
      date: record.date ?? "",
      studio: record.studio ?? "",
      updatedAt: record.updatedAt,
      state,
      files: fileRows,
      haystack: [record.title, record.url, record.key, record.studio ?? "", ...record.files.map((f) => f.name)]
        .join("\n")
        .toLowerCase(),
    });
  }

  return {
    records: rows,
    files,
    sites: sites.size,
    last: summary.last ?? null,
    counts,
    bySite: Array.from(sites.values()).sort((a, b) => a.site.localeCompare(b.site)),
    checkedAt: now,
  };
}

/** What the import dialog is opened for */
export interface Targets {
  scenes?: string[];
  galleries?: string[];
}

/** Scenes and galleries of these records; ready ones only unless `all` */
export function entitiesOf(rows: RecordRow[], all: boolean): Targets {
  const scenes = new Set<string>();
  const galleries = new Set<string>();
  for (const row of rows) {
    for (const file of row.files) {
      for (const e of file.found) {
        if (!all && e.imported) continue;
        (e.kind === "scene" ? scenes : galleries).add(e.id);
      }
    }
  }
  return { scenes: Array.from(scenes), galleries: Array.from(galleries) };
}
