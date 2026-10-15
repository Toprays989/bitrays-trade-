export type NexusOrderState =
  | "CREATED"
  | "BUFFERED"
  | "SENT"
  | "ACKNOWLEDGED"
  | "NEW"
  | "PARTIAL"
  | "CANCEL_PENDING"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXECUTION_UNKNOWN";

const TERMINAL = new Set<NexusOrderState>([
  "FILLED",
  "CANCELED",
  "REJECTED",
]);

const TRANSITIONS: Record<NexusOrderState, ReadonlySet<NexusOrderState>> = {
  CREATED: new Set(["BUFFERED", "SENT", "REJECTED"]),
  BUFFERED: new Set(["SENT", "REJECTED"]),
  SENT: new Set([
    "ACKNOWLEDGED",
    "NEW",
    "PARTIAL",
    "FILLED",
    "REJECTED",
    "EXECUTION_UNKNOWN",
  ]),
  ACKNOWLEDGED: new Set([
    "NEW",
    "PARTIAL",
    "FILLED",
    "CANCEL_PENDING",
    "CANCELED",
    "REJECTED",
    "EXECUTION_UNKNOWN",
  ]),
  NEW: new Set([
    "PARTIAL",
    "FILLED",
    "CANCEL_PENDING",
    "CANCELED",
    "EXECUTION_UNKNOWN",
  ]),
  PARTIAL: new Set([
    "PARTIAL",
    "FILLED",
    "CANCEL_PENDING",
    "CANCELED",
    "EXECUTION_UNKNOWN",
  ]),
  CANCEL_PENDING: new Set([
    "PARTIAL",
    "FILLED",
    "CANCELED",
    "EXECUTION_UNKNOWN",
  ]),
  FILLED: new Set(),
  CANCELED: new Set(),
  REJECTED: new Set(),
  EXECUTION_UNKNOWN: new Set([
    "ACKNOWLEDGED",
    "NEW",
    "PARTIAL",
    "FILLED",
    "CANCELED",
    "REJECTED",
  ]),
};

export function isNexusOrderTerminal(state: NexusOrderState) {
  return TERMINAL.has(state);
}

export function transitionNexusOrderState(
  current: NexusOrderState,
  next: NexusOrderState,
) {
  if (current === next) return current;
  if (!TRANSITIONS[current].has(next))
    throw new Error(`非法订单状态转换：${current} → ${next}`);
  return next;
}

export type NexusOrderLifecycle = {
  clientOrderId: string;
  exchangeOrderId: string | null;
  state: NexusOrderState;
  originalQuantity: number;
  cumulativeQuantity: number;
  averagePrice: number;
  updatedAt: number;
  terminalAt: number | null;
};

export function applyNexusOrderTransition(
  current: NexusOrderLifecycle,
  update: {
    state: NexusOrderState;
    exchangeOrderId?: string | null;
    cumulativeQuantity?: number;
    averagePrice?: number;
    eventTime: number;
  },
): NexusOrderLifecycle {
  const state = transitionNexusOrderState(current.state, update.state);
  const cumulativeQuantity = Math.max(
    current.cumulativeQuantity,
    Number(update.cumulativeQuantity) || 0,
  );
  if (cumulativeQuantity > current.originalQuantity + 1e-12)
    throw new Error("订单累计成交量超过原始数量");
  const averagePrice =
    Number(update.averagePrice) > 0
      ? Number(update.averagePrice)
      : current.averagePrice;
  return {
    ...current,
    exchangeOrderId:
      update.exchangeOrderId || current.exchangeOrderId || null,
    state,
    cumulativeQuantity,
    averagePrice,
    updatedAt: Math.max(current.updatedAt, update.eventTime),
    terminalAt: isNexusOrderTerminal(state)
      ? Math.max(current.updatedAt, update.eventTime)
      : null,
  };
}
