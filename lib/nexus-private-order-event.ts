import type { NexusOrderState } from "./nexus-order-state-machine";

export type NexusPrivateOrderEvent = {
  eventType: "ORDER_TRADE_UPDATE";
  eventTime: number;
  transactionTime: number;
  symbol: string;
  clientOrderId: string;
  exchangeOrderId: string;
  side: "BUY" | "SELL";
  positionSide: "BOTH" | "LONG" | "SHORT";
  orderType: string;
  executionType: string;
  exchangeStatus: string;
  state: NexusOrderState;
  lastFilledQuantity: number;
  cumulativeQuantity: number;
  lastFilledPrice: number;
  averagePrice: number;
  realizedProfit: number;
  commission: number;
  commissionAsset: string | null;
};

function mappedState(
  executionType: string,
  status: string,
): NexusOrderState | null {
  if (status === "NEW") return "NEW";
  if (status === "PARTIALLY_FILLED") return "PARTIAL";
  if (status === "FILLED") return "FILLED";
  if (status === "CANCELED" || status === "EXPIRED") return "CANCELED";
  if (status === "REJECTED") return "REJECTED";
  if (executionType === "NEW") return "NEW";
  if (executionType === "TRADE") return "PARTIAL";
  return null;
}

export function normalizeBinancePrivateOrderEvent(
  payload: unknown,
): NexusPrivateOrderEvent | null {
  const source = payload as {
    e?: unknown;
    E?: unknown;
    T?: unknown;
    o?: Record<string, unknown>;
  };
  if (source?.e !== "ORDER_TRADE_UPDATE" || !source.o) return null;
  const order = source.o;
  const symbol = String(order.s || "").trim().toUpperCase();
  const clientOrderId = String(order.c || "").trim();
  const exchangeOrderId = String(order.i || "").trim();
  const side = String(order.S || "");
  const positionSide = String(order.ps || "BOTH");
  const executionType = String(order.x || "");
  const exchangeStatus = String(order.X || "");
  const state = mappedState(executionType, exchangeStatus);
  const eventTime = Number(source.E);
  const transactionTime = Number(source.T);
  const lastFilledQuantity = Number(order.l || 0);
  const cumulativeQuantity = Number(order.z || 0);
  const lastFilledPrice = Number(order.L || 0);
  const averagePrice = Number(order.ap || 0);
  const realizedProfit = Number(order.rp || 0);
  const commission = Number(order.n || 0);
  if (
    !state ||
    !symbol ||
    !clientOrderId ||
    !exchangeOrderId ||
    !["BUY", "SELL"].includes(side) ||
    !["BOTH", "LONG", "SHORT"].includes(positionSide) ||
    ![eventTime, transactionTime, lastFilledQuantity, cumulativeQuantity]
      .every(Number.isFinite)
  )
    return null;
  return {
    eventType: "ORDER_TRADE_UPDATE",
    eventTime,
    transactionTime,
    symbol,
    clientOrderId,
    exchangeOrderId,
    side: side as "BUY" | "SELL",
    positionSide: positionSide as "BOTH" | "LONG" | "SHORT",
    orderType: String(order.o || ""),
    executionType,
    exchangeStatus,
    state,
    lastFilledQuantity,
    cumulativeQuantity,
    lastFilledPrice: Number.isFinite(lastFilledPrice)
      ? lastFilledPrice
      : 0,
    averagePrice: Number.isFinite(averagePrice) ? averagePrice : 0,
    realizedProfit: Number.isFinite(realizedProfit) ? realizedProfit : 0,
    commission: Number.isFinite(commission) ? commission : 0,
    commissionAsset: order.N ? String(order.N) : null,
  };
}
