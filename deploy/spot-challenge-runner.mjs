import { createServer } from "node:http";

const endpoint = process.env.NQ_SPOT_CHALLENGE_URL || "http://nexus-quant:3000/api/internal/challenges";
const token = process.env.NQ_INTERNAL_RISK_TOKEN || "";
if (token.length < 32) throw new Error("NQ_INTERNAL_RISK_TOKEN is required and must contain at least 32 characters");
const intervalMs = Math.max(1_000, Number(process.env.NQ_SPOT_CHALLENGE_INTERVAL_MS || 5_000));
const timeoutMs = Math.max(5_000, Number(process.env.NQ_SPOT_CHALLENGE_TIMEOUT_MS || 30_000));
const healthPort = Number(process.env.NQ_SPOT_CHALLENGE_HEALTH_PORT || 3210);
const state = { failures: 0, lastAttemptAt: 0, lastSuccessAt: 0, lastFailure: null, lastResult: null };

createServer((request, response) => {
  if (request.url !== "/health") { response.statusCode = 404; response.end(); return; }
  const successAgeMs = state.lastSuccessAt ? Date.now() - state.lastSuccessAt : null;
  const ok = successAgeMs !== null && successAgeMs <= Math.max(intervalMs * 4, timeoutMs * 2);
  response.statusCode = ok ? 200 : 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ ok, plane: "SPOT_CHALLENGE", ...state, successAgeMs }));
}).listen(healthPort, "127.0.0.1");

async function tick() {
  state.lastAttemptAt = Date.now();
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, connection: "close" }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    const parsed = JSON.parse(text);
    if (!response.ok) throw new Error(`spot challenge endpoint returned ${response.status}: ${text.slice(0, 300)}`);
    state.lastResult = parsed;
    state.failures = 0;
    state.lastFailure = null;
    state.lastSuccessAt = Date.now();
  } catch (error) {
    state.failures += 1;
    state.lastFailure = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", service: "spot-challenge-runner", failures: state.failures, message: state.lastFailure, at: new Date().toISOString() }));
  } finally {
    setTimeout(tick, state.failures ? Math.max(intervalMs, 10_000) : intervalMs);
  }
}

setTimeout(tick, 1_000);
