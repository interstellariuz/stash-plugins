/**
 * Module state that components re-render on: a plain variable plus a signal,
 * for state shared by components React does not nest (a navbar badge and a
 * page, a dialog host and the menus that open it).
 */

import { React } from "./stash";

export interface Signal {
  notify(): void;
  /** Hook: re-render the calling component on notify() */
  use(): void;
  /** How many components listen */
  readonly size: number;
}

export function signal(): Signal {
  const listeners = new Set<() => void>();
  return {
    notify: () => listeners.forEach((fn) => fn()),
    use() {
      const [, force] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        listeners.add(force);
        return () => {
          listeners.delete(force);
        };
      }, []);
    },
    get size() {
      return listeners.size;
    },
  };
}
