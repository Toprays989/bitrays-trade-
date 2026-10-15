import { createServer } from "node:http";

const endpoint = process.env.NQ_LIVE_RISK_URL || "http://nexus-quant:3000/api/internal/live-risk";
const token = process.env.NQ_INTERNAL_RISK_TOKEN || "";
if (token.length < 32) throw new Error("NQ_INTERNAL_RISK_TOKEN is required and must contain at least 32 characters");

let failures = 0;
let lastSuccessAt = 0;
let lastAttemptAt = 0;
let lastFailure = null;
const normalIntervalMs = 5_000;
const minimumCycleDelayMs = 250;
const requestTimeoutMs = Number(
  process.env.NQ_LIVE_RISK_REQUEST_TIMEOUT_MS || 20_000,
);
const maximumBackoffMs = 5 * 60_000;
const healthPort = Number(process.env.NQ_RUNNER_HEALTH_PORT || 3201);
const healthFreshnessMs = 45_000;
const recentDurationsMs = [];
let lastDurationMs = null;
let lastScheduledDelayMs = null;

function recordDuration(durationMs) {
  lastDurationMs = durationMs;
  recentDurationsMs.push(durationMs);
  if (recentDurationsMs.length > 120) recentDurationsMs.shift();
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

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
  response.end(
    JSON.stringify({
      ok,
      failures,
      lastAttemptAt: lastAttemptAt || null,
      lastSuccessAt: lastSuccessAt || null,
      successAgeMs,
      lastFailure,
      targetCadenceMs: normalIntervalMs,
      requestTimeoutMs,
      lastDurationMs,
      lastScheduledDelayMs,
      durationP50Ms: percentile(recentDurationsMs, 0.5),
      durationP95Ms: percentile(recentDurationsMs, 0.95),
    }),
  );
}).listen(healthPort, "127.0.0.1");

function retryDelay(response) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return Math.min(maximumBackoffMs, Math.max(normalIntervalMs, retryAfter * 1_000));
  return Math.min(maximumBackoffMs, normalIntervalMs * 2 ** Math.min(failures, 6));
}

async function tick() {
  let delay = normalIntervalMs;
  let timeout;
  const cycleStartedAt = Date.now();
  try {
    lastAttemptAt = cycleStartedAt;
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        // Internal Docker bridge calls are short and infrequent. Do not reuse
        // a stale pooled socket across application replacement or restart.
        connection: "close",
      },
      signal: controller.signal,
    });
    // Always consume the response. Leaving one body unread every five seconds
    // eventually exhausts pooled HTTP connections and presents as sporadic
    // `fetch failed` even though the application and market proxy are healthy.
    const responseText = await response.text();
    if (!response.ok) {
      failures += 1;
      delay = retryDelay(response);
      let detail = "";
      try {
        const payload = JSON.parse(responseText);
        detail =
          typeof payload?.error === "string"
            ? `: ${payload.error.slice(0, 240)}`
            : "";
      } catch {
        detail = responseText.trim()
          ? `: ${responseText.trim().slice(0, 240)}`
          : "";
      }
      throw new Error(`live risk endpoint returned ${response.status}${detail}; retry in ${Math.ceil(delay / 1_000)}s`);
    }
    failures = 0;
    lastSuccessAt = Date.now();
    lastFailure = null;
    const durationMs = lastSuccessAt - cycleStartedAt;
    recordDuration(durationMs);
    // 5 秒是“周期起点到下一周期起点”的目标，而不是请求完成后再等待 5 秒。
    // 这样慢请求不会把保护巡检无意放大到 8-11 秒，同时仍保持串行、绝不重叠。
    delay = Math.max(minimumCycleDelayMs, normalIntervalMs - durationMs);
  } catch (error) {
    recordDuration(Date.now() - cycleStartedAt);
    if (failures === 0) failures = 1;
    if (delay === normalIntervalMs)
      delay = Math.min(maximumBackoffMs, normalIntervalMs * 2 ** Math.min(failures, 6));
    lastFailure = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", service: "live-risk-runner", failures, message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() }));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  lastScheduledDelayMs = delay;
  setTimeout(tick, delay);
}

void tick();
