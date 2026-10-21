import { env } from "cloudflare:workers";

type SpotFilter = { filterType?: string; tickSize?: string; stepSize?: string; minQty?: string; minNotional?: string; notional?: string };

export type BinanceSpotCatalogRow = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  priceTickSize: number;
  quantityStep: number;
  minOrderQty: number;
  minNotionalUsdt: number;
  quoteVolume24h: number;
};

function number(value: string | undefined, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function fetchBinanceSpotCatalog(): Promise<BinanceSpotCatalogRow[]> {
  const proxy = (env as unknown as { NQ_BINANCE_PROXY_URL?: string }).NQ_BINANCE_PROXY_URL?.replace(/\/$/, "");
  const base = proxy ? `${proxy}/spot` : "https://api.binance.com";
  const [infoResponse, tickerResponse] = await Promise.all([
    fetch(`${base}/api/v3/exchangeInfo`, { cache: "no-store" }),
    fetch(`${base}/api/v3/ticker/24hr`, { cache: "no-store" }),
  ]);
  if (!infoResponse.ok || !tickerResponse.ok) throw new Error("Binance Spot 公共数据读取失败");
  const info = await infoResponse.json() as { symbols?: Array<{ symbol?: string; baseAsset?: string; quoteAsset?: string; status?: string; filters?: SpotFilter[] }> };
  const tickers = await tickerResponse.json() as Array<{ symbol?: string; quoteVolume?: string }>;
  const volumeBySymbol = new Map(tickers.map((row) => [String(row.symbol || ""), number(row.quoteVolume)]));
  return (info.symbols || []).filter((row) => row.symbol && row.quoteAsset === "USDT").map((row) => {
    const filters = row.filters || [];
    const price = filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const lot = filters.find((filter) => filter.filterType === "LOT_SIZE" || filter.filterType === "MARKET_LOT_SIZE");
    const notional = filters.find((filter) => filter.filterType === "NOTIONAL" || filter.filterType === "MIN_NOTIONAL");
    return {
      symbol: row.symbol!,
      baseAsset: row.baseAsset || row.symbol!.replace(/USDT$/, ""),
      quoteAsset: row.quoteAsset!,
      status: row.status || "UNKNOWN",
      priceTickSize: number(price?.tickSize, 0.00000001),
      quantityStep: number(lot?.stepSize, 0.00000001),
      minOrderQty: number(lot?.minQty, 0),
      minNotionalUsdt: number(notional?.minNotional, 5),
      quoteVolume24h: volumeBySymbol.get(row.symbol!) || 0,
    };
  });
}
