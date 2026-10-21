// Keep enough of the existing WebSocket mark stream to aggregate the last
// four 1m candles. This remains an in-memory stream buffer and adds no REST
// requests or Binance weight.
const DEFAULT_RETENTION_MS = 5 * 60_000;
const DEFAULT_WATCH_TTL_MS = 2 * 60_000;
const DEFAULT_VOLATILITY_RETENTION_MS = 8 * 24 * 60 * 60_000;
// Keep one bounded 45-second window for the full active Binance futures
// universe. This data is fed by the existing WebSocket stream and does not add
// REST weight.
const DEFAULT_MAX_WATCHED_SYMBOLS = 320;
const DEFAULT_MAX_SAMPLES_PER_SYMBOL = 360;

export function createMarkPriceHistory(options = {}) {
  const retentionMs = positiveInteger(
    options.retentionMs,
    DEFAULT_RETENTION_MS,
  );
  const watchTtlMs = positiveInteger(
    options.watchTtlMs,
    DEFAULT_WATCH_TTL_MS,
  );
  const maximumWatchedSymbols = positiveInteger(
    options.maximumWatchedSymbols,
    DEFAULT_MAX_WATCHED_SYMBOLS,
  );
  const maximumSamplesPerSymbol = positiveInteger(
    options.maximumSamplesPerSymbol,
    DEFAULT_MAX_SAMPLES_PER_SYMBOL,
  );
  const watches = new Map();
  const histories = new Map();
  const volatilityDays = new Map();

  function watch(symbols, observedAtMs = Date.now()) {
    const nowMs = finiteTimestamp(observedAtMs);
    pruneExpiredWatches(nowMs);
    for (const rawSymbol of symbols ?? []) {
      const symbol = normalizedSymbol(rawSymbol);
      if (!symbol) continue;
      watches.delete(symbol);
      watches.set(symbol, nowMs + watchTtlMs);
      while (watches.size > maximumWatchedSymbols) {
        const oldest = watches.keys().next().value;
        if (typeof oldest !== "string") break;
        watches.delete(oldest);
        histories.delete(oldest);
      }
    }
  }

  function record(input) {
    const symbol = normalizedSymbol(input?.symbol);
    const markPrice = Number(input?.markPrice);
    const eventAtMs = finiteTimestamp(input?.eventAtMs);
    const receivedAtMs = finiteTimestamp(input?.receivedAtMs ?? eventAtMs);
    if (!symbol || !Number.isFinite(markPrice) || markPrice <= 0) return false;
    const watchUntilMs = watches.get(symbol) ?? 0;
    if (watchUntilMs < receivedAtMs) {
      watches.delete(symbol);
      histories.delete(symbol);
      return false;
    }
    const cutoffMs = receivedAtMs - retentionMs;
    const history = (histories.get(symbol) ?? []).filter(
      (sample) => sample.eventAtMs >= cutoffMs,
    );
    const sample = { markPrice, eventAtMs, receivedAtMs };
    const last = history.at(-1);
    if (last?.eventAtMs === eventAtMs) history[history.length - 1] = sample;
    else if (!last || eventAtMs > last.eventAtMs) history.push(sample);
    else {
      history.push(sample);
      history.sort((left, right) => left.eventAtMs - right.eventAtMs);
    }
    if (history.length > maximumSamplesPerSymbol)
      history.splice(0, history.length - maximumSamplesPerSymbol);
    histories.set(symbol, history);
    const dayStartMs = Math.floor(eventAtMs / 86_400_000) * 86_400_000;
    const cutoffDayMs = receivedAtMs - DEFAULT_VOLATILITY_RETENTION_MS;
    const days = (volatilityDays.get(symbol) ?? []).filter(
      (day) => day.dayStartMs >= cutoffDayMs,
    );
    const current = days.at(-1);
    if (current?.dayStartMs === dayStartMs) {
      current.low = Math.min(current.low, markPrice);
      current.high = Math.max(current.high, markPrice);
      current.last = markPrice;
      current.sampleCount += 1;
    } else {
      const existing = days.find((day) => day.dayStartMs === dayStartMs);
      if (existing) {
        existing.low = Math.min(existing.low, markPrice);
        existing.high = Math.max(existing.high, markPrice);
        existing.last = markPrice;
        existing.sampleCount += 1;
        days.sort((left, right) => left.dayStartMs - right.dayStartMs);
      } else {
        days.push({
          dayStartMs,
          low: markPrice,
          high: markPrice,
          first: markPrice,
          last: markPrice,
          sampleCount: 1,
        });
      }
    }
    volatilityDays.set(symbol, days);
    return true;
  }

  function snapshot(symbolInput, observedAtMs = Date.now()) {
    const symbol = normalizedSymbol(symbolInput);
    if (!symbol) return [];
    const nowMs = finiteTimestamp(observedAtMs);
    const cutoffMs = nowMs - retentionMs;
    const history = (histories.get(symbol) ?? []).filter(
      (sample) => sample.eventAtMs >= cutoffMs,
    );
    if (history.length) histories.set(symbol, history);
    else histories.delete(symbol);
    return history.map((sample) => ({ ...sample }));
  }

  function metrics(observedAtMs = Date.now()) {
    pruneExpiredWatches(finiteTimestamp(observedAtMs));
    let sampleCount = 0;
    for (const history of histories.values()) sampleCount += history.length;
    return {
      watchedSymbols: watches.size,
      historySymbols: histories.size,
      sampleCount,
      retentionMs,
      maximumWatchedSymbols,
      maximumSamplesPerSymbol,
      volatilitySymbols: volatilityDays.size,
    };
  }

  function volatility(symbolInput, observedAtMs = Date.now(), windowDays = 7) {
    const symbol = normalizedSymbol(symbolInput);
    if (!symbol) return { symbol: "", days: [], complete: false };
    const nowMs = finiteTimestamp(observedAtMs);
    const currentDayStartMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
    const days = (volatilityDays.get(symbol) ?? [])
      .filter((day) => day.dayStartMs < currentDayStartMs)
      .slice(-Math.max(1, Math.floor(Number(windowDays) || 7)))
      .map((day) => ({ ...day, rangePercent: ((day.high - day.low) / day.low) * 100 }));
    return {
      symbol,
      days,
      complete: days.length >= Math.max(3, Math.floor(Number(windowDays) || 7)),
    };
  }

  function pruneExpiredWatches(nowMs) {
    for (const [symbol, watchUntilMs] of watches) {
      if (watchUntilMs >= nowMs) continue;
      watches.delete(symbol);
      histories.delete(symbol);
      volatilityDays.delete(symbol);
    }
  }

  return { watch, record, snapshot, metrics, volatility };
}

function normalizedSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{2,30}$/.test(symbol) ? symbol : "";
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
