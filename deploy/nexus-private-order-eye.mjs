const STATE_BY_STATUS = {
  NEW: "NEW",
  PARTIALLY_FILLED: "PARTIAL",
  FILLED: "FILLED",
  CANCELED: "CANCELED",
  EXPIRED: "CANCELED",
  REJECTED: "REJECTED",
};

export function normalizePrivateOrderUpdate(payload, receivedAt = Date.now()) {
  if (payload?.e !== "ORDER_TRADE_UPDATE" || !payload.o) return null;
  const order = payload.o;
  const state = STATE_BY_STATUS[String(order.X || "")];
  const symbol = String(order.s || "").trim().toUpperCase();
  const clientOrderId = String(order.c || "").trim();
  const exchangeOrderId = String(order.i || "").trim();
  if (!state || !symbol || !clientOrderId || !exchangeOrderId) return null;
  return {
    sequence: 0,
    eventType: "ORDER_TRADE_UPDATE",
    eventTime: Number(payload.E) || receivedAt,
    transactionTime: Number(payload.T) || receivedAt,
    receivedAt,
    symbol,
    clientOrderId,
    exchangeOrderId,
    side: order.S === "SELL" ? "SELL" : "BUY",
    positionSide: ["LONG", "SHORT"].includes(order.ps)
      ? order.ps
      : "BOTH",
    orderType: String(order.o || ""),
    executionType: String(order.x || ""),
    exchangeStatus: String(order.X || ""),
    state,
    originalQuantity: Number(order.q) || 0,
    lastFilledQuantity: Number(order.l) || 0,
    cumulativeQuantity: Number(order.z) || 0,
    lastFilledPrice: Number(order.L) || 0,
    averagePrice: Number(order.ap) || 0,
    realizedProfit: Number(order.rp) || 0,
    commission: Number(order.n) || 0,
    commissionAsset: order.N ? String(order.N) : null,
  };
}

export function createPrivateOrderEventStore(limit = 1_000) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("私有订单事件容量无效");
  const rows = [];
  let sequence = 0;
  return {
    append(payload, receivedAt = Date.now()) {
      const event = normalizePrivateOrderUpdate(payload, receivedAt);
      if (!event) return null;
      sequence += 1;
      event.sequence = sequence;
      rows.push(event);
      if (rows.length > limit) rows.splice(0, rows.length - limit);
      return event;
    },
    after(afterSequence = 0) {
      return rows.filter((row) => row.sequence > afterSequence);
    },
    snapshot() {
      return {
        retained: rows.length,
        lastSequence: sequence,
        oldestSequence: rows[0]?.sequence ?? null,
      };
    },
  };
}
