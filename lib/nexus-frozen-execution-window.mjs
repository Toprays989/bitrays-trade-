export const MIN_FROZEN_EXECUTION_VALIDITY_MS = 60_000;
export const MAX_FROZEN_EXECUTION_VALIDITY_MS = 10 * 60_000;
export const DEFAULT_FROZEN_EXECUTION_VALIDITY_MS = 5 * 60_000;
export const MAX_FROZEN_EXECUTION_LIFETIME_MS = 30 * 60_000;

const RENEWABLE_EXECUTION_WAIT_CODES = new Set([
  "NEXUS_ACCOUNT_BALANCE_REFRESH_FAILED",
  "NEXUS_BOOK_EYE_STALE",
  "LONG_EXECUTION_PIPELINE_RECOVERY_WAIT",
  "PILOT_LIMIT_RULES_WAIT",
  "PILOT_MARK_PRICE_WAIT",
  "PILOT_REST_CAPACITY_WAIT",
  "PILOT_SYMBOL_RULES_WAIT",
  "SHORT_LIVE_MARK_PRICE_WAIT",
  "SHORT_LIVE_REST_CAPACITY_WAIT",
  "SHORT_LIVE_SYMBOL_RULES_WAIT",
  "SHORT_EXECUTION_PIPELINE_RECOVERY_WAIT",
]);

function finiteTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clampedValidityMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0)
    return DEFAULT_FROZEN_EXECUTION_VALIDITY_MS;
  return Math.min(
    Math.max(numeric, MIN_FROZEN_EXECUTION_VALIDITY_MS),
    MAX_FROZEN_EXECUTION_VALIDITY_MS,
  );
}

export function frozenExecutionValidityMs(analysisValiditySeconds) {
  return clampedValidityMs(Number(analysisValiditySeconds) * 1_000);
}

export function buildFrozenExecutionWindow(input) {
  const approvedAtMs = finiteTimestamp(input.approvedAt);
  if (approvedAtMs === null)
    throw new TypeError("获批执行时间无效，不能建立执行窗口");
  const executionValidityMs = frozenExecutionValidityMs(
    input.analysisValiditySeconds,
  );
  const executionExpiresAtMs = approvedAtMs + executionValidityMs;
  return {
    approvedAt: new Date(approvedAtMs).toISOString(),
    executionValidityMs,
    executionExpiresAt: new Date(executionExpiresAtMs).toISOString(),
    executionExpiresAtMs,
  };
}

export function resolveFrozenExecutionDeadline(input) {
  const decision =
    input.frozenDecision &&
      typeof input.frozenDecision === "object" &&
      !Array.isArray(input.frozenDecision)
      ? input.frozenDecision
      : {};
  const explicitDeadline = finiteTimestamp(decision.executionExpiresAt);
  if (explicitDeadline !== null) return explicitDeadline;
  const approvedAtMs = finiteTimestamp(decision.approvedAt);
  if (approvedAtMs === null) return null;
  const executionValidityMs =
    Number.isFinite(Number(decision.executionValidityMs)) &&
      Number(decision.executionValidityMs) > 0
      ? clampedValidityMs(Number(decision.executionValidityMs))
      : frozenExecutionValidityMs(input.analysisValiditySeconds);
  return approvedAtMs + executionValidityMs;
}

export function isFrozenExecutionApproval(decision) {
  return Boolean(
    decision &&
      typeof decision === "object" &&
      !Array.isArray(decision) &&
      decision.approved === true &&
      decision.decisionFrozen === true &&
      decision.retryWithoutReanalysis === true,
  );
}

export function resolveFrozenExecutionIntentExpiry(input) {
  const traceExpiresAtMs = finiteTimestamp(input.traceExpiresAt);
  if (traceExpiresAtMs === null)
    throw new TypeError("策略执行轨迹截止时间无效，不能创建执行意图");
  if (!isFrozenExecutionApproval(input.frozenDecision))
    return traceExpiresAtMs;
  const frozenDeadline = resolveFrozenExecutionDeadline({
    frozenDecision: input.frozenDecision,
    analysisValiditySeconds: input.analysisValiditySeconds,
  });
  return frozenDeadline === null
    ? traceExpiresAtMs
    : Math.max(traceExpiresAtMs, frozenDeadline);
}

export function renewableFrozenExecutionWait(code) {
  return typeof code === "string" &&
    RENEWABLE_EXECUTION_WAIT_CODES.has(code.trim());
}

export function renewFrozenExecutionDecision(input) {
  const source =
    input.frozenDecision &&
      typeof input.frozenDecision === "object" &&
      !Array.isArray(input.frozenDecision)
      ? input.frozenDecision
      : {};
  const deferredAtMs = finiteTimestamp(input.deferredAt);
  const approvedAtMs = finiteTimestamp(source.approvedAt);
  const waitCode =
    typeof input.waitCode === "string" ? input.waitCode.trim() : "";
  const currentDeadline = resolveFrozenExecutionDeadline({
    frozenDecision: source,
    analysisValiditySeconds: input.analysisValiditySeconds,
  });
  const renewalCount = Math.max(
    0,
    Math.trunc(Number(source.executionRenewalCount) || 0),
  );
  const maxRenewals = Math.max(
    0,
    Math.trunc(Number(input.maxRenewals) || 0),
  );
  if (
    input.allowRenewal !== true ||
    renewalCount >= maxRenewals ||
    !isFrozenExecutionApproval(source) ||
    !renewableFrozenExecutionWait(waitCode) ||
    deferredAtMs === null ||
    approvedAtMs === null ||
    currentDeadline === null
  ) {
    return {
      renewed: false,
      executionExpiresAtMs: currentDeadline,
      decision: source,
    };
  }
  const absoluteDeadline = approvedAtMs + MAX_FROZEN_EXECUTION_LIFETIME_MS;
  const renewalValidityMs = frozenExecutionValidityMs(
    input.analysisValiditySeconds,
  );
  const nextDeadline = Math.min(
    Math.max(currentDeadline, deferredAtMs + renewalValidityMs),
    absoluteDeadline,
  );
  const renewed = nextDeadline > currentDeadline;
  return {
    renewed,
    executionExpiresAtMs: nextDeadline,
    decision: {
      ...source,
      executionExpiresAt: new Date(nextDeadline).toISOString(),
      maxExecutionExpiresAt: new Date(absoluteDeadline).toISOString(),
      executionRenewalCount:
        renewalCount + (renewed ? 1 : 0),
      lastRenewedAt: renewed
        ? new Date(deferredAtMs).toISOString()
        : source.lastRenewedAt,
      renewalReason: waitCode,
    },
  };
}

export function frozenExecutionExpiryReason(decision) {
  const source =
    decision &&
      typeof decision === "object" &&
      !Array.isArray(decision)
      ? decision
      : {};
  const lastWaitCode =
    typeof source.waitCode === "string" && source.waitCode.trim()
      ? source.waitCode.trim()
      : "UNKNOWN_TRANSIENT_BLOCKER";
  const lastWaitMessage =
    typeof source.waitMessage === "string" && source.waitMessage.trim()
      ? source.waitMessage.trim()
      : "执行窗口内未记录可恢复条件的最后状态";
  return {
    lastWaitCode,
    lastWaitMessage,
    summary:
      `大脑判断已通过，但独立执行窗口到期；最后阻断为 ${lastWaitCode}：${lastWaitMessage}。` +
      "本次终止，禁止无限期使用旧判断",
  };
}
