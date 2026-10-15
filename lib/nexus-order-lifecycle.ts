import type {
  NexusIntentStatus,
} from "./nexus-execution-coordinator";

export const NEXUS_ORDER_SETTLEMENT_GRACE_MS = 30_000;

/**
 * One authoritative deadline for an exchange-facing entry order. The order
 * must never outlive either its configured GTC horizon or the analysis that
 * authorized it.
 */
export function effectiveNexusOrderDeadline(input: {
  orderCreatedAtMs: number;
  orderTtlSeconds: number;
  orderTtlMs?: number;
  analysisExpiresAtMs: number;
}) {
  const configuredTtlMs = Number.isFinite(input.orderTtlMs)
    ? Math.max(250, Math.trunc(Number(input.orderTtlMs)))
    : Math.max(5, Math.trunc(input.orderTtlSeconds)) * 1_000;
  const configuredDeadline =
    input.orderCreatedAtMs + configuredTtlMs;
  return Math.min(configuredDeadline, input.analysisExpiresAtMs);
}

/**
 * The reservation remains attached until the exchange order has had one
 * reconciliation cycle after its effective deadline. It is not an extension
 * of the trading decision and cannot authorize a retry.
 */
export function nexusExecutionIntentSettlementDeadline(input: {
  orderCreatedAtMs: number;
  orderTtlSeconds: number;
  orderTtlMs?: number;
  analysisExpiresAtMs: number;
  settlementGraceMs?: number;
}) {
  return effectiveNexusOrderDeadline(input) +
    Math.max(
      0,
      Math.trunc(
        input.settlementGraceMs ?? NEXUS_ORDER_SETTLEMENT_GRACE_MS,
      ),
    );
}

/**
 * Exchange truth may close an intent whose reservation lease already expired.
 * This transition only converges ledgers: it never re-opens the reservation or
 * grants another submission attempt.
 */
export function terminalNexusIntentSettlementStatus(
  current: NexusIntentStatus,
  exchangeTerminal: Extract<
    NexusIntentStatus,
    "FILLED" | "CANCELED" | "REJECTED"
  >,
) {
  if (current === exchangeTerminal) return exchangeTerminal;
  if (current === "EXPIRED") return exchangeTerminal;
  return null;
}

export function nexusIntentMayExpireWithoutExchangeOrder(input: {
  status: NexusIntentStatus;
  liveOrderEventId?: number | null;
}) {
  return (
    ["RESERVED", "SUBMITTING"].includes(input.status) &&
    !(Number.isInteger(input.liveOrderEventId) &&
      Number(input.liveOrderEventId) > 0)
  );
}
