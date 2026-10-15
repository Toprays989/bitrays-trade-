import { createServer } from "node:http";
import { synchronizeActivePositionCoverage } from "../lib/position-intelligence-coverage.mjs";

const endpoint =
  process.env.NQ_POSITION_INTELLIGENCE_URL ||
  "http://nexus-quant:3000/api/internal/live-risk?mode=intelligence";
const token = process.env.NQ_INTERNAL_RISK_TOKEN || "";
if (token.length < 32)
  throw new Error(
    "NQ_INTERNAL_RISK_TOKEN is required and must contain at least 32 characters",
  );

const intervalMs = Math.max(
  5_000,
  Number(process.env.NQ_POSITION_INTELLIGENCE_INTERVAL_MS || 5_000),
);
const requestTimeoutMs = Math.max(
  30_000,
  Number(process.env.NQ_POSITION_INTELLIGENCE_TIMEOUT_MS || 90_000),
);
const initialDelayMs = Math.max(
  0,
  Number(process.env.NQ_POSITION_INTELLIGENCE_INITIAL_DELAY_MS || intervalMs),
);
const healthPort = Number(process.env.NQ_RUNNER_HEALTH_PORT || 3204);
const healthFreshnessMs = Math.max(intervalMs * 4, requestTimeoutMs * 2);
const coverageWindowMs = Math.max(intervalMs * 36, 180_000);
const startedAt = Date.now();
let failures = 0;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let lastDurationMs = null;
let lastFailure = null;
let lastPositionId = null;
let lastSymbol = null;
let openPositionTotal = 0;
let duePositionTotal = 0;
const processedPositions = new Map();
const sampledPositions = new Map();

function pruneCoverage(nowMs) {
  for (const observations of [processedPositions, sampledPositions])
    for (const [positionId, observedAt] of observations)
      if (nowMs - observedAt > coverageWindowMs)
        observations.delete(positionId);
}

createServer((request, response) => {
  if (request.url !== "/health") {
    response.statusCode = 404;
    response.end();
    return;
  }
  const successAgeMs = lastSuccessAt ? Date.now() - lastSuccessAt : null;
  pruneCoverage(Date.now());
  const ok = successAgeMs !== null && successAgeMs <= healthFreshnessMs;
  response.statusCode = ok ? 200 : 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok,
    plane: "POSITION_INTELLIGENCE",
    failures,
    lastAttemptAt: lastAttemptAt || null,
    lastSuccessAt: lastSuccessAt || null,
    successAgeMs,
    lastDurationMs,
    lastFailure,
    lastPositionId,
    lastSymbol,
    openPositionTotal,
    duePositionTotal,
    processedPositionCountWindow: processedPositions.size,
    sampledPositionCountWindow: sampledPositions.size,
    coverageWindowMs,
    uptimeMs: Date.now() - startedAt,
    processedCoverageRatio: openPositionTotal > 0
      ? processedPositions.size / openPositionTotal
      : 1,
    sampledCoverageRatio: openPositionTotal > 0
      ? sampledPositions.size / openPositionTotal
      : 1,
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
    if (!response.ok) {
      let detail = responseText;
      try {
        detail = JSON.parse(responseText)?.error || responseText;
      } catch {
        // Preserve the bounded plain-text response.
      }
      throw new Error(
        `position intelligence endpoint returned ${response.status}: ${String(detail || "未返回错误详情").slice(0, 500)}`,
      );
    }
    if (response.ok) {
      const payload = JSON.parse(responseText);
      const nowMs = Date.now();
      const positionId = Number(payload?.positionId);
      openPositionTotal = synchronizeActivePositionCoverage({
        openPositionIds: payload?.openPositionIds,
        fallbackTotal: payload?.total,
        processedPositions,
        sampledPositions,
      });
      duePositionTotal = Math.max(0, Number(payload?.due) || 0);
      if (Number.isInteger(positionId) && positionId > 0) {
        lastPositionId = positionId;
        lastSymbol = typeof payload?.symbol === "string"
          ? payload.symbol
          : null;
        if (Number(payload?.checked) > 0)
          processedPositions.set(positionId, nowMs);
        if (Number(payload?.sampled) > 0)
          sampledPositions.set(positionId, nowMs);
      }
      pruneCoverage(nowMs);
    }
    failures = 0;
    lastSuccessAt = Date.now();
    lastFailure = null;
  } catch (error) {
    failures += 1;
    lastFailure = error instanceof Error ? error.message : String(error);
    delay = Math.max(intervalMs, 60_000);
    console.error(JSON.stringify({
      level: "error",
      service: "position-intelligence-runner",
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
