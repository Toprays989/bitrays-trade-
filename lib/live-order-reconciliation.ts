export type UnknownEntryOrderResolution =
  | "WAIT"
  | "CONFIRMED_EXECUTION"
  | "CONFIRMED_NO_FILL";

export type RecoveredStrategyTraceState =
  | "POSITION_OPEN"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED";

export function strategyTraceIdFromClientOrderId(
  clientOrderId: string,
): number | null {
  const match = clientOrderId.match(/^nq[lsip]_(\d+)_/);
  if (!match) return null;
  const traceId = Number(match[1]);
  return Number.isSafeInteger(traceId) && traceId > 0 ? traceId : null;
}

export function recoveredStrategyTraceState(input: {
  confirmedExecution: boolean;
  canonicalOrderStatus: string;
}): RecoveredStrategyTraceState {
  if (input.confirmedExecution) return "POSITION_OPEN";
  const status = input.canonicalOrderStatus.trim().toUpperCase();
  if (status === "EXPIRED") return "EXPIRED";
  if (status === "REJECTED") return "REJECTED";
  return "CANCELED";
}

export function resolveUnknownEntryOrder(
  exchangeStatus: string,
  executedQuantity: number,
): UnknownEntryOrderResolution {
  const status = exchangeStatus.trim().toUpperCase();
  const quantity =
    Number.isFinite(executedQuantity) && executedQuantity > 0
      ? executedQuantity
      : 0;
  if (
    quantity > 0 &&
    ["FILLED", "PARTIALLY_FILLED", "CANCELED", "EXPIRED"].includes(status)
  )
    return "CONFIRMED_EXECUTION";
  if (
    quantity === 0 &&
    ["CANCELED", "EXPIRED", "REJECTED"].includes(status)
  )
    return "CONFIRMED_NO_FILL";
  return "WAIT";
}

export function recoverableEntryQuantity(
  executedQuantity: number,
  exchangePositionQuantity: number,
  representedLocalQuantity: number,
): number {
  const executed =
    Number.isFinite(executedQuantity) && executedQuantity > 0
      ? executedQuantity
      : 0;
  const exchange =
    Number.isFinite(exchangePositionQuantity) && exchangePositionQuantity > 0
      ? exchangePositionQuantity
      : 0;
  const represented =
    Number.isFinite(representedLocalQuantity) && representedLocalQuantity > 0
      ? representedLocalQuantity
      : 0;
  return Math.min(executed, Math.max(0, exchange - represented));
}
