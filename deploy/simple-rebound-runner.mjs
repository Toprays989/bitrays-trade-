import { createServer } from "node:http";

const endpoint = process.env.NQ_SIMPLE_REBOUND_URL || "http://nexus-quant:3000/api/internal/simple-rebound";
const token = process.env.NQ_INTERNAL_LIQUIDATION_TOKEN || "";
if (token.length < 32) throw new Error("NQ_INTERNAL_LIQUIDATION_TOKEN is required");

const intervalMs = Math.max(2_000, Number(process.env.NQ_SIMPLE_REBOUND_INTERVAL_MS || 2_000));
const idleIntervalMs = Math.max(
  intervalMs,
  Number(process.env.NQ_SIMPLE_REBOUND_IDLE_INTERVAL_MS || 30_000),
);
const timeoutMs = Math.max(1_000, Number(process.env.NQ_SIMPLE_REBOUND_TIMEOUT_MS || 15_000));
const healthPort = Number(process.env.NQ_RUNNER_HEALTH_PORT || 3206);
let running = false;
let failures = 0;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let lastFailure = null;
let lastResult = null;
let nextDelayMs = intervalMs;

async function runCycle() {
  if (running) return;
  running = true;
  lastAttemptAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (response.status === 404) {
      failures = 0;
      lastFailure = null;
      lastSuccessAt = Date.now();
      lastResult = { idle: true, reason: "NO_SIMPLE_REBOUND_STRATEGY" };
      nextDelayMs = idleIntervalMs;
      return;
    }
    if (!response.ok) throw new Error(`simple-rebound HTTP ${response.status}`);
    failures = 0;
    lastFailure = null;
    lastSuccessAt = Date.now();
    lastResult = {
      marketRows: Number(payload?.marketRows ?? 0),
      occupiedSlots: Number(payload?.occupiedSlots ?? 0),
      signals: Array.isArray(payload?.signals) ? payload.signals.length : 0,
      orderPlans: Array.isArray(payload?.orderPlans) ? payload.orderPlans.length : 0,
      exits: Array.isArray(payload?.exits) ? payload.exits.length : 0,
      readOnly: payload?.readOnly === true,
      execution: payload?.execution ?? null,
      marketData: payload?.marketData ?? null,
    };
    const idle = lastResult.readOnly === true &&
      lastResult.occupiedSlots === 0 &&
      lastResult.signals === 0 &&
      lastResult.orderPlans === 0 &&
      lastResult.exits === 0;
    nextDelayMs = idle ? idleIntervalMs : intervalMs;
  } catch (error) {
    failures += 1;
    lastFailure = error instanceof Error ? error.message : String(error);
    nextDelayMs = Math.min(30_000, Math.max(intervalMs, intervalMs * 2 ** Math.min(failures, 4)));
  } finally {
    running = false;
    setTimeout(() => void runCycle(), nextDelayMs);
  }
}

createServer((request, response) => {
  if (request.url !== "/health") { response.statusCode = 404; response.end(); return; }
  const successAgeMs = lastSuccessAt ? Date.now() - lastSuccessAt : null;
  const ok = failures === 0 && successAgeMs !== null && successAgeMs <= Math.max(timeoutMs * 2, intervalMs * 3);
  response.statusCode = ok ? 200 : 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ ok, status: ok ? "HEALTHY" : "DEGRADED", running, failures, lastAttemptAt: lastAttemptAt || null, lastSuccessAt: lastSuccessAt || null, successAgeMs, lastFailure, lastResult, idleIntervalMs, nextDelayMs }));
}).listen(healthPort, "0.0.0.0");

setTimeout(() => void runCycle(), 250);
