import { createServer } from "node:http";

const endpoint = process.env.NQ_MANUAL_GRID_URL || "http://nexus-quant:3000/api/internal/manual-grid";
const token = process.env.NQ_INTERNAL_RISK_TOKEN || "";
if (token.length < 32) throw new Error("NQ_INTERNAL_RISK_TOKEN is required and must contain at least 32 characters");
const intervalMs = Math.max(500, Number(process.env.NQ_MANUAL_GRID_INTERVAL_MS || 1000));
const timeoutMs = Math.max(3000, Number(process.env.NQ_MANUAL_GRID_TIMEOUT_MS || 10000));
const healthPort = Number(process.env.NQ_RUNNER_HEALTH_PORT || 3207);
let lastSuccessAt = 0;
let lastAttemptAt = 0;
let failures = 0;
let lastFailure = null;
let lastResult = null;

createServer((request, response) => {
  if (request.url !== "/health") { response.statusCode = 404; response.end(); return; }
  const successAgeMs = lastSuccessAt ? Date.now() - lastSuccessAt : null;
  const ok = successAgeMs !== null && successAgeMs <= Math.max(intervalMs * 4, timeoutMs * 2);
  response.statusCode = ok ? 200 : 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ ok, plane: "MANUAL_GRID", failures, lastAttemptAt: lastAttemptAt || null, lastSuccessAt: lastSuccessAt || null, successAgeMs, lastFailure, lastResult }));
}).listen(healthPort, "127.0.0.1");

async function tick() {
  lastAttemptAt = Date.now();
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, connection: "close" }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    const parsed = JSON.parse(text);
    if (!response.ok && !(response.status === 503 && parsed?.code === "MANUAL_GRID_EXECUTOR_NOT_READY")) {
      throw new Error(`manual-grid endpoint returned ${response.status}: ${text.slice(0, 300)}`);
    }
    lastResult = parsed;
    failures = 0;
    lastFailure = null;
    lastSuccessAt = Date.now();
  } catch (error) {
    failures += 1;
    lastFailure = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", service: "manual-grid-runner", failures, message: lastFailure, at: new Date().toISOString() }));
  } finally {
    setTimeout(tick, failures ? Math.max(intervalMs, 5000) : intervalMs);
  }
}

setTimeout(tick, 1000);
