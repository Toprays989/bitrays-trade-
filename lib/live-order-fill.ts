export type LiveOrderFillPayload = {
  orderId?: string | number;
  status?: string;
  executedQty?: string | number;
  avgPrice?: string | number;
  cumQuote?: string | number;
  price?: string | number;
};

type StoredLiveOrderFillPayload = LiveOrderFillPayload & {
  nexusPrivateOrderLifecycle?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function stringOrNumberValue(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

export type LiveOrderTradeFill = {
  quantity: number;
  quoteQuantity: number;
  price: number;
};

export function resolveLiveOrderFill(
  data: LiveOrderFillPayload,
  fallbackLimitPrice?: number,
) {
  const status = String(data.status ?? "").trim().toUpperCase();
  const executedQuantity = Number(data.executedQty);
  const averagePrice = Number(data.avgPrice);
  const cumulativeQuote = Number(data.cumQuote);
  const responsePrice = Number(data.price);
  const fallbackPrice = Number(fallbackLimitPrice);
  const executionPrice = averagePrice > 0
    ? averagePrice
    : executedQuantity > 0 && cumulativeQuote > 0
      ? cumulativeQuote / executedQuantity
      : responsePrice > 0
        ? responsePrice
        : fallbackPrice > 0
          ? fallbackPrice
          : 0;
  return {
    status,
    executedQuantity: Number.isFinite(executedQuantity)
      ? executedQuantity
      : 0,
    executionPrice: Number.isFinite(executionPrice) ? executionPrice : 0,
    exchangeOrderId: String(data.orderId ?? "").trim() || null,
  };
}

/**
 * Rebuild a canonical Binance fill from the durable order ledger.  The
 * private user-data stream is authoritative when REST reconciliation is
 * temporarily unavailable, but older/query-reconciled rows may still carry
 * the same fields at the top level.
 */
export function resolveStoredLiveOrderFill(
  data: StoredLiveOrderFillPayload,
  fallbackExchangeOrderId?: string | null,
) {
  const lifecycle = asRecord(data.nexusPrivateOrderLifecycle);
  const normalized: LiveOrderFillPayload = {
    ...data,
    orderId:
      data.orderId ??
      fallbackExchangeOrderId ??
      undefined,
    status:
      stringValue(lifecycle.exchangeStatus) ??
      stringValue(lifecycle.state) ??
      data.status,
    executedQty:
      stringOrNumberValue(lifecycle.cumulativeQuantity) ??
      data.executedQty,
    avgPrice:
      stringOrNumberValue(lifecycle.averagePrice) ??
      data.avgPrice,
  };
  return {
    data: normalized,
    fill: resolveLiveOrderFill(normalized),
    source: Object.keys(lifecycle).length > 0
      ? "PRIVATE_WEBSOCKET" as const
      : "ORDER_LEDGER" as const,
  };
}

export function resolveLiveOrderTradeFill(
  trades: LiveOrderTradeFill[],
) {
  const executedQuantity = trades.reduce(
    (sum, trade) => sum + (Number.isFinite(trade.quantity) ? trade.quantity : 0),
    0,
  );
  const cumulativeQuote = trades.reduce(
    (sum, trade) =>
      sum + (Number.isFinite(trade.quoteQuantity) ? trade.quoteQuantity : 0),
    0,
  );
  const weightedPrice = executedQuantity > 0 && cumulativeQuote > 0
    ? cumulativeQuote / executedQuantity
    : trades.find((trade) => Number.isFinite(trade.price) && trade.price > 0)
        ?.price ?? 0;
  return {
    executedQuantity,
    executionPrice: Number.isFinite(weightedPrice) ? weightedPrice : 0,
  };
}

export function liveOrderHasExecutionEvidence(
  data: LiveOrderFillPayload | null | undefined,
) {
  if (!data) return false;
  const fill = resolveLiveOrderFill(data);
  return Boolean(fill.exchangeOrderId) || fill.executedQuantity > 0 ||
    ["FILLED", "PARTIALLY_FILLED"].includes(fill.status);
}

export function liveOrderFillIsConfirmed(input: {
  status: string;
  executedQuantity: number;
  executionPrice: number;
}) {
  return input.executedQuantity > 0 && input.executionPrice > 0 &&
    !["NEW", "PENDING"].includes(input.status);
}
