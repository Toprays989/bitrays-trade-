import type { SimpleReboundVolumeRow } from "./simple-rebound-scanner.ts";

export type SimpleReboundContractSnapshot = Readonly<{
  symbol: string;
  quoteVolume: number;
  price: number;
}>;

export type SimpleReboundMarkSnapshot = Readonly<{
  symbol: string;
  markPrice: number;
  history?: readonly Readonly<{ markPrice: number; eventAtMs: number }>[];
}>;

/** Pure mapping boundary kept separate from Binance/Cloudflare modules. */
export function mapSimpleReboundVolumeRows(
  contracts: readonly SimpleReboundContractSnapshot[],
  marks: readonly SimpleReboundMarkSnapshot[],
  candlesBySymbol: ReadonlyMap<string, readonly Readonly<{ open: number; close: number }>[]>,
): SimpleReboundVolumeRow[] {
  const markBySymbol = new Map(marks.map((mark) => [mark.symbol.trim().toUpperCase(), mark]));
  return contracts.map((contract) => {
    const symbol = contract.symbol.trim().toUpperCase();
    const mark = markBySymbol.get(symbol);
    const history = mark?.history ?? [];
    return {
      symbol,
      quoteVolume24h: Number(contract.quoteVolume),
      markPrices: history.slice(-11).map((sample) => sample.markPrice),
      oneMinuteCandles: candlesBySymbol.get(symbol) ?? [],
      currentMarkPrice: mark?.markPrice ?? Number(contract.price),
    };
  });
}
