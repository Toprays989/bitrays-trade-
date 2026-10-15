export type MarketPositionCandle = {
  openTime: number;
  high: number;
  low: number;
};

/**
 * Historical/learning observation only.
 *
 * This describes where the latest mark sits inside trailing price ranges. It
 * is deliberately not an entry gate and is not part of the NEXUS order path.
 */
export function analyzeMarkPricePosition(
  markPrice: number,
  markPrice1h: MarketPositionCandle[],
) {
  const valid = Array.isArray(markPrice1h)
    ? markPrice1h.filter(
        (item) =>
          finitePositive(item.openTime) &&
          finitePositive(item.high) &&
          finitePositive(item.low) &&
          item.high >= item.low,
      )
    : [];
  const markWindow24h = valid.slice(-24);
  const markWindow72h = valid.slice(-72);
  const high24h = finitePositive(markPrice) && markWindow24h.length
    ? Math.max(markPrice, ...markWindow24h.map((item) => item.high))
    : null;
  const low24h = finitePositive(markPrice) && markWindow24h.length
    ? Math.min(markPrice, ...markWindow24h.map((item) => item.low))
    : null;
  const range24h =
    high24h !== null && low24h !== null ? high24h - low24h : null;
  const position24hPercent =
    range24h !== null && range24h > 0 && low24h !== null
      ? ((markPrice - low24h) / range24h) * 100
      : null;
  const high72h = finitePositive(markPrice) && markWindow72h.length
    ? Math.max(markPrice, ...markWindow72h.map((item) => item.high))
    : null;
  const low72h = finitePositive(markPrice) && markWindow72h.length
    ? Math.min(markPrice, ...markWindow72h.map((item) => item.low))
    : null;
  const range72h =
    high72h !== null && low72h !== null ? high72h - low72h : null;
  const position72hPercent =
    range72h !== null && range72h > 0 && low72h !== null
      ? ((markPrice - low72h) / range72h) * 100
      : null;
  return {
    markPrice,
    high24h,
    low24h,
    position24hPercent,
    high72h,
    low72h,
    position72hPercent,
    hours72Available: markWindow72h.length,
    hours72Complete: markWindow72h.length >= 72,
    observationOnly: true as const,
    orderAffecting: false as const,
  };
}

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}
