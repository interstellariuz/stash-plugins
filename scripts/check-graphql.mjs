// Validate every GraphQL document inzVrGenerate can send against the real Stash
// schema, taken from a Stash source checkout.
//
// The plugin has already shipped two 422s from queries written by hand: one
// asking for config fields that only exist in newer Stash, one asking for a
// filter field that exists in no version at all. Both would have failed here.
//
//   npm run check:graphql              # ../stash
//   STASH_SRC=/path/to/stash npm run check:graphql
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSchema,
  coerceInputValue,
  parse,
  typeFromAST,
  validate,
} from "graphql";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginSrc = join(root, "inzVrGenerate", "src");
const stashSrc = process.env.STASH_SRC ?? join(root, "..", "stash");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

// The oldest Stash this plugin claims to work on. Everything newer is covered
// by the runtime introspection in vrstash.config_query, which only asks for the
// fields the server reports — so the old schema is the one that constrains.
const MIN_REF = "v0.31.1";
const REFS = [MIN_REF, "HEAD"];

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
function dumpDocuments(schema) {
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

function checkRef(ref) {
  const schema = loadSchema(ref);
  const documents = dumpDocuments(schema);

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
  console.log(`${ref}: ${total - failed}/${total} ok`);
  return failed;
}

if (!hasStashSource()) {
  console.log(`skipped: no Stash source at ${stashSrc} (set STASH_SRC to point at one)`);
  process.exit(0);
}

let failed = 0;
for (const ref of REFS) {
  if (!resolves(ref)) {
    console.log(`${ref}: skipped, this checkout does not have it`);
    continue;
  }
  failed += checkRef(ref);
}
process.exit(failed > 0 ? 1 : 0);
