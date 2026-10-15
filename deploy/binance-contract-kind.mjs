export const SUPPORTED_USDT_PERPETUAL_CONTRACT_TYPES = new Set([
  "PERPETUAL",
  "TRADIFI_PERPETUAL",
]);

export function isSupportedBinanceUsdtPerpetual(item) {
  return Boolean(
    item &&
      item.status === "TRADING" &&
      SUPPORTED_USDT_PERPETUAL_CONTRACT_TYPES.has(item.contractType) &&
      item.quoteAsset === "USDT",
  );
}
