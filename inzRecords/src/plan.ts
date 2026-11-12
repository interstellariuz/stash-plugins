/**
 * The import plan: which record goes with which scene or gallery, what each
 * field would become, and what Import sends given the dialog's switches and
 * edits. No Stash calls here (the one lookup is passed in), so it is tested
 * as is.
 */

import { escapeRegExp, uniq } from "../../shared/util";
import { ROUTE } from "./ids";
import * as R from "./records";

/* -- Entities -------------------------------------------------------------- */

export type Kind = "scene" | "gallery";

export interface Ref {
  id: string;
  name: string;
}

export interface Entity {
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

export const entityKey = (kind: Kind, id: string) => `${kind}:${id}`;
export const entityPath = (kind: Kind, id: string) => `/${kind === "scene" ? "scenes" : "galleries"}/${id}`;
export const otherKind = (kind: Kind): Kind => (kind === "scene" ? "gallery" : "scene");

export function toEntity(kind: Kind, raw: any): Entity {
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

export function entityName(entity: Entity) {
  return entity.title || entity.basenames[0] || "";
}

/** A path regex for "basename is one of these"; either separator, any case */
export function basenameRegex(names: string[]) {
  return `(?i)(^|[/\\\\])(${names.map(escapeRegExp).join("|")})$`;
}

/* -- Dictionaries ---------------------------------------------------------- */

export interface Dictionaries {
  indexes: R.Indexes;
  names: Record<R.DictKind, Map<string, string>>;
}

export function buildDictionaries(lists: Record<R.DictKind, R.Named[]>): Dictionaries {
  const byId = (items: R.Named[]) => new Map(items.map((i) => [String(i.id), i.name]));
  return {
    indexes: {
      studios: R.buildIndex("studios", lists.studios),
      tags: R.buildIndex("tags", lists.tags),
      performers: R.buildIndex("performers", lists.performers),
    },
    names: { studios: byId(lists.studios), tags: byId(lists.tags), performers: byId(lists.performers) },
  };
}

/* -- Records --------------------------------------------------------------- */

export interface Hit {
  site: string;
  key: string;
  record: R.CatalogRecord;
  download: R.Download | null;
}

export const recordId = (hit: { site: string; key: string }) => `${hit.site}\n${hit.key}`;
export const recordPath = (hit: { site: string; key: string }) =>
  `${ROUTE}?${new URLSearchParams({ site: hit.site, key: hit.key }).toString()}`;

/** Every record a file of this entity belongs to, first file first */
export function candidatesFor(entity: Entity, hits: Map<string, Hit[]>): Hit[] {
  const seen = new Map<string, Hit>();
  for (const basename of entity.basenames) {
    for (const hit of hits.get(basename.toLowerCase()) ?? []) {
      if (!seen.has(recordId(hit))) seen.set(recordId(hit), hit);
    }
  }
  return Array.from(seen.values());
}

/** The download of a record that names one of the entity's files */
export function downloadFor(record: R.CatalogRecord, entity: Entity) {
  const names = new Set(entity.basenames.map((b) => b.toLowerCase()));
  return (
    (record.downloads ?? []).find(
      (d) => (d.xName && names.has(d.xName.toLowerCase())) || (d.savedName && names.has(d.savedName.toLowerCase()))
    ) ?? null
  );
}

/** File names of the other kind in the same record: photo sets for a scene, videos for a gallery */
export function relatedNames(record: R.CatalogRecord, kind: Kind): string[] {
  const want = kind === "scene" ? "photo" : "video";
  const names: string[] = [];
  for (const d of record.downloads ?? []) {
    if (d.kind !== want) continue;
    for (const name of [d.xName, d.savedName]) if (name) names.push(name.toLowerCase());
  }
  return uniq(names);
}

/* -- The plan -------------------------------------------------------------- */

// An entry plus where it came from, so the dialog can point at the record
export interface Source extends R.Entry {
  site: string;
  key: string;
}

export function sourceOf(hit: Hit): Source {
  return { site: hit.site, key: hit.key, url: hit.record?.id ?? hit.key, record: hit.record, download: hit.download };
}

export interface Related {
  // parent key > entity key: the nested row's own switch
  key: string;
  entity: Entity;
  entry: Source;
  link: { scene: string; gallery: string } | null;
  // fields are shown and applied under this parent (first one to reach it)
  owner: boolean;
  isTarget: boolean;
}

export interface PlanNode {
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
export type RowType = "text" | "multiline" | "urls" | "studio" | "list" | "source";

export interface FieldRow {
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

export interface EntityPlan {
  rows: FieldRow[];
  skipped: R.Skipped[];
  record: R.CatalogRecord;
}

export interface Base {
  targets: Entity[];
  hits: Map<string, Hit[]>;
  related: Map<string, Entity[]>; // `${kind}|${name}` -> entities
}

export type Labels = (field: string) => string;

/** Plugin settings (inzRecords.yml) */
export interface Settings {
  // custom_fields.source starts switched on
  source: boolean;
}

export function parseSettings(raw: Record<string, unknown>): Settings {
  return { source: raw.skipSource !== true };
}

export function diffRows(
  entity: Entity,
  built: R.Input,
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

/** Entities of one kind whose files carry these names, keyed by lower-case name */
export type FindByNames = (kind: Kind, names: string[]) => Promise<Map<string, Entity[]>>;

/** Stage two: records chosen, related entities found (and cached in base) */
export async function resolveNodes(
  base: Base,
  choices: Map<string, string>,
  findByNames: FindByNames
): Promise<PlanNode[]> {
  const targetKeys = new Set(base.targets.map((e) => e.key));
  const nodes: PlanNode[] = base.targets.map((entity) => {
    const candidates = candidatesFor(entity, base.hits);
    const chosen =
      candidates.length === 1 ? candidates[0] : candidates.find((c) => recordId(c) === choices.get(entity.key)) ?? null;
    return { entity, candidates, entry: chosen ? sourceOf(chosen) : null, related: [] };
  });

  // Fetch what the cache does not have yet, per kind
  const wanted = new Map<Kind, Set<string>>([
    ["scene", new Set()],
    ["gallery", new Set()],
  ]);
  for (const node of nodes) {
    if (!node.entry) continue;
    const other = otherKind(node.entity.kind);
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
    const other = otherKind(parent.kind);
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
export function buildPlans(
  nodes: PlanNode[],
  dicts: Dictionaries,
  label: Labels,
  settings: Settings
): Map<string, EntityPlan> {
  const plans = new Map<string, EntityPlan>();
  const add = (entity: Entity, entry: R.Entry) => {
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

/* -- What the dialog's switches and edits make of it ----------------------- */

/** What the user changed in the dialog */
export interface UiState {
  excluded: Set<string>; // entity keys and nested keys
  checks: Map<string, boolean>; // `${entityKey}|${field}[|${id}]` -> on, over the row's default
  edits: Map<string, string>; // `${entityKey}|${field}` -> typed value
}

export const emptyUiState = (): UiState => ({ excluded: new Set(), checks: new Map(), edits: new Map() });

export const rowKey = (entity: Entity, row: FieldRow) => `${entity.key}|${row.field}`;

export function isOn(st: UiState, key: string, fallback: boolean) {
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
export function rowPatch(entity: Entity, row: FieldRow, st: UiState): Record<string, unknown> | null {
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
export function entityPatch(entity: Entity, plan: EntityPlan | undefined, st: UiState) {
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

export type NodeStatus = "ready" | "current" | "none" | "conflict";

/** `offered`: the edits, with no switch turned off */
export function nodeStatus(node: PlanNode, plans: Map<string, EntityPlan>, offered: UiState): NodeStatus {
  if (!node.entry) return node.candidates.length > 1 ? "conflict" : "none";
  const own = entityPatch(node.entity, plans.get(node.entity.key), offered) !== null;
  const rel = node.related.some(
    (r) => r.link || (r.owner && entityPatch(r.entity, plans.get(r.entity.key), offered) !== null)
  );
  return own || rel ? "ready" : "current";
}

export interface Job {
  key: string;
  kind: Kind;
  input: Record<string, unknown>;
  links: number;
}

/** What Import sends, given the switches and edits */
export function buildJobs(nodes: PlanNode[], plans: Map<string, EntityPlan>, st: UiState): Job[] {
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

/** A studio, tag or performer the records name that Stash does not have (or has twice) */
export interface Miss {
  kind: R.DictKind;
  name: string;
  status: "missing" | "ambiguous";
  count: number;
  candidates: string[];
  urls: string[];
}

export function collectMisses(nodes: PlanNode[], plans: Map<string, EntityPlan>, st: UiState): Miss[] {
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
