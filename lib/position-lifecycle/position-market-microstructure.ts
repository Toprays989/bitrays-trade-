export const POSITION_MARKET_MICROSTRUCTURE_VERSION =
  "position-market-microstructure-v1" as const;

const WINDOWS_SECONDS = [5, 15, 30] as const;

export type PositionMicrostructureDirection =
  | "FAVORABLE"
  | "ADVERSE"
  | "MIXED"
  | "FLAT"
  | "INSUFFICIENT";

export type PositionMicrostructureWindow = {
  seconds: typeof WINDOWS_SECONDS[number];
  sampleCount: number;
  firstPrice: number | null;
  lastPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  amplitude: number | null;
  amplitudePercent: number | null;
  netChangePercent: number | null;
  positionDirectionalChangePercent: number | null;
  givebackFromFavorableExtremePercent: number | null;
  favorableStepRatio: number | null;
  adverseStepRatio: number | null;
  direction: PositionMicrostructureDirection;
};

export type PositionMarketMicrostructure = {
  version: typeof POSITION_MARKET_MICROSTRUCTURE_VERSION;
  source: "BINANCE_MARK_PRICE_WEBSOCKET_1S";
  decisionRole: "POSITION_FACT_ONLY";
  positionSide: "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number;
  observedAtMs: number;
  priceChangeFromEntryPercent: number;
  positionMoveFromEntryPercent: number;
  entryZone: "PROFIT" | "LOSS" | "FLAT";
  historyAgeMs: number | null;
  windows: Record<"5s" | "15s" | "30s", PositionMicrostructureWindow>;
};

export function summarizePositionMarketMicrostructure(input: {
  positionSide: "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number;
  observedAtMs: number;
  samples?: Array<{
    markPrice: number;
    eventAtMs: number;
    receivedAtMs?: number;
  }> | null;
}): PositionMarketMicrostructure {
  const entryPrice = positive(input.entryPrice, "开仓价格");
  const markPrice = positive(input.markPrice, "标记价格");
  const observedAtMs = positive(input.observedAtMs, "观察时间");
  const samples = normalizeSamples(input.samples, observedAtMs, markPrice);
  const priceChangeFromEntryPercent = percentChange(entryPrice, markPrice);
  const positionMoveFromEntryPercent = input.positionSide === "LONG"
    ? priceChangeFromEntryPercent
    : -priceChangeFromEntryPercent;
  const entryZone = positionMoveFromEntryPercent > 1e-8
    ? "PROFIT" as const
    : positionMoveFromEntryPercent < -1e-8
      ? "LOSS" as const
      : "FLAT" as const;
  const windows = Object.fromEntries(
    WINDOWS_SECONDS.map((seconds) => [
      `${seconds}s`,
      summarizeWindow({
        samples,
        seconds,
        observedAtMs,
        positionSide: input.positionSide,
      }),
    ]),
  ) as PositionMarketMicrostructure["windows"];
  return {
    version: POSITION_MARKET_MICROSTRUCTURE_VERSION,
    source: "BINANCE_MARK_PRICE_WEBSOCKET_1S",
    decisionRole: "POSITION_FACT_ONLY",
    positionSide: input.positionSide,
    entryPrice,
    markPrice,
    observedAtMs,
    priceChangeFromEntryPercent,
    positionMoveFromEntryPercent,
    entryZone,
    historyAgeMs: samples.length
      ? Math.max(0, observedAtMs - samples[0].eventAtMs)
      : null,
    windows,
  };
}

function summarizeWindow(input: {
  samples: Array<{ markPrice: number; eventAtMs: number }>;
  seconds: typeof WINDOWS_SECONDS[number];
  observedAtMs: number;
  positionSide: "LONG" | "SHORT";
}): PositionMicrostructureWindow {
  const cutoffMs = input.observedAtMs - input.seconds * 1_000;
  const firstInsideIndex = input.samples.findIndex(
    (sample) => sample.eventAtMs >= cutoffMs,
  );
  const startIndex = firstInsideIndex <= 0
    ? Math.max(0, firstInsideIndex)
    : firstInsideIndex - 1;
  const selected = firstInsideIndex < 0
    ? []
    : input.samples.slice(startIndex);
  if (selected.length < 2)
    return emptyWindow(input.seconds, selected[0]?.markPrice ?? null);
  const prices = selected.map((sample) => sample.markPrice);
  const firstPrice = prices[0];
  const lastPrice = prices.at(-1)!;
  const highPrice = Math.max(...prices);
  const lowPrice = Math.min(...prices);
  const amplitude = highPrice - lowPrice;
  const amplitudePercent = firstPrice > 0
    ? amplitude / firstPrice * 100
    : null;
  const netChangePercent = percentChange(firstPrice, lastPrice);
  const positionDirectionalChangePercent = input.positionSide === "LONG"
    ? netChangePercent
    : -netChangePercent;
  const givebackFromFavorableExtremePercent = input.positionSide === "LONG"
    ? (highPrice - lastPrice) / firstPrice * 100
    : (lastPrice - lowPrice) / firstPrice * 100;
  let favorableSteps = 0;
  let adverseSteps = 0;
  for (let index = 1; index < prices.length; index += 1) {
    const rawChange = prices[index] - prices[index - 1];
    const directionalChange = input.positionSide === "LONG"
      ? rawChange
      : -rawChange;
    if (directionalChange > 0) favorableSteps += 1;
    else if (directionalChange < 0) adverseSteps += 1;
  }
  const directionalSteps = favorableSteps + adverseSteps;
  const favorableStepRatio = directionalSteps
    ? favorableSteps / directionalSteps
    : 0;
  const adverseStepRatio = directionalSteps
    ? adverseSteps / directionalSteps
    : 0;
  const materialMovePercent = Math.max(
    0.005,
    (amplitudePercent ?? 0) * 0.15,
  );
  const direction = Math.abs(positionDirectionalChangePercent) <
      materialMovePercent
    ? amplitudePercent !== null && amplitudePercent >= 0.01
      ? "MIXED" as const
      : "FLAT" as const
    : positionDirectionalChangePercent > 0 && favorableStepRatio >= 0.55
      ? "FAVORABLE" as const
      : positionDirectionalChangePercent < 0 && adverseStepRatio >= 0.55
        ? "ADVERSE" as const
        : "MIXED" as const;
  return {
    seconds: input.seconds,
    sampleCount: selected.length,
    firstPrice,
    lastPrice,
    highPrice,
    lowPrice,
    amplitude,
    amplitudePercent,
    netChangePercent,
    positionDirectionalChangePercent,
    givebackFromFavorableExtremePercent,
    favorableStepRatio,
    adverseStepRatio,
    direction,
  };
}

function emptyWindow(
  seconds: typeof WINDOWS_SECONDS[number],
  price: number | null,
): PositionMicrostructureWindow {
  return {
    seconds,
    sampleCount: price === null ? 0 : 1,
    firstPrice: price,
    lastPrice: price,
    highPrice: price,
    lowPrice: price,
    amplitude: null,
    amplitudePercent: null,
    netChangePercent: null,
    positionDirectionalChangePercent: null,
    givebackFromFavorableExtremePercent: null,
    favorableStepRatio: null,
    adverseStepRatio: null,
    direction: "INSUFFICIENT",
  };
}

function normalizeSamples(
  input: Array<{
    markPrice: number;
    eventAtMs: number;
    receivedAtMs?: number;
  }> | null | undefined,
  observedAtMs: number,
  markPrice: number,
) {
  const byEventAt = new Map<number, { markPrice: number; eventAtMs: number }>();
  for (const sample of input ?? []) {
    const samplePrice = Number(sample.markPrice);
    const eventAtMs = Number(sample.eventAtMs);
    if (
      !Number.isFinite(samplePrice) ||
      samplePrice <= 0 ||
      !Number.isFinite(eventAtMs) ||
      eventAtMs <= 0 ||
      eventAtMs > observedAtMs + 2_000 ||
      eventAtMs < observedAtMs - 45_000
    ) continue;
    byEventAt.set(eventAtMs, { markPrice: samplePrice, eventAtMs });
  }
  byEventAt.set(observedAtMs, { markPrice, eventAtMs: observedAtMs });
  return [...byEventAt.values()].sort(
    (left, right) => left.eventAtMs - right.eventAtMs,
  );
}

function percentChange(first: number, last: number) {
  return (last - first) / first * 100;
}

function positive(value: number, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${label}必须为正数`);
  return number;
}
