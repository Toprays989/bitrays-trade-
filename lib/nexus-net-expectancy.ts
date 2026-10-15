import { strategyPayoffProfile } from "./strategy-payoff.ts";
import { STRATEGY_LEARNING_SETTLEMENT_GRACE_MS } from
  "./strategy-learning-backlog.ts";

export const NEXUS_NET_EXPECTANCY_VERSION =
  "nexus-net-expectancy-v3" as const;

export const NEXUS_COLD_START_SETTLEMENT_GRACE_MS =
  STRATEGY_LEARNING_SETTLEMENT_GRACE_MS;

export type NexusColdStartCycle = {
  traceId: string;
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED" | string;
  exactNetAvailable: boolean;
  eligibility: "ELIGIBLE" | "OBSERVATION_ONLY" | "INCOMPLETE" | string;
  updatedAt: Date | number;
};

export function summarizeNexusColdStartCycles(input: {
  cycles: NexusColdStartCycle[];
  requiredCompletedSamples: number;
  nowMs?: number;
  settlementGraceMs?: number;
}) {
  const requiredCompletedSamples = Math.max(
    1,
    Math.trunc(input.requiredCompletedSamples),
  );
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const settlementGraceMs = Math.max(
    0,
    Math.trunc(
      input.settlementGraceMs ?? NEXUS_COLD_START_SETTLEMENT_GRACE_MS,
    ),
  );
  const latestByTrace = new Map<string, NexusColdStartCycle>();
  for (const cycle of input.cycles) {
    const traceId = clean(cycle.traceId);
    if (!traceId) continue;
    const prior = latestByTrace.get(traceId);
    if (!prior || cycleUpdatedAt(cycle) >= cycleUpdatedAt(prior))
      latestByTrace.set(traceId, cycle);
  }

  let completedSampleCount = 0;
  let activeProbeCount = 0;
  let settlementPendingProbeCount = 0;
  let observationOnlyProbeCount = 0;
  let staleIncompleteProbeCount = 0;
  let otherTerminalProbeCount = 0;
  for (const cycle of latestByTrace.values()) {
    if (
      cycle.terminalStatus === "CLOSED" &&
      cycle.exactNetAvailable &&
      cycle.eligibility === "ELIGIBLE"
    ) {
      completedSampleCount += 1;
      continue;
    }
    if (cycle.terminalStatus === "OPEN") {
      activeProbeCount += 1;
      continue;
    }
    if (cycle.eligibility === "OBSERVATION_ONLY") {
      observationOnlyProbeCount += 1;
      continue;
    }
    const ageMs = Math.max(0, nowMs - cycleUpdatedAt(cycle));
    if (
      cycle.terminalStatus === "CLOSED" &&
      cycle.eligibility === "INCOMPLETE" &&
      ageMs <= settlementGraceMs
    ) {
      settlementPendingProbeCount += 1;
      continue;
    }
    if (
      cycle.terminalStatus === "CLOSED" &&
      cycle.eligibility === "INCOMPLETE"
    ) staleIncompleteProbeCount += 1;
    else otherTerminalProbeCount += 1;
  }
  const issuedProbeCount = Math.min(
    requiredCompletedSamples,
    completedSampleCount + activeProbeCount + settlementPendingProbeCount,
  );
  const replacementEligibleProbeCount =
    observationOnlyProbeCount + staleIncompleteProbeCount +
    otherTerminalProbeCount;
  return {
    requiredCompletedSamples,
    issuedProbeCount,
    completedSampleCount: Math.min(
      requiredCompletedSamples,
      completedSampleCount,
    ),
    activeProbeCount,
    settlementPendingProbeCount,
    observationOnlyProbeCount,
    staleIncompleteProbeCount,
    otherTerminalProbeCount,
    replacementEligibleProbeCount,
    settlementGraceMs,
  };
}

export type NexusProbabilityPolicy = {
  mode: "STANDARD" | "NET_EXPECTANCY";
  /** Retrospective benchmark only; it cannot authorize or reject a live order. */
  minimumNetExpectancyRoePercent: number;
  /** Transparent Bayesian prior used only while this parameterised brain builds its own samples. */
  priorWinProbabilityPercent: number;
  priorEquivalentSamples: number;
  minimumComparableSamples: number;
  maximumComparableSamples: number;
  maximumSampleAgeDays: number;
  estimatedRoundTripFeePercent: number;
  estimatedExitSlippageBps: number;
  /** The source brain supplies cold-start cases; it never shares live state or changes parameters. */
  sourceStrategyId?: number;
};

export const DEFAULT_NEXUS_PROBABILITY_POLICY: NexusProbabilityPolicy = {
  mode: "STANDARD",
  minimumNetExpectancyRoePercent: 0,
  priorWinProbabilityPercent: 55,
  priorEquivalentSamples: 4,
  minimumComparableSamples: 5,
  maximumComparableSamples: 120,
  maximumSampleAgeDays: 30,
  estimatedRoundTripFeePercent: 0.08,
  estimatedExitSlippageBps: 5,
};

export function nexusProbabilityExplorationAllowed(input: {
  policy?: Pick<NexusProbabilityPolicy, "mode"> | null;
  explorationAllowed: boolean;
}) {
  return input.explorationAllowed;
}

export function resolveNexusProbabilityEntryExecution(input: {
  policy?: Pick<NexusProbabilityPolicy, "mode"> | null;
  probabilityDecision?: {
    code: string;
  } | null;
  configuredOrderType: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
  configuredEntryDistanceExecutionMode?: "SHADOW" | "LIVE";
}) {
  return {
    probabilityApproved: false,
    orderAffecting: false as const,
    observationCode: input.probabilityDecision?.code ?? null,
    // Historical expectancy is retained for review, but current eye/brain
    // evidence and the published strategy config own execution and quantity.
    orderType: input.configuredOrderType,
    entryDistanceExecutionMode: input.configuredEntryDistanceExecutionMode,
    forceExchangeMinimumQuantity: false,
  };
}

export type NexusProbabilitySample = {
  exactNetPnlUsdt: number;
  exactNetRoePercent?: number | null;
  direction: "LONG" | "SHORT" | "UNKNOWN";
  decisionPath: string;
  marketContextKey: string;
  observedAt: number;
  sourceStrategyId: number;
};

export function normalizeNexusProbabilityPolicy(
  value: unknown,
): NexusProbabilityPolicy {
  const source = record(value);
  return {
    mode: source.mode === "NET_EXPECTANCY" ? "NET_EXPECTANCY" : "STANDARD",
    minimumNetExpectancyRoePercent: bounded(
      source.minimumNetExpectancyRoePercent,
      -100,
      100,
      DEFAULT_NEXUS_PROBABILITY_POLICY.minimumNetExpectancyRoePercent,
    ),
    priorWinProbabilityPercent: bounded(
      source.priorWinProbabilityPercent,
      1,
      99,
      DEFAULT_NEXUS_PROBABILITY_POLICY.priorWinProbabilityPercent,
    ),
    priorEquivalentSamples: integerBounded(
      source.priorEquivalentSamples,
      1,
      100,
      DEFAULT_NEXUS_PROBABILITY_POLICY.priorEquivalentSamples,
    ),
    minimumComparableSamples: integerBounded(
      source.minimumComparableSamples,
      1,
      100,
      DEFAULT_NEXUS_PROBABILITY_POLICY.minimumComparableSamples,
    ),
    maximumComparableSamples: integerBounded(
      source.maximumComparableSamples,
      10,
      500,
      DEFAULT_NEXUS_PROBABILITY_POLICY.maximumComparableSamples,
    ),
    maximumSampleAgeDays: integerBounded(
      source.maximumSampleAgeDays,
      1,
      365,
      DEFAULT_NEXUS_PROBABILITY_POLICY.maximumSampleAgeDays,
    ),
    estimatedRoundTripFeePercent: bounded(
      source.estimatedRoundTripFeePercent,
      0,
      2,
      DEFAULT_NEXUS_PROBABILITY_POLICY.estimatedRoundTripFeePercent,
    ),
    estimatedExitSlippageBps: bounded(
      source.estimatedExitSlippageBps,
      0,
      100,
      DEFAULT_NEXUS_PROBABILITY_POLICY.estimatedExitSlippageBps,
    ),
    ...(positiveInteger(source.sourceStrategyId) !== null
      ? { sourceStrategyId: positiveInteger(source.sourceStrategyId)! }
      : {}),
  };
}

export function validateNexusProbabilityPolicy(value: unknown) {
  const source = record(value);
  if (!Object.keys(source).length) return null;
  if (!['STANDARD', 'NET_EXPECTANCY'].includes(String(source.mode)))
    return "概率决策模式无效";
  const normalized = normalizeNexusProbabilityPolicy(source);
  if (
    !finiteInRange(source.minimumNetExpectancyRoePercent, -100, 100) ||
    !finiteInRange(source.priorWinProbabilityPercent, 1, 99) ||
    !integerInRange(source.priorEquivalentSamples, 1, 100) ||
    !integerInRange(source.minimumComparableSamples, 1, 100) ||
    !integerInRange(source.maximumComparableSamples, 10, 500) ||
    !integerInRange(source.maximumSampleAgeDays, 1, 365) ||
    !finiteInRange(source.estimatedRoundTripFeePercent, 0, 2) ||
    !finiteInRange(source.estimatedExitSlippageBps, 0, 100)
  ) return "概率策略参数超出有效范围";
  if (
    normalized.maximumComparableSamples < normalized.minimumComparableSamples
  ) return "概率策略最大样本数不能小于最低可比样本数";
  if (
    source.sourceStrategyId !== undefined &&
    positiveInteger(source.sourceStrategyId) === null
  ) return "概率策略来源大脑编号无效";
  return null;
}

/**
 * Eye facts do not receive artificial scores. They select the comparable
 * historical cohort; the probability itself comes only from exact-net cycles
 * plus the explicit, persisted cold-start prior. The result is retrospective
 * evidence and never participates in current entry authorization or sizing.
 */
export function selectNexusProbabilityCohort(input: {
  samples: NexusProbabilitySample[];
  direction: "LONG" | "SHORT";
  selectedPath?: string | null;
  marketContextKey?: string | null;
  minimumComparableSamples: number;
  maximumComparableSamples: number;
}) {
  const directionRows = input.samples.filter(
    (sample) => sample.direction === input.direction,
  );
  const path = clean(input.selectedPath);
  const context = clean(input.marketContextKey);
  const samePath = path
    ? directionRows.filter((sample) => sample.decisionPath === path)
    : [];
  const samePathAndContext = path && context
    ? samePath.filter((sample) => sample.marketContextKey === context)
    : [];
  const minimum = Math.max(1, Math.trunc(input.minimumComparableSamples));
  const selected = samePathAndContext.length >= minimum
    ? samePathAndContext
    : samePath.length >= minimum
      ? samePath
      : directionRows;
  const cohort = selected
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, Math.max(1, Math.trunc(input.maximumComparableSamples)));
  return {
    cohort,
    scope: samePathAndContext.length >= minimum
      ? "SAME_DIRECTION_PATH_CONTEXT" as const
      : samePath.length >= minimum
        ? "SAME_DIRECTION_PATH" as const
        : directionRows.length
          ? "SAME_DIRECTION" as const
          : "PRIOR_ONLY" as const,
  };
}

export function evaluateNexusNetExpectancy(input: {
  policy: NexusProbabilityPolicy;
  direction: "LONG" | "SHORT";
  eyeVerdict: string;
  eyeDataIntegrity?: string | null;
  selectedPath?: string | null;
  marketContextKey?: string | null;
  samples: NexusProbabilitySample[];
  stopLossRoePercent: number;
  takeProfitSteps: Array<{ profitPercent: number; closePercent: number }>;
  leverage: number;
  currentOrderNotionalUsdt?: number | null;
  liveSpreadBps?: number | null;
  /** One conservative adverse funding settlement, in price percent. */
  estimatedFundingCostPercent?: number | null;
  coldStart?: {
    requiredCompletedSamples: number;
    issuedProbeCount: number;
    completedSampleCount: number;
    activeProbeCount?: number;
    settlementPendingProbeCount?: number;
    observationOnlyProbeCount?: number;
    staleIncompleteProbeCount?: number;
    replacementEligibleProbeCount?: number;
  } | null;
}) {
  const policy = normalizeNexusProbabilityPolicy(input.policy);
  const base = {
    version: NEXUS_NET_EXPECTANCY_VERSION,
    mode: policy.mode,
    direction: input.direction,
    eyeVerdict: clean(input.eyeVerdict) || "UNKNOWN",
    eyeDataIntegrity: clean(input.eyeDataIntegrity) || "UNAVAILABLE",
    selectedPath: clean(input.selectedPath) || null,
    marketContextKey: clean(input.marketContextKey) || null,
    orderAffecting: false as const,
    observationOnly: true as const,
  };
  if (policy.mode !== "NET_EXPECTANCY")
    return {
      ...base,
      code: "NET_EXPECTANCY_NOT_ENABLED" as const,
      summary: "当前策略沿用标准大脑流程，未启用净数学期望门禁。",
    };
  if (input.eyeVerdict !== "CONFIRMED")
    return {
      ...base,
      code: "NET_EXPECTANCY_EYE_NOT_CONFIRMED" as const,
      summary: "概率策略只接受眼睛已确认的入场证据，探索探针不能绕过。",
    };
  if (input.eyeDataIntegrity === "INCOMPLETE")
    return {
      ...base,
      code: "NET_EXPECTANCY_EYE_DATA_INCOMPLETE" as const,
      summary: "眼睛同批决策事实不完整，净数学期望不具备可计算基础。",
    };
  const payoff = strategyPayoffProfile({
    stopLossRoePercent: input.stopLossRoePercent,
    takeProfitSteps: input.takeProfitSteps,
    leverage: input.leverage,
    estimatedRoundTripFeePercent: 0,
  });
  if (!payoff?.completeExitConfigured)
    return {
      ...base,
      code: "NET_EXPECTANCY_PAYOFF_INCOMPLETE" as const,
      summary: "止盈数量未覆盖全部仓位，无法形成完整净期望。",
    };
  const coldStart = input.coldStart;
  if (coldStart) {
    const requiredCompletedSamples = Math.max(
      1,
      Math.trunc(coldStart.requiredCompletedSamples),
    );
    const issuedProbeCount = Math.max(
      0,
      Math.trunc(coldStart.issuedProbeCount),
    );
    const completedSampleCount = Math.max(
      0,
      Math.trunc(coldStart.completedSampleCount),
    );
    const settlementPendingProbeCount = Math.max(
      0,
      Math.trunc(coldStart.settlementPendingProbeCount ?? 0),
    );
    const replacementEligibleProbeCount = Math.max(
      0,
      Math.trunc(coldStart.replacementEligibleProbeCount ?? 0),
    );
    if (completedSampleCount < requiredCompletedSamples) {
      const remainingProbeSlots = Math.max(
        0,
        requiredCompletedSamples - issuedProbeCount,
      );
      if (remainingProbeSlots > 0)
        return {
          ...base,
          code: "NET_EXPECTANCY_COLD_START_PROBE" as const,
          requiredCompletedSamples,
          issuedProbeCount,
          completedSampleCount,
          remainingProbeSlots,
          settlementPendingProbeCount,
          replacementEligibleProbeCount,
          summary:
            `概率策略${replacementEligibleProbeCount > 0 ? "冷启动补位" : "冷启动"}探针 ${issuedProbeCount + 1}/${requiredCompletedSamples}：` +
            "眼睛证据已经确认，本次仅按交易所最小有效量实盘；不放宽方向、结构、报价或持仓规则。",
        };
      return {
        ...base,
        code: "NET_EXPECTANCY_COLD_START_WAIT_SETTLEMENT" as const,
        requiredCompletedSamples,
        issuedProbeCount,
        completedSampleCount,
        remainingProbeSlots: 0,
        settlementPendingProbeCount,
        replacementEligibleProbeCount,
        summary:
          `概率策略已发出 ${issuedProbeCount}/${requiredCompletedSamples} 个冷启动探针，` +
          `其中 ${completedSampleCount} 个形成合格精确净结算；` +
          `仍有 ${settlementPendingProbeCount} 个样本处于结算宽限期，完成或超时释放后再判断新订单。`,
      };
    }
  }
  const selection = selectNexusProbabilityCohort({
    samples: input.samples,
    direction: input.direction,
    selectedPath: input.selectedPath,
    marketContextKey: input.marketContextKey,
    minimumComparableSamples: policy.minimumComparableSamples,
    maximumComparableSamples: policy.maximumComparableSamples,
  });
  const decisive = selection.cohort.filter(
    (sample) => Math.abs(sample.exactNetPnlUsdt) > 1e-8,
  );
  const comparable = decisive.length >= policy.minimumComparableSamples
    ? decisive
    : [];
  const wins = comparable.filter((sample) => sample.exactNetPnlUsdt > 0).length;
  const losses = comparable.length - wins;
  const priorProbability = policy.priorWinProbabilityPercent / 100;
  const posteriorWinProbability =
    (wins + priorProbability * policy.priorEquivalentSamples) /
    (comparable.length + policy.priorEquivalentSamples);
  const liveSpreadBps = Math.max(0, finite(input.liveSpreadBps, 0));
  const currentMarginUsdt = currentOrderMarginUsdt({
    orderNotionalUsdt: input.currentOrderNotionalUsdt,
    leverage: input.leverage,
  });
  const realizedNetRoeSamples = comparable.flatMap((sample) => {
    const exact = finiteOrNull(sample.exactNetRoePercent);
    if (exact !== null) return [exact];
    if (currentMarginUsdt === null) return [];
    return [sample.exactNetPnlUsdt / currentMarginUsdt * 100];
  });
  const realizedPayoffAvailable =
    realizedNetRoeSamples.length >= policy.minimumComparableSamples;
  const realizedWins = realizedNetRoeSamples.filter((value) => value > 0);
  const realizedLosses = realizedNetRoeSamples.filter((value) => value < 0);
  const averageRealizedWinRoePercent = average(realizedWins);
  const averageRealizedLossRoePercent = average(realizedLosses);
  const feeCostRoePercent =
    policy.estimatedRoundTripFeePercent * input.leverage;
  const slippageCostRoePercent =
    ((liveSpreadBps + policy.estimatedExitSlippageBps) / 100) * input.leverage;
  const fundingCostRoePercent =
    Math.max(0, finite(input.estimatedFundingCostPercent, 0)) *
    input.leverage;
  const expectedProfitRoePercent = realizedPayoffAvailable
    ? averageRealizedWinRoePercent ?? 0
    : payoff.grossRewardRoePercent;
  const expectedLossRoePercent = realizedPayoffAvailable
    ? Math.abs(averageRealizedLossRoePercent ?? 0)
    : input.stopLossRoePercent;
  const grossExpectedProfitRoePercent =
    posteriorWinProbability * expectedProfitRoePercent;
  const grossExpectedLossRoePercent =
    (1 - posteriorWinProbability) * expectedLossRoePercent;
  const netExpectancyRoePercent = realizedPayoffAvailable
    ? grossExpectedProfitRoePercent - grossExpectedLossRoePercent
    : grossExpectedProfitRoePercent - grossExpectedLossRoePercent -
      feeCostRoePercent - slippageCostRoePercent -
      fundingCostRoePercent;
  const positive =
    netExpectancyRoePercent > policy.minimumNetExpectancyRoePercent;
  return {
    ...base,
    code: positive
      ? "NET_EXPECTANCY_POSITIVE" as const
      : "NET_EXPECTANCY_NON_POSITIVE" as const,
    sampleScope: comparable.length ? selection.scope : "PRIOR_ONLY" as const,
    availableComparableSampleCount: decisive.length,
    sampleCount: comparable.length,
    wins,
    losses,
    empiricalWinProbabilityPercent: comparable.length
      ? wins / comparable.length * 100
      : null,
    priorWinProbabilityPercent: policy.priorWinProbabilityPercent,
    priorEquivalentSamples: policy.priorEquivalentSamples,
    posteriorWinProbabilityPercent: posteriorWinProbability * 100,
    payoffSource: realizedPayoffAvailable
      ? "REALIZED_EXACT_NET" as const
      : "CONFIGURED_PAYOFF" as const,
    fundingCostRoePercent,
    realizedPayoffSampleCount: realizedNetRoeSamples.length,
    realizedPayoffExactRoeSampleCount: comparable.filter((sample) =>
      finiteOrNull(sample.exactNetRoePercent) !== null
    ).length,
    realizedPayoffEstimatedRoeSampleCount: realizedNetRoeSamples.length -
      comparable.filter((sample) =>
        finiteOrNull(sample.exactNetRoePercent) !== null
      ).length,
    currentMarginUsdt,
    averageRealizedWinRoePercent,
    averageRealizedLossRoePercent,
    expectedProfitRoePercent,
    expectedLossRoePercent,
    grossExpectedProfitRoePercent,
    grossExpectedLossRoePercent,
    feeCostRoePercent: realizedPayoffAvailable ? 0 : feeCostRoePercent,
    historicalExactNetIncludesCosts: realizedPayoffAvailable,
    liveSpreadBps,
    estimatedExitSlippageBps: policy.estimatedExitSlippageBps,
    slippageCostRoePercent:
      realizedPayoffAvailable ? 0 : slippageCostRoePercent,
    netExpectancyRoePercent,
    minimumNetExpectancyRoePercent:
      policy.minimumNetExpectancyRoePercent,
    summary: positive
      ? `${realizedPayoffAvailable ? "费用后真实赔率" : "配置赔率"}净期望 +${netExpectancyRoePercent.toFixed(2)}% ROE，高于门槛 ${policy.minimumNetExpectancyRoePercent.toFixed(2)}%；有效可比样本 ${comparable.length} 个，后验胜率 ${(posteriorWinProbability * 100).toFixed(1)}%。`
      : `${realizedPayoffAvailable ? "费用后真实赔率" : "配置赔率"}净期望 ${netExpectancyRoePercent.toFixed(2)}% ROE，不高于参考线 ${policy.minimumNetExpectancyRoePercent.toFixed(2)}%；仅记录复盘，不影响当前下单。`,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function cycleUpdatedAt(cycle: NexusColdStartCycle) {
  const value = cycle.updatedAt instanceof Date
    ? cycle.updatedAt.getTime()
    : Number(cycle.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function finite(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function currentOrderMarginUsdt(input: {
  orderNotionalUsdt?: number | null;
  leverage: number;
}) {
  const notional = finiteOrNull(input.orderNotionalUsdt);
  const leverage = finiteOrNull(input.leverage);
  return notional !== null && notional > 0 && leverage !== null && leverage > 0
    ? notional / leverage
    : null;
}

function bounded(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Math.max(minimum, Math.min(maximum, finite(value, fallback)));
}

function integerBounded(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return Math.trunc(bounded(value, minimum, maximum, fallback));
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function finiteInRange(value: unknown, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum;
}

function integerInRange(value: unknown, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}
