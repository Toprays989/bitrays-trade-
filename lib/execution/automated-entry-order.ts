import { liveOrderStatusFromExchange } from "../live-order-status.ts";

export const AUTOMATED_ENTRY_ORDER_CONTRACT_VERSION =
  "automated-entry-order-contract-v1" as const;

export type AutomatedEntryOrderType = "MARKET" | "LIMIT";

export function resolvedAutomatedEntryPrice(
  order: {
    avgPrice?: unknown;
    cumQuote?: unknown;
    executedQty?: unknown;
    price?: unknown;
  },
  fallback: number,
) {
  const average = Number(order.avgPrice);
  if (Number.isFinite(average) && average > 0) return average;
  const executed = Number(order.executedQty);
  const quote = Number(order.cumQuote);
  if (executed > 0 && quote > 0) return quote / executed;
  const price = Number(order.price);
  return Number.isFinite(price) && price > 0 ? price : fallback;
}

export function buildAutomatedEntryClientOrderId(input: {
  standardPrefix: "nql" | "nqs";
  inverted: boolean;
  traceRowId: number;
  traceId: string;
  attempt?: number;
}) {
  const attempt = Number.isInteger(input.attempt) && Number(input.attempt) > 1
    ? Math.trunc(Number(input.attempt))
    : 1;
  const attemptSuffix = attempt > 1 ? `_${attempt}` : "";
  const prefix = input.inverted ? "nqi" : input.standardPrefix;
  return `${prefix}_${input.traceRowId}_${input.traceId.slice(-10)}${attemptSuffix}`
    .slice(0, 36);
}

export function buildSimpleReboundClientOrderId(input: {
  traceRowId: number;
  traceId: string;
  attempt?: number;
}) {
  const attempt = Number.isInteger(input.attempt) && Number(input.attempt) > 1
    ? `_${Math.trunc(Number(input.attempt))}`
    : "";
  return `srb_${input.traceRowId}_${input.traceId.slice(-10)}${attempt}`.slice(0, 36);
}

export function readAutomatedEntryAcknowledgement(input: {
  response: unknown;
  orderType: AutomatedEntryOrderType;
  fallbackEntryPrice: number;
  confirmedLeverage: number;
  requestedLeverage: number;
}) {
  const response = input.response && typeof input.response === "object"
    ? input.response as Record<string, unknown>
    : {};
  const rawExecutedQuantity = Number(response.executedQty);
  const hasExecutedQuantity =
    Number.isFinite(rawExecutedQuantity) && rawExecutedQuantity > 0;
  const executedQuantity = Number.isFinite(rawExecutedQuantity)
    ? Math.max(0, rawExecutedQuantity)
    : 0;
  const rawAveragePrice = Number(response.avgPrice);
  const averagePrice = Number.isFinite(rawAveragePrice) && rawAveragePrice > 0
    ? rawAveragePrice
    : null;
  const fallbackEntryPrice = Number(input.fallbackEntryPrice);

  return {
    version: AUTOMATED_ENTRY_ORDER_CONTRACT_VERSION,
    exchangeOrderId:
      response.orderId === undefined || response.orderId === null
        ? null
        : String(response.orderId),
    canonicalOrderStatus: liveOrderStatusFromExchange(
      response.status,
      executedQuantity,
    ),
    executedQuantity,
    hasExecutedQuantity,
    averagePrice,
    effectiveEntryPrice: averagePrice ?? fallbackEntryPrice,
    pendingLimit:
      input.orderType === "LIMIT" && !hasExecutedQuantity,
    response: {
      ...response,
      confirmedLeverage: input.confirmedLeverage,
      requestedLeverage: input.requestedLeverage,
    },
  };
}
