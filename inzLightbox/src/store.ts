/**
 * Per-photo views in sessionStorage: one JSON map, written debounced, oldest
 * entries dropped past STORE_MAX. Storage may be missing or full; every access
 * is guarded and the lightbox works without it.
 */

namespace InzLightbox {
  const STORE_KEY = "inzLightbox:v1";
  const STORE_MAX = 500;
  const WRITE_DELAY = 300;

  interface Entry extends NormView {
    t: number;
  }

  let entries: Record<string, Entry> | null = null;
  let timer: number | undefined;

  function load(): Record<string, Entry> {
    if (entries) return entries;
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      entries = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      entries = {};
    }
    return entries as Record<string, Entry>;
  }

  export function recallView(key: string): NormView | null {
    const e = load()[key];
    if (!e) return null;
    const valid = [e.s, e.cx, e.cy].every((x) => typeof x === "number" && Number.isFinite(x));
    return valid && e.s > 0 ? { s: e.s, cx: e.cx, cy: e.cy } : null;
  }

  export function rememberView(key: string, v: NormView): void {
    load()[key] = { s: v.s, cx: v.cx, cy: v.cy, t: Date.now() };
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(flushViews, WRITE_DELAY);
  }

  export function flushViews(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    const all = load();
    const keys = Object.keys(all);
    if (keys.length > STORE_MAX) {
      keys.sort((a, b) => all[a].t - all[b].t);
      for (const k of keys.slice(0, keys.length - STORE_MAX)) delete all[k];
    }
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      // quota exceeded or storage blocked: views stay in memory for this page
    }
  }
}
