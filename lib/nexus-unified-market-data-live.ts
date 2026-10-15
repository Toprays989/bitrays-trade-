import {
  getBinanceLiveKlines,
  getBinanceLiveMarkPriceKlines,
} from "./binance-usdm-live";
import { NexusUnifiedMarketData } from "./nexus-unified-market-data";

export const nexusUnifiedMarketData = new NexusUnifiedMarketData({
  TRADE: (symbol, interval, limit) =>
    getBinanceLiveKlines(symbol, interval, limit),
  MARK_PRICE: (symbol, interval, limit) =>
    getBinanceLiveMarkPriceKlines(symbol, interval, limit),
}, 99, 15_000, 256, 8 * 1024 * 1024);
