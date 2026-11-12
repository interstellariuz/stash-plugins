// Build every plugin, or the ones named, into <plugin>/dist/<id>/.
//
// A plugin is a directory with src/manifest. Its UI is one bundle: esbuild
// starts at src/<id>.tsx (or .ts), pulls in what it imports, ../../shared
// included, and wraps it all in an IIFE, so nothing reaches window. Styles:
// src/*.scss compiled, src/*.css copied. Python and the plugin yml copied.
// The manifest's files list is written from what landed in dist, after
// checking the manifest and the yml agree on name, version and description.
//
//   npm run build
//   npm run build -- inzRecords
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import yaml from "js-yaml";
import * as sass from "sass";

const root = fileURLToPath(new URL("..", import.meta.url));

function findPlugins() {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "src", "manifest")))
    .map((d) => d.name)
    .sort();
}

const fail = (id, message) => {
  throw new Error(`${id}: ${message}`);
};

async function buildOne(dir) {
  const src = join(root, dir, "src");
  const manifest = yaml.load(readFileSync(join(src, "manifest"), "utf8"));
  const id = manifest.id;
  const config = yaml.load(readFileSync(join(src, `${id}.yml`), "utf8"));

  for (const [field, a, b] of [
    ["name", manifest.name, config.name],
    ["version", manifest.version, config.version],
    ["description", manifest.metadata?.description, config.description],
  ]) {
    if (a !== b) fail(id, `manifest ${field} ${JSON.stringify(a)} differs from ${id}.yml ${JSON.stringify(b)}`);
  }

  const out = join(root, dir, "dist", id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const entry = [`${id}.tsx`, `${id}.ts`].map((f) => join(src, f)).find((f) => existsSync(f));
  if (entry) {
    await esbuild.build({
      entryPoints: [entry],
      outfile: join(out, `${id}.js`),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2019",
      charset: "utf8",
      legalComments: "none",
      // React is the PluginApi copy each .tsx imports from shared/stash
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      logLevel: "warning",
    });
  }

  for (const file of readdirSync(src)) {
    const from = join(src, file);
    if (file.endsWith(".scss") && !file.startsWith("_")) {
      const { css } = sass.compile(from, { style: "expanded" });
      writeFileSync(join(out, file.replace(/\.scss$/, ".css")), `${css}\n`);
    } else if (/\.(css|py|yml)$/.test(file)) {
      copyFileSync(from, join(out, file));
    }
  }

  const files = readdirSync(out).sort();
  for (const asset of [...(config.ui?.javascript ?? []), ...(config.ui?.css ?? [])]) {
    if (!files.includes(asset)) fail(id, `${id}.yml loads ${asset}, which the build did not produce`);
  }

  writeFileSync(join(out, "manifest"), yaml.dump({ ...manifest, files }, { lineWidth: -1 }));
  console.log(`built ${id} ${manifest.version}: ${files.join(", ")}`);
}

const wanted = process.argv.slice(2);
const plugins = findPlugins();
for (const name of wanted) {
  if (!plugins.includes(name)) throw new Error(`no plugin ${name}; have ${plugins.join(", ")}`);
}
await Promise.all((wanted.length ? wanted : plugins).map((dir) => buildOne(basename(dir))));
