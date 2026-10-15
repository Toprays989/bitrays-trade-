export type NexusEntryWaitDisposition =
  | "WAIT_WITHIN_DEADLINE"
  | "RETRY_INFRASTRUCTURE_WITHIN_DEADLINE"
  | "TERMINATE_FOR_FRESH_ANALYSIS";

const THESIS_INVALIDATION_CODES = new Set([
  "BROKEN_SUPPORT_RECLAIMED",
  "STRUCTURE_INVALIDATED",
  "EYE_ENTRY_TREND_CONFLICT",
]);

const EXECUTION_TIMING_EXPIRED_CODES = new Set([
  "PRICE_TOO_FAR",
]);

const INFRASTRUCTURE_WAIT_CODES = new Set([
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

export function nexusEntryWaitDisposition(
  code: unknown,
): NexusEntryWaitDisposition {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (
    THESIS_INVALIDATION_CODES.has(normalized) ||
    EXECUTION_TIMING_EXPIRED_CODES.has(normalized)
  ) return "TERMINATE_FOR_FRESH_ANALYSIS";
  if (INFRASTRUCTURE_WAIT_CODES.has(normalized))
    return "RETRY_INFRASTRUCTURE_WITHIN_DEADLINE";
  return "WAIT_WITHIN_DEADLINE";
}

export function explicitProgressRenewal(input: {
  allowRenewal?: boolean;
  previousProgressKey?: unknown;
  nextProgressKey?: unknown;
  renewalCount?: unknown;
  maxRenewals?: unknown;
}) {
  const previousProgressKey = String(input.previousProgressKey ?? "").trim();
  const nextProgressKey = String(input.nextProgressKey ?? "").trim();
  const renewalCount = Math.max(
    0,
    Math.trunc(Number(input.renewalCount) || 0),
  );
  const maxRenewals = Math.max(
    0,
    Math.trunc(Number(input.maxRenewals) || 0),
  );
  const progressChanged = Boolean(
    nextProgressKey && nextProgressKey !== previousProgressKey,
  );
  return {
    allowed:
      input.allowRenewal === true &&
      progressChanged &&
      renewalCount < maxRenewals,
    progressChanged,
    renewalCount,
    maxRenewals,
    nextProgressKey: nextProgressKey || null,
  };
}
