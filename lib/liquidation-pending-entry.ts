import { effectiveNexusOrderDeadline } from "./nexus-order-lifecycle.ts";
import {
  liveOrderIsTerminal,
  liveOrderStatusFromExchange,
} from "./live-order-status.ts";
import {
  unfilledTerminalLiveOrderStatus,
} from "./execution/unfilled-terminal-order.ts";

export type PendingEntryOrderAction =
  | "WAIT"
  | "FINALIZE_FILL"
  | "CANCEL_REMAINDER"
  | "CANCEL_EXPIRED"
  | "CANCEL_STRUCTURE_INVALIDATED"
  | "FINISH_WITHOUT_FILL";

export function decidePendingEntryOrder(input: {
  exchangeStatus: string;
  executedQuantity: number;
  nowMs: number;
  createdAtMs: number;
  orderTtlSeconds: number;
  orderTtlMs?: number;
  analysisExpiresAtMs: number;
  currentMarkPrice: number;
  invalidBoundary: number | null;
  positionSide?: "LONG" | "SHORT";
}): {
  action: PendingEntryOrderAction;
  structureInvalidated: boolean;
  ttlExpired: boolean;
  terminalWithoutFill: boolean;
} {
  const status = input.exchangeStatus.trim().toUpperCase();
  const executedQuantity = finiteNonNegative(input.executedQuantity);
  const canonicalStatus = liveOrderStatusFromExchange(
    status,
    executedQuantity,
  );
  const boundary = finitePositive(input.invalidBoundary);
  const markPrice = finitePositive(input.currentMarkPrice);
  const structureInvalidated =
    boundary !== null &&
    markPrice !== null &&
    (input.positionSide === "SHORT"
      ? markPrice > boundary
      : markPrice < boundary);
  const ttlExpired = input.nowMs >= effectiveNexusOrderDeadline({
    orderCreatedAtMs: input.createdAtMs,
    orderTtlSeconds: input.orderTtlSeconds,
    orderTtlMs: input.orderTtlMs,
    analysisExpiresAtMs: input.analysisExpiresAtMs,
  });
  const terminalWithoutFill = Boolean(
    unfilledTerminalLiveOrderStatus(status, executedQuantity),
  );

  if (
    canonicalStatus === "FILLED" ||
    (liveOrderIsTerminal(canonicalStatus) && executedQuantity > 0)
  )
    return {
      action: "FINALIZE_FILL",
      structureInvalidated,
      ttlExpired,
      terminalWithoutFill,
    };
  if (status === "PARTIALLY_FILLED" && executedQuantity > 0)
    return {
      action: "CANCEL_REMAINDER",
      structureInvalidated,
      ttlExpired,
      terminalWithoutFill,
    };
  if (terminalWithoutFill)
    return {
      action: "FINISH_WITHOUT_FILL",
      structureInvalidated,
      ttlExpired,
      terminalWithoutFill,
    };
  if (structureInvalidated)
    return {
      action: "CANCEL_STRUCTURE_INVALIDATED",
      structureInvalidated,
      ttlExpired,
      terminalWithoutFill,
    };
  if (ttlExpired)
    return {
      action: "CANCEL_EXPIRED",
      structureInvalidated,
      ttlExpired,
      terminalWithoutFill,
    };
  return {
    action: "WAIT",
    structureInvalidated,
    ttlExpired,
    terminalWithoutFill,
  };
}

export function mayRearmAnalyzedLimit(input: {
  action: PendingEntryOrderAction;
  allowSecondOrder: boolean;
  attempt: number;
  nowMs: number;
  analysisExpiresAtMs: number;
}) {
  return (
    input.action === "CANCEL_EXPIRED" &&
    input.allowSecondOrder &&
    input.attempt < 2 &&
    input.nowMs < input.analysisExpiresAtMs
  );
}

export function resolvedExchangeFillTime(
  order: { updateTime?: unknown; time?: unknown },
  fallbackMs: number,
  observedAtMs = Date.now(),
) {
  const candidates = [order.updateTime, order.time]
    .map((value) => Number(value))
    .filter(
      (value) =>
        Number.isFinite(value) &&
        value > 0 &&
        value <= observedAtMs + 5_000,
    );
  const selected = candidates[0] ?? fallbackMs;
  const bounded =
    Number.isFinite(selected) && selected > 0 && selected <= observedAtMs + 5_000
      ? selected
      : observedAtMs;
  return new Date(bounded);
}

function finitePositive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
