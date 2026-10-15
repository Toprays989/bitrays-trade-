import type { NexusUnifiedCandle } from "./nexus-unified-market-data";

export type NexusMarketContextWindow = "24h" | "72h" | "30d" | "60d";
export type NexusMarketContextAuthority =
  | "BACKGROUND_ONLY"
  | "WAKE_ONLY";

export type NexusMarketContextSnapshot = Readonly<{
  version: "nexus-market-context-snapshot-v1";
  id: string;
  symbol: string;
  capturedAt: number;
  ticker24h: Readonly<{
    lastPrice: number | null;
    highPrice: number | null;
    lowPrice: number | null;
    quoteVolume: number | null;
    priceChangePercent: number | null;
    eventAt: number | null;
    receivedAt: number | null;
  }>;
  positions: Readonly<Record<NexusMarketContextWindow, Readonly<{
    high: number | null;
    low: number | null;
    positionPercent: number | null;
    observations: number;
    complete: boolean;
  }>>>;
  policy: Readonly<{
    unified: "BACKGROUND_ONLY";
    highPositionShort: "WAKE_ONLY";
    lowPositionLong: "WAKE_ONLY";
    finalDecisionRequiresCurrentPriceVolumeStructure: true;
  }>;
  orderAffecting: false;
}>;

type Ticker24hInput = {
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
  priceChangePercent: number;
  eventAt: number;
  receivedAt: number;
};

export function nexusContextAuthority(
  strategyMode: "UNIFIED" | "HIGH_POSITION_SHORT" | "LOW_POSITION_LONG",
  _window: NexusMarketContextWindow,
): NexusMarketContextAuthority {
  void _window;
  return strategyMode === "HIGH_POSITION_SHORT" ||
      strategyMode === "LOW_POSITION_LONG"
    ? "WAKE_ONLY"
    : "BACKGROUND_ONLY";
}

export function buildNexusMarketContextSnapshot(input: {
  symbol: string;
  capturedAt: number;
  ticker24h?: Partial<Ticker24hInput> | null;
  candles1h?: NexusUnifiedCandle[];
  candles1d?: NexusUnifiedCandle[];
}): NexusMarketContextSnapshot {
  const symbol = normalizeSymbol(input.symbol);
  const capturedAt = finiteTimestamp(input.capturedAt);
  const ticker24h = normalizeTicker(input.ticker24h);
  const hourly = validCandles(input.candles1h).slice(-72);
  const daily = validCandles(input.candles1d).slice(-60);
  const positions = {
    "24h": tickerPosition(ticker24h),
    "72h": candlePosition(hourly, 72, ticker24h.lastPrice),
    "30d": candlePosition(daily.slice(-30), 30, ticker24h.lastPrice),
    "60d": candlePosition(daily, 60, ticker24h.lastPrice),
  } satisfies NexusMarketContextSnapshot["positions"];
  const identity = stableSerialize({
    symbol,
    capturedAt,
    ticker24h,
    positions,
  });
  return deepFreeze({
    version: "nexus-market-context-snapshot-v1" as const,
    id: `nqctx-${fnv1a64(identity)}`,
    symbol,
    capturedAt,
    ticker24h,
    positions,
    policy: {
      unified: "BACKGROUND_ONLY" as const,
      highPositionShort: "WAKE_ONLY" as const,
      lowPositionLong: "WAKE_ONLY" as const,
      finalDecisionRequiresCurrentPriceVolumeStructure: true as const,
    },
    orderAffecting: false as const,
  });
}

export function nexusFactSnapshotId(input: {
  symbol: string;
  evaluatedAt: number;
  factIds: string[];
  marketContextId?: string | null;
}) {
  return `nqfs-${fnv1a64(stableSerialize({
    symbol: normalizeSymbol(input.symbol),
    evaluatedAt: finiteTimestamp(input.evaluatedAt),
    factIds: [...new Set(input.factIds)].sort(),
    marketContextId: input.marketContextId ?? null,
  }))}`;
}

function normalizeTicker(value: Partial<Ticker24hInput> | null | undefined) {
  return {
    lastPrice: positiveOrNull(value?.lastPrice),
    highPrice: positiveOrNull(value?.highPrice),
    lowPrice: positiveOrNull(value?.lowPrice),
    quoteVolume: nonNegativeOrNull(value?.quoteVolume),
    priceChangePercent: finiteOrNull(value?.priceChangePercent),
    eventAt: timestampOrNull(value?.eventAt),
    receivedAt: timestampOrNull(value?.receivedAt),
  };
}

function tickerPosition(ticker: ReturnType<typeof normalizeTicker>) {
  const observations = ticker.highPrice !== null &&
      ticker.lowPrice !== null &&
      ticker.lastPrice !== null
    ? 1
    : 0;
  return positionResult({
    high: ticker.highPrice,
    low: ticker.lowPrice,
    price: ticker.lastPrice,
    observations,
    requiredObservations: 1,
  });
}

function candlePosition(
  candles: NexusUnifiedCandle[],
  requiredObservations: number,
  latestPrice: number | null,
) {
  if (!candles.length)
    return positionResult({
      high: null,
      low: null,
      price: latestPrice,
      observations: 0,
      requiredObservations,
    });
  const high = Math.max(...candles.map((row) => row.high));
  const low = Math.min(...candles.map((row) => row.low));
  return positionResult({
    high,
    low,
    price: latestPrice ?? candles.at(-1)?.close ?? null,
    observations: candles.length,
    requiredObservations,
  });
}

function positionResult(input: {
  high: number | null;
  low: number | null;
  price: number | null;
  observations: number;
  requiredObservations: number;
}) {
  const range = input.high !== null && input.low !== null
    ? input.high - input.low
    : null;
  const positionPercent =
    range !== null && range > 0 && input.price !== null && input.low !== null
      ? clamp(((input.price - input.low) / range) * 100, 0, 100)
      : null;
  return {
    high: input.high,
    low: input.low,
    positionPercent,
    observations: input.observations,
    complete:
      positionPercent !== null &&
      input.observations >= input.requiredObservations,
  };
}

function validCandles(value: NexusUnifiedCandle[] | undefined) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (row) =>
        Number.isFinite(row.openTime) &&
        positiveOrNull(row.high) !== null &&
        positiveOrNull(row.low) !== null &&
        positiveOrNull(row.close) !== null &&
        row.high >= row.low,
    )
    .sort((left, right) => left.openTime - right.openTime);
}

function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol))
    throw new Error("市场上下文合约代码无效");
  return symbol;
}

function finiteTimestamp(value: unknown) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0)
    throw new Error("市场上下文时间无效");
  return Math.trunc(timestamp);
}

function timestampOrNull(value: unknown) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0
    ? Math.trunc(timestamp)
    : null;
}

function positiveOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(",")}}`;
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
