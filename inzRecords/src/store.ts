/**
 * App-wide state shared by components React does not nest: the records
 * status (the page and the navbar badge), and the import dialog's request
 * (one host, opened from menus and the page).
 */

import { signal } from "../../shared/signal";
import { readJson, writeJson } from "../../shared/storage";
import { computeStatus, runOp } from "./api";
import { recordId } from "./plan";
import type { Status, Targets } from "./status";

/* -- Status ---------------------------------------------------------------- */

const CACHE_KEY = "inzRecords.status";
export const STALE_MS = 10 * 60 * 1000;

interface Cached {
  ready: number;
  at: number;
}

export const status = {
  last: null as Status | null,
  computing: null as Promise<Status> | null,
  changed: signal(),
};

// Full records for the expanded rows; dropped on every refresh
const recordCache = new Map<string, Promise<any>>();

export function cachedReady(): number {
  const cached = readJson("local", CACHE_KEY) as Cached | null;
  return cached?.ready ?? 0;
}

/** One computation at a time, shared by the page and the badge */
export function refreshStatus(): Promise<Status> {
  if (!status.computing) {
    recordCache.clear();
    status.computing = computeStatus()
      .then((result) => {
        status.last = result;
        writeJson("local", CACHE_KEY, { ready: result.counts.ready, at: result.checkedAt } satisfies Cached);
        return result;
      })
      .finally(() => {
        status.computing = null;
        status.changed.notify();
      });
    status.changed.notify();
  }
  return status.computing;
}

export function refreshIfStale() {
  const cached = readJson("local", CACHE_KEY) as Cached | null;
  if (cached && Date.now() - cached.at < STALE_MS) return;
  refreshStatus().catch(() => undefined);
}

/** One full record (the get op), cached until the next refresh */
export function getRecord(row: { site: string; key: string }) {
  const id = recordId(row);
  let found = recordCache.get(id);
  if (!found) {
    found = runOp({ op: "get", site: row.site, key: row.key });
    found.catch(() => recordCache.delete(id));
    recordCache.set(id, found);
  }
  return found;
}

/* -- The import dialog's request ------------------------------------------- */

export interface ImportRequest extends Targets {
  onDone?: () => void;
}

export const dialog = {
  pending: null as ImportRequest | null,
  changed: signal(),
};

export function openImport(request: ImportRequest) {
  if (!dialog.changed.size) {
    console.warn("inzRecords: no dialog host is mounted");
    return;
  }
  dialog.pending = request;
  dialog.changed.notify();
}

export function closeImport() {
  dialog.pending = null;
  dialog.changed.notify();
}
