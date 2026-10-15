import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.isFile() && /\.test\.(mjs|js|ts)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

const root = process.cwd();
const tests = collect(join(root, "tests"));
if (!tests.length) {
  console.error("No test files found under tests/");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...tests.map((path) => relative(root, path))],
  { stdio: "inherit", cwd: root },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
