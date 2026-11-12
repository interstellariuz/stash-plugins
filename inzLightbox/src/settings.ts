/**
 * Plugin settings: read live from Stash's cached Configuration query, written
 * back through configurePlugin. That mutation replaces the plugin's whole map,
 * so a write merges into the server's current values first.
 */

namespace InzLightbox {
  export const PLUGIN_ID = "inzLightbox";

  export type Action = "fill" | "zoomIn" | "zoomOut" | "original" | "fitScreen" | "fitWidth" | "keepView";

  export interface Settings {
    autoFullscreen: boolean;
    remember: boolean;
    smooth: boolean;
    indicator: boolean;
    /** the next image takes the previous one's zoom and position */
    keepView: boolean;
    /** images loaded and decoded ahead of / behind the current one */
    preloadAhead: number;
    preloadBehind: number;
    /** KeyboardEvent.code -> action */
    keys: Map<string, Action>;
  }

  const KEY_SETTINGS: [string, Action, string][] = [
    ["keyFill", "fill", "Space"],
    ["keyZoomIn", "zoomIn", "ArrowUp"],
    ["keyZoomOut", "zoomOut", "ArrowDown"],
    ["keyOriginal", "original", "Z"],
    ["keyFitScreen", "fitScreen", "X"],
    ["keyFitWidth", "fitWidth", "C"],
    ["keyKeepView", "keepView", "V"],
  ];

  const KEY_ALIASES: Record<string, string> = {
    space: "Space",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    enter: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    minus: "Minus",
    equal: "Equal",
    plus: "Equal",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    insert: "Insert",
    delete: "Delete",
  };

  /** "z" -> KeyZ, "5" -> Digit5, aliases as above; anything else is taken as a code. */
  export function keyCode(token: string): string | null {
    const t = token.trim();
    if (!t) return null;
    if (/^[a-z]$/i.test(t)) return `Key${t.toUpperCase()}`;
    if (/^[0-9]$/.test(t)) return `Digit${t}`;
    if (/^f([1-9]|1[0-2])$/i.test(t)) return t.toUpperCase();
    return KEY_ALIASES[t.toLowerCase()] ?? t;
  }

  function parseKeys(raw: unknown, fallback: string): string[] {
    const text = typeof raw === "string" && raw.trim() ? raw : fallback;
    if (text.trim().toLowerCase() === "none") return [];
    return text
      .split(",")
      .map(keyCode)
      .filter((c): c is string => c !== null);
  }

  function count(raw: unknown, fallback: number): number {
    return typeof raw === "number" && Number.isFinite(raw) ? Math.min(5, Math.max(0, Math.round(raw))) : fallback;
  }

  export function parseSettings(raw: Record<string, unknown>): Settings {
    const keys = new Map<string, Action>();
    for (const [name, action, fallback] of KEY_SETTINGS) {
      for (const code of parseKeys(raw[name], fallback)) {
        if (!keys.has(code)) keys.set(code, action);
      }
    }
    return {
      autoFullscreen: raw.autoFullscreen === true,
      remember: raw.disableRememberZoom !== true,
      smooth: raw.disableSmoothZoom !== true,
      indicator: raw.hideZoomIndicator !== true,
      keepView: raw.keepView === true,
      preloadAhead: count(raw.preloadAhead, 2),
      preloadBehind: count(raw.preloadBehind, 1),
      keys,
    };
  }

  export let settings: Settings = parseSettings({});
  export let settingsLoaded = false;

  function api(): any {
    return (window as any).PluginApi;
  }

  function pluginConfig(data: any): Record<string, unknown> {
    return data?.configuration?.plugins?.[PLUGIN_ID] ?? {};
  }

  export function watchSettings(onChange: () => void): void {
    const PluginApi = api();
    PluginApi.utils.StashService.getClient()
      .watchQuery({ query: PluginApi.GQL.ConfigurationDocument })
      .subscribe({
        next: (result: any) => {
          if (!result?.data) return;
          settings = parseSettings(pluginConfig(result.data));
          settingsLoaded = true;
          onChange();
        },
        error: (e: unknown) => console.error("inzLightbox: settings", e),
      });
  }

  export async function saveSetting(name: string, value: unknown): Promise<void> {
    const PluginApi = api();
    const client = PluginApi.utils.StashService.getClient();
    const query = PluginApi.GQL.ConfigurationDocument;
    const current = await client.query({ query, fetchPolicy: "network-only" });
    await client.mutate({
      mutation: PluginApi.GQL.ConfigurePluginDocument,
      variables: { plugin_id: PLUGIN_ID, input: { ...pluginConfig(current.data), [name]: value } },
    });
    // network-only writes the cache, which updates the settings page and watchSettings
    await client.query({ query, fetchPolicy: "network-only" });
  }
}
