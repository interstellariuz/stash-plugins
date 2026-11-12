/** Everything that talks to Stash: GraphQL reads and writes, and the backend's ops. */

import { readPluginConfig } from "../../shared/config";
import { PluginApi, StashService } from "../../shared/stash";
import { chunks, uniq } from "../../shared/util";
import { PLUGIN_ID } from "./ids";
import {
  basenameRegex,
  buildDictionaries,
  parseSettings,
  toEntity,
  type Dictionaries,
  type Entity,
  type Hit,
  type Kind,
  type Miss,
  type Settings,
} from "./plan";
import { QUERIES, type QueryName } from "./queries";
import { buildStatus, summaryNames, type NamedEntity, type Status, type Summary } from "./status";

// Names per findScenes/findGalleries regex
const NAME_CHUNK = 100;
// Names per backend lookup
const LOOKUP_CHUNK = 500;

const documents = new Map<string, unknown>();
function documentFor(name: QueryName) {
  let doc = documents.get(name);
  if (!doc) {
    doc = PluginApi.libraries.Apollo.gql(QUERIES[name]);
    documents.set(name, doc);
  }
  return doc;
}

// no-cache: these are bulk reads with partial field sets; the pages refetch
// their own queries after an import.
async function query(name: QueryName, variables?: Record<string, unknown>): Promise<any> {
  const result = await StashService.getClient().query({
    query: documentFor(name),
    variables,
    fetchPolicy: "no-cache",
  });
  return result.data;
}

async function mutate(name: QueryName, variables: Record<string, unknown>): Promise<any> {
  const result = await StashService.getClient().mutate({
    mutation: documentFor(name),
    variables,
    fetchPolicy: "no-cache",
  });
  return result.data;
}

/** One backend op (inzRecords.py) */
export async function runOp(args: Record<string, unknown>): Promise<any> {
  return (await mutate("RUN_OP", { args })).runPluginOperation;
}

export async function loadSettings(): Promise<Settings> {
  try {
    return parseSettings(await readPluginConfig(PLUGIN_ID));
  } catch {
    return parseSettings({});
  }
}

export async function loadEntities(kind: Kind, ids: string[]): Promise<Entity[]> {
  if (!ids.length) return [];
  const data =
    kind === "scene"
      ? (await query("SCENES_BY_ID", { ids })).findScenes.scenes
      : (await query("GALLERIES_BY_ID", { ids })).findGalleries.galleries;
  return data.map((raw: any) => toEntity(kind, raw));
}

/** Entities of one kind whose files carry these names, keyed by lower-case name */
export async function findByNames(kind: Kind, names: string[]): Promise<Map<string, Entity[]>> {
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

export async function loadDictionaries(): Promise<Dictionaries> {
  const data = await query("DICTIONARIES");
  return buildDictionaries({
    studios: data.findStudios.studios,
    tags: data.findTags.tags,
    performers: data.findPerformers.performers,
  });
}

/** Records with a file of these names, keyed by lower-case name */
export async function lookup(names: string[]): Promise<Map<string, Hit[]>> {
  const out = new Map<string, Hit[]>();
  const unique = uniq(names.map((n) => n.toLowerCase()));
  for (const part of chunks(unique, LOOKUP_CHUNK)) {
    const result = await runOp({ op: "lookup", names: part });
    for (const [name, hits] of Object.entries(result?.hits ?? {})) out.set(name, hits as Hit[]);
  }
  return out;
}

export async function createMiss(miss: Miss) {
  if (miss.kind === "studios") await mutate("STUDIO_CREATE", { input: { name: miss.name } });
  else if (miss.kind === "tags") await mutate("TAG_CREATE", { input: { name: miss.name } });
  else {
    const input: Record<string, unknown> = { name: miss.name };
    if (miss.urls.length) input.urls = miss.urls;
    await mutate("PERFORMER_CREATE", { input });
  }
}

export async function updateEntity(kind: Kind, input: Record<string, unknown>) {
  await mutate(kind === "scene" ? "SCENE_UPDATE" : "GALLERY_UPDATE", { input });
}

/** Refetch what the open pages show, after an import */
export async function refetchActive() {
  await StashService.getClient()
    .refetchQueries({ include: "active" })
    .catch(() => undefined);
}

async function namesInStash(names: string[]): Promise<Map<string, NamedEntity[]>> {
  const found = new Map<string, NamedEntity[]>();
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

export async function computeStatus(): Promise<Status> {
  const summary: Summary = (await runOp({ op: "summary" })) ?? {};
  return buildStatus(summary, await namesInStash(summaryNames(summary)));
}
