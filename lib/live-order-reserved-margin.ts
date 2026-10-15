type PendingOrderMarginInput = {
  estimatedNotional: number;
  quantity?: number;
  referencePrice?: number;
  responseJson?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveLeverage(value: unknown) {
  const leverage = Number(value);
  return Number.isFinite(leverage) && leverage >= 1 ? leverage : null;
}

function positiveQuantity(value: unknown) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function parsedOrderResponse(responseJson: string | null | undefined) {
  try {
    return asRecord(JSON.parse(responseJson ?? "{}"));
  } catch {
    return {};
  }
}

export function pendingOrderLeverage(
  order: Pick<PendingOrderMarginInput, "responseJson">,
  fallbackLeverage: number,
) {
  const response = parsedOrderResponse(order.responseJson);
  const manualPendingEntry = asRecord(response.manualPendingEntry);
  const strategyPendingEntry = asRecord(response.strategyPendingEntry);
  return (
    positiveLeverage(response.confirmedLeverage) ??
    positiveLeverage(strategyPendingEntry.leverage) ??
    positiveLeverage(manualPendingEntry.leverage) ??
    positiveLeverage(response.requestedLeverage) ??
    positiveLeverage(response.leverage) ??
    positiveLeverage(fallbackLeverage) ??
    1
  );
}

export function filledPendingOrderResponse(
  order: Pick<PendingOrderMarginInput, "quantity" | "responseJson">,
  exchangeResponse: unknown,
  fallbackLeverage: number,
) {
  const stored = parsedOrderResponse(order.responseJson);
  const exchange = asRecord(exchangeResponse);
  const requestedLeverage =
    positiveLeverage(stored.requestedLeverage) ??
    positiveLeverage(asRecord(stored.strategyPendingEntry).leverage) ??
    positiveLeverage(asRecord(stored.manualPendingEntry).leverage) ??
    positiveLeverage(fallbackLeverage) ??
    1;
  const confirmedLeverage =
    positiveLeverage(stored.confirmedLeverage) ??
    positiveLeverage(exchange.confirmedLeverage) ??
    requestedLeverage;
  const strategyOrderQuantity =
    positiveQuantity(stored.strategyOrderQuantity) ??
    positiveQuantity(order.quantity);
  return {
    ...stored,
    ...exchange,
    strategyOrderQuantity,
    requestedLeverage,
    confirmedLeverage,
  };
}

export function pendingOrderReservedMargin(
  order: PendingOrderMarginInput,
  fallbackLeverage: number,
) {
  const response = parsedOrderResponse(order.responseJson);
  const requestedQuantity = Number(order.quantity);
  const executedQuantity = Math.max(
    0,
    Number(response.executedQty) ||
      Number(asRecord(response.nexusPrivateOrderLifecycle).cumulativeQuantity) ||
      0,
  );
  const referencePrice = Number(order.referencePrice);
  const remainingNotional =
    Number.isFinite(requestedQuantity) &&
      requestedQuantity > 0 &&
      Number.isFinite(referencePrice) &&
      referencePrice > 0
      ? Math.max(0, requestedQuantity - executedQuantity) * referencePrice
      : Number(order.estimatedNotional);
  const notional = remainingNotional;
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  return notional / pendingOrderLeverage(order, fallbackLeverage);
}
