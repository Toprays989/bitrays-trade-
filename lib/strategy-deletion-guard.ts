export const ACTIVE_STRATEGY_EXECUTION_STATES = [
  "TRIGGERED",
  "ANALYZING",
  "ARMED",
  "ORDER_READY",
  "ORDER_PENDING",
  "POSITION_OPEN",
  "TRAILING_ARMED",
  "TRAILING_ACTIVE",
  "EXIT_PENDING",
  "MONITOR_READY",
] as const;

export const ACTIVE_LIVE_ORDER_STATUSES = [
  "PENDING",
  "SUBMITTED",
  "NEW",
  "PARTIALLY_FILLED",
  "CANCEL_PENDING",
  "EXECUTION_UNKNOWN",
] as const;

type ExecutionTrace = {
  state: string;
  symbol: string;
  expiresAt: Date;
  exchangeOrderId: string | null;
  positionId: string | null;
};

type ActivePosition = {
  symbol: string;
  side: string;
  status: string;
};

type ActiveOrder = {
  symbol: string;
  status: string;
};

export type StrategyDeletionBlocker =
  | { kind: "POSITION"; position: ActivePosition }
  | { kind: "ADDITION" }
  | { kind: "ORDER"; order: ActiveOrder }
  | { kind: "EXECUTION"; trace: ExecutionTrace }
  | null;

export function findStrategyDeletionBlocker(input: {
  strategyStatus: string;
  traces: ExecutionTrace[];
  activePosition?: ActivePosition;
  hasUnresolvedAddition: boolean;
  activeOrder?: ActiveOrder;
  nowMs?: number;
}): StrategyDeletionBlocker {
  if (input.activePosition) {
    return { kind: "POSITION", position: input.activePosition };
  }
  if (input.hasUnresolvedAddition) return { kind: "ADDITION" };
  if (input.activeOrder) return { kind: "ORDER", order: input.activeOrder };

  if (input.strategyStatus !== "RUNNING") return null;
  const nowMs = input.nowMs ?? Date.now();
  const trace = input.traces.find(
    (candidate) =>
      ACTIVE_STRATEGY_EXECUTION_STATES.includes(
        candidate.state as (typeof ACTIVE_STRATEGY_EXECUTION_STATES)[number],
      ) &&
      !candidate.exchangeOrderId &&
      !candidate.positionId &&
      candidate.expiresAt.getTime() > nowMs,
  );
  return trace ? { kind: "EXECUTION", trace } : null;
}
