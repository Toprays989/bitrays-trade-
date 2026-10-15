export type EntryStructureBaseline = {
  version: 1;
  source: "HISTORICAL_MARK_PRICE_5M_BACKFILL_AT_SIGNAL_TIME";
  capturedAt: string;
  eventTime: string;
  eventBucketOpenTime: number;
  priorSupport: number;
  priorResistance: number;
  atr5m: number;
  priorRangeAtr: number;
  supportLookbackCandles: number;
  atrPeriod: number;
  managementEligibility: true;
  entryAttributionEligibility: "PRICE_STRUCTURE_ONLY";
};

type StructureCandle = {
  openTime: number;
  high: number;
  low: number;
  close: number;
  closeTime: number;
};

const FIVE_MINUTES_MS = 5 * 60_000;
const SUPPORT_LOOKBACK_CANDLES = 12;

export function buildEntryStructureBaseline(input: {
  eventTimeMs: number;
  capturedAtMs: number;
  candles: StructureCandle[];
  atrPeriod?: number;
}): EntryStructureBaseline | null {
  if (!finitePositive(input.eventTimeMs)) return null;
  const atrPeriod = Number.isSafeInteger(input.atrPeriod) &&
      input.atrPeriod! >= 2
    ? input.atrPeriod!
    : 14;
  const eventBucketOpenTime =
    Math.floor(input.eventTimeMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const prior = input.candles
    .filter(
      (candle) =>
        finitePositive(candle.openTime) &&
        finitePositive(candle.closeTime) &&
        candle.openTime < eventBucketOpenTime &&
        candle.closeTime < eventBucketOpenTime &&
        finitePositive(candle.high) &&
        finitePositive(candle.low) &&
        finitePositive(candle.close) &&
        candle.high >= candle.low,
    )
    .sort((left, right) => left.openTime - right.openTime);
  if (
    prior.length < Math.max(SUPPORT_LOOKBACK_CANDLES, atrPeriod + 1)
  ) return null;
  const structure = prior.slice(-SUPPORT_LOOKBACK_CANDLES);
  const priorSupport = Math.min(...structure.map((candle) => candle.low));
  const priorResistance = Math.max(...structure.map((candle) => candle.high));
  const trueRanges = prior.slice(1).map((candle, index) => {
    const previousClose = prior[index]!.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  const selectedRanges = trueRanges.slice(-atrPeriod);
  const atr5m =
    selectedRanges.reduce((total, value) => total + value, 0) /
    selectedRanges.length;
  if (
    !finitePositive(priorSupport) ||
    !finitePositive(priorResistance) ||
    !finitePositive(atr5m)
  ) return null;
  return {
    version: 1,
    source: "HISTORICAL_MARK_PRICE_5M_BACKFILL_AT_SIGNAL_TIME",
    capturedAt: new Date(input.capturedAtMs).toISOString(),
    eventTime: new Date(input.eventTimeMs).toISOString(),
    eventBucketOpenTime,
    priorSupport,
    priorResistance,
    atr5m,
    priorRangeAtr: (priorResistance - priorSupport) / atr5m,
    supportLookbackCandles: SUPPORT_LOOKBACK_CANDLES,
    atrPeriod,
    managementEligibility: true,
    entryAttributionEligibility: "PRICE_STRUCTURE_ONLY",
  };
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
