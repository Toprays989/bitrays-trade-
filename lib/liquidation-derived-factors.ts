export const LIQUIDATION_DERIVED_FACTORS_VERSION =
  "liquidation-derived-factors-v1" as const;

export type LiquidationFactorEvent = {
  eventAtMs: number;
  liquidationPrice: number;
  liquidationNotional: number;
  eventCount?: number;
};

export type LiquidationFactorPricePoint = {
  eventAtMs: number;
  price: number;
};

export type LiquidationFactorPolicy = {
  mode: "SHADOW" | "LIVE";
  automaticModeSwitch: boolean;
  learningTargetEpisodes: number;
  learningMinimumExactCycles: number;
  minimumEvents: number;
  minimumObservationSeconds: number;
  minimumAmountUsdt: number;
  minimumVelocityUsdtPerSecond: number;
  minimumLiquidationToOiPercent: number;
  minimumDirectionalPriceImpactPercent: number;
  minimumAccelerationRatio: number;
  maximumDivergenceImpactRatio: number;
  minimumVolumeRatio: number;
  requiredScore: number;
  weights: {
    amount: number;
    velocity: number;
    liquidationToOi: number;
    priceImpact: number;
    acceleration: number;
    divergence: number;
  };
};

export type LiquidationDerivedFactors = ReturnType<
  typeof deriveLiquidationDerivedFactors
>;

export type LiquidationFactorBrainDecision = ReturnType<
  typeof evaluateLiquidationFactorBrain
>;

const DEFAULT_WEIGHTS = {
  amount: 10,
  velocity: 15,
  liquidationToOi: 10,
  priceImpact: 20,
  acceleration: 20,
  divergence: 25,
};

export function selectLiquidationFactorEpisode(
  events: LiquidationFactorEvent[],
  input: { maximumWindowMs: number; maximumInterEventGapMs: number },
) {
  const ordered = events
    .filter((event) => Number.isFinite(event.eventAtMs))
    .sort((left, right) => left.eventAtMs - right.eventAtMs);
  const latestAt = ordered.at(-1)?.eventAtMs;
  if (!Number.isFinite(latestAt)) return [];
  const maximumWindowMs = Math.max(1_000, input.maximumWindowMs);
  const maximumInterEventGapMs = Math.max(
    1_000,
    Math.min(maximumWindowMs, input.maximumInterEventGapMs),
  );
  const selected: LiquidationFactorEvent[] = [];
  let newerAt = latestAt!;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (latestAt! - event.eventAtMs > maximumWindowMs) break;
    if (newerAt - event.eventAtMs > maximumInterEventGapMs) break;
    selected.push(event);
    newerAt = event.eventAtMs;
  }
  return selected.reverse();
}

export function normalizeLiquidationFactorPolicy(
  value: Partial<LiquidationFactorPolicy> | null | undefined,
  fallback: {
    minimumEvents: number;
    minimumAmountUsdt: number;
    observationWindowSeconds: number;
    minimumVolumeRatio: number;
  },
): LiquidationFactorPolicy {
  const observationWindowSeconds = positive(
    fallback.observationWindowSeconds,
    30,
  );
  const configuredWeights = value?.weights ?? DEFAULT_WEIGHTS;
  return {
    mode: value?.mode === "LIVE" ? "LIVE" : "SHADOW",
    automaticModeSwitch: value?.automaticModeSwitch !== false,
    learningTargetEpisodes: Math.max(
      10,
      Math.trunc(positive(value?.learningTargetEpisodes, 30)),
    ),
    learningMinimumExactCycles: Math.max(
      6,
      Math.trunc(positive(value?.learningMinimumExactCycles, 8)),
    ),
    minimumEvents: Math.max(
      3,
      Math.trunc(positive(value?.minimumEvents, fallback.minimumEvents)),
    ),
    minimumObservationSeconds: Math.max(
      1,
      positive(value?.minimumObservationSeconds, 3),
    ),
    minimumAmountUsdt: positive(
      value?.minimumAmountUsdt,
      fallback.minimumAmountUsdt,
    ),
    minimumVelocityUsdtPerSecond: positive(
      value?.minimumVelocityUsdtPerSecond,
      fallback.minimumAmountUsdt / observationWindowSeconds,
    ),
    minimumLiquidationToOiPercent: nonNegative(
      value?.minimumLiquidationToOiPercent,
      0,
    ),
    minimumDirectionalPriceImpactPercent: positive(
      value?.minimumDirectionalPriceImpactPercent,
      0.05,
    ),
    minimumAccelerationRatio: positive(
      value?.minimumAccelerationRatio,
      1.2,
    ),
    maximumDivergenceImpactRatio: clamp(
      value?.maximumDivergenceImpactRatio,
      0,
      1,
      0.5,
    ),
    minimumVolumeRatio: positive(
      value?.minimumVolumeRatio,
      fallback.minimumVolumeRatio,
    ),
    requiredScore: clamp(value?.requiredScore, 1, 100, 60),
    weights: {
      amount: nonNegative(configuredWeights.amount, DEFAULT_WEIGHTS.amount),
      velocity: nonNegative(
        configuredWeights.velocity,
        DEFAULT_WEIGHTS.velocity,
      ),
      liquidationToOi: nonNegative(
        configuredWeights.liquidationToOi,
        DEFAULT_WEIGHTS.liquidationToOi,
      ),
      priceImpact: nonNegative(
        configuredWeights.priceImpact,
        DEFAULT_WEIGHTS.priceImpact,
      ),
      acceleration: nonNegative(
        configuredWeights.acceleration,
        DEFAULT_WEIGHTS.acceleration,
      ),
      divergence: nonNegative(
        configuredWeights.divergence,
        DEFAULT_WEIGHTS.divergence,
      ),
    },
  };
}

export function liquidationFactorPolicyError(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "爆仓衍生因子参数必须是对象";
  const config = value as Record<string, unknown>;
  if (
    config.mode !== undefined &&
    !["SHADOW", "LIVE"].includes(String(config.mode))
  ) return "爆仓衍生因子模式只能是 SHADOW 或 LIVE";
  if (
    config.automaticModeSwitch !== undefined &&
    typeof config.automaticModeSwitch !== "boolean"
  ) return "爆仓衍生因子自动闭环开关必须是布尔值";
  const ranges: Array<[string, number, number, string]> = [
    ["learningTargetEpisodes", 10, 1000, "爆仓因子学习事件段需为 10 至 1000"],
    ["learningMinimumExactCycles", 6, 100, "爆仓因子精确验证周期需为 6 至 100"],
    ["minimumEvents", 3, 100, "衍生因子最少事件数需为 3 至 100"],
    ["minimumObservationSeconds", 1, 300, "衍生因子观察时间需为 1 至 300 秒"],
    ["minimumAmountUsdt", Number.EPSILON, Number.MAX_SAFE_INTEGER, "衍生因子爆仓金额必须大于 0"],
    ["minimumVelocityUsdtPerSecond", Number.EPSILON, Number.MAX_SAFE_INTEGER, "爆仓速度阈值必须大于 0"],
    ["minimumLiquidationToOiPercent", 0, 100, "爆仓/OI 阈值需为 0% 至 100%"],
    ["minimumDirectionalPriceImpactPercent", 0.001, 20, "价格冲击阈值需为 0.001% 至 20%"],
    ["minimumAccelerationRatio", 1, 100, "爆仓加速度阈值需为 1 至 100 倍"],
    ["maximumDivergenceImpactRatio", 0, 1, "爆仓价格背离比需为 0 至 1"],
    ["minimumVolumeRatio", 1, 10, "爆仓确认成交量倍数需为 1 至 10"],
    ["requiredScore", 1, 100, "爆仓衍生因子评分阈值需为 1 至 100"],
  ];
  for (const [key, minimum, maximum, message] of ranges) {
    if (config[key] === undefined) continue;
    const number = Number(config[key]);
    if (!Number.isFinite(number) || number < minimum || number > maximum)
      return message;
  }
  if (config.weights !== undefined) {
    if (
      !config.weights ||
      typeof config.weights !== "object" ||
      Array.isArray(config.weights)
    ) return "爆仓衍生因子权重必须是对象";
    for (const weight of Object.values(config.weights)) {
      const number = Number(weight);
      if (!Number.isFinite(number) || number < 0 || number > 100)
        return "单项爆仓衍生因子权重需为 0 至 100";
    }
  }
  return null;
}

/**
 * Builds one strategy-neutral market snapshot. The raw factors are identical
 * for every brain; only evaluateLiquidationFactorBrain applies strategy-owned
 * thresholds and weights.
 */
export function deriveLiquidationDerivedFactors(input: {
  symbol: string;
  liquidationSide: "BUY" | "SELL";
  events: LiquidationFactorEvent[];
  pricePoints?: LiquidationFactorPricePoint[];
  evaluatedAt: number;
  latestPrice: number | null;
  openInterestValue: number | null;
  openInterestChangePercent: number | null;
  fundingRate: number | null;
  relativeVolume: number | null;
}) {
  const buckets = aggregateSecondBuckets(input.events).slice(-120);
  const totalEventCount = buckets.reduce(
    (sum, bucket) => sum + bucket.eventCount,
    0,
  );
  const totalAmountUsdt = buckets.reduce(
    (sum, bucket) => sum + bucket.liquidationAmountUsdt,
    0,
  );
  const first = buckets[0] ?? null;
  const latest = buckets.at(-1) ?? null;
  const evaluatedAt = Number.isFinite(input.evaluatedAt)
    ? Math.max(input.evaluatedAt, latest?.eventAtMs ?? input.evaluatedAt)
    : latest?.eventAtMs ?? 0;
  const observationMs = first
    ? Math.max(0, evaluatedAt - first.eventAtMs)
    : 0;
  const splitAt = first ? first.eventAtMs + observationMs / 2 : evaluatedAt;
  const previousBuckets = buckets.filter((bucket) => bucket.eventAtMs < splitAt);
  const currentBuckets = buckets.filter((bucket) => bucket.eventAtMs >= splitAt);
  const previousAmountUsdt = sumAmount(previousBuckets);
  const currentAmountUsdt = sumAmount(currentBuckets);
  const segmentSeconds = Math.max(1, observationMs / 2 / 1_000);
  const previousVelocityUsdtPerSecond =
    previousAmountUsdt / segmentSeconds;
  const currentVelocityUsdtPerSecond = currentAmountUsdt / segmentSeconds;
  const velocityAccelerationRatio =
    previousVelocityUsdtPerSecond > 0
      ? currentVelocityUsdtPerSecond / previousVelocityUsdtPerSecond
      : null;
  const openInterestValue = finitePositiveOrNull(input.openInterestValue);
  const liquidationToOiPercent = openInterestValue === null
    ? null
    : totalAmountUsdt / openInterestValue * 100;
  const firstPrice = first?.liquidationPrice ?? null;
  const priceSeries = [
    ...buckets.map((bucket) => ({
      eventAtMs: bucket.eventAtMs,
      price: bucket.liquidationPrice,
    })),
    ...(input.pricePoints ?? []),
    ...(finitePositiveOrNull(input.latestPrice) === null
      ? []
      : [{ eventAtMs: evaluatedAt, price: Number(input.latestPrice) }]),
  ]
    .filter((point) =>
      Number.isFinite(point.eventAtMs) &&
      Number.isFinite(point.price) &&
      point.price > 0 &&
      (!first || point.eventAtMs >= first.eventAtMs) &&
      point.eventAtMs <= evaluatedAt
    )
    .sort((left, right) => left.eventAtMs - right.eventAtMs)
    .slice(-120);
  const midpointPrice = nearestPrice(priceSeries, splitAt) ??
    previousBuckets.at(-1)?.liquidationPrice ?? firstPrice;
  const latestPrice =
    finitePositiveOrNull(input.latestPrice) ?? latest?.liquidationPrice ?? null;
  const rawPriceChangePercent = percentChange(firstPrice, latestPrice);
  const directionalMultiplier = input.liquidationSide === "SELL" ? -1 : 1;
  const directionalPriceImpactPercent = rawPriceChangePercent === null
    ? null
    : rawPriceChangePercent * directionalMultiplier;
  const previousDirectionalPriceImpactPercent =
    (percentChange(firstPrice, midpointPrice) ?? 0) * directionalMultiplier;
  const currentDirectionalPriceImpactPercent =
    (percentChange(midpointPrice, latestPrice) ?? 0) * directionalMultiplier;
  const currentToPreviousImpactRatio =
    previousDirectionalPriceImpactPercent > 0
      ? currentDirectionalPriceImpactPercent /
        previousDirectionalPriceImpactPercent
      : null;
  const priceImpactPerMillionUsdt =
    directionalPriceImpactPercent === null || totalAmountUsdt <= 0
      ? null
      : directionalPriceImpactPercent / (totalAmountUsdt / 1_000_000);

  return {
    version: LIQUIDATION_DERIVED_FACTORS_VERSION,
    symbol: input.symbol.trim().toUpperCase(),
    liquidationSide: input.liquidationSide,
    continuationDirection: input.liquidationSide === "SELL"
      ? "SHORT" as const
      : "LONG" as const,
    reversalDirection: input.liquidationSide === "SELL"
      ? "LONG" as const
      : "SHORT" as const,
    evaluatedAt,
    windowStartedAt: first?.eventAtMs ?? null,
    windowEndedAt: first ? evaluatedAt : null,
    latestLiquidationAt: latest?.eventAtMs ?? null,
    observationMs,
    totalEventCount,
    series: buckets,
    priceSeries,
    factors: {
      liquidationAmountUsdt: totalAmountUsdt,
      liquidationVelocityUsdtPerSecond: currentVelocityUsdtPerSecond,
      previousLiquidationVelocityUsdtPerSecond:
        previousVelocityUsdtPerSecond,
      liquidationToOiPercent,
      directionalPriceImpactPercent,
      rawPriceChangePercent,
      priceImpactPerMillionUsdt,
      liquidationAccelerationRatio: velocityAccelerationRatio,
      liquidationPriceDivergence: {
        previousDirectionalPriceImpactPercent,
        currentDirectionalPriceImpactPercent,
        currentToPreviousImpactRatio,
      },
    },
    confirmations: {
      openInterestValue,
      openInterestChangePercent: finiteOrNull(
        input.openInterestChangePercent,
      ),
      fundingRate: finiteOrNull(input.fundingRate),
      relativeVolume: finiteOrNull(input.relativeVolume),
    },
    segmentAmounts: {
      previousAmountUsdt,
      currentAmountUsdt,
    },
    source: "BINANCE_FORCE_ORDER_PLUS_CLOSED_MARKET_FACTS" as const,
  };
}

export function evaluateLiquidationFactorBrain(input: {
  direction: "LONG" | "SHORT";
  snapshot: LiquidationDerivedFactors;
  policy: LiquidationFactorPolicy;
}) {
  const { snapshot, policy } = input;
  const factors = snapshot.factors;
  const missing: string[] = [];
  if (snapshot.totalEventCount < policy.minimumEvents)
    missing.push(`爆仓事件至少 ${policy.minimumEvents} 次`);
  if (snapshot.observationMs < policy.minimumObservationSeconds * 1_000)
    missing.push(`爆仓序列至少观察 ${policy.minimumObservationSeconds} 秒`);
  if (factors.liquidationAccelerationRatio === null)
    missing.push("前后两个爆仓速度分段");
  if (factors.directionalPriceImpactPercent === null)
    missing.push("爆仓后价格变化");

  const amountQualified =
    factors.liquidationAmountUsdt >= policy.minimumAmountUsdt;
  const velocityQualified =
    factors.liquidationVelocityUsdtPerSecond >=
      policy.minimumVelocityUsdtPerSecond;
  const priorVelocityQualified =
    factors.previousLiquidationVelocityUsdtPerSecond >=
      policy.minimumVelocityUsdtPerSecond;
  const liquidationToOiQualified =
    factors.liquidationToOiPercent !== null &&
    factors.liquidationToOiPercent >=
      policy.minimumLiquidationToOiPercent;
  const priceImpactQualified =
    factors.directionalPriceImpactPercent !== null &&
    factors.directionalPriceImpactPercent >=
      policy.minimumDirectionalPriceImpactPercent;
  const accelerationQualified =
    factors.liquidationAccelerationRatio !== null &&
    factors.liquidationAccelerationRatio >=
      policy.minimumAccelerationRatio;
  const impactRatio =
    factors.liquidationPriceDivergence.currentToPreviousImpactRatio;
  const divergenceQualified =
    (
      accelerationQualified ||
      (
        factors.previousLiquidationVelocityUsdtPerSecond > 0 &&
        factors.liquidationVelocityUsdtPerSecond <=
          factors.previousLiquidationVelocityUsdtPerSecond * 0.5
      )
    ) &&
    (
      factors.liquidationPriceDivergence
          .currentDirectionalPriceImpactPercent <= 0 ||
      (impactRatio !== null &&
        impactRatio <= policy.maximumDivergenceImpactRatio)
    );
  const volumeConfirmed =
    snapshot.confirmations.relativeVolume !== null &&
    snapshot.confirmations.relativeVolume >= policy.minimumVolumeRatio;
  const oiDeleveragingConfirmed =
    snapshot.confirmations.openInterestChangePercent !== null &&
    snapshot.confirmations.openInterestChangePercent < 0;
  const continuationScore = capScore(
    score(amountQualified, policy.weights.amount) +
      score(velocityQualified, policy.weights.velocity) +
      score(liquidationToOiQualified, policy.weights.liquidationToOi) +
      score(priceImpactQualified, policy.weights.priceImpact) +
      score(accelerationQualified && !divergenceQualified, policy.weights.acceleration) +
      score(volumeConfirmed, 5) +
      score(oiDeleveragingConfirmed, 5),
  );
  const exhaustionScore = capScore(
    score(amountQualified, policy.weights.amount) +
      score(velocityQualified || priorVelocityQualified, policy.weights.velocity) +
      score(liquidationToOiQualified, policy.weights.liquidationToOi) +
      score(divergenceQualified, policy.weights.divergence) +
      score(volumeConfirmed, 5) +
      score(oiDeleveragingConfirmed, 5),
  );
  const seriesReady = missing.length === 0;
  const continuationQualified =
    seriesReady && !divergenceQualified &&
    continuationScore >= policy.requiredScore;
  const exhaustionQualified =
    seriesReady && exhaustionScore >= policy.requiredScore;
  const supportsDirection =
    (continuationQualified &&
      input.direction === snapshot.continuationDirection) ||
    (exhaustionQualified && input.direction === snapshot.reversalDirection);
  const conflictsDirection =
    (continuationQualified &&
      input.direction === snapshot.reversalDirection) ||
    (exhaustionQualified && input.direction === snapshot.continuationDirection);
  const verdict = !seriesReady
    ? "WAIT_SERIES" as const
    : supportsDirection
      ? "SUPPORTS_DIRECTION" as const
      : conflictsDirection
        ? "CONFLICTS_DIRECTION" as const
        : "WAIT_SCORE" as const;

  return {
    version: "liquidation-factor-brain-decision-v1" as const,
    direction: input.direction,
    verdict,
    seriesReady,
    supportsDirection,
    conflictsDirection,
    continuationScore,
    exhaustionScore,
    requiredScore: policy.requiredScore,
    regime: divergenceQualified
      ? "LIQUIDATION_PRICE_DIVERGENCE" as const
      : accelerationQualified && priceImpactQualified
        ? "LIQUIDATION_ACCELERATING" as const
        : "LIQUIDATION_UNRESOLVED" as const,
    checks: {
      amountQualified,
      velocityQualified,
      priorVelocityQualified,
      liquidationToOiQualified,
      priceImpactQualified,
      accelerationQualified,
      divergenceQualified,
      volumeConfirmed,
      oiDeleveragingConfirmed,
    },
    missing,
    policy,
    orderAffecting: false as const,
  };
}

function aggregateSecondBuckets(events: LiquidationFactorEvent[]) {
  const buckets = new Map<
    number,
    {
      eventAtMs: number;
      eventCount: number;
      liquidationAmountUsdt: number;
      liquidationPrice: number;
    }
  >();
  for (const event of events) {
    const eventAtMs = Number(event.eventAtMs);
    const price = Number(event.liquidationPrice);
    const amount = Number(event.liquidationNotional);
    if (
      !Number.isFinite(eventAtMs) || eventAtMs <= 0 ||
      !Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(amount) || amount <= 0
    ) continue;
    const bucketAt = Math.floor(eventAtMs / 1_000) * 1_000;
    const current = buckets.get(bucketAt);
    const eventCount = Math.max(1, Math.trunc(positive(event.eventCount, 1)));
    if (!current) {
      buckets.set(bucketAt, {
        eventAtMs: bucketAt,
        eventCount,
        liquidationAmountUsdt: amount,
        liquidationPrice: price,
      });
      continue;
    }
    const nextAmount = current.liquidationAmountUsdt + amount;
    current.liquidationPrice =
      (current.liquidationPrice * current.liquidationAmountUsdt +
        price * amount) /
      nextAmount;
    current.liquidationAmountUsdt = nextAmount;
    current.eventCount += eventCount;
  }
  return [...buckets.values()].sort((left, right) =>
    left.eventAtMs - right.eventAtMs
  );
}

function sumAmount(
  buckets: Array<{ liquidationAmountUsdt: number }>,
) {
  return buckets.reduce(
    (sum, bucket) => sum + bucket.liquidationAmountUsdt,
    0,
  );
}

function percentChange(left: number | null, right: number | null) {
  return left !== null && right !== null && left > 0
    ? (right - left) / left * 100
    : null;
}

function nearestPrice(
  points: LiquidationFactorPricePoint[],
  targetAt: number,
) {
  let selected: LiquidationFactorPricePoint | null = null;
  for (const point of points) {
    if (!selected ||
      Math.abs(point.eventAtMs - targetAt) <
        Math.abs(selected.eventAtMs - targetAt)) selected = point;
  }
  return selected?.price ?? null;
}

function score(qualified: boolean, weight: number) {
  return qualified ? weight : 0;
}

function capScore(value: number) {
  return Math.min(100, Math.max(0, value));
}

function finitePositiveOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegative(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clamp(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : fallback;
}
