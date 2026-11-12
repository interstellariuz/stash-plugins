/**
 * JSON in localStorage or sessionStorage. Storage may be missing, blocked or
 * full, and even reaching it can throw: every access is guarded, and callers
 * work without it.
 */

export type Area = "local" | "session";

function area(which: Area): Storage | null {
  try {
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The stored value, or null when there is none or it cannot be read */
export function readJson(which: Area, key: string): unknown {
  try {
    const raw = area(which)?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Whether the write landed */
export function writeJson(which: Area, key: string, value: unknown): boolean {
  try {
    const store = area(which);
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
