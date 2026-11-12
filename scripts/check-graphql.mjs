// Validate every GraphQL document the plugins can send against the real Stash
// schema, taken from a Stash source checkout.
//
// inzVrGenerate has already shipped two 422s from queries written by hand: one
// asking for config fields that only exist in newer Stash, one asking for a
// filter field that exists in no version at all. Both would have failed here.
//
//   npm run check:graphql              # ../../../libs/stash
//   STASH_SRC=/path/to/stash npm run check:graphql
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

import {
  buildSchema,
  coerceInputValue,
  parse,
  typeFromAST,
  validate,
} from "graphql";

const root = fileURLToPath(new URL("..", import.meta.url));
// ../stash is the CLI, not the Stash sources
const stashSrc = process.env.STASH_SRC ?? join(root, "..", "..", "..", "libs", "stash");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

function git(args, options = {}) {
  return execFileSync("git", ["-C", stashSrc, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function hasStashSource() {
  try {
    git(["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function resolves(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// Read the SDL straight out of the object store, so no ref has to be checked
// out and nothing lands in the Stash working tree.
function loadSchema(ref) {
  const files = git(["ls-tree", "-r", "--name-only", ref, "--", "graphql/schema"])
    .split("\n")
    .filter((f) => f.endsWith(".graphql"))
    .sort();

  const sdl = files.map((f) => git(["show", `${ref}:${f}`])).join("\n");
  // Stash's SDL uses only @deprecated, but gqlgen's dialect is not worth
  // asserting on — the queries are what is under test here.
  return buildSchema(sdl, { assumeValidSDL: true });
}

// The plugin builds its config query from whichever fields the server has, so
// ask the plugin to build it for this schema.
function dumpVrGenerate(schema) {
  const pluginSrc = join(root, "inzVrGenerate", "src");
  const fields = {};
  for (const name of ["ConfigGeneralResult", "Scene"]) {
    const type = schema.getType(name);
    if (!type) throw new Error(`schema has no type ${name}`);
    fields[name] = Object.keys(type.getFields()).sort();
  }

  const out = execFileSync(python, [join(root, "scripts", "dump-queries.py")], {
    input: JSON.stringify({ src: pluginSrc, fields }),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// Sample variables per document: validate() cannot see input shapes
const RECORDS_SAMPLES = {
  RUN_OP: { args: { op: "lookup", names: ["a.mp4"] } },
  SCENES_BY_ID: { ids: ["1"] },
  GALLERIES_BY_ID: { ids: ["1"] },
  SCENES_BY_PATH: { path: "(?i)(^|[/\\\\])(a\\.mp4)$" },
  GALLERIES_BY_PATH: { path: "(?i)(^|[/\\\\])(a\\.zip)$" },
  SCENE_NAMES_BY_PATH: { path: "(?i)a$" },
  GALLERY_NAMES_BY_PATH: { path: "(?i)a$" },
  DICTIONARIES: {},
  SCENE_UPDATE: {
    input: {
      id: "1",
      title: "t",
      code: "c",
      date: "2026-04-14",
      details: "d",
      urls: ["https://example.com/a"],
      studio_id: "1",
      performer_ids: ["1"],
      tag_ids: ["1"],
      gallery_ids: ["1"],
      custom_fields: { full: { source: "https://example.com/a.mp4" } },
    },
  },
  GALLERY_UPDATE: {
    input: {
      id: "1",
      title: "t",
      code: "c",
      date: "2026-04-14",
      details: "d",
      urls: ["https://example.com/a"],
      studio_id: "1",
      performer_ids: ["1"],
      tag_ids: ["1"],
      custom_fields: { full: { source: "https://example.com/a.zip" } },
    },
  },
  STUDIO_CREATE: { input: { name: "s" } },
  TAG_CREATE: { input: { name: "t" } },
  PERFORMER_CREATE: { input: { name: "p", urls: ["https://example.com/p"] } },
};

// queries.ts is a script declaring a namespace: transpile it and read QUERIES
function dumpRecords() {
  const source = readFileSync(join(root, "inzRecords", "src", "queries.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.None },
  });
  const context = {};
  vm.runInNewContext(`${outputText}\nthis.QUERIES = InzRecords.QUERIES;`, context);

  const documents = {};
  for (const [name, query] of Object.entries(context.QUERIES)) {
    documents[name] = { query, variables: RECORDS_SAMPLES[name] ?? {} };
  }
  for (const name of Object.keys(RECORDS_SAMPLES)) {
    if (!(name in documents)) throw new Error(`inzRecords: sample for unknown document ${name}`);
  }
  return documents;
}

// minRef: the oldest Stash the plugin claims to work on. inzVrGenerate covers
// newer ones by runtime introspection, so the old schema is what constrains.
const PLUGINS = [
  { id: "inzVrGenerate", minRef: "v0.31.1", dump: dumpVrGenerate },
  { id: "inzRecords", minRef: "v0.32.0", dump: dumpRecords },
];

// validate() only sees the query text. Anything passed as a variable — most
// importantly the SceneUpdateInput carrying the cover — is opaque to it, so
// coerce the sample values against their declared types too.
function checkVariables(schema, document, variables) {
  const problems = [];
  const definitions = document.definitions[0].variableDefinitions ?? [];
  const declared = new Set();

  for (const definition of definitions) {
    const name = definition.variable.name.value;
    declared.add(name);
    if (!(name in variables)) {
      problems.push(`no sample value for $${name}`);
      continue;
    }
    const type = typeFromAST(schema, definition.type);
    if (!type) {
      problems.push(`$${name} has an unknown type`);
      continue;
    }
    coerceInputValue(variables[name], type, (path, _value, error) => {
      const where = path.length ? ` at ${path.join(".")}` : "";
      problems.push(`$${name}${where}: ${error.message}`);
    });
  }

  for (const name of Object.keys(variables)) {
    if (!declared.has(name)) problems.push(`$${name} is passed but never declared`);
  }
  return problems;
}

function checkRef(ref, plugin) {
  const schema = loadSchema(ref);
  const documents = plugin.dump(schema);

  let failed = 0;
  for (const [name, { query, variables }] of Object.entries(documents)) {
    const problems = [];
    try {
      const document = parse(query);
      problems.push(...validate(schema, document).map((e) => e.message));
      problems.push(...checkVariables(schema, document, variables));
    } catch (error) {
      problems.push(error.message);
    }

    if (problems.length > 0) {
      failed++;
      console.log(`  FAIL  ${name}`);
      for (const problem of problems) console.log(`          ${problem}`);
    }
  }

  const total = Object.keys(documents).length;
  console.log(`${plugin.id} @ ${ref}: ${total - failed}/${total} ok`);
  return failed;
}

if (!hasStashSource()) {
  console.log(`skipped: no Stash source at ${stashSrc} (set STASH_SRC to point at one)`);
  process.exit(0);
}

let failed = 0;
for (const plugin of PLUGINS) {
  for (const ref of new Set([plugin.minRef, "HEAD"])) {
    if (!resolves(ref)) {
      console.log(`${plugin.id} @ ${ref}: skipped, this checkout does not have it`);
      continue;
    }
    failed += checkRef(ref, plugin);
  }
}
process.exit(failed > 0 ? 1 : 0);
