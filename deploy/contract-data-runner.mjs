import { createServer } from "node:http";

const endpoint =
  process.env.NQ_CONTRACT_DATA_URL ||
  "http://nexus-quant:3000/api/internal/contract-data";
const token = process.env.NQ_INTERNAL_LIQUIDATION_TOKEN || "";
if (token.length < 32)
  throw new Error(
    "NQ_INTERNAL_LIQUIDATION_TOKEN is required and must contain at least 32 characters",
  );

const intervalMs = Math.max(
  60_000,
  Number(process.env.NQ_CONTRACT_DATA_INTERVAL_MS || 10 * 60_000),
);
const initialDelayMs = Math.max(
  0,
  Number(process.env.NQ_CONTRACT_DATA_INITIAL_DELAY_MS || 1_000),
);
const requestTimeoutMs = Math.max(
  30_000,
  Number(process.env.NQ_CONTRACT_DATA_TIMEOUT_MS || 120_000),
);
const healthPort = Number(process.env.NQ_RUNNER_HEALTH_PORT || 3203);
const healthFreshnessMs = Math.max(intervalMs * 2, 20 * 60_000);
let failures = 0;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let lastDurationMs = null;
let lastFailure = null;
let lastResult = null;

createServer((request, response) => {
  if (request.url !== "/health") {
    response.statusCode = 404;
    response.end();
    return;
  }
  const successAgeMs = lastSuccessAt ? Date.now() - lastSuccessAt : null;
  const ok = successAgeMs !== null && successAgeMs <= healthFreshnessMs;
  response.statusCode = ok ? 200 : 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok,
    plane: "CONTRACT_DATA",
    failures,
    lastAttemptAt: lastAttemptAt || null,
    lastSuccessAt: lastSuccessAt || null,
    successAgeMs,
    lastDurationMs,
    lastFailure,
    lastResult,
    targetCadenceMs: intervalMs,
    requestTimeoutMs,
  }));
}).listen(healthPort, "127.0.0.1");

async function tick() {
  const startedAt = Date.now();
  lastAttemptAt = startedAt;
  let delay = intervalMs;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        connection: "close",
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const responseText = await response.text();
    let payload = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      payload = null;
    }
    if (!response.ok)
      throw new Error(
        `contract data endpoint returned ${response.status}: ${String(payload?.error || responseText || "未返回错误详情").slice(0, 500)}`,
      );
    failures = 0;
    lastSuccessAt = Date.now();
    lastFailure = null;
    lastResult = {
      refreshed: Boolean(payload?.refreshed),
      checkedAt: payload?.checkedAt || null,
      syncedAt: payload?.syncedAt || null,
      qualifiedCount: payload?.qualifiedCount ?? null,
    };
  } catch (error) {
    failures += 1;
    lastFailure = error instanceof Error ? error.message : String(error);
    delay = Math.min(intervalMs, 30_000 * 2 ** Math.min(failures - 1, 4));
    console.error(JSON.stringify({
      level: "error",
      service: "contract-data-runner",
      failures,
      message: lastFailure,
      at: new Date().toISOString(),
    }));
  } finally {
    lastDurationMs = Date.now() - startedAt;
  }
  setTimeout(tick, delay);
}

setTimeout(tick, initialDelayMs);
