import { liveOrderIsWorking } from "./live-order-status.ts";

export type AutomatedWorkingOrder = {
  id?: number;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  status: string;
  estimatedNotional: number;
};

export type AutomatedOrderConcurrencyDecision =
  | {
      allowed: true;
      code: "ORDER_CAPACITY_RESERVED";
      reservedNotional: number;
      blockingOrder: null;
    }
  | {
      allowed: false;
      code: "EXECUTION_UNKNOWN_ORDER" | "SAME_LEG_WORKING_ORDER";
      reservedNotional: number;
      blockingOrder: AutomatedWorkingOrder;
    };

function normalizedSymbol(value: string) {
  return value.trim().toUpperCase();
}

/**
 * A working order consumes margin, but it must not freeze every unrelated
 * symbol on the account. Unknown execution state remains account-wide because
 * the actual exposure is not yet trustworthy. A known working order blocks
 * only the same executable leg (or the whole symbol in one-way mode).
 */
export function evaluateAutomatedOrderConcurrency(input: {
  orders: AutomatedWorkingOrder[];
  targetSymbol: string;
  targetPositionSide: "LONG" | "SHORT";
  positionMode: "ONE_WAY" | "HEDGE";
}): AutomatedOrderConcurrencyDecision {
  // Treat the database query as an optimization, not a correctness boundary.
  // A caller may accidentally pass daily history (including FILLED/CANCELED
  // rows). Terminal history must never reserve margin or prevent re-entry.
  const workingOrders = input.orders.filter((order) =>
    liveOrderIsWorking(normalizedStatus(order.status))
  );
  const reservedNotional = workingOrders.reduce(
    (sum, order) =>
      sum + Math.max(0, Number(order.estimatedNotional) || 0),
    0,
  );
  const unknown = workingOrders.find(
    (order) => normalizedStatus(order.status) === "EXECUTION_UNKNOWN",
  );
  if (unknown)
    return {
      allowed: false,
      code: "EXECUTION_UNKNOWN_ORDER",
      reservedNotional,
      blockingOrder: unknown,
    };

  const targetSymbol = normalizedSymbol(input.targetSymbol);
  const sameLeg = workingOrders.find((order) => {
    if (normalizedSymbol(order.symbol) !== targetSymbol) return false;
    return input.positionMode === "ONE_WAY" ||
      order.positionSide === input.targetPositionSide;
  });
  if (sameLeg)
    return {
      allowed: false,
      code: "SAME_LEG_WORKING_ORDER",
      reservedNotional,
      blockingOrder: sameLeg,
    };

  return {
    allowed: true,
    code: "ORDER_CAPACITY_RESERVED",
    reservedNotional,
    blockingOrder: null,
  };
}

function normalizedStatus(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}
