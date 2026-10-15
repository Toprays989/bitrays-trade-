export const SIMPLE_REBOUND_ORDER_STATUSES = [
  "PENDING",
  "SUBMITTED",
  "FILLED",
  "REJECTED",
  "EXECUTION_UNKNOWN",
] as const;

export type SimpleReboundOrderStatus = (typeof SIMPLE_REBOUND_ORDER_STATUSES)[number];

export function resolveSimpleReboundOrderStatus(input: Readonly<{
  exchangeStatus?: string | null;
  acknowledged: boolean;
  filled: boolean;
  executionUnknown?: boolean;
}>): SimpleReboundOrderStatus {
  if (input.executionUnknown) return "EXECUTION_UNKNOWN";
  if (!input.acknowledged) return "REJECTED";
  if (input.filled || input.exchangeStatus === "FILLED") return "FILLED";
  return "SUBMITTED";
}

export function simpleReboundOrderCanAdvance(
  from: SimpleReboundOrderStatus,
  to: SimpleReboundOrderStatus,
) {
  if (from === to) return true;
  if (from === "PENDING") return ["SUBMITTED", "REJECTED", "EXECUTION_UNKNOWN"].includes(to);
  if (from === "SUBMITTED") return ["FILLED", "REJECTED", "EXECUTION_UNKNOWN"].includes(to);
  return false;
}

export function simpleReboundOrderTerminal(status: SimpleReboundOrderStatus) {
  return ["FILLED", "REJECTED", "EXECUTION_UNKNOWN"].includes(status);
}
