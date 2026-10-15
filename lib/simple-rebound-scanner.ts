import {
  evaluateSimpleThreeMinuteEntry,
  type SimpleThreeMinuteEntryResult,
} from "./simple-three-minute-entry.ts";

export type SimpleReboundMarketRow = Readonly<{
  symbol: string;
  dailyVolumeRank: number;
  markPrices: readonly number[];
  oneMinuteCandles: readonly Readonly<{ open: number; close: number }>[];
  currentMarkPrice: number;
}>;

export type SimpleReboundCandidate = Readonly<{
  symbol: string;
  referencePrice: number;
  entry: SimpleThreeMinuteEntryResult;
}>;

export type SimpleReboundVolumeRow = Readonly<{
  symbol: string;
  quoteVolume24h: number;
  markPrices: readonly number[];
  oneMinuteCandles: readonly Readonly<{ open: number; close: number }>[];
  currentMarkPrice: number;
}>;

/** Builds the isolated top-volume universe without consulting any other strategy. */
export function buildSimpleReboundMarketRows(
  rows: readonly SimpleReboundVolumeRow[],
): SimpleReboundMarketRow[] {
  return [...rows]
    .filter((row) => Number.isFinite(row.quoteVolume24h) && row.quoteVolume24h > 0)
    .sort((left, right) => right.quoteVolume24h - left.quoteVolume24h)
    .slice(0, 30)
    .map((row, index) => ({
      symbol: row.symbol.trim().toUpperCase(),
      dailyVolumeRank: index + 1,
      markPrices: row.markPrices,
      oneMinuteCandles: row.oneMinuteCandles,
      currentMarkPrice: row.currentMarkPrice,
    }));
}

/** Scans only the top-30 volume universe for the isolated simple strategy. */
export function scanSimpleReboundCandidates(
  rows: readonly SimpleReboundMarketRow[],
): SimpleReboundCandidate[] {
  const seen = new Set<string>();
  return rows
    .filter((row) => row.dailyVolumeRank >= 1 && row.dailyVolumeRank <= 30)
    .sort((left, right) => left.dailyVolumeRank - right.dailyVolumeRank)
    .map((row) => ({
      symbol: row.symbol.trim().toUpperCase(),
      referencePrice: row.currentMarkPrice,
      entry: evaluateSimpleThreeMinuteEntry(row),
    }))
    .filter((candidate) => {
      if (!candidate.entry.eligible || seen.has(candidate.symbol)) return false;
      seen.add(candidate.symbol);
      return true;
    })
    .slice(0, 5);
}
