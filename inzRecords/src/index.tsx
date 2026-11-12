/**
 * UI half of INZ Download Records.
 *
 * The site userscripts push a record to the backend on every download. This
 * side matches records to scenes and galleries by file name, shows an editable
 * "before -> after" preview and applies it:
 *
 *   - "Import from records…" in a scene's and a gallery's … menu;
 *   - the same entry in the scene and gallery list menus, for a selection;
 *   - /inz-records: the records page, reached from a navbar icon and from the
 *     plugin's block in Settings > Plugins.
 *
 *   plan.ts, status.ts   what to import, what state records are in (pure)
 *   records.ts           record -> update input, the CLI's port (pure)
 *   api.ts, queries.ts   Stash and backend calls
 *   store.ts             state the page, the badge and the dialog share
 *   dialog.tsx, page.tsx, menus.tsx, ui.tsx   the UI
 */

import { PluginApi, React } from "../../shared/stash";
import { DialogHost } from "./dialog";
import { PLUGIN_ID, ROUTE } from "./ids";
import { patchGalleryPanel, patchList, patchScenePage } from "./menus";
import { NavButton, RecordsPage, SettingsLink } from "./page";

const { patch } = PluginApi;

patch.after("MainNavBar.UtilityItems", (_props: any, _context: any, result: any) => (
  <>
    <NavButton />
    <DialogHost />
    {result}
  </>
));

PluginApi.register.route(ROUTE, RecordsPage);

patch.after("PluginSettings", (props: any, _context: any, result: any) =>
  props?.pluginID === PLUGIN_ID ? (
    <>
      {result}
      <SettingsLink />
    </>
  ) : (
    result
  )
);

patch.after("ScenePage", patchScenePage);
patch.after("FilteredSceneList", patchList("scene"));
patch.after("FilteredGalleryList", patchList("gallery"));
patch.after("GalleryImagesPanel", patchGalleryPanel);
patch.after("GalleryAddPanel", patchGalleryPanel);
