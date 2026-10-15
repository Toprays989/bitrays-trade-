import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["scripts/run-all-tests.mjs"],
  { stdio: "inherit", cwd: process.cwd() },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
