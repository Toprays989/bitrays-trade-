export const LIVE_ORDER_WORKING_STATUSES = [
  "PENDING",
  "NEW",
  "PARTIALLY_FILLED",
  "CANCEL_PENDING",
  "EXECUTION_UNKNOWN",
] as const;

export const LIVE_ORDER_EXECUTED_STATUSES = [
  "PARTIALLY_FILLED",
  "FILLED",
  "SUBMITTED",
] as const;

export const LIVE_ORDER_TERMINAL_STATUSES = [
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
] as const;

export type LiveOrderStatus =
  | "PENDING"
  | "TEST_ACCEPTED"
  | "SUBMITTED"
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED"
  | "EXECUTION_UNKNOWN";

export type TerminalLiveOrderStatus =
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED";

export function terminalLiveOrderStatus(
  status: TerminalLiveOrderStatus,
): TerminalLiveOrderStatus {
  return status;
}

type JsonRecord = Record<string, unknown>;

export function liveOrderStatusFromExchange(
  exchangeStatus: unknown,
  executedQuantity: unknown,
): LiveOrderStatus {
  const status = String(exchangeStatus ?? "").trim().toUpperCase();
  const quantity = Math.max(0, Number(executedQuantity) || 0);
  if (status === "NEW") return quantity > 0 ? "PARTIALLY_FILLED" : "NEW";
  if (status === "PARTIALLY_FILLED") return "PARTIALLY_FILLED";
  if (status === "FILLED") return quantity > 0 ? "FILLED" : "EXECUTION_UNKNOWN";
  if (status === "CANCELED") return "CANCELED";
  if (status === "EXPIRED" || status === "EXPIRED_IN_MATCH")
    return "EXPIRED";
  if (status === "REJECTED") return "REJECTED";
  return "EXECUTION_UNKNOWN";
}

export function liveOrderStatusFromNexusState(
  state: unknown,
  executedQuantity: unknown,
): LiveOrderStatus {
  const normalized = String(state ?? "").trim().toUpperCase();
  if (normalized === "CREATED" || normalized === "BUFFERED" || normalized === "SENT")
    return "PENDING";
  if (normalized === "ACKNOWLEDGED" || normalized === "NEW")
    return "NEW";
  if (normalized === "PARTIAL") return "PARTIALLY_FILLED";
  if (normalized === "FILLED") return "FILLED";
  if (normalized === "CANCEL_PENDING") return "CANCEL_PENDING";
  if (normalized === "CANCELED") return "CANCELED";
  if (normalized === "EXPIRED" || normalized === "EXPIRED_IN_MATCH")
    return "EXPIRED";
  if (normalized === "REJECTED") return "REJECTED";
  if (normalized === "EXECUTION_UNKNOWN") return "EXECUTION_UNKNOWN";
  return Number(executedQuantity) > 0 ? "PARTIALLY_FILLED" : "EXECUTION_UNKNOWN";
}

export function canonicalStoredLiveOrderStatus(input: {
  storedStatus: string;
  response?: JsonRecord | null;
  requestedQuantity?: number;
}): LiveOrderStatus {
  const stored = input.storedStatus.trim().toUpperCase() as LiveOrderStatus;
  if (!["PENDING", "SUBMITTED", "EXECUTION_UNKNOWN"].includes(stored))
    return stored;
  const response = input.response ?? {};
  const lifecycle =
    response.nexusPrivateOrderLifecycle &&
      typeof response.nexusPrivateOrderLifecycle === "object"
      ? response.nexusPrivateOrderLifecycle as JsonRecord
      : {};
  const exchangeStatus =
    lifecycle.exchangeStatus ?? lifecycle.state ?? response.status;
  const executedQuantity =
    lifecycle.cumulativeQuantity ?? response.executedQty ?? 0;
  if (String(exchangeStatus ?? "").trim()) {
    const canonical = liveOrderStatusFromExchange(
      exchangeStatus,
      executedQuantity,
    );
    if (canonical !== "EXECUTION_UNKNOWN") return canonical;
  }
  // Before lifecycle tracking was introduced, SUBMITTED meant a verified fill.
  if (stored === "SUBMITTED") return "FILLED";
  if (stored === "PENDING") return "NEW";
  // A genuinely unknown order must remain unknown when the stored exchange
  // response has no conclusive lifecycle evidence.  When Binance has already
  // returned FILLED/partial/terminal evidence above, however, the canonical
  // state is allowed to converge automatically without operator intervention.
  return "EXECUTION_UNKNOWN";
}

export function liveOrderIsWorking(status: string) {
  return (LIVE_ORDER_WORKING_STATUSES as readonly string[]).includes(status);
}

export function liveOrderCountsAsExecuted(status: string) {
  return (LIVE_ORDER_EXECUTED_STATUSES as readonly string[]).includes(status);
}

export function liveOrderIsTerminal(status: unknown) {
  const normalized = String(status ?? "").trim().toUpperCase();
  return (LIVE_ORDER_TERMINAL_STATUSES as readonly string[]).includes(
    normalized,
  );
}
