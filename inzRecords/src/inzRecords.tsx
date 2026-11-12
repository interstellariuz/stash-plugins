/**
 * UI half of Download Records.
 *
 * The site userscripts push a record to the backend on every download. This
 * side matches records to scenes and galleries by file name, shows a
 * "before -> after" preview and applies it:
 *
 *   - "Import from records…" in a scene's and a gallery's … menu;
 *   - the same entry in the scene and gallery list menus, for a selection;
 *   - /plugin/records: a status page, reached from a navbar icon and from the
 *     plugin's block in Settings > Plugins.
 *
 * The dialog lives in one host mounted with the navbar, so the menu patches
 * stay pure element edits: no wrapper components that would hide the tree from
 * another plugin patching the same menu (inzVrGenerate does).
 */

type PatchFn = (target: string, fn: (...args: any[]) => any) => void;
type Component = React.FC<any>;

interface IPluginApi {
  React: typeof React;
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
    ReactRouterDOM: { Link: Component; NavLink: Component };
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
  const { Link, NavLink } = PluginApi.libraries.ReactRouterDOM;
  const { useIntl } = PluginApi.libraries.Intl;
  const StashService = PluginApi.utils.StashService;
  const R = InzRecords;

  const PLUGIN_ID = "inzRecords";
  const ROUTE = "/plugin/records";
  const CACHE_KEY = "inzRecords.status";
  const STALE_MS = 10 * 60 * 1000;
  // Names per findScenes/findGalleries regex
  const NAME_CHUNK = 100;

  /* ------------------------------------------------------------------ *
   * Strings: a server catalogue entry with the same id wins, as in
   * inzVrGenerate. {name} placeholders are filled in here.
   * ------------------------------------------------------------------ */

  const TEXT = {
    "inzRecords.title": "Download Records",
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
    "inzRecords.none": "(none)",
    "inzRecords.source": "Source",
    "inzRecords.link_gallery": "Link gallery",
    "inzRecords.link_scene": "Link scene",
    "inzRecords.linked": "already linked",
    "inzRecords.own_row": "fields in its own row",
    "inzRecords.fields": "fields",
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
    "inzRecords.page.last": "Last received {ago} · {site} · {title}",
    "inzRecords.page.nothing_yet": "Nothing received yet.",
    "inzRecords.page.ready": "Ready to import",
    "inzRecords.page.missing": "Not in Stash yet",
    "inzRecords.page.imported": "Imported",
    "inzRecords.page.import_all": "Import all ready",
    "inzRecords.page.files": "files",
    "inzRecords.page.site": "site",
    "inzRecords.page.records": "records",
    "inzRecords.page.checked": "Checked {time}",
    "inzRecords.page.refresh": "Refresh",
    "inzRecords.page.checking": "Checking…",
    "inzRecords.settings.open": "Open the status page",
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

  async function lookup(names: string[]): Promise<Map<string, Hit[]>> {
    const out = new Map<string, Hit[]>();
    const unique = Array.from(new Set(names.map((n) => n.toLowerCase())));
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

  function entryOf(hit: Hit): InzRecords.Entry {
    return { url: hit.record?.id ?? hit.key, record: hit.record, download: hit.download };
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
    return Array.from(new Set(names));
  }

  /* ------------------------------------------------------------------ *
   * The import plan
   * ------------------------------------------------------------------ */

  interface Related {
    // parent key > entity key: the nested row's own switch
    key: string;
    entity: Entity;
    entry: InzRecords.Entry;
    link: { scene: string; gallery: string } | null;
    // fields are shown and applied under this parent (first one to reach it)
    owner: boolean;
    isTarget: boolean;
  }

  interface PlanNode {
    entity: Entity;
    candidates: Hit[];
    entry: InzRecords.Entry | null;
    related: Related[];
  }

  interface FieldRow {
    field: string;
    label: string;
    before: string;
    after: string;
    replaces: boolean;
    added?: string[];
    // custom_fields.source: always applied with the entity, no switch
    fixed?: boolean;
    patch: Record<string, unknown>;
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

  const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  type Labels = (field: string) => string;

  function diffRows(entity: Entity, built: InzRecords.Input, dicts: Dictionaries, label: Labels): FieldRow[] {
    const rows: FieldRow[] = [];
    const scalar = (field: string, before: string) => {
      const after = built[field];
      if (typeof after !== "string" || after === before) return;
      rows.push({ field, label: label(field), before, after, replaces: before !== "", patch: { [field]: after } });
    };

    scalar("title", entity.title);
    scalar("code", entity.code);
    scalar("date", entity.date);
    scalar("details", entity.details);

    const urls = built.urls as string[] | undefined;
    if (urls && !sameList(urls, entity.urls)) {
      rows.push({
        field: "urls",
        label: label("urls"),
        before: entity.urls.join(", "),
        after: urls.join(", "),
        replaces: entity.urls.length > 0,
        patch: { urls },
      });
    }

    const studio = built.studio_id as string | undefined;
    if (studio && studio !== entity.studio?.id) {
      rows.push({
        field: "studio_id",
        label: label("studio"),
        before: entity.studio?.name ?? "",
        after: dicts.names.studios.get(studio) ?? studio,
        replaces: !!entity.studio,
        patch: { studio_id: studio },
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
        before: "",
        after: "",
        replaces: false,
        added: added.map((id) => dicts.names[kind].get(id) ?? id),
        patch: { [field]: ids },
      });
    }

    const custom = built.custom_fields as { full: Record<string, unknown> } | undefined;
    const source = custom?.full?.source;
    if (custom && source !== entity.custom_fields?.source) {
      rows.push({
        field: "custom_fields",
        label: label("source"),
        before: String(entity.custom_fields?.source ?? ""),
        after: String(source ?? ""),
        replaces: entity.custom_fields?.source != null,
        fixed: true,
        patch: { custom_fields: custom },
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
      return { entity, candidates, entry: chosen ? entryOf(chosen) : null, related: [] };
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
  function buildPlans(nodes: PlanNode[], dicts: Dictionaries, label: Labels): Map<string, EntityPlan> {
    const plans = new Map<string, EntityPlan>();
    const add = (entity: Entity, entry: InzRecords.Entry) => {
      const built = R.buildInput(entity, entry, dicts.indexes);
      plans.set(entity.key, {
        rows: diffRows(entity, built.input, dicts, label),
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

  interface Selection {
    excluded: Set<string>; // entity keys and nested keys
    off: Set<string>; // `${entityKey}|${field}`
  }

  interface Job {
    key: string;
    kind: Kind;
    input: Record<string, unknown>;
    links: number;
  }

  /** What Import sends, given the switches */
  function buildJobs(nodes: PlanNode[], plans: Map<string, EntityPlan>, sel: Selection): Job[] {
    const jobs = new Map<string, Job>();
    const scenes = new Map<string, Entity>();
    const newLinks = new Map<string, Set<string>>(); // scene id -> gallery ids

    const take = (entity: Entity) => {
      const plan = plans.get(entity.key);
      if (!plan) return;
      const input: Record<string, unknown> = { id: entity.id };
      for (const row of plan.rows) {
        if (row.fixed || !sel.off.has(`${entity.key}|${row.field}`)) Object.assign(input, row.patch);
      }
      // A source line alone is not worth a write
      const real = plan.rows.some((row) => !row.fixed && !sel.off.has(`${entity.key}|${row.field}`));
      if (real) jobs.set(entity.key, { key: entity.key, kind: entity.kind, input, links: 0 });
    };

    for (const node of nodes) {
      if (!node.entry || sel.excluded.has(node.entity.key)) continue;
      take(node.entity);
      for (const rel of node.related) {
        if (sel.excluded.has(rel.key)) continue;
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
      job.input.gallery_ids = Array.from(new Set([...scene.linked, ...galleries]));
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

  function collectMisses(nodes: PlanNode[], plans: Map<string, EntityPlan>, sel: Selection): Miss[] {
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
      if (!node.entry || sel.excluded.has(node.entity.key)) continue;
      add(node.entity.key);
      for (const rel of node.related) if (rel.owner && !sel.excluded.has(rel.key)) add(rel.entity.key);
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

  const Check: React.FC<{ id: string; checked: boolean; disabled?: boolean; onChange: () => void }> = ({
    id,
    checked,
    disabled,
    onChange,
  }) => (
    <Form.Check
      id={`inz-records-${id}`}
      className="inz-records-check"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
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

  const FieldRows: React.FC<{
    entity: Entity;
    plan: EntityPlan | undefined;
    sel: Selection;
    disabled: boolean;
    onToggle: (key: string) => void;
  }> = ({ entity, plan, sel, disabled, onToggle }) => {
    const text = useText();
    if (!plan?.rows.length) return null;
    return (
      <div className="inz-records-fields">
        {plan.rows.map((row) => {
          const key = `${entity.key}|${row.field}`;
          return (
            <div key={row.field} className={`inz-records-field${row.fixed ? " text-muted" : ""}`}>
              <span>
                {row.fixed ? null : (
                  <Check id={key} checked={!sel.off.has(key)} disabled={disabled} onChange={() => onToggle(key)} />
                )}
              </span>
              <span className="inz-records-label">{row.label}</span>
              {row.added ? (
                <span className="inz-records-added">
                  {row.added.map((name) => (
                    <Badge key={name} variant="secondary" className="mr-1">
                      + {name}
                    </Badge>
                  ))}
                </span>
              ) : (
                <>
                  <span className="inz-records-before text-muted">{row.before || text("inzRecords.empty")}</span>
                  <span className="inz-records-arrow">→</span>
                  <span className="inz-records-after">{row.after}</span>
                  {row.replaces ? (
                    <Badge variant="warning" className="inz-records-replaces">
                      {text("inzRecords.replaces")}
                    </Badge>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const RecordLink: React.FC<{ url: string }> = ({ url }) => {
    const link = R.parseUrl(url);
    if (!link) return null;
    return (
      <a className="inz-records-url text-muted" href={url} target="_blank" rel="noopener noreferrer">
        {`${link.host}${link.pathname}`}
      </a>
    );
  };

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
    const [choices, setChoices] = React.useState<Map<string, string>>(new Map());
    const [sel, setSel] = React.useState<Selection>({ excluded: new Set(), off: new Set() });
    const [open, setOpen] = React.useState<Set<string>>(new Set());
    const [busy, setBusy] = React.useState<string | null>(null);
    const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
    const [creating, setCreating] = React.useState<Set<string>>(new Set());

    const requested = (request.scenes?.length ?? 0) + (request.galleries?.length ?? 0);

    // Stage one: entities, their records, the dictionaries
    React.useEffect(() => {
      let live = true;
      (async () => {
        const [scenes, galleries, loaded] = await Promise.all([
          loadEntities("scene", Array.from(new Set(request.scenes ?? []))),
          loadEntities("gallery", Array.from(new Set(request.galleries ?? []))),
          loadDictionaries(),
        ]);
        const targets = [...scenes, ...galleries];
        const hits = await lookup(targets.flatMap((e) => e.basenames));
        if (!live) return;
        baseRef.current = { targets, hits, related: new Map() };
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
      () => (nodes && dicts ? buildPlans(nodes, dicts, label) : new Map<string, EntityPlan>()),
      [nodes, dicts, label]
    );
    const jobs = React.useMemo(() => (nodes ? buildJobs(nodes, plans, sel) : []), [nodes, plans, sel]);
    const misses = React.useMemo(() => (nodes ? collectMisses(nodes, plans, sel) : []), [nodes, plans, sel]);

    const status = (node: PlanNode) => {
      if (!node.entry) return node.candidates.length > 1 ? "conflict" : "none";
      const own = plans.get(node.entity.key)?.rows.some((r) => !r.fixed) ?? false;
      const rel = node.related.some(
        (r) => r.link || (r.owner && plans.get(r.entity.key)?.rows.some((row) => !row.fixed))
      );
      return own || rel ? "ready" : "current";
    };

    const counts = { ready: 0, current: 0, none: 0, conflict: 0 };
    for (const node of nodes ?? []) counts[status(node)] += 1;

    const toggleExcluded = (key: string) => setSel((s) => ({ ...s, excluded: toggled(s.excluded, key) }));
    const toggleOff = (key: string) => setSel((s) => ({ ...s, off: toggled(s.off, key) }));
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

    function renderRelated(node: PlanNode, rel: Related, parentOff: boolean) {
      const plan = plans.get(rel.entity.key);
      const hasFields = rel.owner && !!plan?.rows.some((r) => !r.fixed);
      if (!rel.link && !hasFields) return null;
      const off = parentOff || sel.excluded.has(rel.key);
      const isOpen = open.has(rel.key);
      const linkLabel = rel.entity.kind === "gallery" ? text("inzRecords.link_gallery") : text("inzRecords.link_scene");
      return (
        <div key={rel.key} className="inz-records-related">
          <div className="inz-records-row">
            <Check id={rel.key} checked={!off} disabled={parentOff || !!busy} onChange={() => toggleExcluded(rel.key)} />
            <span>
              {rel.link ? linkLabel : kindLabel(rel.entity.kind, stash)} {rel.entity.id} {entityName(rel.entity)}
              {rel.link ? null : <span className="text-muted"> · {text("inzRecords.linked")}</span>}
            </span>
            {hasFields ? (
              <Button variant="link" size="sm" className="inz-records-caret" onClick={() => toggleOpen(rel.key)}>
                {isOpen ? "▾" : "▸"} {text("inzRecords.fields")}
              </Button>
            ) : rel.isTarget ? (
              <span className="text-muted">· {text("inzRecords.own_row")}</span>
            ) : null}
            {errors.has(rel.entity.key) ? <span className="text-danger">✗ {errors.get(rel.entity.key)}</span> : null}
          </div>
          {hasFields && isOpen ? (
            <FieldRows entity={rel.entity} plan={plan} sel={sel} disabled={off || !!busy} onToggle={toggleOff} />
          ) : null}
        </div>
      );
    }

    function renderNode(node: PlanNode) {
      const entity = node.entity;
      const head = (
        <>
          {kindLabel(entity.kind, stash)} {entity.id} <strong>{entityName(entity)}</strong>
        </>
      );
      const st = status(node);
      const failed = errors.get(entity.key);

      if (st === "none") {
        return (
          <div key={entity.key} className="inz-records-row text-muted">
            <span className="inz-records-mark">✗</span>
            <span>{head}</span>
            <span>{text("inzRecords.no_record_for", { name: entity.basenames[0] ?? "—" })}</span>
          </div>
        );
      }

      if (st === "conflict") {
        return (
          <div key={entity.key} className="inz-records-row">
            <span className="inz-records-mark text-warning">⚠</span>
            <span>{head}</span>
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

      if (st === "current") {
        return (
          <div key={entity.key} className="inz-records-row text-muted">
            <span className="inz-records-mark">–</span>
            <span>{head}</span>
            <span>{text("inzRecords.up_to_date")}</span>
            {chooser}
          </div>
        );
      }

      const off = sel.excluded.has(entity.key);
      const isOpen = open.has(entity.key);
      const plan = plans.get(entity.key);
      const summary = (plan?.rows ?? []).filter((r) => !r.fixed).map((r) => r.label);
      const link = node.related.find((r) => r.link);
      if (link) {
        const id = link.entity.kind === "gallery" ? "inzRecords.link_gallery" : "inzRecords.link_scene";
        summary.push(text(id).toLowerCase());
      }

      return (
        <div key={entity.key} className="inz-records-node">
          <div className="inz-records-row">
            <Check id={entity.key} checked={!off} disabled={!!busy} onChange={() => toggleExcluded(entity.key)} />
            <Button variant="link" size="sm" className="inz-records-caret" onClick={() => toggleOpen(entity.key)}>
              {isOpen ? "▾" : "▸"}
            </Button>
            <span>{head}</span>
            <RecordLink url={node.entry!.url} />
            {isOpen ? null : <span className="text-muted inz-records-summary">{summary.join(" · ")}</span>}
            {chooser}
            {failed ? <span className="text-danger">✗ {failed}</span> : null}
          </div>
          {isOpen ? (
            <>
              <FieldRows entity={entity} plan={plan} sel={sel} disabled={off || !!busy} onToggle={toggleOff} />
              <div className="inz-records-fields">
                {node.related.map((rel) => renderRelated(node, rel, off))}
              </div>
            </>
          ) : null}
        </div>
      );
    }

    const creatable = misses.filter((m) => m.status === "missing");
    const loading = !error && !nodes;

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
              <div className="inz-records-counts">
                {[
                  counts.ready ? `${counts.ready} ${text("inzRecords.ready")}` : "",
                  counts.current ? `${counts.current} ${text("inzRecords.up_to_date")}` : "",
                  counts.none ? `${counts.none} ${text("inzRecords.no_record")}` : "",
                  counts.conflict ? `${counts.conflict} ${text("inzRecords.conflicts")}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || text("inzRecords.nothing")}
              </div>
              {nodes.map(renderNode)}
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
   * Status: what the admin page and the navbar badge show
   * ------------------------------------------------------------------ */

  type FileState = "missing" | "ready" | "imported";

  interface SummaryRecord {
    site: string;
    key: string;
    title: string;
    url: string;
    updatedAt: string;
    files: { name: string; kind: string }[];
  }

  interface Status {
    records: number;
    files: number;
    sites: number;
    last: { site: string; title: string; key: string; updatedAt: string } | null;
    counts: Record<FileState, number>;
    bySite: ({ site: string; records: number } & Record<FileState, number>)[];
    missingFiles: { site: string; name: string; title: string }[];
    ready: { scenes: string[]; galleries: string[] };
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
    const names = Array.from(new Set(records.flatMap((r) => r.files.map((f) => f.name.toLowerCase()))));
    const inStash = await namesInStash(names);

    const counts: Record<FileState, number> = { missing: 0, ready: 0, imported: 0 };
    const sites = new Map<string, { site: string; records: number } & Record<FileState, number>>();
    const missingFiles: Status["missingFiles"] = [];
    const readyScenes = new Set<string>();
    const readyGalleries = new Set<string>();
    let files = 0;

    for (const record of records) {
      const link = R.parseUrl(record.url);
      const page = link ? R.recordUrls(link)[0] : null;
      let ready = false;
      let found = 0;
      let imported = 0;

      for (const file of record.files) {
        files += 1;
        const entities = inStash.get(file.name.toLowerCase()) ?? [];
        if (!entities.length) {
          missingFiles.push({ site: record.site, name: file.name, title: record.title });
          continue;
        }
        found += 1;
        const todo = entities.filter((e) => !page || !e.urls.includes(page));
        if (todo.length) {
          ready = true;
          for (const e of todo) (e.kind === "scene" ? readyScenes : readyGalleries).add(e.id);
        } else imported += 1;
      }

      const state: FileState = ready ? "ready" : found && imported === found ? "imported" : "missing";
      counts[state] += 1;
      const site = sites.get(record.site) ?? { site: record.site, records: 0, missing: 0, ready: 0, imported: 0 };
      site.records += 1;
      site[state] += 1;
      sites.set(record.site, site);
    }

    return {
      records: records.length,
      files,
      sites: sites.size,
      last: summary?.last ?? null,
      counts,
      bySite: Array.from(sites.values()).sort((a, b) => a.site.localeCompare(b.site)),
      missingFiles,
      ready: { scenes: Array.from(readyScenes), galleries: Array.from(readyGalleries) },
      checkedAt: Date.now(),
    };
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

  /** One computation at a time, shared by the page and the badge */
  function refreshStatus(): Promise<Status> {
    if (!computing) {
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
   * Status page
   * ------------------------------------------------------------------ */

  function ago(iso: string) {
    const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (!Number.isFinite(seconds)) return iso;
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
  }

  const RecordsPage: React.FC = () => {
    useSubscription(statusListeners);
    const text = useText();
    const { LoadingIndicator } = PluginApi.components;
    const [error, setError] = React.useState<string | null>(null);
    const [showMissing, setShowMissing] = React.useState(false);

    const refresh = React.useCallback(() => {
      setError(null);
      refreshStatus().catch((e) => setError(errorText(e)));
    }, []);

    React.useEffect(refresh, []);

    const status = lastStatus;
    const checking = computing !== null;

    return (
      <div className="container inz-records-page">
        <h2>{text("inzRecords.title")}</h2>
        {error ? <div className="text-danger mb-2">{error}</div> : null}
        {!status ? (
          checking ? <LoadingIndicator /> : null
        ) : (
          <>
            <p className="mb-1">
              {text("inzRecords.page.totals", { records: status.records, files: status.files, sites: status.sites })}
            </p>
            <p className="text-muted">
              {status.last
                ? text("inzRecords.page.last", {
                    ago: ago(status.last.updatedAt),
                    site: status.last.site,
                    title: status.last.title || status.last.key,
                  })
                : text("inzRecords.page.nothing_yet")}
            </p>

            <Table size="sm" className="inz-records-states">
              <tbody>
                <tr>
                  <td>{text("inzRecords.page.ready")}</td>
                  <td className="text-right">{status.counts.ready}</td>
                  <td>
                    <Button
                      size="sm"
                      disabled={!status.counts.ready}
                      onClick={() =>
                        openImport({ scenes: status.ready.scenes, galleries: status.ready.galleries, onDone: refresh })
                      }
                    >
                      {text("inzRecords.page.import_all")}
                    </Button>
                  </td>
                </tr>
                <tr>
                  <td>{text("inzRecords.page.missing")}</td>
                  <td className="text-right">{status.counts.missing}</td>
                  <td>
                    {status.missingFiles.length ? (
                      <Button variant="link" size="sm" onClick={() => setShowMissing(!showMissing)}>
                        {showMissing ? "▾" : "▸"} {text("inzRecords.page.files")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
                {showMissing ? (
                  <tr>
                    <td colSpan={3}>
                      {status.missingFiles.map((f) => (
                        <div key={`${f.site}|${f.name}`} className="text-break">
                          <span className="text-muted">{f.site}</span> {f.name}
                        </div>
                      ))}
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <td>{text("inzRecords.page.imported")}</td>
                  <td className="text-right">{status.counts.imported}</td>
                  <td />
                </tr>
              </tbody>
            </Table>

            <Table striped size="sm" className="inz-records-sites">
              <thead>
                <tr>
                  <th>{text("inzRecords.page.site")}</th>
                  <th className="text-right">{text("inzRecords.page.records")}</th>
                  <th className="text-right">{text("inzRecords.page.ready")}</th>
                  <th className="text-right">{text("inzRecords.page.missing")}</th>
                  <th className="text-right">{text("inzRecords.page.imported")}</th>
                </tr>
              </thead>
              <tbody>
                {status.bySite.map((s) => (
                  <tr key={s.site}>
                    <td>{s.site}</td>
                    <td className="text-right">{s.records}</td>
                    <td className="text-right">{s.ready}</td>
                    <td className="text-right">{s.missing}</td>
                    <td className="text-right">{s.imported}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
        <div className="text-muted">
          {checking
            ? text("inzRecords.page.checking")
            : status
            ? text("inzRecords.page.checked", { time: new Date(status.checkedAt).toLocaleTimeString() })
            : null}{" "}
          <Button variant="secondary" size="sm" disabled={checking} onClick={refresh}>
            {text("inzRecords.page.refresh")}
          </Button>
        </div>
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
