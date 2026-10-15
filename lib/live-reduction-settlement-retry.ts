export const REDUCTION_SETTLEMENT_RETRY_MAX_AGE_MS = 24 * 60 * 60_000;

const REDUCTION_SETTLEMENT_RETRY_DELAYS_MS = [
  1_000,
  2_000,
  5_000,
  10_000,
  30_000,
  60_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;

export type ReductionSettlementRetryState = {
  version: 1;
  status: "PENDING" | "UNAVAILABLE";
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  terminalReason: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readReductionSettlementRetryState(
  response: unknown,
): ReductionSettlementRetryState | null {
  const candidate = record(record(response)._nexusSettlementRetry);
  const attempts = Math.max(0, Math.trunc(Number(candidate.attempts) || 0));
  const status = candidate.status === "UNAVAILABLE"
    ? "UNAVAILABLE"
    : candidate.status === "PENDING"
      ? "PENDING"
      : null;
  if (!status) return null;
  return {
    version: 1,
    status,
    attempts,
    lastAttemptAt: typeof candidate.lastAttemptAt === "string"
      ? candidate.lastAttemptAt
      : null,
    nextAttemptAt: typeof candidate.nextAttemptAt === "string"
      ? candidate.nextAttemptAt
      : null,
    terminalReason: typeof candidate.terminalReason === "string"
      ? candidate.terminalReason
      : null,
  };
}

export function reductionSettlementRetryDue(input: {
  response: unknown;
  createdAtMs: number;
  nowMs: number;
}) {
  const state = readReductionSettlementRetryState(input.response);
  if (state?.status === "UNAVAILABLE")
    return { due: false, terminal: true, state };
  if (input.nowMs - input.createdAtMs >= REDUCTION_SETTLEMENT_RETRY_MAX_AGE_MS)
    return { due: false, terminal: true, state };
  const nextAttemptMs = state?.nextAttemptAt
    ? Date.parse(state.nextAttemptAt)
    : Number.NaN;
  return {
    due: !Number.isFinite(nextAttemptMs) || nextAttemptMs <= input.nowMs,
    terminal: false,
    state,
  };
}

export function scheduleReductionSettlementRetry(input: {
  response: unknown;
  createdAtMs: number;
  nowMs: number;
}) {
  const response = record(input.response);
  const prior = readReductionSettlementRetryState(response);
  const attempts = (prior?.attempts ?? 0) + 1;
  const delay = REDUCTION_SETTLEMENT_RETRY_DELAYS_MS[attempts - 1];
  const terminal =
    delay === undefined ||
    input.nowMs - input.createdAtMs >= REDUCTION_SETTLEMENT_RETRY_MAX_AGE_MS;
  const state: ReductionSettlementRetryState = {
    version: 1,
    status: terminal ? "UNAVAILABLE" : "PENDING",
    attempts,
    lastAttemptAt: new Date(input.nowMs).toISOString(),
    nextAttemptAt: terminal
      ? null
      : new Date(input.nowMs + delay).toISOString(),
    terminalReason: terminal ? "BINANCE_TRADE_DETAILS_UNAVAILABLE" : null,
  };
  return {
    response: {
      ...response,
      _nexusSettlementRetry: state,
    },
    state,
    terminal,
  };
}

export function terminalizeReductionSettlementRetry(input: {
  response: unknown;
  nowMs: number;
  reason?: string;
}) {
  const response = record(input.response);
  const prior = readReductionSettlementRetryState(response);
  const state: ReductionSettlementRetryState = {
    version: 1,
    status: "UNAVAILABLE",
    attempts: prior?.attempts ?? 0,
    lastAttemptAt: prior?.lastAttemptAt ?? null,
    nextAttemptAt: null,
    terminalReason: input.reason ?? "SETTLEMENT_RETRY_WINDOW_EXPIRED",
  };
  return {
    ...response,
    _nexusSettlementRetry: state,
  };
}
