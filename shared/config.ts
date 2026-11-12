/**
 * Plugin settings, as Settings > Plugins stores them: configuration.plugins
 * of Stash's cached Configuration query, written through configurePlugin.
 */

import { PluginApi, StashService } from "./stash";

export type PluginConfig = Record<string, unknown>;

export function pluginConfig(data: any, pluginId: string): PluginConfig {
  return data?.configuration?.plugins?.[pluginId] ?? {};
}

/** The current values, from the cache when Stash has loaded them already */
export async function readPluginConfig(pluginId: string): Promise<PluginConfig> {
  const result = await StashService.getClient().query({ query: PluginApi.GQL.ConfigurationDocument });
  return pluginConfig(result?.data, pluginId);
}

/** onChange now and on every change, the settings page's own saves included */
export function watchPluginConfig(pluginId: string, onChange: (config: PluginConfig) => void): void {
  StashService.getClient()
    .watchQuery({ query: PluginApi.GQL.ConfigurationDocument })
    .subscribe({
      next: (result: any) => {
        if (result?.data) onChange(pluginConfig(result.data, pluginId));
      },
      error: (e: unknown) => console.error(`${pluginId}: settings`, e),
    });
}

/**
 * Set one value. configurePlugin replaces the plugin's whole map, so this
 * merges into the server's current values first.
 */
export async function savePluginSetting(pluginId: string, name: string, value: unknown): Promise<void> {
  const client = StashService.getClient();
  const query = PluginApi.GQL.ConfigurationDocument;
  const current = await client.query({ query, fetchPolicy: "network-only" });
  await client.mutate({
    mutation: PluginApi.GQL.ConfigurePluginDocument,
    variables: { plugin_id: pluginId, input: { ...pluginConfig(current.data, pluginId), [name]: value } },
  });
  // network-only writes the cache, which updates the settings page and watchers
  await client.query({ query, fetchPolicy: "network-only" });
}
