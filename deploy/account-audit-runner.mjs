import { createServer } from "node:http";

const endpoint =
  process.env.NQ_ACCOUNT_AUDIT_URL ||
  "http://nexus-quant:3000/api/internal/live-risk?mode=account-audit";
const fundingEndpoint =
  process.env.NQ_ACCOUNT_FUNDING_AUDIT_URL ||
  "http://nexus-quant:3000/api/internal/account-funding-audit";
const orderReconciliationEndpoint =
  process.env.NQ_ORDER_RECONCILIATION_URL ||
  "http://nexus-quant:3000/api/internal/live-risk?mode=order-reconcile";
const strategyLearningEndpoint =
  process.env.NQ_STRATEGY_LEARNING_URL ||
  "http://nexus-quant:3000/api/internal/live-risk?mode=strategy-learning";
const token = process.env.NQ_INTERNAL_RISK_TOKEN || "";
if (token.length < 32)
  throw new Error(
    "NQ_INTERNAL_RISK_TOKEN is required and must contain at least 32 characters",
  );

const fundingIntervalMs = Math.max(
  30_000,
  Number(process.env.NQ_ACCOUNT_AUDIT_INTERVAL_MS || 30_000),
);
const orderReconciliationIntervalMs = Math.max(
  1_000,
  Number(process.env.NQ_ORDER_RECONCILIATION_INTERVAL_MS || 2_000),
);
const orderReconciliationTimeoutMs = Math.max(
  5_000,
  Number(process.env.NQ_ORDER_RECONCILIATION_TIMEOUT_MS || 15_000),
);
const strategyLearningIntervalMs = Math.max(
  30_000,
  Number(process.env.NQ_STRATEGY_LEARNING_INTERVAL_MS || 30_000),
);
const strategyLearningTimeoutMs = Math.max(
  10_000,
  Number(process.env.NQ_STRATEGY_LEARNING_TIMEOUT_MS || 60_000),
);
// Full order/position convergence is deliberately lower frequency than the
// authoritative funding snapshot. Running both every 30 seconds used to make
// them contend for the same account rows and could starve balances forever.
const reconciliationIntervalMs = Math.max(
  5 * 60_000,
  Number(process.env.NQ_ACCOUNT_RECONCILIATION_INTERVAL_MS || 5 * 60_000),
);
const requestTimeoutMs = Math.max(
  60_000,
  Number(process.env.NQ_ACCOUNT_AUDIT_TIMEOUT_MS || 180_000),
);
const fundingRequestTimeoutMs = Math.max(
  10_000,
  Number(process.env.NQ_ACCOUNT_FUNDING_AUDIT_TIMEOUT_MS || 30_000),
);
const initialDelayMs = Math.max(
  0,
  Number(process.env.NQ_ACCOUNT_AUDIT_INITIAL_DELAY_MS || 15_000),
);
const reconciliationInitialDelayMs = Math.max(
  initialDelayMs + 30_000,
  Number(
    process.env.NQ_ACCOUNT_RECONCILIATION_INITIAL_DELAY_MS ||
      initialDelayMs + 30_000,
  ),
);
const strategyLearningInitialDelayMs = Math.max(
  initialDelayMs,
  Number(process.env.NQ_STRATEGY_LEARNING_INITIAL_DELAY_MS || initialDelayMs),
);
const reconciliationFirstDeadlineAt =
  Date.now() + reconciliationInitialDelayMs + requestTimeoutMs;
const strategyLearningFirstDeadlineAt =
  Date.now() + strategyLearningInitialDelayMs + strategyLearningTimeoutMs;
const healthPort = Number(process.env.NQ_RUNNER_HEALTH_PORT || 3205);
const auditHealthFreshnessMs = Math.max(
  reconciliationIntervalMs * 2,
  requestTimeoutMs * 2,
);
const fundingHealthFreshnessMs = Math.max(
  fundingIntervalMs * 8,
  fundingRequestTimeoutMs * 2,
);
const strategyLearningHealthFreshnessMs = Math.max(
  strategyLearningIntervalMs * 4,
  strategyLearningTimeoutMs * 2,
);
const auditState = {
  failures: 0,
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  lastDurationMs: null,
  lastFailure: null,
  lastResult: null,
};
const fundingState = {
  failures: 0,
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  lastDurationMs: null,
  lastFailure: null,
  lastResult: null,
};
const orderState = {
  failures: 0,
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  lastDurationMs: null,
  lastFailure: null,
  lastResult: null,
};
const learningState = {
  failures: 0,
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  lastDurationMs: null,
  lastFailure: null,
  lastResult: null,
};

createServer((request, response) => {
  if (request.url !== "/health") {
    response.statusCode = 404;
    response.end();
    return;
  }
  const auditSuccessAgeMs = auditState.lastSuccessAt
    ? Date.now() - auditState.lastSuccessAt
    : null;
  const fundingSuccessAgeMs = fundingState.lastSuccessAt
    ? Date.now() - fundingState.lastSuccessAt
    : null;
  const orderSuccessAgeMs = orderState.lastSuccessAt
    ? Date.now() - orderState.lastSuccessAt
    : null;
  const learningSuccessAgeMs = learningState.lastSuccessAt
    ? Date.now() - learningState.lastSuccessAt
    : null;
  // The heavyweight reconciliation is intentionally staggered behind the
  // authoritative funding refresh.  Do not report a false failure while its
  // first scheduled run is still waiting or legitimately in flight.
  const reconciliationStartupGrace =
    auditState.lastSuccessAt === 0 &&
    auditState.failures === 0 &&
    Date.now() <= reconciliationFirstDeadlineAt;
  const reconciliationHealthy =
    reconciliationStartupGrace ||
    (auditSuccessAgeMs !== null &&
      auditSuccessAgeMs <= auditHealthFreshnessMs);
  const learningStartupGrace =
    learningState.lastSuccessAt === 0 &&
    learningState.failures === 0 &&
    Date.now() <= strategyLearningFirstDeadlineAt;
  const learningHealthy =
    learningStartupGrace ||
    (learningSuccessAgeMs !== null &&
      learningSuccessAgeMs <= strategyLearningHealthFreshnessMs);
  const ok =
    reconciliationHealthy &&
    learningHealthy &&
    orderSuccessAgeMs !== null &&
    orderSuccessAgeMs <= 30_000 &&
    fundingSuccessAgeMs !== null &&
    fundingSuccessAgeMs <= fundingHealthFreshnessMs;
  const failures = auditState.failures + fundingState.failures +
    orderState.failures + learningState.failures;
  const lastAttemptAt = Math.max(
    auditState.lastAttemptAt,
    fundingState.lastAttemptAt,
    orderState.lastAttemptAt,
    learningState.lastAttemptAt,
  );
  const lastSuccessAt = Math.min(
    auditState.lastSuccessAt || Number.MAX_SAFE_INTEGER,
    fundingState.lastSuccessAt || Number.MAX_SAFE_INTEGER,
    orderState.lastSuccessAt || Number.MAX_SAFE_INTEGER,
    learningState.lastSuccessAt || Number.MAX_SAFE_INTEGER,
  );
  const normalizedLastSuccessAt = Number.isSafeInteger(lastSuccessAt) &&
    lastSuccessAt !== Number.MAX_SAFE_INTEGER
    ? lastSuccessAt
    : null;
  const lastFailure = orderState.lastFailure || learningState.lastFailure ||
    fundingState.lastFailure || auditState.lastFailure;
  response.statusCode = ok ? 200 : 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok,
    plane: "ACCOUNT_AUDIT",
    failures,
    lastAttemptAt: lastAttemptAt || null,
    lastSuccessAt: normalizedLastSuccessAt,
    successAgeMs: Math.max(
      auditSuccessAgeMs ?? 0,
      fundingSuccessAgeMs ?? 0,
      learningSuccessAgeMs ?? 0,
    ) || null,
    lastDurationMs: Math.max(
      Number(auditState.lastDurationMs) || 0,
      Number(fundingState.lastDurationMs) || 0,
      Number(learningState.lastDurationMs) || 0,
    ) || null,
    lastFailure,
    lastResult: {
      ...(auditState.lastResult || {}),
      ...(fundingState.lastResult || {}),
      ...(orderState.lastResult || {}),
      ...(learningState.lastResult || {}),
    },
    accountReconciliation: auditState,
    reconciliationStartupGrace,
    fundingRefresh: fundingState,
    orderReconciliation: orderState,
    strategyLearning: learningState,
    learningStartupGrace,
    targetCadenceMs: fundingIntervalMs,
    fundingIntervalMs,
    reconciliationIntervalMs,
    requestTimeoutMs,
    fundingRequestTimeoutMs,
    orderReconciliationIntervalMs,
    orderReconciliationTimeoutMs,
    strategyLearningIntervalMs,
    strategyLearningTimeoutMs,
  }));
}).listen(healthPort, "127.0.0.1");

async function call(url, label, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      connection: "close",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Preserve the bounded plain-text response in the error below.
  }
  if (!response.ok)
    throw new Error(
      `${label} endpoint returned ${response.status}: ${String(parsed?.error || responseText || "未返回错误详情").slice(0, 500)}`,
    );
  return { parsed };
}

async function fundingTick() {
  const startedAt = Date.now();
  fundingState.lastAttemptAt = startedAt;
  let delay = fundingIntervalMs;
  try {
    const funding = await call(
      fundingEndpoint,
      "account funding audit",
      fundingRequestTimeoutMs,
    );
    const parsed = funding.parsed;
    fundingState.lastResult = {
      plane: "ACCOUNT_AUDIT",
      attemptedBalanceRefreshes:
        Number(parsed?.balanceRefresh?.attempted) || 0,
      completedBalanceRefreshes:
        Number(parsed?.balanceRefresh?.completed) || 0,
      failedBalanceRefreshes:
        Number(parsed?.balanceRefresh?.failed) || 0,
      oldestBalanceSyncedAt:
        parsed?.balanceRefresh?.oldestSyncedAt ?? null,
      latestBalanceSyncedAt:
        parsed?.balanceRefresh?.latestSyncedAt ?? null,
    };
    if (
      parsed?.balanceRefresh &&
      (Number(parsed.balanceRefresh.failed) > 0 ||
        Number(parsed.balanceRefresh.completed) !==
          Number(parsed.balanceRefresh.attempted))
    ) {
      throw new Error(
        `account balance refresh incomplete: ${Number(parsed.balanceRefresh.completed) || 0}/${Number(parsed.balanceRefresh.attempted) || 0} completed, ${Number(parsed.balanceRefresh.failed) || 0} failed`,
      );
    }
    fundingState.failures = 0;
    fundingState.lastSuccessAt = Date.now();
    fundingState.lastFailure = null;
  } catch (error) {
    fundingState.failures += 1;
    fundingState.lastFailure = error instanceof Error ? error.message : String(error);
    delay = Math.max(fundingIntervalMs, 60_000);
    console.error(JSON.stringify({
      level: "error",
      service: "account-audit-runner",
      operation: "funding-refresh",
      failures: fundingState.failures,
      message: fundingState.lastFailure,
      at: new Date().toISOString(),
    }));
  } finally {
    fundingState.lastDurationMs = Date.now() - startedAt;
  }
  setTimeout(fundingTick, delay);
}

async function auditTick() {
  const startedAt = Date.now();
  auditState.lastAttemptAt = startedAt;
  let delay = reconciliationIntervalMs;
  try {
    const audit = await call(endpoint, "account audit", requestTimeoutMs);
    const parsed = audit.parsed;
    auditState.lastResult = {
      plane: "ACCOUNT_AUDIT",
      scheduledBalanceRefreshes: Number(parsed?.scheduledBalanceRefreshes) || 0,
      auxiliaryErrors: Number(parsed?.auxiliaryReconciliation?.errors) || 0,
      pendingCloseChecked: Number(parsed?.pendingCloseReconciliation?.checked) || 0,
      pendingCloseReconciled: Number(parsed?.pendingCloseReconciliation?.reconciled) || 0,
      pendingCloseReleased: Number(parsed?.pendingCloseReconciliation?.released) || 0,
      pendingCloseErrors: Number(parsed?.pendingCloseReconciliation?.errors) || 0,
      fullAccountErrors: Number(parsed?.fullAccountPositionReconciliation?.errors) || 0,
      fullAccountMismatches: Number(parsed?.fullAccountPositionReconciliation?.mismatched) || 0,
      sentinelShadowSampled:
        Number(parsed?.sentinelShadowEntryBackfill?.sampled) || 0,
      sentinelShadowErrors:
        Number(parsed?.sentinelShadowEntryBackfill?.errors) || 0,
      sentinelShadowDeferred:
        parsed?.sentinelShadowEntryBackfill?.deferred === true,
      sentinelShadowTraceId:
        parsed?.sentinelShadowEntryBackfill?.traceId ?? null,
    };
    auditState.failures = 0;
    auditState.lastSuccessAt = Date.now();
    auditState.lastFailure = null;
  } catch (error) {
    auditState.failures += 1;
    auditState.lastFailure = error instanceof Error ? error.message : String(error);
    delay = Math.max(reconciliationIntervalMs, 60_000);
    console.error(JSON.stringify({
      level: "error",
      service: "account-audit-runner",
      operation: "account-reconciliation",
      failures: auditState.failures,
      message: auditState.lastFailure,
      at: new Date().toISOString(),
    }));
  } finally {
    auditState.lastDurationMs = Date.now() - startedAt;
  }
  setTimeout(auditTick, delay);
}

async function strategyLearningTick() {
  const startedAt = Date.now();
  learningState.lastAttemptAt = startedAt;
  let delay = strategyLearningIntervalMs;
  try {
    const result = await call(
      strategyLearningEndpoint,
      "strategy learning",
      strategyLearningTimeoutMs,
    );
    const summary = result.parsed?.strategyLearningRefresh ?? {};
    learningState.lastResult = {
      plane: "STRATEGY_LEARNING",
      strategyLearningRefreshed: Number(summary.refreshed) || 0,
      strategyLearningErrors: Number(summary.errors) || 0,
      strategyLearningDeferred: summary.deferred === true,
      strategyLearningReason: summary.reason ?? null,
      strategyLearningTraceId: summary.traceId ?? null,
    };
    if (Number(summary.errors) > 0)
      throw new Error(
        `strategy learning reported ${Number(summary.errors)} errors`,
      );
    learningState.failures = 0;
    learningState.lastSuccessAt = Date.now();
    learningState.lastFailure = null;
  } catch (error) {
    learningState.failures += 1;
    learningState.lastFailure = error instanceof Error
      ? error.message
      : String(error);
    delay = Math.max(strategyLearningIntervalMs, 60_000);
    console.error(JSON.stringify({
      level: "error",
      service: "account-audit-runner",
      operation: "strategy-learning",
      failures: learningState.failures,
      message: learningState.lastFailure,
      at: new Date().toISOString(),
    }));
  } finally {
    learningState.lastDurationMs = Date.now() - startedAt;
  }
  setTimeout(strategyLearningTick, delay);
}

async function orderReconciliationTick() {
  const startedAt = Date.now();
  orderState.lastAttemptAt = startedAt;
  let delay = orderReconciliationIntervalMs;
  try {
    const result = await call(
      orderReconciliationEndpoint,
      "order reconciliation",
      orderReconciliationTimeoutMs,
    );
    const summary = result.parsed?.unknownEntryOrderReconciliation ?? {};
    const closeSummary = result.parsed?.pendingCloseReconciliation ?? {};
    const settlementSummary =
      result.parsed?.reductionSettlementBackfill ?? {};
    orderState.lastResult = {
      pendingCloseChecked: Number(closeSummary.checked) || 0,
      pendingCloseReconciled: Number(closeSummary.reconciled) || 0,
      pendingCloseReleased: Number(closeSummary.released) || 0,
      pendingCloseWaiting: Number(closeSummary.waiting) || 0,
      pendingCloseErrors: Number(closeSummary.errors) || 0,
      orderReconciliationChecked: Number(summary.checked) || 0,
      orderReconciliationReconciled: Number(summary.reconciled) || 0,
      orderReconciliationWaiting: Number(summary.waiting) || 0,
      orderReconciliationErrors: Number(summary.errors) || 0,
      reductionSettlementUpdated: Number(settlementSummary.updated) || 0,
      reductionSettlementExact: settlementSummary.exact === true,
      reductionSettlementErrors: Number(settlementSummary.errors) || 0,
      reductionSettlementDeferred: settlementSummary.deferred === true,
      reductionSettlementReason: settlementSummary.reason ?? null,
      reductionSettlementNextAttemptAt:
        settlementSummary.nextAttemptAt ?? null,
    };
    if (Number(closeSummary.errors) > 0 || Number(summary.errors) > 0)
      throw new Error(
        `order reconciliation reported ${Number(closeSummary.errors) || 0} close errors and ${Number(summary.errors) || 0} entry errors`,
      );
    orderState.failures = 0;
    orderState.lastSuccessAt = Date.now();
    orderState.lastFailure = null;
  } catch (error) {
    orderState.failures += 1;
    orderState.lastFailure = error instanceof Error ? error.message : String(error);
    delay = Math.min(30_000, orderReconciliationIntervalMs * 2 ** Math.min(orderState.failures, 4));
    console.error(JSON.stringify({
      level: "error",
      service: "account-audit-runner",
      operation: "order-reconciliation",
      failures: orderState.failures,
      message: orderState.lastFailure,
      at: new Date().toISOString(),
    }));
  } finally {
    orderState.lastDurationMs = Date.now() - startedAt;
  }
  setTimeout(orderReconciliationTick, delay);
}

setTimeout(fundingTick, initialDelayMs);
setTimeout(auditTick, reconciliationInitialDelayMs);
setTimeout(strategyLearningTick, strategyLearningInitialDelayMs);
setTimeout(orderReconciliationTick, Math.min(initialDelayMs, 2_000));
