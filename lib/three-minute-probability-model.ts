export type ThreeMinuteProbabilityFeatures = Readonly<{
  symbol: string;
  factSnapshotId: string;
  observedAt: number;
  markAgeMs: number;
  return1mBps: number;
  return3mBps: number;
  return4mBps: number;
  return5mBps: number;
  return15mBps: number;
  return30mBps: number;
  return1hBps: number;
  return4hBps: number;
  return1dBps: number;
  relativeVolume3m: number;
  aggressorImbalance3s: number;
  depthImbalance: number;
  position24hPercent: number;
  position72hPercent: number;
  position7dPercent: number;
  historicalLongWins: number;
  historicalLongLosses: number;
  historicalShortWins: number;
  historicalShortLosses: number;
  averageLongWinBps: number;
  averageLongLossBps: number;
  averageShortWinBps: number;
  averageShortLossBps: number;
  twoSecondDownCount?: number;
  oneMinuteBearishCount?: number;
  oneMinuteRecovery?: boolean;
}>;

export type ThreeMinuteProbabilityDecision = Readonly<{
  modelVersion: "three-minute-probability-v2";
  symbol: string;
  factSnapshotId: string;
  pLongPercent: number;
  pShortPercent: number;
  sampleCount: number;
  confidenceIntervalPercent: readonly [number, number];
  grossEdgeBps: number;
  estimatedCostBps: number;
  netEdgeBps: number;
  breakEvenProbabilityPercent: number;
  eligibilityMode: "DIRECT_PROBABILITY";
  direction: "LONG" | "SHORT" | "NO_TRADE";
  dataQuality: "READY" | "STALE" | "INSUFFICIENT";
}>;

export function decideThreeMinuteProbability(input: {
  features: ThreeMinuteProbabilityFeatures;
  minimumProbabilityPercent: number;
  minimumNetEdgeBps: number;
  estimatedRoundTripFeeBps: number;
  estimatedSlippageBps: number;
  maxFactAgeMs: number;
  eligibilityMode?:
    | "DIRECT_PROBABILITY"
    | "NET_EXPECTANCY"
    | "CALIBRATION_MINIMUM_ORDER";
}): ThreeMinuteProbabilityDecision {
  const feature = input.features;
  const simpleLongOnly =
    (feature.twoSecondDownCount ?? 0) >= 10 &&
    (feature.oneMinuteBearishCount ?? 0) >= 2 &&
    (feature.oneMinuteBearishCount ?? 0) <= 3 &&
    feature.oneMinuteRecovery === true;
  const longSampleCount = Math.max(
    0,
    Math.trunc(feature.historicalLongWins) +
      Math.trunc(feature.historicalLongLosses),
  );
  const shortSampleCount = Math.max(
    0,
    Math.trunc(feature.historicalShortWins) +
      Math.trunc(feature.historicalShortLosses),
  );
  const sampleCount = longSampleCount + shortSampleCount;
  const priorSamples = 6;
  const momentum = bounded(
    feature.return1mBps * 0.22 +
      feature.return3mBps * 0.30 +
      feature.return4mBps * 0.08 +
      feature.return5mBps * 0.12 +
      feature.return15mBps * 0.12 +
      feature.return30mBps * 0.06 +
      feature.return1hBps * 0.05 +
      feature.return4hBps * 0.02 +
      feature.return1dBps * 0.01,
    -120,
    120,
  );
  const flow = bounded(
    feature.aggressorImbalance3s * 18 + feature.depthImbalance * 12,
    -30,
    30,
  );
  const volumeConfirmation = bounded(
    (feature.relativeVolume3m - 1) * Math.sign(momentum || flow) * 10,
    -15,
    15,
  );
  const locationBias = bounded(
      (50 - feature.position24hPercent) * 0.06 +
      (50 - feature.position72hPercent) * 0.03 +
      (50 - feature.position7dPercent) * 0.01,
    -6,
    6,
  );
  const pLongPercent = bounded(
    50 + momentum * 0.12 + flow + volumeConfirmation + locationBias,
    1,
    99,
  );
  const pShortPercent = 100 - pLongPercent;
  const candidateDirection = simpleLongOnly ? "LONG" : "NO_TRADE";
  const probability = simpleLongOnly ? 60 : Math.max(pLongPercent, pShortPercent);
  const averageWinBps = Math.max(
    1,
    Math.abs(candidateDirection === "LONG"
      ? feature.averageLongWinBps
      : feature.averageShortWinBps) || 18,
  );
  const averageLossBps = Math.max(
    1,
    Math.abs(candidateDirection === "LONG"
      ? feature.averageLongLossBps
      : feature.averageShortLossBps) || 18,
  );
  const estimatedCostBps = Math.max(
    0,
    input.estimatedRoundTripFeeBps + input.estimatedSlippageBps,
  );
  const breakEvenProbabilityPercent =
    ((averageLossBps + estimatedCostBps) /
      (averageWinBps + averageLossBps)) * 100;
  const grossEdgeBps =
    probability / 100 * averageWinBps -
    (1 - probability / 100) * averageLossBps;
  const netEdgeBps = grossEdgeBps - estimatedCostBps;
  const standardError = Math.sqrt(
    Math.max(0.0001, probability / 100 * (1 - probability / 100)) /
      Math.max(1, sampleCount + priorSamples),
  ) * 100;
  const confidenceIntervalPercent = Object.freeze([
    bounded(probability - 1.96 * standardError, 0, 100),
    bounded(probability + 1.96 * standardError, 0, 100),
  ] as const);
  const dataQuality = feature.markAgeMs > input.maxFactAgeMs
    ? "STALE"
    : !feature.factSnapshotId || !Number.isFinite(feature.observedAt)
      ? "INSUFFICIENT"
      : "READY";
  const eligibilityMode = "DIRECT_PROBABILITY" as const;
  const eligible = simpleLongOnly && dataQuality === "READY";
  return Object.freeze({
    modelVersion: "three-minute-probability-v2",
    symbol: feature.symbol.trim().toUpperCase(),
    factSnapshotId: feature.factSnapshotId,
    pLongPercent,
    pShortPercent,
    sampleCount,
    confidenceIntervalPercent,
    grossEdgeBps,
    estimatedCostBps,
    netEdgeBps,
    breakEvenProbabilityPercent,
    eligibilityMode,
    direction: eligible ? candidateDirection : "NO_TRADE",
    dataQuality,
  });
}

export function rankThreeMinuteProbabilityDecisions(input: {
  decisions: readonly ThreeMinuteProbabilityDecision[];
  maximum: number;
}) {
  const bestBySymbol = new Map<string, ThreeMinuteProbabilityDecision>();
  for (const decision of input.decisions) {
    if (decision.direction === "NO_TRADE") continue;
    const previous = bestBySymbol.get(decision.symbol);
    if (
      !previous ||
      selectedProbability(decision) > selectedProbability(previous) ||
      selectedProbability(decision) === selectedProbability(previous) &&
        decision.netEdgeBps > previous.netEdgeBps
    )
      bestBySymbol.set(decision.symbol, decision);
  }
  return [...bestBySymbol.values()]
    .sort((left, right) => {
      return selectedProbability(right) - selectedProbability(left) ||
        right.netEdgeBps - left.netEdgeBps ||
        left.symbol.localeCompare(right.symbol);
    })
    .slice(0, Math.max(0, Math.trunc(input.maximum)));
}

function selectedProbability(decision: ThreeMinuteProbabilityDecision) {
  return Math.max(decision.pLongPercent, decision.pShortPercent);
}

function bounded(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}
