import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const pagesDir = join(root, "pages");
const skipDirs = new Set(["node_modules", "scripts", "pages", ".github", ".git"]);

// Stash parses dates with time.Parse("2006-01-02 15:04:05") in UTC.
function stashTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function buildStamp() {
  const sha = process.env.GITHUB_SHA ?? tryGitSha();
  return sha ? sha.slice(0, 7) : null;
}

function tryGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// A package is any <plugin>/dist/<id>/ directory holding a manifest.
function findPackages() {
  const found = [];

  for (const entry of readdirSync(root)) {
    if (skipDirs.has(entry) || !statSync(join(root, entry)).isDirectory()) continue;

    const distDir = join(root, entry, "dist");
    if (!existsSync(distDir)) continue;

    for (const id of readdirSync(distDir)) {
      const dir = join(distDir, id);
      if (existsSync(join(dir, "manifest"))) found.push({ id, dir });
    }
  }

  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function packOne({ id, dir }, date, stamp) {
  const manifest = yaml.load(readFileSync(join(dir, "manifest"), "utf8"));

  if (manifest.id !== id) {
    throw new Error(`${id}: manifest id is ${manifest.id}, expected the directory name`);
  }

  // Files go in at the zip root: installPackage writes each entry to
  // <plugins>/<id>/<name in zip>, so a nested folder would be duplicated.
  // The manifest is left out because Stash writes its own on install.
  const zip = new AdmZip();
  const files = readdirSync(dir).filter((f) => f !== "manifest");

  for (const file of files) {
    zip.addLocalFile(join(dir, file));
  }

  const data = zip.toBuffer();
  const zipName = `${id}.zip`;
  writeFileSync(join(pagesDir, zipName), data);

  return {
    id,
    name: manifest.name,
    metadata: manifest.metadata ?? {},
    version: stamp ? `${manifest.version}-${stamp}` : manifest.version,
    date: stashTime(date),
    requires: manifest.requires ?? [],
    path: zipName,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

const packages = findPackages();
if (packages.length === 0) {
  throw new Error("no built packages found — run `npm run build` first");
}

rmSync(pagesDir, { recursive: true, force: true });
mkdirSync(pagesDir, { recursive: true });

const date = new Date();
const stamp = buildStamp();
const index = packages.map((pkg) => packOne(pkg, date, stamp));

// forceQuotes keeps `date` a string; unquoted it would resolve as a YAML
// timestamp, which Stash's custom string-based unmarshaller rejects.
writeFileSync(
  join(pagesDir, "index.yml"),
  yaml.dump(index, { forceQuotes: true, quotingType: '"', lineWidth: -1 })
);

for (const entry of index) {
  console.log(`packaged ${entry.id} ${entry.version} -> ${entry.path} (${entry.sha256})`);
}
