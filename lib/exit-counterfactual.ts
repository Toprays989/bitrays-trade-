export const LEGACY_EXIT_COUNTERFACTUAL_VERSION =
  "nexus-exit-counterfactual-v1" as const;
export const EXIT_COUNTERFACTUAL_VERSION =
  "nexus-exit-counterfactual-v2" as const;

export const EXIT_COUNTERFACTUAL_HORIZON_MINUTES = [
  1,
  3,
  5,
  15,
  30,
  60,
] as const;

export type ExitCounterfactualExitReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "TRAILING_STOP"
  | "TIME_EXIT";

export type ExitCounterfactualPathOutcome =
  | "EXIT_CONFIRMED"
  | "EXIT_EARLY"
  | "INCONCLUSIVE";

export type ExitCounterfactualExecutionTiming =
  | "ON_TIME"
  | "LATE"
  | "UNAVAILABLE";

/** Legacy combined result retained for stored v1 events and reentry callers. */
export type ExitCounterfactualClassification =
  | ExitCounterfactualPathOutcome
  | "EXIT_LATE";

export type ExitCounterfactualCandle = Readonly<{
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}>;

export function isExitCounterfactualVersion(value: unknown) {
  return value === EXIT_COUNTERFACTUAL_VERSION ||
    value === LEGACY_EXIT_COUNTERFACTUAL_VERSION;
}

export function directionalPriceReturnPercent(input: {
  positionSide: "LONG" | "SHORT";
  fromPrice: number;
  toPrice: number;
}) {
  if (
    !Number.isFinite(input.fromPrice) ||
    input.fromPrice <= 0 ||
    !Number.isFinite(input.toPrice) ||
    input.toPrice <= 0
  ) return null;
  const raw = (input.toPrice / input.fromPrice - 1) * 100;
  return input.positionSide === "SHORT" ? -raw : raw;
}

export function resolveExitCounterfactualMaterialMove(input: {
  roundTripCostPercent?: number | null;
  executionSlippagePercent?: number | null;
  preExitAtrPercent?: number | null;
  fixedFloorPercent?: number;
}) {
  const fixedFloorPercent = positiveOr(input.fixedFloorPercent, 0.1);
  const roundTripCostPercent = nonNegativeOrNull(
    input.roundTripCostPercent,
  );
  const executionSlippagePercent = nonNegativeOrNull(
    input.executionSlippagePercent,
  );
  const preExitAtrPercent = nonNegativeOrNull(input.preExitAtrPercent);
  const costThreshold = roundTripCostPercent === null &&
      executionSlippagePercent === null
    ? null
    : ((roundTripCostPercent ?? 0) + (executionSlippagePercent ?? 0)) * 1.25;
  const atrThreshold = preExitAtrPercent === null
    ? null
    : preExitAtrPercent * 0.25;
  const percent = Math.min(
    2,
    Math.max(
      fixedFloorPercent,
      costThreshold ?? 0,
      atrThreshold ?? 0,
    ),
  );
  return {
    percent: rounded(percent, 8),
    fixedFloorPercent: rounded(fixedFloorPercent, 8),
    roundTripCostPercent,
    executionSlippagePercent,
    preExitAtrPercent,
    sources: [
      "FIXED_FLOOR" as const,
      ...(costThreshold === null ? [] : ["COST" as const]),
      ...(atrThreshold === null ? [] : ["ATR" as const]),
    ],
  };
}

export function classifyExitCounterfactualDetailed(input: {
  exitReason: ExitCounterfactualExitReason;
  directionReturnPercent: number | null;
  exitRoePercent?: number | null;
  capitalPreservationStopRoePercent?: number | null;
  materialMovePercent?: number;
}) {
  const exitRoePercent = finiteOrNull(input.exitRoePercent);
  const capitalStop = positiveOrNull(
    input.capitalPreservationStopRoePercent,
  );
  const executionTiming: ExitCounterfactualExecutionTiming =
    input.exitReason !== "STOP_LOSS" ||
      exitRoePercent === null ||
      capitalStop === null
      ? "UNAVAILABLE"
      : exitRoePercent < -capitalStop * 1.1
        ? "LATE"
        : "ON_TIME";
  const move = finiteOrNull(input.directionReturnPercent);
  const threshold = positiveOr(input.materialMovePercent, 0.25);
  const pathOutcome: ExitCounterfactualPathOutcome = move === null
    ? "INCONCLUSIVE"
    : move >= threshold
      ? "EXIT_EARLY"
      : move <= -threshold
        ? "EXIT_CONFIRMED"
        : "INCONCLUSIVE";
  return {
    executionTiming,
    pathOutcome,
    classification: executionTiming === "LATE"
      ? "EXIT_LATE" as const
      : pathOutcome,
  };
}

export function classifyExitCounterfactual(input: {
  exitReason: ExitCounterfactualExitReason;
  directionReturnPercent: number | null;
  exitRoePercent?: number | null;
  capitalPreservationStopRoePercent?: number | null;
  materialMovePercent?: number;
}): ExitCounterfactualClassification {
  return classifyExitCounterfactualDetailed(input).classification;
}

export function buildExitCounterfactualPath(input: {
  positionSide: "LONG" | "SHORT";
  exitPrice: number;
  exitAtMs: number;
  horizonAtMs: number;
  evaluatedAtMs: number;
  materialMovePercent: number;
  markPriceCandles: readonly ExitCounterfactualCandle[];
  tradeCandles?: readonly ExitCounterfactualCandle[];
}) {
  const materialMovePercent = positiveOr(input.materialMovePercent, 0.25);
  const causallyClosedWindow = [
    input.exitPrice,
    input.exitAtMs,
    input.horizonAtMs,
    input.evaluatedAtMs,
  ].every(Number.isFinite) &&
    input.exitPrice > 0 &&
    input.exitAtMs >= 0 &&
    input.horizonAtMs > input.exitAtMs &&
    input.evaluatedAtMs >= input.horizonAtMs;
  const marks = causallyClosedWindow
    ? normalizedCandles(input.markPriceCandles).filter(
        (candle) =>
          candle.closeTime > input.exitAtMs &&
          candle.closeTime <= input.horizonAtMs &&
          candle.closeTime <= input.evaluatedAtMs,
      )
    : [];
  const trades = normalizedCandles(input.tradeCandles ?? []);
  const observedTrades = trades.filter(
    (candle) =>
      candle.closeTime > input.exitAtMs &&
      candle.closeTime <= input.horizonAtMs &&
      candle.closeTime <= input.evaluatedAtMs,
  );
  const baselineTrades = trades.filter(
    (candle) => candle.closeTime <= input.exitAtMs,
  ).slice(-20);
  if (!marks.length)
    return emptyExitCounterfactualPath(materialMovePercent);

  const directional = marks.map((candle) => {
    const favorablePrice = input.positionSide === "LONG"
      ? candle.high
      : candle.low;
    const adversePrice = input.positionSide === "LONG"
      ? candle.low
      : candle.high;
    return {
      candle,
      favorable: directionalPriceReturnPercent({
        positionSide: input.positionSide,
        fromPrice: input.exitPrice,
        toPrice: favorablePrice,
      })!,
      adverse: directionalPriceReturnPercent({
        positionSide: input.positionSide,
        fromPrice: input.exitPrice,
        toPrice: adversePrice,
      })!,
    };
  });
  const favorablePeak = directional.reduce((best, current) =>
    current.favorable > best.favorable ? current : best
  );
  const adversePeak = directional.reduce((worst, current) =>
    current.adverse < worst.adverse ? current : worst
  );
  const firstMaterialFavorable = directional.find(
    (item) => item.favorable >= materialMovePercent,
  );
  const firstMaterialAdverse = directional.find(
    (item) => item.adverse <= -materialMovePercent,
  );
  const averageBaselineVolume = averagePositiveVolume(baselineTrades);
  const averagePostExitVolume = averagePositiveVolume(observedTrades);
  const postExitVolumeRatio =
    averageBaselineVolume !== null &&
      averagePostExitVolume !== null &&
      averageBaselineVolume > 0
      ? averagePostExitVolume / averageBaselineVolume
      : null;
  const horizon = marks.at(-1)!;
  return {
    causallyClosed: true,
    closedCandleCount: marks.length,
    latestObservedAtMs: horizon.closeTime,
    directionReturnPercent: directionalPriceReturnPercent({
      positionSide: input.positionSide,
      fromPrice: input.exitPrice,
      toPrice: horizon.close,
    }),
    postExitMfePercent: rounded(favorablePeak.favorable, 8),
    postExitMaePercent: rounded(adversePeak.adverse, 8),
    favorablePeakAtMs: favorablePeak.candle.closeTime,
    adversePeakAtMs: adversePeak.candle.closeTime,
    firstMaterialFavorableAtMs:
      firstMaterialFavorable?.candle.closeTime ?? null,
    firstMaterialAdverseAtMs: firstMaterialAdverse?.candle.closeTime ?? null,
    favorableBeforeAdverse:
      firstMaterialFavorable && firstMaterialAdverse
        ? firstMaterialFavorable.candle.closeTime <=
          firstMaterialAdverse.candle.closeTime
        : null,
    postExitVolumeRatio: postExitVolumeRatio === null
      ? null
      : rounded(postExitVolumeRatio, 8),
    materialMovePercent,
    historicalLabelOnly: true as const,
  };
}

export function preExitAverageTrueRangePercent(input: {
  exitPrice: number;
  exitAtMs: number;
  candles: readonly ExitCounterfactualCandle[];
  periods?: number;
}) {
  if (!Number.isFinite(input.exitPrice) || input.exitPrice <= 0) return null;
  const candles = normalizedCandles(input.candles)
    .filter((candle) => candle.closeTime <= input.exitAtMs)
    .slice(-Math.max(2, Math.trunc(input.periods ?? 14)));
  if (candles.length < 2) return null;
  const ranges = candles.map((candle, index) => {
    const previousClose = index > 0 ? candles[index - 1].close : candle.open;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return rounded(average(ranges) / input.exitPrice * 100, 8);
}

export function dueExitCounterfactualHorizons(input: {
  closedAtMs: number;
  nowMs: number;
  recordedHorizons?: Iterable<number>;
}) {
  const recorded = new Set(input.recordedHorizons ?? []);
  return EXIT_COUNTERFACTUAL_HORIZON_MINUTES.filter(
    (minute) =>
      !recorded.has(minute) &&
      input.nowMs >= input.closedAtMs + minute * 60_000,
  );
}

export function exitCounterfactualObservationBatchSize(input: {
  remainingWeight: number;
  reserveWeight?: number;
  weightPerTarget?: number;
  maximumTargets?: number;
}) {
  const remainingWeight = finiteOrNull(input.remainingWeight) ?? 0;
  const reserveWeight = Math.max(0, finiteOrNull(input.reserveWeight) ?? 150);
  const weightPerTarget = Math.max(
    1,
    finiteOrNull(input.weightPerTarget) ?? 2,
  );
  const maximumTargets = Math.max(
    1,
    Math.trunc(finiteOrNull(input.maximumTargets) ?? 8),
  );
  return Math.min(
    maximumTargets,
    Math.max(0, Math.floor((remainingWeight - reserveWeight) / weightPerTarget)),
  );
}

function emptyExitCounterfactualPath(materialMovePercent: number) {
  return {
    causallyClosed: false,
    closedCandleCount: 0,
    latestObservedAtMs: null,
    directionReturnPercent: null,
    postExitMfePercent: null,
    postExitMaePercent: null,
    favorablePeakAtMs: null,
    adversePeakAtMs: null,
    firstMaterialFavorableAtMs: null,
    firstMaterialAdverseAtMs: null,
    favorableBeforeAdverse: null,
    postExitVolumeRatio: null,
    materialMovePercent,
    historicalLabelOnly: true as const,
  };
}

function normalizedCandles(candles: readonly ExitCounterfactualCandle[]) {
  const latestByOpenTime = new Map<number, ExitCounterfactualCandle>();
  for (const candle of candles) {
    if (
      ![
        candle.openTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.closeTime,
      ].every(Number.isFinite) ||
      candle.openTime < 0 ||
      candle.closeTime < candle.openTime ||
      candle.open <= 0 ||
      candle.high <= 0 ||
      candle.low <= 0 ||
      candle.close <= 0 ||
      candle.high < candle.low
    ) continue;
    latestByOpenTime.set(candle.openTime, candle);
  }
  return [...latestByOpenTime.values()].sort(
    (left, right) => left.openTime - right.openTime,
  );
}

function averagePositiveVolume(candles: readonly ExitCounterfactualCandle[]) {
  const values = candles
    .map((candle) => candle.volume)
    .filter((volume) => Number.isFinite(volume) && volume > 0);
  return values.length ? average(values) : null;
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveOrNull(value: unknown) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function nonNegativeOrNull(value: unknown) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function positiveOr(value: unknown, fallback: number) {
  return positiveOrNull(value) ?? fallback;
}

function rounded(value: number, precision: number) {
  const scale = 10 ** precision;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
