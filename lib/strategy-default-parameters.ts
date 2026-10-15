import type { StrategyTriggerKind } from "./strategy-trigger-catalog.ts";

export const STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION =
  "nexus-strategy-defaults-2026-08-31-v5";

export type StrategyParameterProfileStamp = Readonly<{
  version: typeof STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION;
  triggerKind: StrategyTriggerKind;
}>;

type TakeProfitStep = Readonly<{
  profitPercent: number;
  closePercent: number;
}>;

export type StrategyDefaultParameterProfile = Readonly<{
  probabilityPolicy: Readonly<{
    mode: "STANDARD" | "NET_EXPECTANCY";
    minimumNetExpectancyRoePercent: number;
    priorWinProbabilityPercent: number;
    priorEquivalentSamples: number;
    minimumComparableSamples: number;
    maximumComparableSamples: number;
    maximumSampleAgeDays: number;
    estimatedRoundTripFeePercent: number;
    estimatedExitSlippageBps: number;
  }>;
  liquidationFactors: Readonly<{
    mode: "SHADOW";
    automaticModeSwitch: true;
    learningTargetEpisodes: 30;
    learningMinimumExactCycles: 8;
    minimumEvents: number;
    minimumObservationSeconds: 3;
    minimumAmountUsdt: number;
    minimumVelocityUsdtPerSecond: 100;
    minimumLiquidationToOiPercent: 0;
    minimumDirectionalPriceImpactPercent: 0.08;
    minimumAccelerationRatio: 1.3;
    maximumDivergenceImpactRatio: 0.5;
    minimumVolumeRatio: number;
    requiredScore: 65;
  }>;
  trigger: Readonly<Record<string, number>>;
  marketPosition: Readonly<{ maxPosition72hPercent: number }>;
  trend: Readonly<{
    volumeRatio3m: number;
    atrPeriod5m: number;
    maxEntryDistanceAtr: number;
    maxPriorRangeAtr: number;
    trend1hBreakHandling: "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
    structure30mBreakHandling: "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
  }>;
  shortTrend: Readonly<{
    minimumLongLiquidationSharePercent: number;
    minimumMarket60mDropPercent: number;
  }>;
  execution: Readonly<{
    directionMode: "FOLLOW_BRAIN";
    orderType: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
    entryDistanceExecutionMode: "LIVE";
    limitOffsetPercent: number;
    adaptiveMarketMaxDistanceAtr: number;
    orderTtlSeconds: number;
    liquidationLimitOrderTtlMs?: number;
    allowSecondOrder: boolean;
    sameLegWorkingOrderPolicy: "BLOCK";
    existingPositionPolicy: "BLOCK";
    minimumOrderFloorMode: "REJECT";
    explorationOrderTarget: 0;
    leverage: number;
    quantitySizingMode: "EVIDENCE_1_TO_2";
    minimumOrderQuantityMultiplier: 1;
    minimumPositionNotionalUsdt: number;
    equityAllocationPercent: number;
    targetOrderNotionalUsdt: number;
    maxOrderNotionalUsdt: number;
    maxDailyNotionalUsdt: number;
  }>;
  risk: Readonly<{
    maxMarginUsagePercent: number;
    dailyLossLimitUsdt: number;
    stopLossPercent: number;
    minimumObservationMinutes: number;
    liquidationGuardBufferPercent: number;
    takeProfitSteps: readonly TakeProfitStep[];
    atrStopBuffer: number;
    dynamicTrailingEnabled: boolean;
    trailingActivationPercent: number;
    trailingDrawdownPercent: number;
    positionManagement: Readonly<{
      profitGivebackRoePoints: number;
      bottomRecoveryRoePoints: number;
      tailWaveExitEnabled: boolean;
      tailWaveObservationMinutes: 15;
      tailWaveMaximumPositionPercent: 35;
      tailWavePeakGivebackAtr: 0.5;
      addOnEnabled: false;
      profitScaleInEnabled: false;
      addOnNotionalUsdt: 5.1;
      maxAddOnsPerPosition: 1;
      minMinutesBetweenAddOns: 30;
      maxAddOnLossRoePercent: number;
      contrarianFallbackEnabled: false;
      contrarianProbeNotionalUsdt: 5.1;
      contrarianProfitRoeBeforeHedge: 3;
      evidenceRisk: Readonly<{
        enabled: true;
        warningMinute: 3;
        reductionMinute: 5;
        exitMinute: 15;
        reductionPercent: 30;
        minimumDeteriorationRoePoints: 0.5;
        postReductionExitDelaySeconds: 15;
        exitRemainingOnPersistentInvalidation: false;
      }>;
    }>;
  }>;
}>;

type ProfileInput = Readonly<{
  leverage: number;
  orderType: "LIMIT_OFFSET" | "ADAPTIVE";
  stopLossPercent: number;
  takeProfitSteps: readonly TakeProfitStep[];
  minimumObservationMinutes: number;
  dynamicTrailingEnabled: boolean;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
  volumeRatio3m: number;
  maxEntryDistanceAtr: number;
  maxPosition72hPercent: number;
  minimumLongLiquidationSharePercent: number;
  minimumMarket60mDropPercent: number;
  probabilityMode?: "STANDARD" | "NET_EXPECTANCY";
  maxMarginUsagePercent?: number;
  dailyLossLimitUsdt?: number;
  maxDailyNotionalUsdt?: number;
  limitOffsetPercent?: number;
  trigger?: Readonly<Record<string, number>>;
  tailWaveExitEnabled?: boolean;
  liquidationLimitOrderTtlMs?: number;
  orderTtlSeconds?: number;
  minimumPositionNotionalUsdt?: number;
  equityAllocationPercent?: number;
  maxOrderMarginUsdt?: number;
  allowSecondOrder?: boolean;
}>;

function createProfile(input: ProfileInput): StrategyDefaultParameterProfile {
  return Object.freeze({
    probabilityPolicy: Object.freeze({
      mode: input.probabilityMode ?? "NET_EXPECTANCY",
      minimumNetExpectancyRoePercent: 0.25,
      priorWinProbabilityPercent: 50,
      priorEquivalentSamples: 6,
      minimumComparableSamples: 8,
      maximumComparableSamples: 120,
      maximumSampleAgeDays: 30,
      estimatedRoundTripFeePercent: 0.08,
      estimatedExitSlippageBps: 5,
    }),
    liquidationFactors: Object.freeze({
      mode: "SHADOW",
      automaticModeSwitch: true,
      learningTargetEpisodes: 30,
      learningMinimumExactCycles: 8,
      minimumEvents: input.trigger?.minClusterEvents ?? 3,
      minimumObservationSeconds: 3,
      minimumAmountUsdt:
        input.trigger?.minLiquidationNotionalUsdt ?? 6_000,
      minimumVelocityUsdtPerSecond: 100,
      minimumLiquidationToOiPercent: 0,
      minimumDirectionalPriceImpactPercent: 0.08,
      minimumAccelerationRatio: 1.3,
      maximumDivergenceImpactRatio: 0.5,
      minimumVolumeRatio: input.volumeRatio3m,
      requiredScore: 65,
    }),
    trigger: Object.freeze({
      analysisValiditySeconds: 600,
      cooldownMinutes: 15,
      maxConcurrentAnalyses: 2,
      ...input.trigger,
    }),
    marketPosition: Object.freeze({
      maxPosition72hPercent: input.maxPosition72hPercent,
    }),
    trend: Object.freeze({
      volumeRatio3m: input.volumeRatio3m,
      atrPeriod5m: 14,
      maxEntryDistanceAtr: input.maxEntryDistanceAtr,
      maxPriorRangeAtr: 3,
      trend1hBreakHandling: "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM",
      structure30mBreakHandling: "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM",
    }),
    shortTrend: Object.freeze({
      minimumLongLiquidationSharePercent:
        input.minimumLongLiquidationSharePercent,
      minimumMarket60mDropPercent: input.minimumMarket60mDropPercent,
    }),
    execution: Object.freeze({
      directionMode: "FOLLOW_BRAIN",
      orderType: input.orderType,
      entryDistanceExecutionMode: "LIVE",
      limitOffsetPercent: input.limitOffsetPercent ?? 0.03,
      adaptiveMarketMaxDistanceAtr: Math.max(
        0.05,
        Math.min(0.2, input.maxEntryDistanceAtr),
      ),
      orderTtlSeconds: input.orderTtlSeconds ?? 180,
      ...(input.liquidationLimitOrderTtlMs
        ? { liquidationLimitOrderTtlMs: input.liquidationLimitOrderTtlMs }
        : {}),
      allowSecondOrder: input.allowSecondOrder === true,
      sameLegWorkingOrderPolicy: "BLOCK",
      existingPositionPolicy: "BLOCK",
      minimumOrderFloorMode: "REJECT",
      explorationOrderTarget: 0,
      leverage: input.leverage,
      quantitySizingMode: "EVIDENCE_1_TO_2",
      minimumOrderQuantityMultiplier: 1,
      minimumPositionNotionalUsdt:
        input.minimumPositionNotionalUsdt ?? 20,
      equityAllocationPercent: input.equityAllocationPercent ?? 12,
      targetOrderNotionalUsdt: 5.1,
      maxOrderNotionalUsdt: input.maxOrderMarginUsdt ?? 10,
      maxDailyNotionalUsdt: input.maxDailyNotionalUsdt ?? 30,
    }),
    risk: Object.freeze({
      maxMarginUsagePercent: input.maxMarginUsagePercent ?? 30,
      dailyLossLimitUsdt: input.dailyLossLimitUsdt ?? 3,
      stopLossPercent: input.stopLossPercent,
      minimumObservationMinutes: input.minimumObservationMinutes,
      liquidationGuardBufferPercent: 5,
      takeProfitSteps: Object.freeze(
        input.takeProfitSteps.map((step) => Object.freeze({ ...step })),
      ),
      atrStopBuffer: 1,
      dynamicTrailingEnabled: input.dynamicTrailingEnabled,
      trailingActivationPercent: input.trailingActivationPercent,
      trailingDrawdownPercent: input.trailingDrawdownPercent,
      positionManagement: Object.freeze({
        profitGivebackRoePoints: input.trailingDrawdownPercent,
        bottomRecoveryRoePoints: 2,
        tailWaveExitEnabled: input.tailWaveExitEnabled ?? true,
        tailWaveObservationMinutes: 15,
        tailWaveMaximumPositionPercent: 35,
        tailWavePeakGivebackAtr: 0.5,
        addOnEnabled: false,
        profitScaleInEnabled: false,
        addOnNotionalUsdt: 5.1,
        maxAddOnsPerPosition: 1,
        minMinutesBetweenAddOns: 30,
        maxAddOnLossRoePercent: input.stopLossPercent,
        contrarianFallbackEnabled: false,
        contrarianProbeNotionalUsdt: 5.1,
        contrarianProfitRoeBeforeHedge: 3,
        evidenceRisk: Object.freeze({
          enabled: true,
          warningMinute: 3,
          reductionMinute: 5,
          exitMinute: 15,
          reductionPercent: 30,
          minimumDeteriorationRoePoints: 0.5,
          postReductionExitDelaySeconds: 15,
          exitRemainingOnPersistentInvalidation: false,
        }),
      }),
    }),
  });
}

const PROFILES: Readonly<Record<StrategyTriggerKind, StrategyDefaultParameterProfile>> =
  Object.freeze({
    LIQUIDATION_WINDOW: createProfile({
      leverage: 5,
      orderType: "ADAPTIVE",
      liquidationLimitOrderTtlMs: 1_500,
      allowSecondOrder: true,
      maxDailyNotionalUsdt: 60,
      stopLossPercent: 7,
      takeProfitSteps: [
        { profitPercent: 6, closePercent: 40 },
        { profitPercent: 12, closePercent: 30 },
        { profitPercent: 20, closePercent: 30 },
      ],
      minimumObservationMinutes: 30,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      volumeRatio3m: 1.3,
      maxEntryDistanceAtr: 0.6,
      maxPosition72hPercent: 35,
      minimumLongLiquidationSharePercent: 70,
      minimumMarket60mDropPercent: 0.3,
      trigger: {
        minLiquidationNotionalUsdt: 15_000,
        minSingleLiquidationNotionalUsdt: 8_000,
        maxSignalDelayMs: 1_500,
        minClusterEvents: 3,
        maxClusterSpanSeconds: 120,
        maxClusterEventGapSeconds: 30,
        maxConcurrentAnalyses: 4,
      },
    }),
    PRICE_VOLUME_STRUCTURE: createProfile({
      leverage: 3,
      orderType: "ADAPTIVE",
      stopLossPercent: 6,
      takeProfitSteps: [
        { profitPercent: 5, closePercent: 40 },
        { profitPercent: 10, closePercent: 30 },
        { profitPercent: 16, closePercent: 30 },
      ],
      minimumObservationMinutes: 30,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 2.5,
      volumeRatio3m: 1.4,
      maxEntryDistanceAtr: 0.5,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 70,
      minimumMarket60mDropPercent: 0.3,
    }),
    RELATIVE_STRENGTH_CONTINUATION: createProfile({
      leverage: 3,
      orderType: "ADAPTIVE",
      stopLossPercent: 6,
      takeProfitSteps: [
        { profitPercent: 5, closePercent: 40 },
        { profitPercent: 10, closePercent: 30 },
        { profitPercent: 16, closePercent: 30 },
      ],
      minimumObservationMinutes: 30,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 2.5,
      volumeRatio3m: 1.4,
      maxEntryDistanceAtr: 0.35,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 65,
      minimumMarket60mDropPercent: 0.2,
      trigger: { cooldownMinutes: 90 },
    }),
    LIQUIDATION_OR_PRICE_MOMENTUM_WAKE: createProfile({
      leverage: 5,
      orderType: "ADAPTIVE",
      stopLossPercent: 7,
      takeProfitSteps: [
        { profitPercent: 6, closePercent: 40 },
        { profitPercent: 12, closePercent: 30 },
        { profitPercent: 20, closePercent: 30 },
      ],
      minimumObservationMinutes: 30,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      volumeRatio3m: 1.4,
      maxEntryDistanceAtr: 0.35,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 70,
      minimumMarket60mDropPercent: 0.3,
      trigger: { cooldownMinutes: 20, maxConcurrentAnalyses: 2 },
    }),
    HIGH_POSITION_PRICE_VOLUME_STRUCTURE: createProfile({
      leverage: 3,
      orderType: "ADAPTIVE",
      stopLossPercent: 6,
      takeProfitSteps: [
        { profitPercent: 5, closePercent: 40 },
        { profitPercent: 10, closePercent: 30 },
        { profitPercent: 16, closePercent: 30 },
      ],
      minimumObservationMinutes: 15,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 2.5,
      volumeRatio3m: 1.3,
      maxEntryDistanceAtr: 0.4,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 75,
      minimumMarket60mDropPercent: 0.4,
      trigger: { cooldownMinutes: 30 },
    }),
    LOW_POSITION_WINDOW: createProfile({
      leverage: 3,
      orderType: "ADAPTIVE",
      stopLossPercent: 7,
      takeProfitSteps: [
        { profitPercent: 5, closePercent: 35 },
        { profitPercent: 10, closePercent: 35 },
        { profitPercent: 18, closePercent: 30 },
      ],
      minimumObservationMinutes: 60,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      volumeRatio3m: 1.2,
      maxEntryDistanceAtr: 0.5,
      maxPosition72hPercent: 25,
      minimumLongLiquidationSharePercent: 70,
      minimumMarket60mDropPercent: 0.3,
      trigger: { analysisValiditySeconds: 900, cooldownMinutes: 30 },
    }),
    THREE_MINUTE_PROBABILITY: createProfile({
      leverage: 2,
      orderType: "ADAPTIVE",
      equityAllocationPercent: 20,
      stopLossPercent: 4,
      takeProfitSteps: [
        { profitPercent: 3, closePercent: 40 },
        { profitPercent: 6, closePercent: 30 },
        { profitPercent: 10, closePercent: 30 },
      ],
      minimumObservationMinutes: 0,
      dynamicTrailingEnabled: false,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      volumeRatio3m: 1.1,
      maxEntryDistanceAtr: 0.4,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 65,
      minimumMarket60mDropPercent: 0.2,
      probabilityMode: "STANDARD",
      maxMarginUsagePercent: 15,
      dailyLossLimitUsdt: 1.5,
      maxDailyNotionalUsdt: 10,
      tailWaveExitEnabled: false,
      trigger: {
        analysisValiditySeconds: 300,
        cooldownMinutes: 3,
        maxConcurrentAnalyses: 1,
      },
    }),
    GRID_PRICE_LEVEL: createProfile({
      leverage: 2,
      orderType: "LIMIT_OFFSET",
      equityAllocationPercent: 20,
      stopLossPercent: 4,
      takeProfitSteps: [
        { profitPercent: 3, closePercent: 40 },
        { profitPercent: 6, closePercent: 30 },
        { profitPercent: 10, closePercent: 30 },
      ],
      minimumObservationMinutes: 0,
      dynamicTrailingEnabled: false,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      volumeRatio3m: 1.1,
      maxEntryDistanceAtr: 0.3,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 65,
      minimumMarket60mDropPercent: 0.2,
      maxMarginUsagePercent: 20,
      dailyLossLimitUsdt: 2,
      maxDailyNotionalUsdt: 20,
      limitOffsetPercent: 0,
      tailWaveExitEnabled: false,
      trigger: {
        analysisValiditySeconds: 300,
        cooldownMinutes: 1,
        maxConcurrentAnalyses: 1,
      },
    }),
    SCHEDULED_SCAN: createProfile({
      leverage: 3,
      orderType: "ADAPTIVE",
      stopLossPercent: 7,
      takeProfitSteps: [
        { profitPercent: 5, closePercent: 35 },
        { profitPercent: 10, closePercent: 35 },
        { profitPercent: 18, closePercent: 30 },
      ],
      minimumObservationMinutes: 30,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      volumeRatio3m: 1.3,
      maxEntryDistanceAtr: 0.5,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 70,
      minimumMarket60mDropPercent: 0.3,
      trigger: { analysisValiditySeconds: 900 },
    }),
    BREAKOUT_RETEST: createProfile({
      leverage: 5,
      orderType: "ADAPTIVE",
      orderTtlSeconds: 60,
      allowSecondOrder: true,
      maxDailyNotionalUsdt: 60,
      stopLossPercent: 7,
      takeProfitSteps: [
        { profitPercent: 6, closePercent: 40 },
        { profitPercent: 12, closePercent: 30 },
        { profitPercent: 20, closePercent: 30 },
      ],
      minimumObservationMinutes: 15,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      // The trigger has already proved 5m breakout volume >= 1.5x.  The
      // execution window asks the latest closed 1m candle to retain at least
      // normal participation instead of demanding a second 1.5x spike after
      // the retest.
      volumeRatio3m: 1,
      maxEntryDistanceAtr: 0.5,
      maxPosition72hPercent: 40,
      minimumLongLiquidationSharePercent: 70,
      minimumMarket60mDropPercent: 0.3,
    }),
  });

export function strategyDefaultParameterProfile(
  kind: StrategyTriggerKind,
): StrategyDefaultParameterProfile {
  return PROFILES[kind];
}

export function stampStrategyParameterProfile<T extends object>(
  value: T,
  kind: StrategyTriggerKind,
): T {
  return {
    ...value,
    parameterProfile: {
      version: STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION,
      triggerKind: kind,
    },
  } as T;
}

export function normalizeStrategyTriggerScopedExecution(
  value: unknown,
  kind: StrategyTriggerKind,
): Record<string, unknown> {
  const execution = { ...record(value) };
  delete execution.maxConcurrentPositions;
  const {
    liquidationLimitOrderTtlMs,
    ...sharedExecution
  } = execution;
  if (
    kind === "LIQUIDATION_WINDOW" &&
    execution.orderType !== "MARKET" &&
    liquidationLimitOrderTtlMs !== undefined
  ) {
    return {
      ...sharedExecution,
      liquidationLimitOrderTtlMs,
    };
  }
  return sharedExecution;
}

export function applyStrategyDefaultParameters<T extends object>(
  value: T,
  kind: StrategyTriggerKind,
): T {
  const profile = strategyDefaultParameterProfile(kind);
  const source = value as Record<string, unknown>;
  const risk = record(source.risk);
  const positionManagement = record(risk.positionManagement);
  const takeProfitSteps = profile.risk.takeProfitSteps.map((step) => ({
    ...step,
  }));
  const execution = normalizeStrategyTriggerScopedExecution(
    {
      ...record(source.execution),
      ...profile.execution,
    },
    kind,
  );
  return {
    ...source,
    parameterProfile: {
      version: STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION,
      triggerKind: kind,
    },
    leverage: profile.execution.leverage,
    stopLossPercent: profile.risk.stopLossPercent,
    takeProfitPercent: takeProfitSteps.at(-1)?.profitPercent ?? 0,
    probabilityPolicy: {
      ...record(source.probabilityPolicy),
      ...profile.probabilityPolicy,
    },
    liquidationFactors: {
      ...record(source.liquidationFactors),
      ...profile.liquidationFactors,
    },
    trigger: {
      ...record(source.trigger),
      ...profile.trigger,
    },
    marketPosition: {
      ...record(source.marketPosition),
      ...profile.marketPosition,
    },
    trend: {
      ...record(source.trend),
      ...profile.trend,
    },
    shortTrend: {
      ...record(source.shortTrend),
      ...profile.shortTrend,
    },
    execution,
    risk: {
      ...risk,
      ...profile.risk,
      takeProfitSteps,
      positionManagement: {
        ...positionManagement,
        ...profile.risk.positionManagement,
      },
    },
  } as T;
}

export function strategyParameterProfileError(
  value: unknown,
  expectedTriggerKind: StrategyTriggerKind,
): string | null {
  const source = record(value);
  const stamp = record(source.parameterProfile);
  if (stamp.version !== STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION)
    return "策略参数模板版本已过期，请刷新页面后重新配置并保存";
  if (stamp.triggerKind !== expectedTriggerKind)
    return "策略参数模板与所选触发器不一致，请重新选择触发器后保存";
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
