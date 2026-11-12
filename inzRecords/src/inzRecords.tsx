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
 *     plugin's block in Settings > Plugins. Not under /plugin/: the server owns
 *     that prefix (plugin assets), so loading such a URL directly is its 404.
 *
 * The dialog lives in one host mounted with the navbar, so the menu patches
 * stay pure element edits: no wrapper components that would hide the tree from
 * another plugin patching the same menu (inzVrGenerate does).
 */

type PatchFn = (target: string, fn: (...args: any[]) => any) => void;
type Component = React.FC<any>;

interface IPluginApi {
  React: typeof React;
  GQL: Record<string, unknown>;
  libraries: {
    Apollo: { gql: (source: string) => unknown };
    Bootstrap: {
      Badge: Component;
      Button: Component;
      Dropdown: Component & { Item: Component };
      Form: Component & { Check: Component; Control: Component };
      Modal: Component & { Header: Component; Title: Component; Body: Component; Footer: Component };
      Table: Component;
    };
    FontAwesomeSolid: Record<string, unknown>;
    Intl: {
      useIntl: () => {
        messages: Record<string, unknown>;
        formatMessage: (descriptor: { id: string }, values?: Record<string, unknown>) => string;
      };
    };
    ReactRouterDOM: {
      Link: Component;
      NavLink: Component;
      useLocation: () => { pathname: string; search: string };
    };
  };
  components: Record<string, Component>;
  hooks: { useToast: () => { success: (m: string) => void; error: (e: unknown) => void } };
  register: { route: (path: string, component: React.FC<any>) => void };
  utils: { StashService: Record<string, any> };
  patch: { before: PatchFn; instead: PatchFn; after: PatchFn };
}

(function () {
  const PluginApi = (window as any).PluginApi as IPluginApi;
  const React = PluginApi.React;
  const { Badge, Button, Dropdown, Form, Modal, Table } = PluginApi.libraries.Bootstrap;
  const { Link, NavLink, useLocation } = PluginApi.libraries.ReactRouterDOM;
  const { useIntl } = PluginApi.libraries.Intl;
  const StashService = PluginApi.utils.StashService;
  const R = InzRecords;

  const PLUGIN_ID = "inzRecords";
  const ROUTE = "/inz-records";
  const CACHE_KEY = "inzRecords.status";
  const STALE_MS = 10 * 60 * 1000;
  // Names per findScenes/findGalleries regex
  const NAME_CHUNK = 100;
  // Records page rows rendered at once
  const PAGE_SIZE = 200;

  /* ------------------------------------------------------------------ *
   * Strings: a server catalogue entry with the same id wins, as in
   * inzVrGenerate. {name} placeholders are filled in here.
   * ------------------------------------------------------------------ */

  const TEXT = {
    "inzRecords.title": "INZ Download Records",
    "inzRecords.import": "Import from records",
    "inzRecords.selected": "{count} selected",
    "inzRecords.ready": "ready",
    "inzRecords.up_to_date": "up to date",
    "inzRecords.no_record": "no record",
    "inzRecords.conflict": "{count} records match",
    "inzRecords.conflicts": "conflicting",
    "inzRecords.choose": "choose…",
    "inzRecords.no_record_for": "no record for {name}",
    "inzRecords.replaces": "replaces",
    "inzRecords.empty": "(empty)",
    "inzRecords.source": "Source",
    "inzRecords.source_hint": "The direct file link, in custom field \"source\". Written along with other changes, never on its own.",
    "inzRecords.link_gallery": "Link gallery",
    "inzRecords.link_scene": "Link scene",
    "inzRecords.linked": "already linked",
    "inzRecords.own_row": "fields in its own row",
    "inzRecords.fields": "fields",
    "inzRecords.all_fields": "all fields",
    "inzRecords.fewer_fields": "changed fields only",
    "inzRecords.reset": "Back to the record's value",
    "inzRecords.urls_hint": "one per line",
    "inzRecords.open_record": "record",
    "inzRecords.open_record_hint": "Show this record on the records page",
    "inzRecords.filter.all": "all",
    "inzRecords.expand_all": "Expand all",
    "inzRecords.collapse_all": "Collapse all",
    "inzRecords.not_in_stash": "Not in Stash",
    "inzRecords.ambiguous": "ambiguous",
    "inzRecords.create": "Create",
    "inzRecords.create_all": "Create all",
    "inzRecords.import_n": "Import {count}",
    "inzRecords.importing": "Importing {done}/{total}…",
    "inzRecords.imported_toast": "Imported {count} · linked {links}",
    "inzRecords.nothing": "Nothing to import.",
    "inzRecords.kind.studios": "studio",
    "inzRecords.kind.tags": "tag",
    "inzRecords.kind.performers": "performer",
    "inzRecords.page.totals": "{records} records · {files} files · {sites} sites",
    "inzRecords.page.last": "Last received {ago} · {site} ·",
    "inzRecords.page.nothing_yet": "Nothing received yet.",
    "inzRecords.page.ready": "Ready to import",
    "inzRecords.page.missing": "Not in Stash yet",
    "inzRecords.page.imported": "Imported",
    "inzRecords.page.import_all": "Import all ready",
    "inzRecords.page.site": "site",
    "inzRecords.page.sites": "Sites",
    "inzRecords.page.records": "records",
    "inzRecords.page.record": "record",
    "inzRecords.page.state": "state",
    "inzRecords.page.in_stash": "in Stash",
    "inzRecords.page.received": "received",
    "inzRecords.page.search": "Search title, URL, studio or file name…",
    "inzRecords.page.all_sites": "All sites",
    "inzRecords.page.all_states": "All states",
    "inzRecords.page.shown": "{shown} of {total}",
    "inzRecords.page.more": "Show {count} more",
    "inzRecords.page.no_match": "No records match.",
    "inzRecords.page.shift_hint": "Shift+click selects a range",
    "inzRecords.page.import_selected": "Import {count}",
    "inzRecords.page.delete_selected": "Delete {count}…",
    "inzRecords.page.select_all": "Select all {count}",
    "inzRecords.page.clear": "Clear selection",
    "inzRecords.page.select_site": "select",
    "inzRecords.page.delete_site": "delete…",
    "inzRecords.page.delete_title": "Delete records",
    "inzRecords.page.delete_body": "Delete {count} records from the store?",
    "inzRecords.page.delete_site_body": "Delete all {count} records of {site} from the store?",
    "inzRecords.page.delete_note": "Scenes, galleries and what was imported into them stay as they are. A push from the userscript (a download, or its backfill) sends a record again.",
    "inzRecords.page.deleted": "Deleted {count} records",
    "inzRecords.page.import_one": "Import",
    "inzRecords.page.delete_one": "Delete…",
    "inzRecords.page.downloads": "Downloads",
    "inzRecords.page.link_only": "link only",
    "inzRecords.page.saved": "saved {ago}",
    "inzRecords.page.not_found": "not in Stash",
    "inzRecords.page.gone": "This record is no longer in the store.",
    "inzRecords.page.checked": "Checked {time}",
    "inzRecords.page.refresh": "Refresh",
    "inzRecords.page.checking": "Checking…",
    "inzRecords.settings.open": "Open the records page",
  };

  type TextId = keyof typeof TEXT;
  type Fmt = (id: TextId, values?: Record<string, unknown>) => string;

  function fill(template: string, values?: Record<string, unknown>) {
    return template.replace(/\{(\w+)\}/g, (all, name) =>
      values && name in values ? String(values[name]) : all
    );
  }

  function useText(): Fmt {
    const intl = useIntl();
    return React.useCallback<Fmt>(
      (id, values) =>
        intl.messages?.[id] ? intl.formatMessage({ id }, values) : fill(TEXT[id], values),
      [intl]
    );
  }

  /** Stash's own message, when a label has one */
  function useStashText() {
    const intl = useIntl();
    return React.useCallback(
      (id: string, fallback: string) => (intl.messages?.[id] ? intl.formatMessage({ id }) : fallback),
      [intl]
    );
  }

  // Menu patches are not components and cannot call hooks; the host keeps these
  // current so list menus get the same wording.
  let menuLabel = `${TEXT["inzRecords.import"]}…`;
  let generateLabel = "Generate…";

  const MenuLabel: React.FC = () => {
    const text = useText();
    return <>{`${text("inzRecords.import")}…`}</>;
  };

  /* ------------------------------------------------------------------ *
   * GraphQL
   * ------------------------------------------------------------------ */

  const documents = new Map<string, unknown>();
  function documentFor(name: InzRecords.QueryName) {
    let doc = documents.get(name);
    if (!doc) {
      doc = PluginApi.libraries.Apollo.gql(R.QUERIES[name]);
      documents.set(name, doc);
    }
    return doc;
  }

  // no-cache: these are bulk reads with partial field sets; the pages refetch
  // their own queries after an import.
  async function query(name: InzRecords.QueryName, variables?: Record<string, unknown>): Promise<any> {
    const result = await StashService.getClient().query({
      query: documentFor(name),
      variables,
      fetchPolicy: "no-cache",
    });
    return result.data;
  }

  async function mutate(name: InzRecords.QueryName, variables: Record<string, unknown>): Promise<any> {
    const result = await StashService.getClient().mutate({
      mutation: documentFor(name),
      variables,
      fetchPolicy: "no-cache",
    });
    return result.data;
  }

  async function runOp(args: Record<string, unknown>): Promise<any> {
    return (await mutate("RUN_OP", { args })).runPluginOperation;
  }

  function errorText(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  interface Settings {
    // custom_fields.source starts switched on
    source: boolean;
  }

  /** Plugin settings, from Stash's own (cached) configuration query */
  async function loadSettings(): Promise<Settings> {
    try {
      const result = await StashService.getClient().query({ query: PluginApi.GQL.ConfigurationDocument });
      const raw = result?.data?.configuration?.plugins?.[PLUGIN_ID] ?? {};
      return { source: raw.skipSource !== true };
    } catch {
      return { source: true };
    }
  }

  /* ------------------------------------------------------------------ *
   * Entities
   * ------------------------------------------------------------------ */

  type Kind = "scene" | "gallery";

  interface Ref {
    id: string;
    name: string;
  }

  interface Entity {
    kind: Kind;
    key: string;
    id: string;
    title: string;
    code: string;
    date: string;
    details: string;
    urls: string[];
    studio: Ref | null;
    performers: Ref[];
    tags: Ref[];
    // galleries of a scene, scenes of a gallery
    linked: string[];
    custom_fields: Record<string, unknown> | null;
    basenames: string[];
  }

  const entityKey = (kind: Kind, id: string) => `${kind}:${id}`;
  const entityPath = (kind: Kind, id: string) => `/${kind === "scene" ? "scenes" : "galleries"}/${id}`;

  function toEntity(kind: Kind, raw: any): Entity {
    const id = String(raw.id);
    return {
      kind,
      key: entityKey(kind, id),
      id,
      title: raw.title ?? "",
      code: raw.code ?? "",
      date: raw.date ?? "",
      details: raw.details ?? "",
      urls: raw.urls ?? [],
      studio: raw.studio ? { id: String(raw.studio.id), name: raw.studio.name } : null,
      performers: (raw.performers ?? []).map((p: any) => ({ id: String(p.id), name: p.name })),
      tags: (raw.tags ?? []).map((t: any) => ({ id: String(t.id), name: t.name })),
      linked: ((kind === "scene" ? raw.galleries : raw.scenes) ?? []).map((x: any) => String(x.id)),
      custom_fields: raw.custom_fields ?? null,
      basenames: (raw.files ?? []).map((f: any) => String(f.basename)),
    };
  }

  async function loadEntities(kind: Kind, ids: string[]): Promise<Entity[]> {
    if (!ids.length) return [];
    const data =
      kind === "scene"
        ? (await query("SCENES_BY_ID", { ids })).findScenes.scenes
        : (await query("GALLERIES_BY_ID", { ids })).findGalleries.galleries;
    return data.map((raw: any) => toEntity(kind, raw));
  }

  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** A path regex for "basename is one of these"; either separator, any case */
  function basenameRegex(names: string[]) {
    return `(?i)(^|[/\\\\])(${names.map(escapeRegExp).join("|")})$`;
  }

  function chunks<T>(list: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  const uniq = <T,>(list: T[]) => Array.from(new Set(list));

  /** Entities of one kind whose files carry these names, keyed by lower-case name */
  async function findByNames(kind: Kind, names: string[]): Promise<Map<string, Entity[]>> {
    const found = new Map<string, Entity[]>();
    for (const part of chunks(names, NAME_CHUNK)) {
      const path = basenameRegex(part);
      const raw =
        kind === "scene"
          ? (await query("SCENES_BY_PATH", { path })).findScenes.scenes
          : (await query("GALLERIES_BY_PATH", { path })).findGalleries.galleries;
      for (const item of raw) {
        const entity = toEntity(kind, item);
        for (const basename of entity.basenames) {
          const key = basename.toLowerCase();
          const list = found.get(key) ?? [];
          if (!list.some((e) => e.key === entity.key)) list.push(entity);
          found.set(key, list);
        }
      }
    }
    return found;
  }

  /* ------------------------------------------------------------------ *
   * Dictionaries
   * ------------------------------------------------------------------ */

  interface Dictionaries {
    indexes: InzRecords.Indexes;
    names: Record<InzRecords.DictKind, Map<string, string>>;
  }

  async function loadDictionaries(): Promise<Dictionaries> {
    const data = await query("DICTIONARIES");
    const lists: Record<InzRecords.DictKind, InzRecords.Named[]> = {
      studios: data.findStudios.studios,
      tags: data.findTags.tags,
      performers: data.findPerformers.performers,
    };
    const byId = (items: InzRecords.Named[]) => new Map(items.map((i) => [String(i.id), i.name]));
    return {
      indexes: {
        studios: R.buildIndex("studios", lists.studios),
        tags: R.buildIndex("tags", lists.tags),
        performers: R.buildIndex("performers", lists.performers),
      },
      names: { studios: byId(lists.studios), tags: byId(lists.tags), performers: byId(lists.performers) },
    };
  }

  /* ------------------------------------------------------------------ *
   * Records
   * ------------------------------------------------------------------ */

  interface Hit {
    site: string;
    key: string;
    record: InzRecords.CatalogRecord;
    download: InzRecords.Download | null;
  }

  const recordId = (hit: { site: string; key: string }) => `${hit.site}\n${hit.key}`;
  const recordPath = (hit: { site: string; key: string }) =>
    `${ROUTE}?${new URLSearchParams({ site: hit.site, key: hit.key }).toString()}`;

  async function lookup(names: string[]): Promise<Map<string, Hit[]>> {
    const out = new Map<string, Hit[]>();
    const unique = uniq(names.map((n) => n.toLowerCase()));
    for (const part of chunks(unique, 500)) {
      const result = await runOp({ op: "lookup", names: part });
      for (const [name, hits] of Object.entries(result?.hits ?? {})) out.set(name, hits as Hit[]);
    }
    return out;
  }

  /** Every record a file of this entity belongs to, first file first */
  function candidatesFor(entity: Entity, hits: Map<string, Hit[]>): Hit[] {
    const seen = new Map<string, Hit>();
    for (const basename of entity.basenames) {
      for (const hit of hits.get(basename.toLowerCase()) ?? []) {
        if (!seen.has(recordId(hit))) seen.set(recordId(hit), hit);
      }
    }
    return Array.from(seen.values());
  }

  /** The download of a record that names one of the entity's files */
  function downloadFor(record: InzRecords.CatalogRecord, entity: Entity) {
    const names = new Set(entity.basenames.map((b) => b.toLowerCase()));
    return (
      (record.downloads ?? []).find(
        (d) =>
          (d.xName && names.has(d.xName.toLowerCase())) ||
          (d.savedName && names.has(d.savedName.toLowerCase()))
      ) ?? null
    );
  }

  /** File names of the other kind in the same record: photo sets for a scene, videos for a gallery */
  function relatedNames(record: InzRecords.CatalogRecord, kind: Kind): string[] {
    const want = kind === "scene" ? "photo" : "video";
    const names: string[] = [];
    for (const d of record.downloads ?? []) {
      if (d.kind !== want) continue;
      for (const name of [d.xName, d.savedName]) if (name) names.push(name.toLowerCase());
    }
    return uniq(names);
  }

  /* ------------------------------------------------------------------ *
   * The import plan
   * ------------------------------------------------------------------ */

  // An entry plus where it came from, so the dialog can point at the record
  interface Source extends InzRecords.Entry {
    site: string;
    key: string;
  }

  function sourceOf(hit: Hit): Source {
    return { site: hit.site, key: hit.key, url: hit.record?.id ?? hit.key, record: hit.record, download: hit.download };
  }

  interface Related {
    // parent key > entity key: the nested row's own switch
    key: string;
    entity: Entity;
    entry: Source;
    link: { scene: string; gallery: string } | null;
    // fields are shown and applied under this parent (first one to reach it)
    owner: boolean;
    isTarget: boolean;
  }

  interface PlanNode {
    entity: Entity;
    candidates: Hit[];
    entry: Source | null;
    related: Related[];
  }

  /*
   * text, multiline, urls: editable, present for every entity whether the
   * record changes them or not; studio, list, source: what the record offers,
   * switched on and off
   */
  type RowType = "text" | "multiline" | "urls" | "studio" | "list" | "source";

  interface FieldRow {
    field: string;
    label: string;
    type: RowType;
    before: string;
    // the record's value; equals `before` when it has none or the same
    after: string;
    // the record changes this field
    proposed: boolean;
    defaultOn: boolean;
    // studio id, or the custom_fields payload
    value?: unknown;
    // list: ids on the entity now, and the ones the record adds
    current?: string[];
    added?: Ref[];
  }

  interface EntityPlan {
    rows: FieldRow[];
    skipped: InzRecords.Skipped[];
    record: InzRecords.CatalogRecord;
  }

  interface Base {
    targets: Entity[];
    hits: Map<string, Hit[]>;
    related: Map<string, Entity[]>; // `${kind}|${name}` -> entities
  }

  type Labels = (field: string) => string;

  function diffRows(
    entity: Entity,
    built: InzRecords.Input,
    dicts: Dictionaries,
    label: Labels,
    settings: Settings
  ): FieldRow[] {
    const rows: FieldRow[] = [];
    const editable = (field: string, type: RowType, before: string, offered: unknown) => {
      const after = typeof offered === "string" ? offered : before;
      rows.push({ field, label: label(field), type, before, after, proposed: after !== before, defaultOn: true });
    };

    editable("title", "text", entity.title, built.title);
    editable("code", "text", entity.code, built.code);
    editable("date", "text", entity.date, built.date);
    editable("details", "multiline", entity.details, built.details);
    const urls = built.urls as string[] | undefined;
    editable("urls", "urls", entity.urls.join("\n"), urls?.join("\n"));

    const studio = built.studio_id as string | undefined;
    if (studio && studio !== entity.studio?.id) {
      rows.push({
        field: "studio_id",
        label: label("studio"),
        type: "studio",
        before: entity.studio?.name ?? "",
        after: dicts.names.studios.get(studio) ?? studio,
        proposed: true,
        defaultOn: true,
        value: studio,
      });
    }

    for (const [field, kind, current] of [
      ["performer_ids", "performers", entity.performers],
      ["tag_ids", "tags", entity.tags],
    ] as const) {
      const ids = built[field] as string[] | undefined;
      if (!ids) continue;
      const have = new Set(current.map((x) => x.id));
      const added = ids.filter((id) => !have.has(id));
      if (!added.length) continue;
      rows.push({
        field,
        label: label(kind),
        type: "list",
        before: "",
        after: "",
        proposed: true,
        defaultOn: true,
        current: current.map((x) => x.id),
        added: added.map((id) => ({ id, name: dicts.names[kind].get(id) ?? id })),
      });
    }

    const custom = built.custom_fields as { full: Record<string, unknown> } | undefined;
    const source = custom?.full?.source;
    if (custom && source !== entity.custom_fields?.source) {
      rows.push({
        field: "custom_fields",
        label: label("source"),
        type: "source",
        before: String(entity.custom_fields?.source ?? ""),
        after: String(source ?? ""),
        proposed: true,
        defaultOn: settings.source,
        value: custom,
      });
    }

    return rows;
  }

  /** Stage two: records chosen, related entities found */
  async function resolveNodes(base: Base, choices: Map<string, string>): Promise<PlanNode[]> {
    const targetKeys = new Set(base.targets.map((e) => e.key));
    const nodes: PlanNode[] = base.targets.map((entity) => {
      const candidates = candidatesFor(entity, base.hits);
      const chosen =
        candidates.length === 1
          ? candidates[0]
          : candidates.find((c) => recordId(c) === choices.get(entity.key)) ?? null;
      return { entity, candidates, entry: chosen ? sourceOf(chosen) : null, related: [] };
    });

    // Fetch what the cache does not have yet, per kind
    const wanted = new Map<Kind, Set<string>>([
      ["scene", new Set()],
      ["gallery", new Set()],
    ]);
    for (const node of nodes) {
      if (!node.entry) continue;
      const other: Kind = node.entity.kind === "scene" ? "gallery" : "scene";
      for (const name of relatedNames(node.entry.record, node.entity.kind)) {
        if (!base.related.has(`${other}|${name}`)) wanted.get(other)!.add(name);
      }
    }
    for (const [kind, names] of wanted) {
      if (!names.size) continue;
      const found = await findByNames(kind, Array.from(names));
      for (const name of names) base.related.set(`${kind}|${name}`, found.get(name) ?? []);
    }

    const owned = new Set<string>();
    for (const node of nodes) {
      if (!node.entry) continue;
      const parent = node.entity;
      const other: Kind = parent.kind === "scene" ? "gallery" : "scene";
      const seen = new Set<string>();
      for (const name of relatedNames(node.entry.record, parent.kind)) {
        for (const entity of base.related.get(`${other}|${name}`) ?? []) {
          if (seen.has(entity.key)) continue;
          seen.add(entity.key);

          const scene = parent.kind === "scene" ? parent : entity;
          const gallery = parent.kind === "scene" ? entity : parent;
          const linked = scene.linked.includes(gallery.id) || gallery.linked.includes(scene.id);
          const isTarget = targetKeys.has(entity.key);
          const owner = !isTarget && !owned.has(entity.key);
          if (owner) owned.add(entity.key);

          node.related.push({
            key: `${parent.key}>${entity.key}`,
            entity,
            entry: { ...node.entry, download: downloadFor(node.entry.record, entity) },
            link: linked ? null : { scene: scene.id, gallery: gallery.id },
            owner,
            isTarget,
          });
        }
      }
    }

    return nodes;
  }

  /** Stage three: field diffs, recomputed whenever the dictionaries change */
  function buildPlans(
    nodes: PlanNode[],
    dicts: Dictionaries,
    label: Labels,
    settings: Settings
  ): Map<string, EntityPlan> {
    const plans = new Map<string, EntityPlan>();
    const add = (entity: Entity, entry: InzRecords.Entry) => {
      const built = R.buildInput(entity, entry, dicts.indexes);
      plans.set(entity.key, {
        rows: diffRows(entity, built.input, dicts, label, settings),
        skipped: built.skipped,
        record: entry.record,
      });
    };
    for (const node of nodes) {
      if (node.entry) add(node.entity, node.entry);
      for (const rel of node.related) if (rel.owner) add(rel.entity, rel.entry);
    }
    return plans;
  }

  /** What the user changed in the dialog */
  interface UiState {
    excluded: Set<string>; // entity keys and nested keys
    checks: Map<string, boolean>; // `${entityKey}|${field}[|${id}]` -> on, over the row's default
    edits: Map<string, string>; // `${entityKey}|${field}` -> typed value
  }

  const rowKey = (entity: Entity, row: FieldRow) => `${entity.key}|${row.field}`;

  function isOn(st: UiState, key: string, fallback: boolean) {
    return st.checks.get(key) ?? fallback;
  }

  const splitUrls = (text: string) =>
    text
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean);

  /** The value a text row would write, edits applied */
  function rowValue(st: UiState, key: string, row: FieldRow) {
    const value = st.edits.get(key) ?? row.after;
    return row.type === "text" ? value.trim() : value;
  }

  /** One row's contribution to the update, or null */
  function rowPatch(entity: Entity, row: FieldRow, st: UiState): Record<string, unknown> | null {
    const key = rowKey(entity, row);
    if (!isOn(st, key, row.defaultOn) && row.type !== "list") return null;
    switch (row.type) {
      case "text":
      case "multiline": {
        const value = rowValue(st, key, row);
        return value !== row.before ? { [row.field]: value } : null;
      }
      case "urls": {
        const value = splitUrls(rowValue(st, key, row));
        return value.join("\n") !== splitUrls(row.before).join("\n") ? { urls: value } : null;
      }
      case "studio":
        return { studio_id: row.value };
      case "list": {
        const on = (row.added ?? []).filter((a) => isOn(st, `${key}|${a.id}`, true));
        return on.length ? { [row.field]: uniq([...(row.current ?? []), ...on.map((a) => a.id)]) } : null;
      }
      case "source":
        return { custom_fields: row.value };
    }
  }

  /** The update for one entity; null when only the source line would change */
  function entityPatch(entity: Entity, plan: EntityPlan | undefined, st: UiState) {
    if (!plan) return null;
    const input: Record<string, unknown> = {};
    let real = false;
    for (const row of plan.rows) {
      const patch = rowPatch(entity, row, st);
      if (!patch) continue;
      Object.assign(input, patch);
      if (row.type !== "source") real = true;
    }
    return real ? input : null;
  }

  interface Job {
    key: string;
    kind: Kind;
    input: Record<string, unknown>;
    links: number;
  }

  /** What Import sends, given the switches and edits */
  function buildJobs(nodes: PlanNode[], plans: Map<string, EntityPlan>, st: UiState): Job[] {
    const jobs = new Map<string, Job>();
    const scenes = new Map<string, Entity>();
    const newLinks = new Map<string, Set<string>>(); // scene id -> gallery ids

    const take = (entity: Entity) => {
      const input = entityPatch(entity, plans.get(entity.key), st);
      if (input) jobs.set(entity.key, { key: entity.key, kind: entity.kind, input: { id: entity.id, ...input }, links: 0 });
    };

    for (const node of nodes) {
      if (!node.entry || st.excluded.has(node.entity.key)) continue;
      take(node.entity);
      for (const rel of node.related) {
        if (st.excluded.has(rel.key)) continue;
        if (rel.owner) take(rel.entity);
        if (rel.link) {
          const scene = node.entity.kind === "scene" ? node.entity : rel.entity;
          scenes.set(scene.id, scene);
          const set = newLinks.get(rel.link.scene) ?? new Set<string>();
          set.add(rel.link.gallery);
          newLinks.set(rel.link.scene, set);
        }
      }
    }

    // The link lives on the scene: top up gallery_ids
    for (const [sceneId, galleries] of newLinks) {
      const scene = scenes.get(sceneId)!;
      const key = scene.key;
      const job = jobs.get(key) ?? { key, kind: "scene" as Kind, input: { id: sceneId }, links: 0 };
      job.input.gallery_ids = uniq([...scene.linked, ...galleries]);
      job.links = galleries.size;
      jobs.set(key, job);
    }

    return Array.from(jobs.values());
  }

  interface Miss {
    kind: InzRecords.DictKind;
    name: string;
    status: "missing" | "ambiguous";
    count: number;
    candidates: string[];
    urls: string[];
  }

  function collectMisses(nodes: PlanNode[], plans: Map<string, EntityPlan>, st: UiState): Miss[] {
    const misses = new Map<string, Miss>();
    const add = (key: string) => {
      const plan = plans.get(key);
      if (!plan) return;
      for (const skip of plan.skipped) {
        const id = `${skip.kind}|${R.normalizeName(skip.name)}`;
        const miss = misses.get(id) ?? {
          kind: skip.kind,
          name: skip.name,
          status: skip.status,
          count: 0,
          candidates: (skip.candidates ?? []).map((c) => c.name),
          urls: [],
        };
        miss.count += 1;
        if (skip.kind === "performers") {
          const url = (plan.record.performers ?? []).find(
            (p) => R.normalizeName(p.name) === R.normalizeName(skip.name)
          )?.url;
          if (url && !miss.urls.includes(url)) miss.urls.push(url);
        }
        misses.set(id, miss);
      }
    };
    for (const node of nodes) {
      if (!node.entry || st.excluded.has(node.entity.key)) continue;
      add(node.entity.key);
      for (const rel of node.related) if (rel.owner && !st.excluded.has(rel.key)) add(rel.entity.key);
    }
    const order = { studios: 0, performers: 1, tags: 2 };
    return Array.from(misses.values()).sort(
      (a, b) => order[a.kind] - order[b.kind] || b.count - a.count || a.name.localeCompare(b.name)
    );
  }

  async function createMiss(miss: Miss) {
    if (miss.kind === "studios") await mutate("STUDIO_CREATE", { input: { name: miss.name } });
    else if (miss.kind === "tags") await mutate("TAG_CREATE", { input: { name: miss.name } });
    else {
      const input: Record<string, unknown> = { name: miss.name };
      if (miss.urls.length) input.urls = miss.urls;
      await mutate("PERFORMER_CREATE", { input });
    }
  }

  /* ------------------------------------------------------------------ *
   * The dialog
   * ------------------------------------------------------------------ */

  interface ImportRequest {
    scenes?: string[];
    galleries?: string[];
    onDone?: () => void;
  }

  const Check: React.FC<{
    id: string;
    checked: boolean;
    disabled?: boolean;
    title?: string;
    onChange: (shift: boolean) => void;
  }> = ({ id, checked, disabled, title, onChange }) => (
    <Form.Check
      id={`inz-records-${id}`}
      className="inz-records-check"
      checked={checked}
      disabled={disabled}
      title={title}
      // shiftKey lives on the click, not the change
      onClick={(e: React.MouseEvent) => onChange(e.shiftKey)}
      onMouseDown={(e: React.MouseEvent) => e.shiftKey && e.preventDefault()}
      onChange={() => undefined}
    />
  );

  function toggled(set: Set<string>, key: string) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  const kindLabel = (kind: Kind, stash: ReturnType<typeof useStashText>) =>
    kind === "scene" ? stash("scene", "Scene") : stash("gallery", "Gallery");

  function entityName(entity: Entity) {
    return entity.title || entity.basenames[0] || "";
  }

  /** Kind, id and name, the name opening the entity in a new tab */
  const EntityHead: React.FC<{ entity: Entity; strong?: boolean }> = ({ entity, strong }) => {
    const stash = useStashText();
    const name = entityName(entity);
    return (
      <span>
        {kindLabel(entity.kind, stash)} {entity.id}{" "}
        <Link to={entityPath(entity.kind, entity.id)} target="_blank" rel="noopener noreferrer">
          {strong ? <strong>{name}</strong> : name}
        </Link>
      </span>
    );
  };

  const FieldRows: React.FC<{
    entity: Entity;
    plan: EntityPlan | undefined;
    st: UiState;
    disabled: boolean;
    showAll: boolean;
    onShowAll: () => void;
    onCheck: (key: string, on: boolean) => void;
    onEdit: (key: string, value: string | null) => void;
  }> = ({ entity, plan, st, disabled, showAll, onShowAll, onCheck, onEdit }) => {
    const text = useText();
    if (!plan) return null;

    const visible = plan.rows.filter((row) => row.proposed || showAll || st.edits.has(rowKey(entity, row)));
    const hidden = plan.rows.length - visible.length;

    const renderValue = (row: FieldRow, key: string, on: boolean) => {
      if (row.type === "list") {
        return (
          <span className="inz-records-added">
            {(row.added ?? []).map((item) => {
              const itemKey = `${key}|${item.id}`;
              const itemOn = isOn(st, itemKey, true);
              return (
                <Badge
                  key={item.id}
                  as="button"
                  type="button"
                  variant={itemOn ? "secondary" : "dark"}
                  className={`mr-1 inz-records-chip${itemOn ? "" : " inz-records-chip-off"}`}
                  disabled={disabled}
                  onClick={() => onCheck(itemKey, !itemOn)}
                >
                  {itemOn ? "+" : "−"} {item.name}
                </Badge>
              );
            })}
          </span>
        );
      }

      const before = <span className="inz-records-before text-muted">{row.before || text("inzRecords.empty")}</span>;
      const arrow = <span className="inz-records-arrow">→</span>;

      if (row.type === "studio" || row.type === "source") {
        return (
          <>
            {before}
            {arrow}
            <span className="inz-records-after">{row.after}</span>
            {row.before && on ? (
              <Badge variant="warning" className="inz-records-replaces">
                {text("inzRecords.replaces")}
              </Badge>
            ) : (
              <span />
            )}
          </>
        );
      }

      const value = st.edits.get(key) ?? row.after;
      const changed = rowPatch(entity, row, { ...st, checks: new Map([[key, true]]) }) !== null;
      const edited = st.edits.has(key);
      return (
        <>
          {before}
          {arrow}
          <span className="inz-records-after d-flex align-items-start">
            <Form.Control
              size="sm"
              as={row.type === "text" ? "input" : "textarea"}
              rows={row.type === "text" ? undefined : Math.min(6, Math.max(2, value.split("\n").length))}
              className={`inz-records-input${changed && on ? " inz-records-input-changed" : ""}`}
              value={value}
              placeholder={row.type === "urls" ? text("inzRecords.urls_hint") : undefined}
              disabled={disabled || !on}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const next = e.currentTarget.value;
                onEdit(key, next === row.after ? null : next);
              }}
            />
            {edited ? (
              <Button
                variant="link"
                size="sm"
                className="inz-records-reset"
                title={text("inzRecords.reset")}
                disabled={disabled}
                onClick={() => onEdit(key, null)}
              >
                ↺
              </Button>
            ) : null}
          </span>
          {row.before && changed && on ? (
            <Badge variant="warning" className="inz-records-replaces">
              {text("inzRecords.replaces")}
            </Badge>
          ) : (
            <span />
          )}
        </>
      );
    };

    return (
      <div className="inz-records-fields">
        {visible.map((row) => {
          const key = rowKey(entity, row);
          const on = isOn(st, key, row.defaultOn);
          return (
            <div
              key={row.field}
              className={`inz-records-field${row.type === "source" ? " text-muted" : ""}`}
              title={row.type === "source" ? text("inzRecords.source_hint") : undefined}
            >
              <span>
                {row.type === "list" ? null : (
                  <Check id={key} checked={on} disabled={disabled} onChange={() => onCheck(key, !on)} />
                )}
              </span>
              <span className="inz-records-label">{row.label}</span>
              {renderValue(row, key, on)}
            </div>
          );
        })}
        {hidden > 0 || showAll ? (
          <Button variant="link" size="sm" className="inz-records-more" onClick={onShowAll}>
            {showAll ? `▴ ${text("inzRecords.fewer_fields")}` : `▾ ${text("inzRecords.all_fields")} (+${hidden})`}
          </Button>
        ) : null}
      </div>
    );
  };

  const RecordLink: React.FC<{ entry: Source; onLeave: () => void }> = ({ entry, onLeave }) => {
    const text = useText();
    const link = R.parseUrl(entry.url);
    return (
      <span className="inz-records-url text-muted">
        {link ? (
          <a href={entry.url} target="_blank" rel="noopener noreferrer">
            {`${link.host}${link.pathname}`}
          </a>
        ) : null}{" "}
        ·{" "}
        <Link to={recordPath(entry)} title={text("inzRecords.open_record_hint")} onClick={onLeave}>
          {text("inzRecords.open_record")}
        </Link>
      </span>
    );
  };

  type NodeStatus = "ready" | "current" | "none" | "conflict";
  type DialogFilter = NodeStatus | "all";

  const ImportDialog: React.FC<{ request: ImportRequest; onClose: () => void }> = ({ request, onClose }) => {
    const text = useText();
    const stash = useStashText();
    const Toast = PluginApi.hooks.useToast();
    const { LoadingIndicator } = PluginApi.components;

    const label = React.useCallback<Labels>(
      (field) => {
        switch (field) {
          case "title":
            return stash("title", "Title");
          case "code":
            return stash("scene_code", "Studio Code");
          case "date":
            return stash("date", "Date");
          case "details":
            return stash("details", "Details");
          case "urls":
            return stash("urls", "URLs");
          case "studio":
            return stash("studio", "Studio");
          case "performers":
            return stash("performers", "Performers");
          case "tags":
            return stash("tags", "Tags");
          default:
            return text("inzRecords.source");
        }
      },
      [stash, text]
    );

    const baseRef = React.useRef<Base | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [nodes, setNodes] = React.useState<PlanNode[] | null>(null);
    const [dicts, setDicts] = React.useState<Dictionaries | null>(null);
    const [settings, setSettings] = React.useState<Settings>({ source: true });
    const [choices, setChoices] = React.useState<Map<string, string>>(new Map());
    const [st, setSt] = React.useState<UiState>({ excluded: new Set(), checks: new Map(), edits: new Map() });
    const [open, setOpen] = React.useState<Set<string>>(new Set());
    const [filter, setFilter] = React.useState<DialogFilter>("all");
    const [busy, setBusy] = React.useState<string | null>(null);
    const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
    const [creating, setCreating] = React.useState<Set<string>>(new Set());

    const requested = (request.scenes?.length ?? 0) + (request.galleries?.length ?? 0);

    // Stage one: entities, their records, the dictionaries
    React.useEffect(() => {
      let live = true;
      (async () => {
        const [scenes, galleries, loaded, conf] = await Promise.all([
          loadEntities("scene", uniq(request.scenes ?? [])),
          loadEntities("gallery", uniq(request.galleries ?? [])),
          loadDictionaries(),
          loadSettings(),
        ]);
        const targets = [...scenes, ...galleries];
        const hits = await lookup(targets.flatMap((e) => e.basenames));
        if (!live) return;
        baseRef.current = { targets, hits, related: new Map() };
        setSettings(conf);
        setDicts(loaded);
        if (targets.length === 1) setOpen(new Set([targets[0].key]));
      })().catch((e) => live && setError(errorText(e)));
      return () => {
        live = false;
      };
    }, [request]);

    // Stage two, again whenever a conflict is decided
    React.useEffect(() => {
      const base = baseRef.current;
      if (!base || !dicts) return;
      let live = true;
      resolveNodes(base, choices)
        .then((resolved) => live && setNodes(resolved))
        .catch((e) => live && setError(errorText(e)));
      return () => {
        live = false;
      };
    }, [choices, dicts !== null]);

    const plans = React.useMemo(
      () => (nodes && dicts ? buildPlans(nodes, dicts, label, settings) : new Map<string, EntityPlan>()),
      [nodes, dicts, label, settings]
    );
    const jobs = React.useMemo(() => (nodes ? buildJobs(nodes, plans, st) : []), [nodes, plans, st]);
    const misses = React.useMemo(() => (nodes ? collectMisses(nodes, plans, st) : []), [nodes, plans, st]);

    // What the record (and the edits) offer, before any switch is turned off
    const offered = React.useMemo<UiState>(() => ({ excluded: new Set(), checks: new Map(), edits: st.edits }), [st.edits]);

    const status = (node: PlanNode): NodeStatus => {
      if (!node.entry) return node.candidates.length > 1 ? "conflict" : "none";
      const own = entityPatch(node.entity, plans.get(node.entity.key), offered) !== null;
      const rel = node.related.some(
        (r) => r.link || (r.owner && entityPatch(r.entity, plans.get(r.entity.key), offered) !== null)
      );
      return own || rel ? "ready" : "current";
    };

    const counts: Record<NodeStatus, number> = { ready: 0, current: 0, none: 0, conflict: 0 };
    for (const node of nodes ?? []) counts[status(node)] += 1;

    const toggleExcluded = (key: string) => setSt((s) => ({ ...s, excluded: toggled(s.excluded, key) }));
    const setCheck = (key: string, on: boolean) =>
      setSt((s) => {
        const checks = new Map(s.checks);
        checks.set(key, on);
        return { ...s, checks };
      });
    const setEdit = (key: string, value: string | null) =>
      setSt((s) => {
        const edits = new Map(s.edits);
        if (value === null) edits.delete(key);
        else edits.set(key, value);
        return { ...s, edits };
      });
    const toggleOpen = (key: string) => setOpen((o) => toggled(o, key));

    async function create(list: Miss[]) {
      const ids = list.map((m) => `${m.kind}|${m.name}`);
      setCreating((c) => new Set([...Array.from(c), ...ids]));
      try {
        for (const miss of list) await createMiss(miss);
      } catch (e) {
        Toast.error(e);
      }
      try {
        setDicts(await loadDictionaries());
      } catch (e) {
        Toast.error(e);
      }
      setCreating((c) => new Set(Array.from(c).filter((id) => !ids.includes(id))));
    }

    async function onImport() {
      const failed = new Map<string, string>();
      let done = 0;
      let links = 0;
      for (let i = 0; i < jobs.length; i++) {
        setBusy(text("inzRecords.importing", { done: i + 1, total: jobs.length }));
        const job = jobs[i];
        try {
          await mutate(job.kind === "scene" ? "SCENE_UPDATE" : "GALLERY_UPDATE", { input: job.input });
          done += 1;
          links += job.links;
        } catch (e) {
          failed.set(job.key, errorText(e));
        }
      }
      await StashService.getClient()
        .refetchQueries({ include: "active" })
        .catch(() => undefined);
      setBusy(null);
      if (done) Toast.success(text("inzRecords.imported_toast", { count: done, links }));
      request.onDone?.();
      if (failed.size) setErrors(failed);
      else onClose();
    }

    const fieldRows = (entity: Entity, disabled: boolean) => (
      <FieldRows
        entity={entity}
        plan={plans.get(entity.key)}
        st={st}
        disabled={disabled}
        showAll={open.has(`${entity.key}|all`)}
        onShowAll={() => toggleOpen(`${entity.key}|all`)}
        onCheck={setCheck}
        onEdit={setEdit}
      />
    );

    function renderRelated(rel: Related, parentOff: boolean) {
      const hasFields = rel.owner && plans.has(rel.entity.key);
      if (!rel.link && !hasFields) return null;
      const off = parentOff || st.excluded.has(rel.key);
      const isOpen = open.has(rel.key);
      const linkLabel = rel.entity.kind === "gallery" ? text("inzRecords.link_gallery") : text("inzRecords.link_scene");
      const failed = errors.get(rel.entity.key);
      return (
        <div key={rel.key} className="inz-records-related">
          <div className="inz-records-row">
            <Check id={rel.key} checked={!off} disabled={parentOff || !!busy} onChange={() => toggleExcluded(rel.key)} />
            {rel.link ? <span>{linkLabel}</span> : null}
            <EntityHead entity={rel.entity} />
            {rel.link ? null : <span className="text-muted">· {text("inzRecords.linked")}</span>}
            {hasFields ? (
              <Button variant="link" size="sm" className="inz-records-caret" onClick={() => toggleOpen(rel.key)}>
                {isOpen ? "▾" : "▸"} {text("inzRecords.fields")}
              </Button>
            ) : rel.isTarget ? (
              <span className="text-muted">· {text("inzRecords.own_row")}</span>
            ) : null}
            {failed ? <span className="text-danger">✗ {failed}</span> : null}
          </div>
          {hasFields && isOpen ? fieldRows(rel.entity, off || !!busy) : null}
        </div>
      );
    }

    function renderNode(node: PlanNode) {
      const entity = node.entity;
      const st0 = status(node);
      const failed = errors.get(entity.key);

      if (st0 === "none") {
        return (
          <div key={entity.key} className="inz-records-row text-muted">
            <span className="inz-records-mark">✗</span>
            <EntityHead entity={entity} strong />
            <span>{text("inzRecords.no_record_for", { name: entity.basenames[0] ?? "—" })}</span>
          </div>
        );
      }

      if (st0 === "conflict") {
        return (
          <div key={entity.key} className="inz-records-row">
            <span className="inz-records-mark text-warning">⚠</span>
            <EntityHead entity={entity} strong />
            <span>{text("inzRecords.conflict", { count: node.candidates.length })}</span>
            <Form.Control
              as="select"
              size="sm"
              className="inz-records-choose"
              value={choices.get(entity.key) ?? ""}
              disabled={!!busy}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                const value = e.currentTarget.value;
                setChoices((c) => {
                  const next = new Map(c);
                  if (value) next.set(entity.key, value);
                  else next.delete(entity.key);
                  return next;
                });
              }}
            >
              <option value="">{text("inzRecords.choose")}</option>
              {node.candidates.map((c) => (
                <option key={recordId(c)} value={recordId(c)}>
                  {`${c.site} · ${c.record?.title || c.key}`}
                </option>
              ))}
            </Form.Control>
          </div>
        );
      }

      // A decided conflict stays switchable
      const chooser =
        node.candidates.length > 1 ? (
          <Button
            variant="link"
            size="sm"
            onClick={() =>
              setChoices((c) => {
                const next = new Map(c);
                next.delete(entity.key);
                return next;
              })
            }
          >
            {text("inzRecords.conflict", { count: node.candidates.length })}
          </Button>
        ) : null;

      const off = st.excluded.has(entity.key);
      const isOpen = open.has(entity.key);
      const plan = plans.get(entity.key);
      const summary =
        st0 === "current"
          ? [text("inzRecords.up_to_date")]
          : (plan?.rows ?? [])
              .filter((r) => r.type !== "source" && rowPatch(entity, r, st))
              .map((r) => r.label);
      const link = node.related.find((r) => r.link && !st.excluded.has(r.key));
      if (link && st0 === "ready") {
        const id = link.entity.kind === "gallery" ? "inzRecords.link_gallery" : "inzRecords.link_scene";
        summary.push(text(id).toLowerCase());
      }

      return (
        <div key={entity.key} className={`inz-records-node${st0 === "current" ? " inz-records-current" : ""}`}>
          <div className="inz-records-row">
            <Check id={entity.key} checked={!off} disabled={!!busy} onChange={() => toggleExcluded(entity.key)} />
            <Button variant="link" size="sm" className="inz-records-caret" onClick={() => toggleOpen(entity.key)}>
              {isOpen ? "▾" : "▸"}
            </Button>
            <EntityHead entity={entity} strong />
            <RecordLink entry={node.entry!} onLeave={onClose} />
            {isOpen ? null : <span className="text-muted inz-records-summary">{summary.join(" · ")}</span>}
            {chooser}
            {failed ? <span className="text-danger">✗ {failed}</span> : null}
          </div>
          {isOpen ? (
            <>
              {fieldRows(entity, off || !!busy)}
              <div className="inz-records-fields">{node.related.map((rel) => renderRelated(rel, off))}</div>
            </>
          ) : null}
        </div>
      );
    }

    const creatable = misses.filter((m) => m.status === "missing");
    const loading = !error && !nodes;
    const shown = (nodes ?? []).filter((n) => filter === "all" || status(n) === filter);
    const openable = shown.filter((n) => n.entry).map((n) => n.entity.key);
    const allOpen = openable.length > 0 && openable.every((k) => open.has(k));

    const chips: [DialogFilter, number, string][] = [
      ["all", nodes?.length ?? 0, text("inzRecords.filter.all")],
      ["ready", counts.ready, text("inzRecords.ready")],
      ["current", counts.current, text("inzRecords.up_to_date")],
      ["none", counts.none, text("inzRecords.no_record")],
      ["conflict", counts.conflict, text("inzRecords.conflicts")],
    ];

    return (
      <Modal show size="xl" scrollable onHide={busy ? () => undefined : onClose} dialogClassName="inz-records-dialog">
        <Modal.Header closeButton={!busy}>
          <Modal.Title>
            {text("inzRecords.import")} — {text("inzRecords.selected", { count: requested })}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error ? <div className="text-danger">{error}</div> : null}
          {loading ? <LoadingIndicator /> : null}
          {nodes ? (
            <>
              <div className="inz-records-toolbar">
                {nodes.length > 1
                  ? chips
                      .filter(([key, count]) => key === "all" || count > 0)
                      .map(([key, count, name]) => (
                        <Button
                          key={key}
                          size="sm"
                          variant={filter === key ? "primary" : "secondary"}
                          onClick={() => setFilter(key)}
                        >
                          {name} {count}
                        </Button>
                      ))
                  : null}
                {!jobs.length && counts.ready === 0 ? <span>{text("inzRecords.nothing")}</span> : null}
                {openable.length > 1 ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      setOpen((o) => {
                        const next = new Set(o);
                        for (const k of openable) {
                          if (allOpen) next.delete(k);
                          else next.add(k);
                        }
                        return next;
                      })
                    }
                  >
                    {allOpen ? text("inzRecords.collapse_all") : text("inzRecords.expand_all")}
                  </Button>
                ) : null}
              </div>
              {shown.map(renderNode)}
              {misses.length ? (
                <div className="inz-records-misses">
                  <h6>{text("inzRecords.not_in_stash")}</h6>
                  {misses.map((miss) => {
                    const id = `${miss.kind}|${miss.name}`;
                    return (
                      <div key={id} className="inz-records-row">
                        <span>
                          {text(`inzRecords.kind.${miss.kind}` as TextId)} “{miss.name}” ×{miss.count}
                        </span>
                        {miss.status === "missing" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={creating.has(id) || !!busy}
                            onClick={() => create([miss])}
                          >
                            {text("inzRecords.create")}
                          </Button>
                        ) : (
                          <span className="text-muted">
                            — {text("inzRecords.ambiguous")}: {miss.candidates.join(", ")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          {busy ? <span className="mr-auto">{busy}</span> : null}
          {creatable.length > 1 ? (
            <Button variant="secondary" disabled={!!busy || creating.size > 0} onClick={() => create(creatable)}>
              {text("inzRecords.create_all")}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={!!busy} onClick={onClose}>
            {stash("actions.cancel", "Cancel")}
          </Button>
          <Button disabled={!!busy || !jobs.length} onClick={onImport}>
            {text("inzRecords.import_n", { count: jobs.length })}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  };

  /* ------------------------------------------------------------------ *
   * Dialog host: one per app, mounted with the navbar
   * ------------------------------------------------------------------ */

  let pending: ImportRequest | null = null;
  const hostListeners = new Set<() => void>();

  function openImport(request: ImportRequest) {
    if (!hostListeners.size) {
      console.warn("inzRecords: no dialog host is mounted");
      return;
    }
    pending = request;
    hostListeners.forEach((fn) => fn());
  }

  function useSubscription(listeners: Set<() => void>) {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      listeners.add(force);
      return () => {
        listeners.delete(force);
      };
    }, []);
  }

  const DialogHost: React.FC = () => {
    useSubscription(hostListeners);
    const text = useText();
    const intl = useIntl();
    menuLabel = `${text("inzRecords.import")}…`;
    generateLabel = `${intl.formatMessage({ id: "actions.generate" })}…`;
    if (!pending) return null;
    // A new object per open, so the dialog starts over
    return (
      <ImportDialog
        request={pending}
        onClose={() => {
          pending = null;
          hostListeners.forEach((fn) => fn());
        }}
      />
    );
  };

  /* ------------------------------------------------------------------ *
   * Status: what the records page and the navbar badge show
   * ------------------------------------------------------------------ */

  type FileState = "missing" | "ready" | "imported";

  interface SummaryRecord {
    site: string;
    key: string;
    title: string;
    url: string;
    date?: string;
    studio?: string;
    updatedAt: string;
    files: { name: string; kind: string }[];
  }

  interface FoundEntity {
    kind: Kind;
    id: string;
    imported: boolean;
  }

  interface FileRow {
    name: string;
    kind: string;
    found: FoundEntity[];
  }

  interface RecordRow {
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

  interface SiteRow {
    site: string;
    records: number;
    missing: number;
    ready: number;
    imported: number;
  }

  interface Status {
    records: RecordRow[];
    files: number;
    sites: number;
    last: { site: string; title: string; key: string; updatedAt: string } | null;
    counts: Record<FileState, number>;
    bySite: SiteRow[];
    checkedAt: number;
  }

  async function namesInStash(names: string[]) {
    const found = new Map<string, { kind: Kind; id: string; urls: string[] }[]>();
    for (const part of chunks(names, NAME_CHUNK)) {
      const path = basenameRegex(part);
      const [scenes, galleries] = await Promise.all([
        query("SCENE_NAMES_BY_PATH", { path }),
        query("GALLERY_NAMES_BY_PATH", { path }),
      ]);
      const items: [Kind, any][] = [
        ...scenes.findScenes.scenes.map((s: any) => ["scene", s] as [Kind, any]),
        ...galleries.findGalleries.galleries.map((g: any) => ["gallery", g] as [Kind, any]),
      ];
      for (const [kind, item] of items) {
        for (const file of item.files ?? []) {
          const key = String(file.basename).toLowerCase();
          const list = found.get(key) ?? [];
          list.push({ kind, id: String(item.id), urls: item.urls ?? [] });
          found.set(key, list);
        }
      }
    }
    return found;
  }

  async function computeStatus(): Promise<Status> {
    const summary = await runOp({ op: "summary" });
    const records: SummaryRecord[] = summary?.records ?? [];
    const names = uniq(records.flatMap((r) => r.files.map((f) => f.name.toLowerCase())));
    const inStash = await namesInStash(names);

    const counts: Record<FileState, number> = { missing: 0, ready: 0, imported: 0 };
    const sites = new Map<string, SiteRow>();
    const rows: RecordRow[] = [];
    let files = 0;

    for (const record of records) {
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
      last: summary?.last ?? null,
      counts,
      bySite: Array.from(sites.values()).sort((a, b) => a.site.localeCompare(b.site)),
      checkedAt: Date.now(),
    };
  }

  /** Scenes and galleries of these records, for the dialog; ready ones only unless `all` */
  function entitiesOf(rows: RecordRow[], all: boolean): ImportRequest {
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

  interface Cached {
    ready: number;
    at: number;
  }

  function readCache(): Cached | null {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as Cached) : null;
    } catch {
      return null;
    }
  }

  function writeCache(value: Cached) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch {
      // the badge just recomputes next time
    }
  }

  let lastStatus: Status | null = null;
  let computing: Promise<Status> | null = null;
  const statusListeners = new Set<() => void>();
  // Full records for the expanded rows; dropped on every refresh
  const recordCache = new Map<string, Promise<any>>();

  /** One computation at a time, shared by the page and the badge */
  function refreshStatus(): Promise<Status> {
    if (!computing) {
      recordCache.clear();
      computing = computeStatus()
        .then((status) => {
          lastStatus = status;
          writeCache({ ready: status.counts.ready, at: status.checkedAt });
          return status;
        })
        .finally(() => {
          computing = null;
          statusListeners.forEach((fn) => fn());
        });
      statusListeners.forEach((fn) => fn());
    }
    return computing;
  }

  function refreshIfStale() {
    const cached = readCache();
    if (cached && Date.now() - cached.at < STALE_MS) return;
    refreshStatus().catch(() => undefined);
  }

  function getRecord(row: { site: string; key: string }) {
    const id = recordId(row);
    let found = recordCache.get(id);
    if (!found) {
      found = runOp({ op: "get", site: row.site, key: row.key });
      found.catch(() => recordCache.delete(id));
      recordCache.set(id, found);
    }
    return found;
  }

  /* ------------------------------------------------------------------ *
   * Navbar icon
   * ------------------------------------------------------------------ */

  const NavButton: React.FC = () => {
    useSubscription(statusListeners);
    const text = useText();
    const { Icon } = PluginApi.components;
    const icon = PluginApi.libraries.FontAwesomeSolid.faFileImport;

    React.useEffect(() => {
      refreshIfStale();
      const timer = setInterval(refreshIfStale, STALE_MS);
      return () => clearInterval(timer);
    }, []);

    const ready = lastStatus?.counts.ready ?? readCache()?.ready ?? 0;
    return (
      <NavLink className="nav-utility" exact to={ROUTE}>
        <Button className="minimal d-flex align-items-center h-100" title={text("inzRecords.title")}>
          <Icon icon={icon} />
          {ready ? (
            <Badge pill variant="info" className="ml-1">
              {ready}
            </Badge>
          ) : null}
        </Button>
      </NavLink>
    );
  };

  PluginApi.patch.after("MainNavBar.UtilityItems", (_props: any, _context: any, result: any) => (
    <>
      <NavButton />
      <DialogHost />
      {result}
    </>
  ));

  /* ------------------------------------------------------------------ *
   * Records page
   * ------------------------------------------------------------------ */

  function ago(iso: string) {
    const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (!Number.isFinite(seconds)) return iso;
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
  }

  const fullTime = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  };

  const STATE_VARIANT: Record<FileState, string> = { ready: "info", missing: "secondary", imported: "success" };
  const STATE_TEXT: Record<FileState, TextId> = {
    ready: "inzRecords.page.ready",
    missing: "inzRecords.page.missing",
    imported: "inzRecords.page.imported",
  };

  const EntityLinks: React.FC<{ found: FoundEntity[] }> = ({ found }) => {
    const stash = useStashText();
    return (
      <>
        {found.map((e) => (
          <Link
            key={`${e.kind}:${e.id}`}
            to={entityPath(e.kind, e.id)}
            className={`inz-records-entity mr-2${e.imported ? " text-success" : ""}`}
          >
            {kindLabel(e.kind, stash).toLowerCase()} {e.id}
            {e.imported ? " ✓" : ""}
          </Link>
        ))}
      </>
    );
  };

  const RecordDetail: React.FC<{
    row: RecordRow;
    onImport: () => void;
    onDelete: () => void;
  }> = ({ row, onImport, onDelete }) => {
    const text = useText();
    const stash = useStashText();
    const { LoadingIndicator } = PluginApi.components;
    const [data, setData] = React.useState<any>(undefined);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
      let live = true;
      getRecord(row)
        .then((r) => live && setData(r))
        .catch((e) => live && setError(errorText(e)));
      return () => {
        live = false;
      };
    }, [row.id]);

    const record: InzRecords.CatalogRecord | undefined = data?.record;
    const byName = new Map(row.files.map((f) => [f.name.toLowerCase(), f]));
    const anyFound = row.files.some((f) => f.found.length);

    const field = (name: string, value: React.ReactNode) =>
      value ? (
        <>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </>
      ) : null;

    return (
      <div className="inz-records-detail">
        {error ? <div className="text-danger">{error}</div> : null}
        {data === undefined && !error ? <LoadingIndicator inline small /> : null}
        {data === null ? <div className="text-muted">{text("inzRecords.page.gone")}</div> : null}
        {record ? (
          <>
            <dl className="inz-records-dl">
              {field(stash("title", "Title"), record.title)}
              {field(stash("date", "Date"), record.date)}
              {field(stash("studio", "Studio"), record.studio)}
              {field(
                stash("performers", "Performers"),
                (record.performers ?? []).length
                  ? (record.performers ?? []).map((p) => (
                      <span key={p.name} className={`mr-2${p.ignored ? " text-muted inz-records-ignored" : ""}`}>
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noopener noreferrer">
                            {p.name}
                          </a>
                        ) : (
                          p.name
                        )}
                      </span>
                    ))
                  : null
              )}
              {field(
                stash("tags", "Tags"),
                (record.tags ?? []).length
                  ? (record.tags ?? []).map((t) => (
                      <Badge key={t} variant="secondary" className="mr-1">
                        {t}
                      </Badge>
                    ))
                  : null
              )}
              {field(
                stash("details", "Details"),
                record.description ? <div className="inz-records-description">{record.description}</div> : null
              )}
            </dl>
            <h6>{text("inzRecords.page.downloads")}</h6>
            <Table size="sm" className="inz-records-downloads">
              <tbody>
                {(record.downloads ?? []).map((d, i) => {
                  const name = R.diskName(d);
                  const file = byName.get(name.toLowerCase());
                  return (
                    <tr key={`${d.slot}|${i}`}>
                      <td className="text-muted">{d.kind}</td>
                      <td className="text-break">{name || String(d.label ?? d.slot)}</td>
                      <td className="text-muted text-nowrap">
                        {d.savedAt
                          ? text("inzRecords.page.saved", { ago: ago(d.savedAt) })
                          : text("inzRecords.page.link_only")}
                      </td>
                      <td>
                        {!d.savedAt ? null : file?.found.length ? (
                          <EntityLinks found={file.found} />
                        ) : (
                          <span className="text-muted">{text("inzRecords.page.not_found")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </>
        ) : null}
        <div className="inz-records-actions">
          <Button size="sm" disabled={!anyFound} onClick={onImport}>
            {text("inzRecords.page.import_one")}
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            {text("inzRecords.page.delete_one")}
          </Button>
        </div>
      </div>
    );
  };

  type SortBy = "updatedAt" | "title" | "site" | "state";

  interface DeleteAsk {
    rows?: RecordRow[];
    site?: SiteRow;
  }

  const DeleteDialog: React.FC<{ ask: DeleteAsk; onClose: (deleted: boolean) => void }> = ({ ask, onClose }) => {
    const text = useText();
    const stash = useStashText();
    const Toast = PluginApi.hooks.useToast();
    const [busy, setBusy] = React.useState(false);

    async function run() {
      setBusy(true);
      try {
        const result = ask.site
          ? await runOp({ op: "delete", site: ask.site.site })
          : await runOp({ op: "delete", records: (ask.rows ?? []).map((r) => ({ site: r.site, key: r.key })) });
        Toast.success(text("inzRecords.page.deleted", { count: result?.deleted ?? 0 }));
        onClose(true);
      } catch (e) {
        Toast.error(e);
        setBusy(false);
      }
    }

    return (
      <Modal show onHide={() => !busy && onClose(false)}>
        <Modal.Header closeButton={!busy}>
          <Modal.Title>{text("inzRecords.page.delete_title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>
            {ask.site
              ? text("inzRecords.page.delete_site_body", { count: ask.site.records, site: ask.site.site })
              : text("inzRecords.page.delete_body", { count: ask.rows?.length ?? 0 })}
          </p>
          {ask.rows && ask.rows.length <= 5 ? (
            <ul>
              {ask.rows.map((r) => (
                <li key={r.id} className="text-break">
                  <span className="text-muted">{r.site}</span> {r.title || r.key}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-muted mb-0">{text("inzRecords.page.delete_note")}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" disabled={busy} onClick={() => onClose(false)}>
            {stash("actions.cancel", "Cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={run}>
            {stash("actions.delete", "Delete")}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  };

  const RecordsPage: React.FC = () => {
    useSubscription(statusListeners);
    const text = useText();
    const location = useLocation();
    const { LoadingIndicator } = PluginApi.components;

    const [error, setError] = React.useState<string | null>(null);
    const [site, setSite] = React.useState("");
    const [state, setState] = React.useState<FileState | "">("");
    const [search, setSearch] = React.useState("");
    const [sort, setSort] = React.useState<{ by: SortBy; desc: boolean }>({ by: "updatedAt", desc: true });
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    const [limit, setLimit] = React.useState(PAGE_SIZE);
    const [focus, setFocus] = React.useState<string | null>(null);
    const [ask, setAsk] = React.useState<DeleteAsk | null>(null);
    const anchor = React.useRef<string | null>(null);
    const rowRefs = React.useRef(new Map<string, HTMLElement>());
    const scrolledTo = React.useRef<string | null>(null);

    /** Show one record: filters off, row open, scrolled to once */
    const focusOn = React.useCallback((id: string) => {
      setSite("");
      setState("");
      setSearch("");
      scrolledTo.current = null;
      setFocus(id);
      setExpanded((e) => new Set(e).add(id));
    }, []);

    const refresh = React.useCallback(() => {
      setError(null);
      refreshStatus().catch((e) => setError(errorText(e)));
    }, []);

    React.useEffect(refresh, []);

    // ?site=&key= (the dialog's "record" link): show that one, opened
    React.useEffect(() => {
      const params = new URLSearchParams(location.search);
      const s = params.get("site");
      const k = params.get("key");
      if (s && k) focusOn(recordId({ site: s, key: k }));
    }, [location.search]);

    const status = lastStatus;
    const checking = computing !== null;

    const visible = React.useMemo(() => {
      if (!status) return [];
      const needle = search.trim().toLowerCase();
      const list = status.records.filter(
        (r) =>
          (!site || r.site === site) && (!state || r.state === state) && (!needle || r.haystack.includes(needle))
      );
      const order = { ready: 0, missing: 1, imported: 2 };
      const cmp = (a: RecordRow, b: RecordRow) => {
        switch (sort.by) {
          case "title":
            return (a.title || a.key).localeCompare(b.title || b.key);
          case "site":
            return a.site.localeCompare(b.site) || b.updatedAt.localeCompare(a.updatedAt);
          case "state":
            return order[a.state] - order[b.state] || b.updatedAt.localeCompare(a.updatedAt);
          default:
            return a.updatedAt.localeCompare(b.updatedAt);
        }
      };
      list.sort((a, b) => (sort.desc ? -cmp(a, b) : cmp(a, b)));
      return list;
    }, [status, site, state, search, sort]);

    // The focused record: page far enough, then scroll to it once
    React.useEffect(() => {
      if (!focus || !status || scrolledTo.current === focus) return;
      const at = visible.findIndex((r) => r.id === focus);
      if (at >= limit) {
        setLimit(at + 1);
        return;
      }
      const el = rowRefs.current.get(focus);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      scrolledTo.current = focus;
    }, [focus, status, visible, limit]);

    // Selection only keeps records that still exist
    React.useEffect(() => {
      if (!status) return;
      const ids = new Set(status.records.map((r) => r.id));
      setSelected((s) => {
        const next = new Set(Array.from(s).filter((id) => ids.has(id)));
        return next.size === s.size ? s : next;
      });
    }, [status]);

    React.useEffect(() => setLimit(PAGE_SIZE), [site, state, search, sort]);

    const shown = visible.slice(0, limit);
    const selectedRows = status ? status.records.filter((r) => selected.has(r.id)) : [];
    const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

    function onCheck(id: string, shift: boolean) {
      const on = !selected.has(id);
      const next = new Set(selected);
      const ids = visible.map((r) => r.id);
      const from = anchor.current ? ids.indexOf(anchor.current) : -1;
      const to = ids.indexOf(id);
      const range = shift && from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
      for (const x of range) {
        if (on) next.add(x);
        else next.delete(x);
      }
      anchor.current = id;
      setSelected(next);
    }

    function selectAll() {
      setSelected((s) => {
        const next = new Set(s);
        for (const r of visible) {
          if (allSelected) next.delete(r.id);
          else next.add(r.id);
        }
        return next;
      });
    }

    function selectSite(name: string) {
      if (!status) return;
      setSelected((s) => {
        const next = new Set(s);
        for (const r of status.records) if (r.site === name) next.add(r.id);
        return next;
      });
    }

    const importRows = (rows: RecordRow[], all: boolean) => openImport({ ...entitiesOf(rows, all), onDone: refresh });

    const onDeleted = (deleted: boolean) => {
      setAsk(null);
      if (deleted) {
        setSelected(new Set());
        refresh();
      }
    };

    const sortHead = (by: SortBy, name: string, className?: string) => (
      <th className={className}>
        <Button
          variant="link"
          size="sm"
          className="inz-records-sort"
          onClick={() => setSort((s) => (s.by === by ? { by, desc: !s.desc } : { by, desc: by === "updatedAt" }))}
        >
          {name}
          {sort.by === by ? (sort.desc ? " ▾" : " ▴") : ""}
        </Button>
      </th>
    );

    const lastRow = status?.last ? status.records.find((r) => r.id === recordId(status.last!)) : undefined;

    return (
      <div className="container-fluid inz-records-page">
        <div className="inz-records-head">
          <h2>{text("inzRecords.title")}</h2>
          <span className="text-muted">
            {checking
              ? text("inzRecords.page.checking")
              : status
              ? text("inzRecords.page.checked", { time: new Date(status.checkedAt).toLocaleTimeString() })
              : null}
          </span>
          <Button variant="secondary" size="sm" disabled={checking} onClick={refresh}>
            {text("inzRecords.page.refresh")}
          </Button>
        </div>
        {error ? <div className="text-danger mb-2">{error}</div> : null}
        {!status ? (
          checking ? (
            <LoadingIndicator />
          ) : null
        ) : (
          <>
            <p className="mb-1">
              {text("inzRecords.page.totals", { records: status.records.length, files: status.files, sites: status.sites })}
            </p>
            <p className="text-muted">
              {status.last ? (
                <>
                  {text("inzRecords.page.last", { ago: ago(status.last.updatedAt), site: status.last.site })}{" "}
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 align-baseline"
                    onClick={() => lastRow && focusOn(lastRow.id)}
                  >
                    {status.last.title || status.last.key}
                  </Button>
                </>
              ) : (
                text("inzRecords.page.nothing_yet")
              )}
            </p>

            <div className="inz-records-states">
              {(["ready", "missing", "imported"] as FileState[]).map((s) => (
                <Button
                  key={s}
                  variant={state === s ? "primary" : "secondary"}
                  className="inz-records-state"
                  onClick={() => setState(state === s ? "" : s)}
                >
                  <span className="inz-records-state-count">{status.counts[s]}</span>
                  <span>{text(STATE_TEXT[s])}</span>
                </Button>
              ))}
              <Button
                className="inz-records-state"
                disabled={!status.counts.ready}
                onClick={() => importRows(status.records.filter((r) => r.state === "ready"), false)}
              >
                {text("inzRecords.page.import_all")}
              </Button>
            </div>

            {status.bySite.length ? (
              <details className="inz-records-sites" open={status.bySite.length <= 8}>
                <summary>
                  {text("inzRecords.page.sites")} ({status.bySite.length})
                </summary>
                <Table striped size="sm">
                  <thead>
                    <tr>
                      <th>{text("inzRecords.page.site")}</th>
                      <th className="text-right">{text("inzRecords.page.records")}</th>
                      <th className="text-right">{text("inzRecords.page.ready")}</th>
                      <th className="text-right">{text("inzRecords.page.missing")}</th>
                      <th className="text-right">{text("inzRecords.page.imported")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {status.bySite.map((s) => (
                      <tr key={s.site} className={site === s.site ? "table-active" : undefined}>
                        <td>
                          <Button
                            variant="link"
                            size="sm"
                            className="p-0"
                            onClick={() => setSite(site === s.site ? "" : s.site)}
                          >
                            {s.site}
                          </Button>
                        </td>
                        <td className="text-right">{s.records}</td>
                        <td className="text-right">{s.ready}</td>
                        <td className="text-right">{s.missing}</td>
                        <td className="text-right">{s.imported}</td>
                        <td className="text-right text-nowrap">
                          <Button variant="link" size="sm" className="py-0" onClick={() => selectSite(s.site)}>
                            {text("inzRecords.page.select_site")}
                          </Button>
                          <Button
                            variant="link"
                            size="sm"
                            className="py-0 text-danger"
                            onClick={() => setAsk({ site: s })}
                          >
                            {text("inzRecords.page.delete_site")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </details>
            ) : null}

            <div className="inz-records-filters">
              <Form.Control
                size="sm"
                type="search"
                className="inz-records-search"
                placeholder={text("inzRecords.page.search")}
                value={search}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.currentTarget.value)}
              />
              <Form.Control
                as="select"
                size="sm"
                className="inz-records-select"
                value={site}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSite(e.currentTarget.value)}
              >
                <option value="">{text("inzRecords.page.all_sites")}</option>
                {status.bySite.map((s) => (
                  <option key={s.site} value={s.site}>
                    {s.site}
                  </option>
                ))}
              </Form.Control>
              <Form.Control
                as="select"
                size="sm"
                className="inz-records-select"
                value={state}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setState(e.currentTarget.value as FileState | "")}
              >
                <option value="">{text("inzRecords.page.all_states")}</option>
                {(["ready", "missing", "imported"] as FileState[]).map((s) => (
                  <option key={s} value={s}>
                    {text(STATE_TEXT[s])}
                  </option>
                ))}
              </Form.Control>
              <span className="text-muted">
                {text("inzRecords.page.shown", { shown: shown.length, total: visible.length })}
              </span>
            </div>

            {selected.size ? (
              <div className="inz-records-bulk">
                <span>{text("inzRecords.selected", { count: selected.size })}</span>
                <Button
                  size="sm"
                  disabled={!selectedRows.some((r) => r.files.some((f) => f.found.length))}
                  onClick={() => importRows(selectedRows, true)}
                >
                  {text("inzRecords.page.import_selected", { count: selected.size })}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setAsk({ rows: selectedRows })}>
                  {text("inzRecords.page.delete_selected", { count: selected.size })}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>
                  {text("inzRecords.page.clear")}
                </Button>
              </div>
            ) : null}

            {visible.length ? (
              <Table size="sm" hover className="inz-records-table">
                <thead>
                  <tr>
                    <th className="inz-records-check-cell">
                      <Check
                        id="all"
                        checked={allSelected}
                        title={text("inzRecords.page.select_all", { count: visible.length })}
                        onChange={selectAll}
                      />
                    </th>
                    {sortHead("title", text("inzRecords.page.record"))}
                    {sortHead("site", text("inzRecords.page.site"), "d-none d-md-table-cell")}
                    {sortHead("state", text("inzRecords.page.state"))}
                    <th className="d-none d-lg-table-cell">{text("inzRecords.page.in_stash")}</th>
                    {sortHead("updatedAt", text("inzRecords.page.received"), "text-nowrap")}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const isOpen = expanded.has(row.id);
                    const link = R.parseUrl(row.url);
                    const found = row.files.flatMap((f) => f.found);
                    return (
                      <React.Fragment key={row.id}>
                        <tr
                          ref={(el: HTMLTableRowElement | null) => {
                            if (el) rowRefs.current.set(row.id, el);
                            else rowRefs.current.delete(row.id);
                          }}
                          className={focus === row.id ? "inz-records-focus" : undefined}
                        >
                          <td className="inz-records-check-cell" title={text("inzRecords.page.shift_hint")}>
                            <Check id={row.id} checked={selected.has(row.id)} onChange={(shift) => onCheck(row.id, shift)} />
                          </td>
                          <td>
                            <Button
                              variant="link"
                              size="sm"
                              className="inz-records-title"
                              onClick={() => setExpanded((e) => toggled(e, row.id))}
                            >
                              {isOpen ? "▾ " : "▸ "}
                              {row.title || row.key}
                            </Button>
                            <div className="inz-records-sub text-muted">
                              <span className="d-md-none">{row.site} · </span>
                              {[row.date, row.studio].filter(Boolean).join(" · ")}
                              {row.date || row.studio ? " · " : ""}
                              {link ? (
                                <a href={row.url} target="_blank" rel="noopener noreferrer">
                                  {`${link.host}${link.pathname}`}
                                </a>
                              ) : (
                                row.url
                              )}
                            </div>
                          </td>
                          <td className="d-none d-md-table-cell">{row.site}</td>
                          <td>
                            <Badge variant={STATE_VARIANT[row.state]}>{text(STATE_TEXT[row.state])}</Badge>
                          </td>
                          <td className="d-none d-lg-table-cell">
                            <EntityLinks found={found} />
                          </td>
                          <td className="text-nowrap text-muted" title={fullTime(row.updatedAt)}>
                            {ago(row.updatedAt)}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="inz-records-detail-row">
                            <td />
                            <td colSpan={5}>
                              <RecordDetail
                                row={row}
                                onImport={() => importRows([row], true)}
                                onDelete={() => setAsk({ rows: [row] })}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </Table>
            ) : (
              <p className="text-muted">{text("inzRecords.page.no_match")}</p>
            )}
            {visible.length > shown.length ? (
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                {text("inzRecords.page.more", { count: Math.min(PAGE_SIZE, visible.length - shown.length) })}
              </Button>
            ) : null}
          </>
        )}
        {ask ? <DeleteDialog ask={ask} onClose={onDeleted} /> : null}
      </div>
    );
  };

  PluginApi.register.route(ROUTE, RecordsPage);

  // Settings > Plugins: a way in from the plugin's own block
  const SettingsLink: React.FC = () => {
    const text = useText();
    return (
      <div className="setting">
        <div>
          <h3>{text("inzRecords.title")}</h3>
        </div>
        <div>
          <Link className="btn btn-secondary btn-sm" to={ROUTE}>
            {text("inzRecords.settings.open")}
          </Link>
        </div>
      </div>
    );
  };

  PluginApi.patch.after("PluginSettings", (props: any, _context: any, result: any) =>
    props?.pluginID === PLUGIN_ID ? (
      <>
        {result}
        <SettingsLink />
      </>
    ) : (
      result
    )
  );

  /* ------------------------------------------------------------------ *
   * Walking a rendered tree (as in inzVrGenerate), plus props.tree: that is
   * where a wrapper of another plugin keeps the tree it was handed.
   * ------------------------------------------------------------------ */

  const MAX_DEPTH = 24;

  function replaceElement(node: any, match: (el: any) => any | null, depth = 0): { node: any; found: boolean } {
    if (depth > MAX_DEPTH || node === null || node === undefined || typeof node !== "object") {
      return { node, found: false };
    }

    if (Array.isArray(node)) {
      let found = false;
      const next = node.map((child) => {
        if (found) return child;
        const result = replaceElement(child, match, depth + 1);
        found = found || result.found;
        return result.node;
      });
      return found ? { node: next, found } : { node, found: false };
    }

    if (!React.isValidElement(node)) return { node, found: false };

    const replacement = match(node);
    if (replacement) return { node: replacement, found: true };

    const props = (node as any).props ?? {};
    const children = replaceElement(props.children, match, depth + 1);
    if (children.found) return { node: React.cloneElement(node as any, undefined, children.node), found: true };

    if (props.tree) {
      const tree = replaceElement(props.tree, match, depth + 1);
      if (tree.found) return { node: React.cloneElement(node as any, { tree: tree.node }), found: true };
    }

    return { node, found: false };
  }

  function safely<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      console.warn("inzRecords: patch skipped", e);
      return fallback;
    }
  }

  /* ------------------------------------------------------------------ *
   * Scene page: an item after "Generate…" in the … menu
   * ------------------------------------------------------------------ */

  PluginApi.patch.after("ScenePage", (props: any, _context: any, result: any) => {
    const sceneId = props?.scene?.id;
    if (!sceneId) return result;
    return safely(
      () =>
        replaceElement(result, (el) => {
          const children = (el as any).props?.children;
          if (!Array.isArray(children)) return null;
          const at = children.findIndex((c: any) => React.isValidElement(c) && (c as any).key === "generate");
          if (at < 0) return null;
          const next = children.slice();
          next.splice(
            at + 1,
            0,
            <Dropdown.Item
              key="inz-records-import"
              className="bg-secondary text-white"
              onClick={() => openImport({ scenes: [String(sceneId)] })}
            >
              <MenuLabel />
            </Dropdown.Item>
          );
          return React.cloneElement(el as any, undefined, next);
        }).node,
      result
    );
  });

  /* ------------------------------------------------------------------ *
   * Scene and gallery lists: an operation for the selection
   * ------------------------------------------------------------------ */

  function patchList(kind: Kind) {
    return (_props: any, _context: any, result: any) =>
      safely(
        () =>
          replaceElement(result, (el) => {
            // FilteredListToolbar: holds the selection and the … menu element
            const props = (el as any).props;
            const ops = props?.operationComponent;
            if (!props?.listSelect || !React.isValidElement(ops)) return null;
            const selected: Set<string> = props.listSelect.selectedIds ?? new Set();
            const existing: any[] = (ops as any).props?.operations ?? [];
            const entry = {
              text: menuLabel,
              onClick: () => {
                const ids = Array.from(selected);
                openImport(kind === "scene" ? { scenes: ids } : { galleries: ids });
              },
              isDisplayed: () => selected.size > 0,
            };
            const at = existing.findIndex((o) => o?.text === generateLabel);
            const operations = existing.slice();
            operations.splice(at < 0 ? operations.length : at + 1, 0, entry);
            return React.cloneElement(el as any, {
              operationComponent: React.cloneElement(ops as any, { operations }),
            });
          }).node,
        result
      );
  }

  PluginApi.patch.after("FilteredSceneList", patchList("scene"));
  PluginApi.patch.after("FilteredGalleryList", patchList("gallery"));

  /* ------------------------------------------------------------------ *
   * Gallery page: the header menu is not patchable, so the item is put into
   * the DOM. Hosted by whichever right-hand panel is mounted (the tab
   * container unmounts the other); both get `gallery` in props.
   *
   * react-bootstrap 1.6 renders the menu on first open, hence the observer.
   * Appending a node React does not own is safe here: it places its own nodes
   * with insertBefore relative to their own siblings.
   * ------------------------------------------------------------------ */

  const GalleryMenuItem: React.FC<{ galleryId: string }> = ({ galleryId }) => {
    const text = useText();
    const intl = useIntl();

    React.useEffect(() => {
      const generate = `${intl.formatMessage({ id: "actions.generate" })}…`;
      const label = `${text("inzRecords.import")}…`;
      let inserted: HTMLElement | null = null;
      let warned = false;

      const place = () => {
        const toggle = document.getElementById("operation-menu");
        const menu = toggle?.parentElement?.querySelector(":scope > .dropdown-menu");
        if (!toggle || !menu || menu.querySelector("[data-inz-records]")) return;

        const anchor = Array.from(menu.children).find((c) => c.textContent === generate);
        if (!anchor) {
          if (!warned) console.warn("inzRecords: no Generate… item in the gallery menu; entry not added");
          warned = true;
          return;
        }

        const item = document.createElement("a");
        item.className = "dropdown-item bg-secondary text-white";
        item.href = "#";
        item.setAttribute("role", "button");
        item.dataset.inzRecords = "1";
        item.textContent = label;
        item.addEventListener("click", (event) => {
          event.preventDefault();
          toggle.click(); // closes the menu
          openImport({ galleries: [galleryId] });
        });
        anchor.after(item);
        inserted = item;
      };

      const observer = new MutationObserver(place);
      observer.observe(document.body, { childList: true, subtree: true });
      place();
      return () => {
        observer.disconnect();
        inserted?.remove();
      };
    }, [galleryId, intl, text]);

    return null;
  };

  function patchGalleryPanel(props: any, _context: any, result: any) {
    const id = props?.gallery?.id;
    if (!id) return result;
    return (
      <>
        {result}
        <GalleryMenuItem galleryId={String(id)} />
      </>
    );
  }

  PluginApi.patch.after("GalleryImagesPanel", patchGalleryPanel);
  PluginApi.patch.after("GalleryAddPanel", patchGalleryPanel);
})();
