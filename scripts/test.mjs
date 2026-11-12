// Run every test: <dir>/test/*.test.ts under node:test (through tsx), and
// <dir>/test/test_*.py under unittest, one plugin at a time.
//
//   npm test
//   PYTHON=python3.12 npm test
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const dirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "test")))
  .map((d) => join(root, d.name, "test"))
  .sort();

const of = (pattern) => dirs.flatMap((dir) => readdirSync(dir).filter((f) => pattern.test(f)).map((f) => join(dir, f)));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status === 0;
}

let ok = true;

const scripts = of(/\.test\.ts$/);
if (scripts.length) ok = run(process.execPath, ["--import", "tsx", "--test", ...scripts]) && ok;

for (const dir of dirs) {
  if (!readdirSync(dir).some((f) => /^test_.*\.py$/.test(f))) continue;
  // -I: the tests put their plugin sources on the path; -B: no __pycache__
  ok = run(python, ["-I", "-B", "-m", "unittest", "discover", "-s", dir, "-t", dir]) && ok;
}

process.exit(ok ? 0 : 1);
