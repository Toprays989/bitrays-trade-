import { createServer } from "node:http";
import { readResponseTextBounded } from "./bounded-response-body.mjs";
import { retryAfterDelayMs } from "./process-memory-guard.mjs";
import {
  isRuntimeUnavailableError,
  runtimeRecoveryDelayMs,
} from "./runtime-recovery-delay.mjs";

const normalResponseBudgetBytes = 32 * 1024;
const errorResponseBudgetBytes = 8 * 1024;

function compactResponseEndpoint(endpoint) {
  const url = new URL(endpoint);
  url.searchParams.set("compact", "1");
  return url.toString();
}

const branchEndpoints = [
  {
    branch: "LONG",
    endpoint:
      compactResponseEndpoint(
        process.env.NQ_NEXUS_LONG_MONITOR_URL ||
          "http://nexus-quant:3000/api/internal/liquidation-monitor",
      ),
  },
  {
    branch: "SHORT",
    endpoint:
      compactResponseEndpoint(
        process.env.NQ_NEXUS_SHORT_MONITOR_URL ||
          "http://nexus-quant:3000/api/internal/short-continuation-monitor",
      ),
  },
  {
    branch: "RELATIVE_STRENGTH",
    endpoint:
      compactResponseEndpoint(
        process.env.NQ_NEXUS_RELATIVE_STRENGTH_MONITOR_URL ||
          "http://nexus-quant:3000/api/internal/relative-strength-monitor",
      ),
  },
];
const pendingEntryEndpoint =
  compactResponseEndpoint(
    process.env.NQ_NEXUS_PENDING_ENTRY_URL ||
      "http://nexus-quant:3000/api/internal/liquidation-monitor?mode=pending-entry",
  );
const token = process.env.NQ_INTERNAL_LIQUIDATION_TOKEN || "";
if (token.length < 32)
  throw new Error(
    "NQ_INTERNAL_LIQUIDATION_TOKEN is required and must contain at least 32 characters",
  );

let failures = 0;
let lastSuccessAt = 0;
let lastAttemptAt = 0;
let lastFailure = null;
let memoryPressurePaused = false;
let memoryPressureRetryAt = null;
let successfulCycles = 0;
let runtimeRecoveryPending = false;
let runtimeRecoveryStartedAt = null;
let runtimeRecoveryAttempts = 0;
const normalIntervalMs = Math.max(
  1_000,
  Number(process.env.NQ_NEXUS_BRAIN_INTERVAL_MS || 3_000),
);
// Branches used to share one round-robin clock. When only one trigger family
// was enabled, the two idle branches still consumed full monitor requests and
// made the remaining branch run three times as often. Keep every active branch
// on its original effective cadence while parking an explicitly empty branch.
const branchCadenceMs = normalIntervalMs * branchEndpoints.length;
const emptyBranchBackoffMs = Math.max(
  branchCadenceMs,
  Number(process.env.NQ_NEXUS_EMPTY_BRANCH_BACKOFF_MS || 5 * 60_000),
);
const initialDelayMs = Math.max(
  0,
  Number(process.env.NQ_NEXUS_BRAIN_INITIAL_DELAY_MS || 0),
);
const minimumCycleDelayMs = 250;
const requestTimeoutMs = Math.max(
  1_000,
  Number(process.env.NQ_NEXUS_BRAIN_REQUEST_TIMEOUT_MS || 45_000),
);
const timeoutCooldownMs = Math.max(
  normalIntervalMs,
  Number(process.env.NQ_NEXUS_BRAIN_TIMEOUT_COOLDOWN_MS || 10_000),
);
const maximumBackoffMs = Math.max(60_000, timeoutCooldownMs);
const healthPort = Number(process.env.NQ_RUNNER_HEALTH_PORT || 3202);
const healthFreshnessMs = Math.max(2 * requestTimeoutMs, 45_000);
const recentDurationsMs = [];
let lastDurationMs = null;
let lastScheduledDelayMs = null;
let lastAttemptCount = 0;
let lastBusinessTimings = null;
let nextBranchIndex = 0;
let lastExecutedBranch = null;
const branchState = Object.fromEntries(
  branchEndpoints.map(({ branch }) => [branch, {
    attempts: 0,
    successes: 0,
    failures: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailure: null,
    lastDurationMs: null,
    degraded: false,
    retryAt: null,
    nextDueAt: 0,
    idleUntil: null,
  }]),
);
const pendingEntryState = {
  failures: 0,
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  lastFailure: null,
  lastResult: null,
};
const pendingEntryIdleIntervalMs = 5_000;
const pendingEntryActiveIntervalMs = 250;
const pendingEntryStartedAt = Date.now();

function recordDuration(durationMs) {
  lastDurationMs = durationMs;
  recentDurationsMs.push(durationMs);
  if (recentDurationsMs.length > 120) recentDurationsMs.shift();
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.floor((sorted.length - 1) * ratio),
    )
  ];
}

function nextDueBranch(nowMs) {
  let earliestDueAt = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < branchEndpoints.length; offset += 1) {
    const index = (nextBranchIndex + offset) % branchEndpoints.length;
    const target = branchEndpoints[index];
    const state = branchState[target.branch];
    const dueAt = Math.max(state.nextDueAt || 0, state.idleUntil || 0);
    if (dueAt <= nowMs) {
      nextBranchIndex = (index + 1) % branchEndpoints.length;
      return { target, waitMs: 0 };
    }
    earliestDueAt = Math.min(earliestDueAt, dueAt);
  }
  return {
    target: null,
    waitMs: Math.max(minimumCycleDelayMs, earliestDueAt - nowMs),
  };
}

function errorCode(error) {
  if (!error || typeof error !== "object") return null;
  const cause = "cause" in error ? error.cause : null;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return null;
  const code = String(cause.code || "").trim();
  return code || null;
}

function errorSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return code ? `${message} (${code})` : message;
}

async function requestMonitor(target) {
  lastAttemptCount = 1;
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const responseBody = await readResponseTextBounded(
    response,
    response.ok ? normalResponseBudgetBytes : errorResponseBudgetBytes,
  );
  if (response.ok && responseBody.truncated)
    throw new Error(
      `brain branch response exceeded ${normalResponseBudgetBytes} bytes (${target.branch})`,
    );
  const responseText = responseBody.text;
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = null;
  }
  return { response, responseText, payload, attemptCount: 1 };
}

createServer((request, response) => {
  if (request.url !== "/health") {
    response.statusCode = 404;
    response.end();
    return;
  }
  const successAgeMs = lastSuccessAt ? Date.now() - lastSuccessAt : null;
  // An empty strategy universe is intentionally parked for a bounded backoff
  // window. During that window no market-brain request is scheduled, so the
  // last successful cycle can be older than the normal freshness budget even
  // though the runner is healthy and waiting by design. Treat that explicit
  // idle state as healthy, while still requiring a successful cycle and zero
  // branch failures. Once the next due time arrives, normal freshness checks
  // resume automatically.
  const now = Date.now();
  const idleHealthy =
    branchEndpoints.length > 0 &&
    branchEndpoints.every(({ branch }) => {
      const state = branchState[branch];
      const dueAt = Math.max(state.nextDueAt || 0, state.idleUntil || 0);
      return (
        dueAt > now &&
        state.idleUntil !== null &&
        state.failures === 0 &&
        state.lastSuccessAt !== null
      );
    });
  const ok =
    failures === 0 &&
    successAgeMs !== null &&
    (successAgeMs <= healthFreshnessMs || idleHealthy) &&
    pendingEntryState.failures === 0 &&
    (
      pendingEntryState.lastSuccessAt > 0 ||
      Date.now() - pendingEntryStartedAt <= 30_000
    );
  const degraded = failures > 0 || memoryPressurePaused;
  response.statusCode = ok ? 200 : 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      ok,
      degraded,
      status: degraded ? "DEGRADED" : "HEALTHY",
      failures,
      lastAttemptAt: lastAttemptAt || null,
      lastSuccessAt: lastSuccessAt || null,
      successAgeMs,
      idleHealthy,
      lastFailure,
      memoryPressurePaused,
      memoryPressureRetryAt,
      runtimeRecoveryPending,
      runtimeRecoveryStartedAt,
      runtimeRecoveryAttempts,
      successfulCycles,
      targetCadenceMs: normalIntervalMs,
      requestTimeoutMs,
      lastDurationMs,
      lastScheduledDelayMs,
      lastAttemptCount,
      lastBusinessTimings,
      lastExecutedBranch,
      nextBranch: branchEndpoints[nextBranchIndex]?.branch ?? null,
      branches: branchState,
      pendingEntryReconciliation: pendingEntryState,
      durationP50Ms: percentile(recentDurationsMs, 0.5),
      durationP95Ms: percentile(recentDurationsMs, 0.95),
      runtime: "NEXUS_MARKET_BRAIN",
    }),
  );
}).listen(healthPort, "127.0.0.1");

async function tick() {
  let delay = normalIntervalMs;
  const cycleStartedAt = Date.now();
  const scheduled = nextDueBranch(cycleStartedAt);
  if (!scheduled.target) {
    lastScheduledDelayMs = scheduled.waitMs;
    setTimeout(tick, scheduled.waitMs);
    return;
  }
  const target = scheduled.target;
  lastExecutedBranch = target.branch;
  const currentBranchState = branchState[target.branch];
  currentBranchState.attempts += 1;
  currentBranchState.lastAttemptAt = cycleStartedAt;
  currentBranchState.nextDueAt = cycleStartedAt + branchCadenceMs;
  try {
    lastAttemptAt = cycleStartedAt;
    const { response, responseText, payload, attemptCount } = await requestMonitor(target);
    lastAttemptCount = attemptCount;
    if (runtimeRecoveryPending) {
      console.info(
        JSON.stringify({
          level: "info",
          service: "liquidation-monitor-runner",
          code: "NEXUS_MONITOR_RUNTIME_RECOVERED",
          branch: target.branch,
          recoveryAttempts: runtimeRecoveryAttempts,
          unavailableMs: runtimeRecoveryStartedAt
            ? Date.now() - runtimeRecoveryStartedAt
            : null,
          at: new Date().toISOString(),
        }),
      );
      runtimeRecoveryPending = false;
      runtimeRecoveryStartedAt = null;
      runtimeRecoveryAttempts = 0;
    }
    if (response.status === 429) {
      const pressureCode = String(
        payload?.code || "MARKET_ANALYSIS_MEMORY_PRESSURE_PAUSED",
      );
      delay = retryAfterDelayMs(response.headers.get("retry-after"), {
        fallbackMs: 15_000,
        minimumMs: normalIntervalMs,
        maximumMs: maximumBackoffMs,
      });
      failures = 0;
      lastSuccessAt = Date.now();
      lastFailure = pressureCode;
      memoryPressurePaused = true;
      memoryPressureRetryAt = lastSuccessAt + delay;
      currentBranchState.successes += 1;
      currentBranchState.failures = 0;
      currentBranchState.lastSuccessAt = lastSuccessAt;
      currentBranchState.lastFailure = pressureCode;
      currentBranchState.degraded = true;
      currentBranchState.retryAt = memoryPressureRetryAt;
    } else if (!response.ok) {
      const detail = payload?.error || responseText;
      throw new Error(
        `brain branch returned ${response.status} (${target.branch}): ${String(detail || "未返回错误详情").slice(0, 1_000)}`,
      );
    } else {
      failures = 0;
      lastSuccessAt = Date.now();
      lastFailure = null;
      memoryPressurePaused = false;
      memoryPressureRetryAt = null;
      for (const state of Object.values(branchState)) {
        if (state.degraded) {
          state.degraded = false;
          state.retryAt = null;
          state.lastFailure = null;
        }
      }
      currentBranchState.successes += 1;
      currentBranchState.failures = 0;
      currentBranchState.lastSuccessAt = lastSuccessAt;
      currentBranchState.lastFailure = null;
      currentBranchState.idleUntil = Number(payload?.strategies) === 0
        ? lastSuccessAt + emptyBranchBackoffMs
        : null;
      lastBusinessTimings = payload?.timings || null;
      const durationMs = lastSuccessAt - cycleStartedAt;
      // Keep a three-second start-to-start cadence without overlapping the
      // previous whole-market analysis. A slow cycle schedules the next one
      // promptly, instead of adding another fixed three seconds of blind time.
      delay = Math.max(
        minimumCycleDelayMs,
        normalIntervalMs - durationMs,
      );
    }
    successfulCycles += 1;
    currentBranchState.lastDurationMs = lastSuccessAt - cycleStartedAt;
    recordDuration(currentBranchState.lastDurationMs);
  } catch (error) {
    recordDuration(Date.now() - cycleStartedAt);
    failures += 1;
    delay = runtimeRecoveryDelayMs(error, {
      normalIntervalMs,
      failures,
      maximumBackoffMs,
      timeoutCooldownMs,
    });
    if (isRuntimeUnavailableError(error)) {
      runtimeRecoveryPending = true;
      runtimeRecoveryStartedAt ??= Date.now();
      runtimeRecoveryAttempts += 1;
      currentBranchState.nextDueAt = Date.now() + delay;
      nextBranchIndex = branchEndpoints.findIndex(
        ({ branch }) => branch === target.branch,
      );
    }
    lastFailure = errorSummary(error);
    currentBranchState.failures += 1;
    currentBranchState.lastFailure = lastFailure;
    currentBranchState.lastDurationMs = Date.now() - cycleStartedAt;
    currentBranchState.degraded = true;
    currentBranchState.retryAt = Date.now() + delay;
    console.error(
      JSON.stringify({
        level: "error",
        service: "liquidation-monitor-runner",
        branch: target.branch,
        failures,
        message: lastFailure,
        at: new Date().toISOString(),
      }),
    );
  }
  lastScheduledDelayMs = delay;
  setTimeout(tick, delay);
}

async function pendingEntryTick() {
  pendingEntryState.lastAttemptAt = Date.now();
  let delay = pendingEntryIdleIntervalMs;
  try {
    const response = await fetch(pendingEntryEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const responseBody = await readResponseTextBounded(
      response,
      response.ok ? normalResponseBudgetBytes : errorResponseBudgetBytes,
    );
    if (response.ok && responseBody.truncated)
      throw new Error(
        `pending entry response exceeded ${normalResponseBudgetBytes} bytes`,
      );
    const responseText = responseBody.text;
    let payload = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      // The bounded response text is retained in the error below.
    }
    if (!response.ok)
      throw new Error(
        `pending entry monitor returned ${response.status}: ${String(payload?.error || responseText || "未返回错误详情").slice(0, 500)}`,
      );
    const pending = payload?.pendingEntries || {};
    pendingEntryState.failures = 0;
    pendingEntryState.lastSuccessAt = Date.now();
    pendingEntryState.lastFailure = null;
    pendingEntryState.lastResult = pending;
    if (
      Number(pending.checked) > 0 ||
      Number(pending.waiting) > 0
    ) delay = pendingEntryActiveIntervalMs;
  } catch (error) {
    pendingEntryState.failures += 1;
    pendingEntryState.lastFailure = errorSummary(error);
    delay = Math.min(
      30_000,
      pendingEntryIdleIntervalMs *
        2 ** Math.min(pendingEntryState.failures, 4),
    );
    console.error(JSON.stringify({
      level: "error",
      service: "liquidation-monitor-runner",
      operation: "pending-entry-reconciliation",
      failures: pendingEntryState.failures,
      message: pendingEntryState.lastFailure,
      at: new Date().toISOString(),
    }));
  }
  setTimeout(pendingEntryTick, delay);
}

setTimeout(tick, initialDelayMs);
setTimeout(pendingEntryTick, initialDelayMs);
