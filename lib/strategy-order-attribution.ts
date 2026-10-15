export function strategyTraceIdFromClientOrderId(
  clientOrderId: string,
) {
  // Only automatic strategy *entry* prefixes own a strategy trace.
  // `nqc_` is reserved by the live-position close endpoint and its numeric
  // component is a position id, not a strategy trace id. Treating it as a
  // trace can accidentally charge a closing order against a strategy's daily
  // entry-margin quota when the two unrelated ids happen to be equal.
  const match = /^nq[lsip]_(\d+)_/.exec(clientOrderId);
  if (!match) return null;
  const traceId = Number(match[1]);
  return Number.isSafeInteger(traceId) && traceId > 0 ? traceId : null;
}

export const liquidationLongTraceIdFromClientOrderId =
  strategyTraceIdFromClientOrderId;

export function attributedOrderNotional(
  orders: Array<{ clientOrderId: string; estimatedNotional: number }>,
  traceIds: Iterable<number>,
) {
  const ownedTraceIds = new Set(traceIds);
  return orders.reduce((total, order) => {
    const traceId = strategyTraceIdFromClientOrderId(
      order.clientOrderId,
    );
    if (traceId === null || !ownedTraceIds.has(traceId)) return total;
    return total + order.estimatedNotional;
  }, 0);
}

function orderLeverage(
  responseJson: string | null | undefined,
  fallbackLeverage: number,
) {
  let parsed: Record<string, unknown> = {};
  if (typeof responseJson === "string" && responseJson.trim()) {
    try {
      const candidate = JSON.parse(responseJson);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
        parsed = candidate as Record<string, unknown>;
    } catch {
      // Historical order payloads may be incomplete. The strategy version
      // leverage remains the explicit compatibility fallback.
    }
  }
  for (const raw of [
    parsed.confirmedLeverage,
    parsed.requestedLeverage,
    parsed.leverage,
    fallbackLeverage,
  ]) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1 && value <= 125) return value;
  }
  return 1;
}

export function attributedOrderInitialMargin(
  orders: Array<{
    clientOrderId: string;
    estimatedNotional: number;
    responseJson?: string | null;
  }>,
  traceIds: Iterable<number>,
  fallbackLeverage: number,
) {
  const ownedTraceIds = new Set(traceIds);
  return orders.reduce((total, order) => {
    const traceId = strategyTraceIdFromClientOrderId(order.clientOrderId);
    if (traceId === null || !ownedTraceIds.has(traceId)) return total;
    const notional = Number(order.estimatedNotional);
    if (!Number.isFinite(notional) || notional <= 0) return total;
    return total + notional /
      orderLeverage(order.responseJson, fallbackLeverage);
  }, 0);
}

export function attributedPositionMargin(
  positions: Array<{
    id: number;
    quantity: number;
    markPrice: number;
    leverage: number;
  }>,
  ownedPositionIds: Iterable<number>,
) {
  const owned = new Set(ownedPositionIds);
  return positions.reduce((total, position) => {
    if (!owned.has(position.id)) return total;
    return total +
      position.quantity * position.markPrice /
        Math.max(position.leverage, 1);
  }, 0);
}

export function attributedPositionUnrealizedPnl(
  positions: Array<{
    id: number;
    positionSide: "LONG" | "SHORT";
    quantity: number;
    entryPrice: number;
    markPrice: number;
  }>,
  ownedPositionIds: Iterable<number>,
) {
  const owned = new Set(ownedPositionIds);
  return positions.reduce((total, position) => {
    if (!owned.has(position.id)) return total;
    const quantity = Number(position.quantity);
    const entryPrice = Number(position.entryPrice);
    const markPrice = Number(position.markPrice);
    if (
      !Number.isFinite(quantity) ||
      !Number.isFinite(entryPrice) ||
      !Number.isFinite(markPrice) ||
      quantity <= 0 ||
      entryPrice <= 0 ||
      markPrice <= 0
    )
      return total;
    const direction = position.positionSide === "SHORT" ? -1 : 1;
    return total + (markPrice - entryPrice) * quantity * direction;
  }, 0);
}
