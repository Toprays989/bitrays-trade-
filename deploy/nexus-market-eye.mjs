// Binance individual bookTicker is event-driven: when the best quote does not
// change, no new event is emitted. 500ms therefore describes the maximum
// transport delay of a received event, not the lifetime of an unchanged quote.
export const NEXUS_BOOK_STALE_MS = 500;
export const NEXUS_BOOK_SNAPSHOT_STALE_MS = 30_000;

export function normalizeBookTicker(payload, receivedAt = Date.now()) {
  if (!payload || (payload.st !== undefined && Number(payload.st) !== 1))
    return null;
  const symbol = String(payload.s || "").trim().toUpperCase();
  const bidPrice = Number(payload.b);
  const bidQuantity = Number(payload.B);
  const askPrice = Number(payload.a);
  const askQuantity = Number(payload.A);
  const updateId = Number(payload.u);
  const eventTime = Number(payload.E) || receivedAt;
  const transactionTime = Number(payload.T) || eventTime;
  if (
    !symbol ||
    ![bidPrice, bidQuantity, askPrice, askQuantity, updateId].every(
      Number.isFinite,
    ) ||
    bidPrice <= 0 ||
    askPrice <= bidPrice ||
    bidQuantity < 0 ||
    askQuantity < 0 ||
    updateId < 0
  )
    return null;
  const totalQuantity = bidQuantity + askQuantity;
  const midPrice = (bidPrice + askPrice) / 2;
  const microPrice =
    totalQuantity > 0
      ? (askPrice * bidQuantity + bidPrice * askQuantity) / totalQuantity
      : midPrice;
  return {
    symbol,
    updateId,
    eventTime,
    transactionTime,
    receivedAt,
    transportLatencyMs: Math.max(0, receivedAt - eventTime),
    bidPrice,
    bidQuantity,
    askPrice,
    askQuantity,
    midPrice,
    microPrice,
    spread: askPrice - bidPrice,
    spreadBps: ((askPrice - bidPrice) / midPrice) * 10_000,
    imbalance:
      totalQuantity > 0 ? (bidQuantity - askQuantity) / totalQuantity : 0,
  };
}

export function recordBookTicker(store, ticker) {
  if (!ticker) return { accepted: false, reason: "INVALID" };
  const previous = store.get(ticker.symbol);
  if (previous && ticker.updateId <= previous.updateId)
    return { accepted: false, reason: "NON_MONOTONIC", previous };
  store.set(ticker.symbol, ticker);
  return { accepted: true, reason: "UPDATED", value: ticker };
}

export function bookTickerSnapshot(
  store,
  symbols,
  now = Date.now(),
  maxTransportLatencyMs = NEXUS_BOOK_STALE_MS,
  snapshotStaleMs = NEXUS_BOOK_SNAPSHOT_STALE_MS,
) {
  const rows = [];
  const missing = [];
  const stale = [];
  for (const rawSymbol of symbols) {
    const symbol = String(rawSymbol || "").trim().toUpperCase();
    if (!symbol) continue;
    const row = store.get(symbol);
    if (!row) {
      missing.push(symbol);
      continue;
    }
    const ageMs = Math.max(0, now - row.receivedAt);
    const transportLatencyMs = Math.max(
      0,
      Number(row.transportLatencyMs) || row.receivedAt - row.eventTime,
    );
    const fresh =
      ageMs <= snapshotStaleMs &&
      transportLatencyMs <= maxTransportLatencyMs;
    rows.push({ ...row, ageMs, transportLatencyMs, fresh });
    if (!fresh) stale.push(symbol);
  }
  return {
    ready: missing.length === 0 && stale.length === 0 && rows.length > 0,
    // Keep staleAfterMs for compatible consumers; it now correctly represents
    // snapshot lifetime rather than transport latency.
    staleAfterMs: snapshotStaleMs,
    snapshotStaleAfterMs: snapshotStaleMs,
    maxTransportLatencyMs,
    missing,
    stale,
    rows,
  };
}
