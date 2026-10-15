import {
  getBinanceLiveContractUniverse,
  getBinanceLiveMarkPrices,
} from "./binance-usdm-live.ts";
import { buildSimpleReboundMarketRows } from "./simple-rebound-scanner.ts";
import { mapSimpleReboundVolumeRows } from "./simple-rebound-market-mapping.ts";

type MarkHistorySample = Readonly<{ markPrice: number; eventAtMs: number }>;

/**
 * Build the small set of 1m bars needed by the independent strategy from the
 * existing mark-price WebSocket history.  This intentionally does not call
 * /fapi/v1/klines (or the unified REST-backed market-data adapter).
 */
export function aggregateSimpleReboundMinuteCandles(
  history: readonly MarkHistorySample[],
) {
  const buckets = new Map<number, { open: number; close: number }>();
  for (const sample of history) {
    const price = Number(sample.markPrice);
    const eventAtMs = Number(sample.eventAtMs);
    if (!(price > 0) || !Number.isFinite(eventAtMs)) continue;
    const bucket = Math.floor(eventAtMs / 60_000) * 60_000;
    const current = buckets.get(bucket);
    if (!current) buckets.set(bucket, { open: price, close: price });
    else current.close = price;
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, candle]) => candle);
}

/**
 * Load only the independent strategy's top-volume universe.  Contracts,
 * ticker/mark prices and their short history are all served by the existing
 * Binance WebSocket proxy.  No per-symbol K-line REST request is made here.
 */
export async function loadSimpleReboundMarketRows() {
  const contracts = await getBinanceLiveContractUniverse();
  const ranked = contracts
    .filter((contract) => Number.isFinite(contract.quoteVolume) && contract.quoteVolume > 0)
    .sort((left, right) => right.quoteVolume - left.quoteVolume)
    .slice(0, 30);
  const symbols = ranked.map((contract) => contract.symbol.trim().toUpperCase());
  const marks = await getBinanceLiveMarkPrices(symbols, { includeHistory: true });
  const candlesBySymbol = new Map(
    marks.map((mark) => [
      mark.symbol.trim().toUpperCase(),
      aggregateSimpleReboundMinuteCandles(mark.history ?? []),
    ] as const),
  );
  const rows = mapSimpleReboundVolumeRows(ranked, marks, candlesBySymbol);
  return buildSimpleReboundMarketRows(rows);
}
