import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "deploy/binance-proxy.mjs",
  "deploy/liquidation-monitor-runner.mjs",
  "deploy/position-intelligence-runner.mjs",
  "deploy/account-audit-runner.mjs",
  "lib/automated-order-concurrency.ts",
  "lib/three-minute-opportunity-board.ts",
  "scripts/run-all-tests.mjs",
  "scripts/run-mainline-baseline.mjs",
  "tests/control-strategy-types.test.mjs",
  "tests/mutex-regression.test.mjs",
  "docker-compose.server.yml",
  "deploy/server-entrypoint.sh",
  "deploy/production-runtime.mjs",
  ".deploy/remote_release.py",
];

for (const relative of required)
  assert.equal(existsSync(join(root, relative)), true, `missing critical runtime: ${relative}`);

const compose = readFileSync(join(root, "docker-compose.server.yml"), "utf8");
assert.match(compose, /NQ_RELEASE_ID:\s*["']?\$\{NQ_RELEASE_ID:-local\}/);
assert.match(compose, /nexus-quant-contract-trader/);

const entrypoint = readFileSync(join(root, "deploy/server-entrypoint.sh"), "utf8");
const runtime = readFileSync(join(root, "deploy/production-runtime.mjs"), "utf8");
const release = readFileSync(join(root, ".deploy/remote_release.py"), "utf8");
const migrationRoot = "/var/lib/nexus-quant/wrangler/state/v3";
const runtimeRoot = "/var/lib/nexus-quant/wrangler/state/v3/v3";
assert.equal(entrypoint.includes(`--persist-to ${migrationRoot}`), true);
assert.equal(runtime.includes(runtimeRoot), true);
assert.equal(release.includes(runtimeRoot), true);

console.log(`critical runtime names checked: ${required.length}`);
