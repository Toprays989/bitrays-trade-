export type AcknowledgedEntryRecovery = {
  orderStatus: "FILLED" | "PENDING" | "EXECUTION_UNKNOWN";
  traceState: "POSITION_OPEN" | "ORDER_PENDING" | "EXECUTION_UNKNOWN";
  intentStatus: "FILLED" | "SUBMITTED" | "EXECUTION_UNKNOWN";
  executionConfirmed: boolean;
  positionBindingComplete: boolean;
  duplicateSubmissionBlocked: boolean;
};

/**
 * Classifies local recovery after Binance has already acknowledged an order.
 * An acknowledged exchange order must never fall back to REJECTED merely
 * because a later local persistence or observability write failed.
 */
export function classifyAcknowledgedEntryRecovery(input: {
  orderType: "MARKET" | "LIMIT";
  executedQuantity: number;
  positionExists: boolean;
}): AcknowledgedEntryRecovery {
  const executedQuantity = Number.isFinite(input.executedQuantity)
    ? Math.max(0, input.executedQuantity)
    : 0;
  if (executedQuantity > 0 && input.positionExists)
    return {
      orderStatus: "FILLED",
      traceState: "POSITION_OPEN",
      intentStatus: "FILLED",
      executionConfirmed: true,
      positionBindingComplete: true,
      duplicateSubmissionBlocked: true,
    };
  if (executedQuantity <= 0 && input.orderType === "LIMIT")
    return {
      orderStatus: "PENDING",
      traceState: "ORDER_PENDING",
      intentStatus: "SUBMITTED",
      executionConfirmed: false,
      positionBindingComplete: false,
      duplicateSubmissionBlocked: true,
    };
  return {
    orderStatus: "EXECUTION_UNKNOWN",
    traceState: "EXECUTION_UNKNOWN",
    intentStatus: "EXECUTION_UNKNOWN",
    executionConfirmed: executedQuantity > 0,
    positionBindingComplete: false,
    duplicateSubmissionBlocked: true,
  };
}
