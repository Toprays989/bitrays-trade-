export const NEXUS_BTC_RELATIONSHIP_VERSION =
  "nexus-btc-relationship-v1" as const;

export type NexusBtcRelationshipState =
  | "BTC_FOLLOWING"
  | "BTC_AMPLIFIED"
  | "INDEPENDENT_VOLUME_DRIVEN"
  | "DECOUPLED_WEAK"
  | "REGIME_TRANSITION"
  | "INSUFFICIENT";

export function nexusBtcRelationshipLabel(
  state: NexusBtcRelationshipState,
) {
  return {
    BTC_FOLLOWING: "跟随BTC",
    BTC_AMPLIFIED: "放大跟随BTC",
    INDEPENDENT_VOLUME_DRIVEN: "放量独立行情",
    DECOUPLED_WEAK: "弱脱钩噪音",
    REGIME_TRANSITION: "联动关系转换",
    INSUFFICIENT: "联动样本不足",
  }[state];
}

export type NexusRelationshipCandle = {
  openTime: number;
  close: number;
  quoteVolume?: number;
  volume?: number;
};

export type NexusBtcRelationshipResult = {
  version: typeof NEXUS_BTC_RELATIONSHIP_VERSION;
  state: NexusBtcRelationshipState;
  observations: number;
  fastCorrelation: number | null;
  slowCorrelation: number | null;
  covariance: number | null;
  beta: number | null;
  rSquared: number | null;
  altVariance: number | null;
  btcVariance: number | null;
  residual: number | null;
  residualZScore: number | null;
  relativeVolume: number | null;
  altReturn: number | null;
  btcReturn: number | null;
  reason: string;
  orderAffecting: false;
};

type WeightedMoments = {
  meanX: number;
  meanY: number;
  varianceX: number;
  varianceY: number;
  covariance: number;
  correlation: number;
};

export function analyzeNexusBtcRelationship(input: {
  altCandles: NexusRelationshipCandle[];
  btcCandles: NexusRelationshipCandle[];
  fastWindow?: number;
  slowWindow?: number;
  decay?: number;
  minimumObservations?: number;
  followerCorrelation?: number;
  amplifiedBeta?: number;
  independentCorrelation?: number;
  residualZThreshold?: number;
  relativeVolumeThreshold?: number;
  transitionCorrelationDelta?: number;
  relativeVolumeOverride?: number | null;
}): NexusBtcRelationshipResult {
  const fastWindow = positiveInteger(input.fastWindow ?? 20, 5);
  const slowWindow = positiveInteger(
    input.slowWindow ?? 60,
    fastWindow,
  );
  const minimumObservations = positiveInteger(
    input.minimumObservations ?? 20,
    5,
  );
  const decay = bounded(input.decay ?? 0.94, 0.5, 0.999);
  const aligned = alignCandles(input.altCandles, input.btcCandles);
  const returns = alignedReturns(aligned).slice(-slowWindow);
  if (returns.length < minimumObservations)
    return insufficient(returns.length, "BTC与目标合约的闭合K线样本不足");

  const slow = exponentiallyWeightedMoments(
    returns.map((row) => row.btcReturn),
    returns.map((row) => row.altReturn),
    decay,
  );
  const fastRows = returns.slice(-Math.min(fastWindow, returns.length));
  const fast = exponentiallyWeightedMoments(
    fastRows.map((row) => row.btcReturn),
    fastRows.map((row) => row.altReturn),
    decay,
  );
  if (!slow || !fast || slow.varianceX <= Number.EPSILON)
    return insufficient(returns.length, "BTC收益方差不足，无法计算联动关系");

  const beta = slow.covariance / slow.varianceX;
  const alpha = slow.meanY - beta * slow.meanX;
  const residuals = returns.map(
    (row) => row.altReturn - (alpha + beta * row.btcReturn),
  );
  const residualStats = exponentiallyWeightedSingle(residuals, decay);
  const residual = residuals.at(-1) ?? null;
  const residualZScore =
    residual !== null &&
    residualStats &&
    residualStats.variance > Number.EPSILON
      ? (residual - residualStats.mean) /
        Math.sqrt(residualStats.variance)
      : 0;
  const relativeVolume =
    Number.isFinite(input.relativeVolumeOverride) &&
    Number(input.relativeVolumeOverride) >= 0
      ? Number(input.relativeVolumeOverride)
      : calculateRelativeVolume(aligned, slowWindow, decay);
  const altReturn = returns.at(-1)?.altReturn ?? null;
  const btcReturn = returns.at(-1)?.btcReturn ?? null;
  const correlationDelta = Math.abs(
    fast.correlation - slow.correlation,
  );
  const followerCorrelation = bounded(
    input.followerCorrelation ?? 0.55,
    0,
    1,
  );
  const independentCorrelation = bounded(
    input.independentCorrelation ?? 0.35,
    0,
    followerCorrelation,
  );
  const amplifiedBeta = Math.max(1, input.amplifiedBeta ?? 1.25);
  const residualZThreshold = Math.max(
    0.5,
    input.residualZThreshold ?? 1.5,
  );
  const relativeVolumeThreshold = Math.max(
    1,
    input.relativeVolumeThreshold ?? 1.5,
  );
  const transitionCorrelationDelta = bounded(
    input.transitionCorrelationDelta ?? 0.35,
    0.05,
    1,
  );

  let state: NexusBtcRelationshipState;
  let reason: string;
  const independentMove =
    Math.abs(residualZScore ?? 0) >= residualZThreshold &&
    (relativeVolume ?? 0) >= relativeVolumeThreshold &&
    (Math.abs(fast.correlation) <= independentCorrelation ||
      Math.abs(fast.correlation) < Math.abs(slow.correlation));
  const relationshipTransition =
    correlationDelta >= transitionCorrelationDelta ||
    fast.correlation * slow.correlation < 0;
  if (independentMove) {
    state = "INDEPENDENT_VOLUME_DRIVEN";
    reason = "BTC无法解释的残差显著且相对成交量放大，识别为独立行情";
  } else if (relationshipTransition) {
    state = "REGIME_TRANSITION";
    reason = "短窗与稳定窗相关关系快速变化，等待联动结构重新稳定";
  } else if (
    slow.correlation >= followerCorrelation &&
    beta >= amplifiedBeta
  ) {
    state = "BTC_AMPLIFIED";
    reason = "与BTC保持高正相关且Beta大于放大阈值";
  } else if (
    slow.correlation >= followerCorrelation &&
    beta > 0
  ) {
    state = "BTC_FOLLOWING";
    reason = "与BTC保持高正相关，当前属于大盘跟随行情";
  } else {
    state = "DECOUPLED_WEAK";
    reason =
      relativeVolume !== null && relativeVolume < relativeVolumeThreshold
        ? "BTC相关性不足且没有相对成交量支持，按弱脱钩噪音处理"
        : "BTC相关性不足，但独立行情证据尚未完整";
  }

  return {
    version: NEXUS_BTC_RELATIONSHIP_VERSION,
    state,
    observations: returns.length,
    fastCorrelation: fast.correlation,
    slowCorrelation: slow.correlation,
    covariance: slow.covariance,
    beta,
    rSquared: slow.correlation ** 2,
    altVariance: slow.varianceY,
    btcVariance: slow.varianceX,
    residual,
    residualZScore,
    relativeVolume,
    altReturn,
    btcReturn,
    reason,
    orderAffecting: false,
  };
}

function alignCandles(
  altCandles: NexusRelationshipCandle[],
  btcCandles: NexusRelationshipCandle[],
) {
  const btc = new Map(
    btcCandles
      .filter(validCandle)
      .map((row) => [Math.trunc(row.openTime), row] as const),
  );
  return altCandles
    .filter(validCandle)
    .map((alt) => {
      const matchingBtc = btc.get(Math.trunc(alt.openTime));
      return matchingBtc ? { alt, btc: matchingBtc } : null;
    })
    .filter(
      (
        row,
      ): row is {
        alt: NexusRelationshipCandle;
        btc: NexusRelationshipCandle;
      } => Boolean(row),
    )
    .sort((left, right) => left.alt.openTime - right.alt.openTime);
}

function alignedReturns(
  rows: Array<{
    alt: NexusRelationshipCandle;
    btc: NexusRelationshipCandle;
  }>,
) {
  const result: Array<{
    altReturn: number;
    btcReturn: number;
  }> = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const altReturn = Math.log(current.alt.close / previous.alt.close);
    const btcReturn = Math.log(current.btc.close / previous.btc.close);
    if (Number.isFinite(altReturn) && Number.isFinite(btcReturn))
      result.push({ altReturn, btcReturn });
  }
  return result;
}

function exponentiallyWeightedMoments(
  x: number[],
  y: number[],
  decay: number,
): WeightedMoments | null {
  if (x.length !== y.length || x.length < 2) return null;
  const weights = normalizedWeights(x.length, decay);
  const meanX = weightedMean(x, weights);
  const meanY = weightedMean(y, weights);
  let varianceX = 0;
  let varianceY = 0;
  let covariance = 0;
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    varianceX += weights[index] * dx * dx;
    varianceY += weights[index] * dy * dy;
    covariance += weights[index] * dx * dy;
  }
  const denominator = Math.sqrt(varianceX * varianceY);
  return {
    meanX,
    meanY,
    varianceX,
    varianceY,
    covariance,
    correlation: denominator > Number.EPSILON
      ? bounded(covariance / denominator, -1, 1)
      : 0,
  };
}

function exponentiallyWeightedSingle(values: number[], decay: number) {
  if (values.length < 2) return null;
  const weights = normalizedWeights(values.length, decay);
  const mean = weightedMean(values, weights);
  return {
    mean,
    variance: values.reduce(
      (total, value, index) =>
        total + weights[index] * (value - mean) ** 2,
      0,
    ),
  };
}

function calculateRelativeVolume(
  rows: Array<{
    alt: NexusRelationshipCandle;
    btc: NexusRelationshipCandle;
  }>,
  window: number,
  decay: number,
) {
  const volumes = rows
    .slice(-(window + 1))
    .map(({ alt }) => alt.quoteVolume ?? alt.volume)
    .filter(
      (value): value is number =>
        Number.isFinite(value) && Number(value) >= 0,
    );
  if (volumes.length < 3) return null;
  const current = volumes.at(-1)!;
  const history = volumes.slice(0, -1);
  const baseline = weightedMean(
    history,
    normalizedWeights(history.length, decay),
  );
  return baseline > 0 ? current / baseline : null;
}

function normalizedWeights(length: number, decay: number) {
  const weights = Array.from(
    { length },
    (_, index) => decay ** (length - index - 1),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function weightedMean(values: number[], weights: number[]) {
  return values.reduce(
    (sum, value, index) => sum + value * weights[index],
    0,
  );
}

function validCandle(row: NexusRelationshipCandle) {
  return (
    Number.isFinite(row.openTime) &&
    Number.isFinite(row.close) &&
    row.close > 0
  );
}

function positiveInteger(value: number, minimum: number) {
  return Math.max(minimum, Math.trunc(value));
}

function bounded(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function insufficient(
  observations: number,
  reason: string,
): NexusBtcRelationshipResult {
  return {
    version: NEXUS_BTC_RELATIONSHIP_VERSION,
    state: "INSUFFICIENT",
    observations,
    fastCorrelation: null,
    slowCorrelation: null,
    covariance: null,
    beta: null,
    rSquared: null,
    altVariance: null,
    btcVariance: null,
    residual: null,
    residualZScore: null,
    relativeVolume: null,
    altReturn: null,
    btcReturn: null,
    reason,
    orderAffecting: false,
  };
}
