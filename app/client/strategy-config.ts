import { AUTOMATED_STRATEGY_LEVERAGE } from "../../lib/liquidation-trend-config";
import { APPLYABLE_STRATEGY_SUGGESTION_PATHS } from "../../lib/nexus-suggestion-contract";
import { normalizeAutomatedOrderQuantityMultiplier } from "../../lib/order-quantity";
import {
  inferStrategyTriggerKind,
  isNewStrategyTriggerKind,
  type StrategyTriggerKind,
} from "../../lib/strategy-trigger-catalog";
import {
  DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG,
  type LowPositionWindowTriggerConfig,
} from "../../lib/strategy-triggers/low-position-config";
import { DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG } from "../../lib/strategy-triggers/three-minute-probability-config";
import type { ThreeMinuteProbabilityTriggerConfig } from "../../lib/strategy-triggers/three-minute-probability-config";
import {
  DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG,
  type GridPriceLevelTriggerConfig,
} from "../../lib/strategy-triggers/grid-price-level-config";
import {
  DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG,
  type ScheduledScanTriggerConfig,
} from "../../lib/strategy-triggers/scheduled-scan-config";
import {
  DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG,
  type BreakoutRetestTriggerConfig,
} from "../../lib/strategy-triggers/breakout-retest-config";
import { DEFAULT_RELATIVE_STRENGTH_CONFIG } from "../../lib/relative-strength-trend";
import { DEFAULT_HIGH_POSITION_SHORT_CONFIG } from "../../lib/high-position-short";
import { applyStrategyDefaultParameters } from "../../lib/strategy-default-parameters";
import {
  resolveStrategyPlugin,
  strategyPluginId as inferStrategyPluginId,
  type StrategyPluginId,
} from "../../lib/strategy-plugins/registry";

export function liquidationConfigShape(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return ["trigger", "marketPosition", "trend", "execution", "risk", "validation"]
    .every((key) => config[key] && typeof config[key] === "object" && !Array.isArray(config[key]));
}
export type StrategyDirection = "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
export type StrategyDirectionDecisionUi = {
  mode: "TRIGGER_DIRECTED" | "COMPETING_DIRECTIONS";
  minimumRewardRiskRatio: number;
  minimumDirectionAdvantageRoePercent: number;
  maximumUncertaintyRoePercent: number;
};
function finiteUiNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
export function strategyTriggerKind(value: unknown): StrategyTriggerKind {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "LIQUIDATION_WINDOW";
  return inferStrategyTriggerKind(value as Record<string, unknown>);
}

export function strategyPluginId(value: unknown): StrategyPluginId | null {
  return inferStrategyPluginId(value);
}

export function withStrategyPlugin<T extends object>(
  value: T,
  id: StrategyPluginId | null,
): T {
  if (!liquidationConfigShape(value)) return value;
  if (!id) return { ...value, strategyPlugin: undefined } as T;
  const plugin = resolveStrategyPlugin(id);
  return plugin.apply(withStrategyTriggerKind(value, plugin.triggerKind));
}

export function withStrategyTriggerKind<T extends object>(
  value: T,
  kind: StrategyTriggerKind,
) {
  if (!liquidationConfigShape(value) || !isNewStrategyTriggerKind(kind))
    return value;
  const config = value as Record<string, unknown>;
  const valueWithoutPlugin = { ...value, strategyPlugin: undefined } as T;
  const trigger = config.trigger as Record<string, unknown>;
  const previousTriggerKind = strategyTriggerKind(value);
  const marketProfile =
    config.marketProfile &&
    typeof config.marketProfile === "object" &&
    !Array.isArray(config.marketProfile)
      ? config.marketProfile as Record<string, unknown>
      : {};
  if (kind === "LOW_POSITION_WINDOW") {
    const risk = config.risk as Record<string, unknown>;
    const positionManagement =
      risk.positionManagement &&
      typeof risk.positionManagement === "object" &&
      !Array.isArray(risk.positionManagement)
        ? risk.positionManagement as Record<string, unknown>
        : {};
    return applyStrategyDefaultParameters({
      ...valueWithoutPlugin,
      directionDecision: undefined,
      direction: "LONG_ONLY",
      trigger: {
        ...trigger,
        kind,
        lowPositionWindow: {
          ...DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG,
        },
      },
      marketProfile: {
        ...marketProfile,
        mode: "LOW_POSITION_LONG",
        contractType: "PERPETUAL",
        triggerPolicy: "LOW_POSITION_WINDOW",
        orderSizing: "EXCHANGE_MINIMUM",
      },
      risk: {
        ...risk,
        positionManagement: {
          ...positionManagement,
          contrarianFallbackEnabled: false,
        },
      },
      execution: {
        ...(config.execution as Record<string, unknown>),
        directionMode: "FOLLOW_BRAIN",
        entryDistanceExecutionMode: "LIVE",
      },
    } as T, kind);
  }
  if (kind === "THREE_MINUTE_PROBABILITY") {
    const risk = config.risk as Record<string, unknown>;
    const positionManagement =
      risk.positionManagement &&
      typeof risk.positionManagement === "object" &&
      !Array.isArray(risk.positionManagement)
        ? risk.positionManagement as Record<string, unknown>
        : {};
    return applyStrategyDefaultParameters({
      ...valueWithoutPlugin,
      directionDecision: undefined,
      direction: "BOTH",
      trigger: {
        ...trigger,
        kind,
        threeMinuteProbability: {
          ...DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG,
        },
      },
      marketProfile: {
        ...marketProfile,
        mode: "THREE_MINUTE_PROBABILITY",
        contractType: "PERPETUAL",
        triggerPolicy: "THREE_MINUTE_PROBABILITY",
        orderSizing: "EXCHANGE_MINIMUM",
      },
      execution: {
        ...(config.execution as Record<string, unknown>),
        directionMode: "FOLLOW_BRAIN",
        explorationOrderTarget: 0,
        existingPositionPolicy: "BLOCK",
        sameLegWorkingOrderPolicy: "BLOCK",
      },
      risk: {
        ...risk,
        minimumObservationMinutes: 0,
        dynamicTrailingEnabled: false,
        positionManagement: {
          ...positionManagement,
          contrarianFallbackEnabled: false,
          addOnEnabled: false,
          profitScaleInEnabled: false,
        },
      },
    } as T, kind);
  }
  if (
    kind === "GRID_PRICE_LEVEL" ||
    kind === "SCHEDULED_SCAN" ||
    kind === "BREAKOUT_RETEST"
  ) {
    const risk = config.risk as Record<string, unknown>;
    const positionManagement =
      risk.positionManagement &&
      typeof risk.positionManagement === "object" &&
      !Array.isArray(risk.positionManagement)
        ? risk.positionManagement as Record<string, unknown>
        : {};
    const {
      lowPositionWindow: _lowPositionWindow,
      threeMinuteProbability: _threeMinuteProbability,
      gridPriceLevel: _gridPriceLevel,
      scheduledScan: _scheduledScan,
      breakoutRetest: _breakoutRetest,
      ...sharedTrigger
    } = trigger;
    void _lowPositionWindow;
    void _threeMinuteProbability;
    void _gridPriceLevel;
    void _scheduledScan;
    void _breakoutRetest;
    const mode = kind === "GRID_PRICE_LEVEL"
      ? "GRID_PRICE"
      : kind === "SCHEDULED_SCAN"
        ? "SCHEDULED_SCAN"
        : "BREAKOUT_RETEST";
    const dedicatedConfig = kind === "GRID_PRICE_LEVEL"
      ? { gridPriceLevel: { ...DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG } }
      : kind === "SCHEDULED_SCAN"
        ? { scheduledScan: { ...DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG } }
        : { breakoutRetest: { ...DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG } };
    return applyStrategyDefaultParameters({
      ...valueWithoutPlugin,
      directionDecision: kind === "SCHEDULED_SCAN"
        ? config.directionDecision
        : undefined,
      direction: "BOTH",
      trigger: {
        ...sharedTrigger,
        kind,
        ...dedicatedConfig,
      },
      marketProfile: {
        ...marketProfile,
        mode,
        contractType: "PERPETUAL",
        triggerPolicy: kind,
        orderSizing: "EXCHANGE_MINIMUM",
      },
      execution: {
        ...(config.execution as Record<string, unknown>),
        directionMode: "FOLLOW_BRAIN",
        ...(previousTriggerKind === "THREE_MINUTE_PROBABILITY"
          ? { explorationOrderTarget: 10 }
          : {}),
      },
      risk: {
        ...risk,
        positionManagement: {
          ...positionManagement,
          contrarianFallbackEnabled: false,
        },
      },
    } as T, kind);
  }
  const implementedProfiles: Partial<
    Record<
      StrategyTriggerKind,
      {
        mode: string;
        contractType: string;
        triggerPolicy: string;
        direction: StrategyDirection;
      }
    >
  > = {
    PRICE_VOLUME_STRUCTURE: {
      mode: "TRADFI",
      contractType: "TRADIFI_PERPETUAL",
      triggerPolicy: "PRICE_VOLUME_STRUCTURE",
      direction: "BOTH",
    },
    RELATIVE_STRENGTH_CONTINUATION: {
      mode: "RELATIVE_STRENGTH",
      contractType: "MIXED_PERPETUAL",
      triggerPolicy: "RELATIVE_STRENGTH_CONTINUATION",
      direction: "BOTH",
    },
    LIQUIDATION_OR_PRICE_MOMENTUM_WAKE: {
      mode: "TREND_PULLBACK",
      contractType: "PERPETUAL",
      triggerPolicy: "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE",
      direction: "BOTH",
    },
    HIGH_POSITION_PRICE_VOLUME_STRUCTURE: {
      mode: "HIGH_POSITION_SHORT",
      contractType: "PERPETUAL",
      triggerPolicy: "HIGH_POSITION_PRICE_VOLUME_STRUCTURE",
      direction: "SHORT_ONLY",
    },
  };
  const implementedProfile = implementedProfiles[kind];
  if (implementedProfile) {
    const {
      lowPositionWindow: _lowPositionWindow,
      threeMinuteProbability: _threeMinuteProbability,
      ...sharedTrigger
    } = trigger;
    void _lowPositionWindow;
    void _threeMinuteProbability;
    const risk = config.risk as Record<string, unknown>;
    const positionManagement =
      risk.positionManagement &&
        typeof risk.positionManagement === "object" &&
        !Array.isArray(risk.positionManagement)
        ? risk.positionManagement as Record<string, unknown>
        : {};
    return applyStrategyDefaultParameters({
      ...valueWithoutPlugin,
      directionDecision: undefined,
      direction: implementedProfile.direction,
      trigger: { ...sharedTrigger, kind },
      ...(kind === "RELATIVE_STRENGTH_CONTINUATION"
        ? { relativeStrength: { ...DEFAULT_RELATIVE_STRENGTH_CONFIG } }
        : {}),
      ...(kind === "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
        ? { highPositionShort: { ...DEFAULT_HIGH_POSITION_SHORT_CONFIG } }
        : {}),
      marketProfile: {
        ...marketProfile,
        mode: implementedProfile.mode,
        contractType: implementedProfile.contractType,
        triggerPolicy: implementedProfile.triggerPolicy,
        orderSizing: "EXCHANGE_MINIMUM",
      },
      execution: {
        ...(config.execution as Record<string, unknown>),
        directionMode: "FOLLOW_BRAIN",
        ...(previousTriggerKind === "THREE_MINUTE_PROBABILITY"
          ? { explorationOrderTarget: 10 }
          : {}),
      },
      risk: {
        ...risk,
        positionManagement: {
          ...positionManagement,
          contrarianFallbackEnabled: false,
        },
      },
    } as T, kind);
  }
  const {
    lowPositionWindow: _lowPositionWindow,
    threeMinuteProbability: _threeMinuteProbability,
    ...liquidationTrigger
  } =
    trigger;
  void _lowPositionWindow;
  void _threeMinuteProbability;
  return applyStrategyDefaultParameters({
    ...valueWithoutPlugin,
    directionDecision: undefined,
    trigger: { ...liquidationTrigger, kind },
    marketProfile: {
      ...marketProfile,
      mode: "UNIFIED",
      contractType: "PERPETUAL",
      triggerPolicy: "LIQUIDATION_ONLY",
      orderSizing: "EXCHANGE_MINIMUM",
    },
    execution: previousTriggerKind === "THREE_MINUTE_PROBABILITY"
      ? {
          ...(config.execution as Record<string, unknown>),
          explorationOrderTarget: 10,
        }
      : config.execution,
  } as T, kind);
}

export type NexusProbabilityPolicyUi = {
  mode: "STANDARD" | "NET_EXPECTANCY";
  minimumNetExpectancyRoePercent: number;
  priorWinProbabilityPercent: number;
  priorEquivalentSamples: number;
  minimumComparableSamples: number;
  maximumComparableSamples: number;
  maximumSampleAgeDays: number;
  estimatedRoundTripFeePercent: number;
  estimatedExitSlippageBps: number;
  sourceStrategyId?: number;
};

export function nexusProbabilityPolicyUi(
  value: unknown,
): NexusProbabilityPolicyUi | null {
  if (!liquidationConfigShape(value)) return null;
  const policy = (value as Record<string, unknown>).probabilityPolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy))
    return null;
  return policy as NexusProbabilityPolicyUi;
}

export function withNexusProbabilityPolicy<T extends object>(
  value: T,
  patch: Partial<NexusProbabilityPolicyUi>,
) {
  if (!liquidationConfigShape(value)) return value;
  const current = nexusProbabilityPolicyUi(value) ?? {
    mode: "STANDARD" as const,
    minimumNetExpectancyRoePercent: 0,
    priorWinProbabilityPercent: 55,
    priorEquivalentSamples: 4,
    minimumComparableSamples: 5,
    maximumComparableSamples: 120,
    maximumSampleAgeDays: 30,
    estimatedRoundTripFeePercent: 0.08,
    estimatedExitSlippageBps: 5,
  };
  return {
    ...value,
    probabilityPolicy: { ...current, ...patch },
  } as T;
}
export function liquidationDirection(value: unknown): StrategyDirection {
  if (!liquidationConfigShape(value)) return "BOTH";
  const direction = (value as Record<string, unknown>).direction;
  return direction === "SHORT_ONLY" || direction === "BOTH"
    ? direction
    : "LONG_ONLY";
}
export function withLiquidationDirection<T extends object>(
  value: T,
  direction: StrategyDirection,
) {
  if (!liquidationConfigShape(value)) return value;
  if (inferStrategyPluginId(value) && direction !== "BOTH") return value;
  if (direction === "BOTH") return { ...value, direction } as T;
  const config = value as Record<string, unknown>;
  const risk = config.risk as Record<string, unknown>;
  const positionManagement =
    risk.positionManagement &&
      typeof risk.positionManagement === "object" &&
      !Array.isArray(risk.positionManagement)
      ? risk.positionManagement as Record<string, unknown>
      : {};
  return {
    ...value,
    direction,
    directionDecision: undefined,
    risk: {
      ...risk,
      positionManagement: {
        ...positionManagement,
        contrarianFallbackEnabled: false,
      },
    },
  } as T;
}
export function strategyDirectionDecisionUi(
  value: unknown,
): StrategyDirectionDecisionUi {
  if (!liquidationConfigShape(value))
    return {
      mode: "TRIGGER_DIRECTED",
      minimumRewardRiskRatio: 1.2,
      minimumDirectionAdvantageRoePercent: 0.15,
      maximumUncertaintyRoePercent: 1.5,
    };
  const raw = (value as Record<string, unknown>).directionDecision;
  const decision = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    mode: decision.mode === "COMPETING_DIRECTIONS"
      ? "COMPETING_DIRECTIONS"
      : "TRIGGER_DIRECTED",
    minimumRewardRiskRatio:
      finiteUiNumber(decision.minimumRewardRiskRatio, 1.2),
    minimumDirectionAdvantageRoePercent:
      finiteUiNumber(decision.minimumDirectionAdvantageRoePercent, 0.15),
    maximumUncertaintyRoePercent:
      finiteUiNumber(decision.maximumUncertaintyRoePercent, 1.5),
  };
}
export function withStrategyDirectionDecision<T extends object>(
  value: T,
  patch: Partial<StrategyDirectionDecisionUi>,
) {
  if (
    !liquidationConfigShape(value) ||
    strategyTriggerKind(value) !== "SCHEDULED_SCAN" ||
    liquidationDirection(value) !== "BOTH"
  ) return value;
  return {
    ...value,
    directionDecision: {
      ...strategyDirectionDecisionUi(value),
      ...patch,
      ...(inferStrategyPluginId(value)
        ? { mode: "COMPETING_DIRECTIONS" as const }
        : {}),
    },
  } as T;
}
export const MANUAL_DEFAULT_LEVERAGE = 3;
export type LiquidationExecutionUi = {
  directionMode?: "FOLLOW_BRAIN" | "INVERSE_BRAIN";
  orderType?: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
  entryDistanceExecutionMode?: "SHADOW" | "LIVE";
  limitOffsetPercent?: number;
  adaptiveMarketMaxDistanceAtr?: number;
  orderTtlSeconds?: number;
  liquidationLimitOrderTtlMs?: number;
  allowSecondOrder?: boolean;
  sameLegWorkingOrderPolicy?: "BLOCK" | "ALLOW";
  existingPositionPolicy?: "BLOCK" | "ALLOW_SAME_DIRECTION";
  minimumOrderFloorMode?: "REJECT" | "ALLOW_WITH_MARGIN_GATE";
  explorationOrderTarget?: number;
  leverage: number;
  quantitySizingMode?: "FIXED" | "EVIDENCE_1_TO_2";
  minimumOrderQuantityMultiplier?: number;
  minimumPositionNotionalUsdt?: number;
  equityAllocationPercent?: number;
  /** 策略下单使用的目标初始保证金。 */
  targetOrderMarginUsdt?: number;
  /** 单笔订单允许使用的最大初始保证金。 */
  maxOrderMarginUsdt?: number;
};
export type LiquidationRiskUi = {
  maxMarginUsagePercent?: number;
  dailyLossLimitUsdt?: number;
  stopLossPercent?: number;
  minimumObservationMinutes?: number;
  liquidationGuardBufferPercent?: number;
  takeProfitSteps?: LiquidationTakeProfitStepUi[];
  atrStopBuffer?: number;
  dynamicTrailingEnabled?: boolean;
  trailingActivationPercent?: number;
  trailingDrawdownPercent?: number;
  portfolioRisk?: NexusPortfolioRiskUi;
  positionManagement?: PositionManagementUi;
};
export type NexusPortfolioRiskUi = {
  perTradeRiskPercent?: number;
  strategyRiskBudgetPercent?: number;
  learningProbeRiskBudgetPercent?: number;
  maxPortfolioRiskPercent?: number;
  maxDirectionalRiskPercent?: number;
  maxCorrelationGroupRiskPercent?: number;
  drawdownCautionPercent?: number;
  drawdownReducedPercent?: number;
  drawdownHaltPercent?: number;
  cautionMultiplier?: number;
  reducedMultiplier?: number;
};
export type PositionManagementUi = {
  profitGivebackRoePoints?: number;
  bottomRecoveryRoePoints?: number;
  tailWaveExitEnabled?: boolean;
  tailWaveObservationMinutes?: number;
  tailWaveMaximumPositionPercent?: number;
  tailWavePeakGivebackAtr?: number;
  addOnEnabled?: boolean;
  profitScaleInEnabled?: boolean;
  addOnNotionalUsdt?: number;
  maxAddOnsPerPosition?: number;
  minMinutesBetweenAddOns?: number;
  maxAddOnLossRoePercent?: number;
  contrarianFallbackEnabled?: boolean;
  contrarianProbeNotionalUsdt?: number;
  contrarianProfitRoeBeforeHedge?: number;
  evidenceRisk?: {
    enabled?: boolean;
    warningMinute?: number;
    reductionMinute?: number;
    exitMinute?: number;
    reductionPercent?: number;
    minimumDeteriorationRoePoints?: number;
    postReductionExitDelaySeconds?: number;
    exitRemainingOnPersistentInvalidation?: boolean;
  };
};
export type LiquidationTakeProfitStepUi = {
  profitPercent: number;
  closePercent: number;
};
export type LiquidationLargeTraderUi = {
  minOpenInterestChangePercent: number;
  minTopPositionRatioChangePercent: number;
  minTopAccountRatioChangePercent: number;
  minTakerBuySellRatio: number;
  maxDataAgeMinutes: number;
};
export type LiquidationTrendUi = {
  volumeRatio3m?: number;
  atrPeriod5m?: number;
  maxEntryDistanceAtr?: number;
  maxPriorRangeAtr?: number;
  trend1hBreakHandling?: "REJECT" | "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
  structure30mBreakHandling?: "REJECT" | "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
};
export type LiquidationShortTrendUi = {
  minimumLongLiquidationSharePercent?: number;
  minimumMarket60mDropPercent?: number;
};
export type LiquidationTriggerUi = {
  minLiquidationNotionalUsdt?: number;
  minSingleLiquidationNotionalUsdt?: number;
  minLiquidationPrice?: number;
  maxLiquidationPrice?: number;
  maxSignalDelayMs?: number;
  analysisValiditySeconds?: number;
  cooldownMinutes?: number;
  maxConcurrentAnalyses?: number;
  minClusterEvents?: number;
  maxClusterSpanSeconds?: number;
  maxClusterEventGapSeconds?: number;
};
export type LowPositionTriggerUi = LowPositionWindowTriggerConfig;
export type LiquidationFactorUi = {
  mode: "SHADOW" | "LIVE";
  automaticModeSwitch: boolean;
  learningTargetEpisodes: number;
  learningMinimumExactCycles: number;
};
export type LiquidationMarketPositionUi = {
  maxPosition72hPercent?: number;
};
export function lowPositionTriggerUi(
  value: unknown,
): LowPositionTriggerUi | null {
  if (!liquidationConfigShape(value)) return null;
  const trigger = (value as Record<string, unknown>).trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger))
    return null;
  const lowPositionWindow = (trigger as Record<string, unknown>)
    .lowPositionWindow;
  return lowPositionWindow &&
    typeof lowPositionWindow === "object" &&
    !Array.isArray(lowPositionWindow)
    ? {
        ...DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG,
        ...lowPositionWindow as Partial<LowPositionTriggerUi>,
      }
    : { ...DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG };
}
export function withLowPositionTrigger<T extends object>(
  value: T,
  patch: Partial<LowPositionTriggerUi>,
) {
  const current = lowPositionTriggerUi(value);
  if (!current) return value;
  const config = value as Record<string, unknown>;
  const trigger = config.trigger as Record<string, unknown>;
  return {
    ...value,
    trigger: {
      ...trigger,
      lowPositionWindow: { ...current, ...patch },
    },
  } as T;
}
export type ThreeMinuteProbabilityTriggerUi =
  ThreeMinuteProbabilityTriggerConfig;
export function threeMinuteProbabilityTriggerUi(
  value: unknown,
): ThreeMinuteProbabilityTriggerUi | null {
  if (!liquidationConfigShape(value)) return null;
  const trigger = (value as Record<string, unknown>).trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger))
    return null;
  const probability = (trigger as Record<string, unknown>)
    .threeMinuteProbability;
  return probability && typeof probability === "object" &&
      !Array.isArray(probability)
    ? {
        ...DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG,
        ...probability as Partial<ThreeMinuteProbabilityTriggerUi>,
        roundSeconds: 180,
      }
    : { ...DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG };
}
export function withThreeMinuteProbabilityTrigger<T extends object>(
  value: T,
  patch: Partial<ThreeMinuteProbabilityTriggerUi>,
) {
  const current = threeMinuteProbabilityTriggerUi(value);
  if (!current) return value;
  const config = value as Record<string, unknown>;
  const trigger = config.trigger as Record<string, unknown>;
  return {
    ...value,
    trigger: {
      ...trigger,
      threeMinuteProbability: {
        ...current,
        ...patch,
        roundSeconds: 180,
      },
    },
  } as T;
}
export type GridPriceLevelTriggerUi = GridPriceLevelTriggerConfig;
export type ScheduledScanTriggerUi = ScheduledScanTriggerConfig;
export type BreakoutRetestTriggerUi = BreakoutRetestTriggerConfig;

export function gridPriceLevelTriggerUi(
  value: unknown,
): GridPriceLevelTriggerUi | null {
  return dedicatedTriggerUi(
    value,
    "gridPriceLevel",
    DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG,
  );
}

export function scheduledScanTriggerUi(
  value: unknown,
): ScheduledScanTriggerUi | null {
  return dedicatedTriggerUi(
    value,
    "scheduledScan",
    DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG,
  );
}

export function breakoutRetestTriggerUi(
  value: unknown,
): BreakoutRetestTriggerUi | null {
  return dedicatedTriggerUi(
    value,
    "breakoutRetest",
    DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG,
  );
}

export function withGridPriceLevelTrigger<T extends object>(
  value: T,
  patch: Partial<GridPriceLevelTriggerUi>,
) {
  return withDedicatedTrigger(value, "gridPriceLevel", patch, gridPriceLevelTriggerUi);
}

export function withScheduledScanTrigger<T extends object>(
  value: T,
  patch: Partial<ScheduledScanTriggerUi>,
) {
  return withDedicatedTrigger(value, "scheduledScan", patch, scheduledScanTriggerUi);
}

export function withBreakoutRetestTrigger<T extends object>(
  value: T,
  patch: Partial<BreakoutRetestTriggerUi>,
) {
  return withDedicatedTrigger(value, "breakoutRetest", patch, breakoutRetestTriggerUi);
}

function dedicatedTriggerUi<T extends object>(
  value: unknown,
  key: string,
  defaults: T,
): T | null {
  if (!liquidationConfigShape(value)) return null;
  const trigger = (value as Record<string, unknown>).trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger))
    return null;
  const section = (trigger as Record<string, unknown>)[key];
  return section && typeof section === "object" && !Array.isArray(section)
    ? { ...defaults, ...section as Partial<T> }
    : { ...defaults };
}

function withDedicatedTrigger<T extends object, U extends object>(
  value: T,
  key: string,
  patch: Partial<U>,
  read: (value: unknown) => U | null,
) {
  const current = read(value);
  if (!current) return value;
  const config = value as Record<string, unknown>;
  const trigger = config.trigger as Record<string, unknown>;
  return {
    ...value,
    trigger: {
      ...trigger,
      [key]: { ...current, ...patch },
    },
  } as T;
}
export const DEFAULT_LIQUIDATION_LARGE_TRADER_UI: LiquidationLargeTraderUi = {
  minOpenInterestChangePercent: -1,
  minTopPositionRatioChangePercent: 0,
  minTopAccountRatioChangePercent: -3,
  minTakerBuySellRatio: 1,
  maxDataAgeMinutes: 12,
};
export function liquidationExecutionUi(value: unknown): LiquidationExecutionUi | null {
  if (!liquidationConfigShape(value)) return null;
  const execution = (value as Record<string, unknown>).execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution))
    return null;
  const source = execution as Record<string, unknown>;
  const targetOrderMarginUsdt = Number(
    source.targetOrderMarginUsdt ?? source.targetOrderNotionalUsdt,
  );
  const maxOrderMarginUsdt = Number(
    source.maxOrderMarginUsdt ?? source.maxOrderNotionalUsdt,
  );
  return {
    ...(source as unknown as LiquidationExecutionUi),
    leverage: Number.isFinite(Number(source.leverage))
      ? Number(source.leverage)
      : AUTOMATED_STRATEGY_LEVERAGE,
    minimumOrderQuantityMultiplier:
      normalizeAutomatedOrderQuantityMultiplier(
        source.minimumOrderQuantityMultiplier,
      ),
    targetOrderMarginUsdt: Number.isFinite(targetOrderMarginUsdt)
      ? targetOrderMarginUsdt
      : undefined,
    maxOrderMarginUsdt: Number.isFinite(maxOrderMarginUsdt)
      ? maxOrderMarginUsdt
      : undefined,
  };
}
export function withLiquidationExecution<T extends object>(
  value: T,
  patch: Partial<LiquidationExecutionUi>,
) {
  const execution = liquidationExecutionUi(value);
  if (!execution) return value;
  const persistedPatch: Record<string, unknown> = { ...patch };
  if (patch.targetOrderMarginUsdt !== undefined)
    persistedPatch.targetOrderNotionalUsdt = patch.targetOrderMarginUsdt;
  if (patch.maxOrderMarginUsdt !== undefined)
    persistedPatch.maxOrderNotionalUsdt = patch.maxOrderMarginUsdt;
  delete persistedPatch.targetOrderMarginUsdt;
  delete persistedPatch.maxOrderMarginUsdt;
  const current = (value as Record<string, unknown>).execution as Record<
    string,
    unknown
  >;
  return {
    ...value,
    execution: { ...current, ...persistedPatch },
  } as T;
}
export function liquidationRiskUi(value: unknown): LiquidationRiskUi | null {
  if (!liquidationConfigShape(value)) return null;
  const risk = (value as Record<string, unknown>).risk;
  return risk && typeof risk === "object" && !Array.isArray(risk)
    ? risk as LiquidationRiskUi
    : null;
}
export function withLiquidationRisk<T extends object>(
  value: T,
  patch: Partial<LiquidationRiskUi>,
) {
  const risk = liquidationRiskUi(value);
  if (!risk) return value;
  return { ...value, risk: { ...risk, ...patch } } as T;
}
export function withLiquidationPortfolioRisk<T extends object>(
  value: T,
  patch: Partial<NexusPortfolioRiskUi>,
) {
  const risk = liquidationRiskUi(value);
  if (!risk) return value;
  return withLiquidationRisk(value, {
    portfolioRisk: {
      perTradeRiskPercent:
        risk.portfolioRisk?.perTradeRiskPercent ?? 1,
      strategyRiskBudgetPercent:
        risk.portfolioRisk?.strategyRiskBudgetPercent ?? 4,
      learningProbeRiskBudgetPercent:
        risk.portfolioRisk?.learningProbeRiskBudgetPercent ?? 3,
      maxPortfolioRiskPercent:
        risk.portfolioRisk?.maxPortfolioRiskPercent ?? 8,
      maxDirectionalRiskPercent:
        risk.portfolioRisk?.maxDirectionalRiskPercent ?? 6,
      maxCorrelationGroupRiskPercent:
        risk.portfolioRisk?.maxCorrelationGroupRiskPercent ?? 4,
      drawdownCautionPercent:
        risk.portfolioRisk?.drawdownCautionPercent ?? 3,
      drawdownReducedPercent:
        risk.portfolioRisk?.drawdownReducedPercent ?? 6,
      drawdownHaltPercent:
        risk.portfolioRisk?.drawdownHaltPercent ?? 10,
      cautionMultiplier:
        risk.portfolioRisk?.cautionMultiplier ?? 0.5,
      reducedMultiplier:
        risk.portfolioRisk?.reducedMultiplier ?? 0.25,
      ...risk.portfolioRisk,
      ...patch,
    },
  });
}
export function withLiquidationPositionManagement<T extends object>(
  value: T,
  patch: Partial<PositionManagementUi>,
) {
  const risk = liquidationRiskUi(value);
  if (!risk) return value;
  return withLiquidationRisk(value, {
    positionManagement: {
      profitGivebackRoePoints:
        risk.positionManagement?.profitGivebackRoePoints ?? 3,
      bottomRecoveryRoePoints:
        risk.positionManagement?.bottomRecoveryRoePoints ?? 2,
      tailWaveExitEnabled:
        risk.positionManagement?.tailWaveExitEnabled ?? true,
      tailWaveObservationMinutes:
        risk.positionManagement?.tailWaveObservationMinutes ?? 15,
      tailWaveMaximumPositionPercent:
        risk.positionManagement?.tailWaveMaximumPositionPercent ?? 35,
      tailWavePeakGivebackAtr:
        risk.positionManagement?.tailWavePeakGivebackAtr ?? 0.5,
      addOnEnabled: risk.positionManagement?.addOnEnabled ?? false,
      profitScaleInEnabled:
        risk.positionManagement?.profitScaleInEnabled ?? false,
      addOnNotionalUsdt:
        risk.positionManagement?.addOnNotionalUsdt ?? 5.1,
      maxAddOnsPerPosition:
        risk.positionManagement?.maxAddOnsPerPosition ?? 1,
      minMinutesBetweenAddOns:
        risk.positionManagement?.minMinutesBetweenAddOns ?? 30,
      maxAddOnLossRoePercent:
        risk.positionManagement?.maxAddOnLossRoePercent ?? 20,
      contrarianFallbackEnabled:
        risk.positionManagement?.contrarianFallbackEnabled ?? false,
      contrarianProbeNotionalUsdt:
        risk.positionManagement?.contrarianProbeNotionalUsdt ??
        liquidationExecutionUi(value)?.targetOrderMarginUsdt ??
        5.1,
      contrarianProfitRoeBeforeHedge:
        risk.positionManagement?.contrarianProfitRoeBeforeHedge ?? 3,
      ...patch,
      evidenceRisk: {
        enabled:
          risk.positionManagement?.evidenceRisk?.enabled ?? true,
        warningMinute:
          risk.positionManagement?.evidenceRisk?.warningMinute ?? 3,
        reductionMinute:
          risk.positionManagement?.evidenceRisk?.reductionMinute ?? 5,
        exitMinute:
          risk.positionManagement?.evidenceRisk?.exitMinute ?? 15,
        reductionPercent:
          risk.positionManagement?.evidenceRisk?.reductionPercent ?? 30,
        minimumDeteriorationRoePoints:
          risk.positionManagement?.evidenceRisk
            ?.minimumDeteriorationRoePoints ?? 0.5,
        postReductionExitDelaySeconds:
          risk.positionManagement?.evidenceRisk
            ?.postReductionExitDelaySeconds ?? 15,
        exitRemainingOnPersistentInvalidation:
          risk.positionManagement?.evidenceRisk
            ?.exitRemainingOnPersistentInvalidation ?? false,
        ...patch.evidenceRisk,
      },
    },
  });
}
export function withLiquidationTakeProfitStep<T extends object>(
  value: T,
  index: number,
  patch: Partial<LiquidationTakeProfitStepUi>,
) {
  const risk = liquidationRiskUi(value);
  if (!risk) return value;
  const takeProfitSteps = (risk.takeProfitSteps ?? []).map((step, stepIndex) =>
    stepIndex === index ? { ...step, ...patch } : step,
  );
  return withLiquidationRisk(value, { takeProfitSteps });
}
export function liquidationLargeTraderUi(value: unknown): LiquidationLargeTraderUi | null {
  if (!liquidationConfigShape(value)) return null;
  const section = (value as Record<string, unknown>).largeTrader;
  return section && typeof section === "object" && !Array.isArray(section)
    ? { ...DEFAULT_LIQUIDATION_LARGE_TRADER_UI, ...section as Partial<LiquidationLargeTraderUi> }
    : { ...DEFAULT_LIQUIDATION_LARGE_TRADER_UI };
}
export function withLiquidationLargeTrader<T extends object>(
  value: T,
  patch: Partial<LiquidationLargeTraderUi>,
) {
  const section = liquidationLargeTraderUi(value);
  if (!section) return value;
  return { ...value, largeTrader: { ...section, ...patch } } as T;
}
export function liquidationTrendUi(value: unknown): LiquidationTrendUi | null {
  if (!liquidationConfigShape(value)) return null;
  const trend = (value as Record<string, unknown>).trend;
  return trend && typeof trend === "object" && !Array.isArray(trend)
    ? trend as LiquidationTrendUi
    : null;
}
export function withLiquidationTrend<T extends object>(
  value: T,
  patch: Partial<LiquidationTrendUi>,
) {
  const trend = liquidationTrendUi(value);
  if (!trend) return value;
  return { ...value, trend: { ...trend, ...patch } } as T;
}
export function liquidationShortTrendUi(
  value: unknown,
): LiquidationShortTrendUi | null {
  if (!liquidationConfigShape(value)) return null;
  const section = (value as Record<string, unknown>).shortTrend;
  return section && typeof section === "object" && !Array.isArray(section)
    ? (section as LiquidationShortTrendUi)
    : {};
}
export function withLiquidationShortTrend<T extends object>(
  value: T,
  patch: Partial<LiquidationShortTrendUi>,
) {
  const section = liquidationShortTrendUi(value);
  if (!section) return value;
  return { ...value, shortTrend: { ...section, ...patch } } as T;
}
export function liquidationTriggerUi(value: unknown): LiquidationTriggerUi | null {
  if (!liquidationConfigShape(value)) return null;
  const trigger = (value as Record<string, unknown>).trigger;
  return trigger && typeof trigger === "object" && !Array.isArray(trigger)
    ? trigger as LiquidationTriggerUi
    : null;
}
export function withLiquidationTrigger<T extends object>(
  value: T,
  patch: Partial<LiquidationTriggerUi>,
) {
  const trigger = liquidationTriggerUi(value);
  if (!trigger) return value;
  return { ...value, trigger: { ...trigger, ...patch } } as T;
}
export function liquidationFactorUi(value: unknown): LiquidationFactorUi | null {
  if (!liquidationConfigShape(value)) return null;
  const section = (value as Record<string, unknown>).liquidationFactors;
  if (!section || typeof section !== "object" || Array.isArray(section))
    return {
      mode: "SHADOW",
      automaticModeSwitch: true,
      learningTargetEpisodes: 30,
      learningMinimumExactCycles: 8,
    };
  const candidate = section as Partial<LiquidationFactorUi>;
  return {
    mode: candidate.mode === "LIVE" ? "LIVE" : "SHADOW",
    automaticModeSwitch: candidate.automaticModeSwitch !== false,
    learningTargetEpisodes: Number(candidate.learningTargetEpisodes ?? 30),
    learningMinimumExactCycles: Number(
      candidate.learningMinimumExactCycles ?? 8,
    ),
  };
}
export function withLiquidationFactor<T extends object>(
  value: T,
  patch: Partial<LiquidationFactorUi>,
) {
  const section = liquidationFactorUi(value);
  if (!section) return value;
  const current = (value as Record<string, unknown>).liquidationFactors;
  return {
    ...value,
    liquidationFactors: {
      ...(current && typeof current === "object" && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {}),
      ...section,
      ...patch,
    },
  } as T;
}
export function liquidationMarketPositionUi(value: unknown): LiquidationMarketPositionUi | null {
  if (!liquidationConfigShape(value)) return null;
  const marketPosition = (value as Record<string, unknown>).marketPosition;
  return marketPosition && typeof marketPosition === "object" && !Array.isArray(marketPosition)
    ? marketPosition as LiquidationMarketPositionUi
    : null;
}
export function withLiquidationMarketPosition<T extends object>(
  value: T,
  patch: Partial<LiquidationMarketPositionUi>,
) {
  const marketPosition = liquidationMarketPositionUi(value);
  if (!marketPosition) return value;
  return { ...value, marketPosition: { ...marketPosition, ...patch } } as T;
}
export { APPLYABLE_STRATEGY_SUGGESTION_PATHS };
export function applyStrategySuggestionValue<T extends object>(
  config: T,
  parameterName: string,
  suggestedValue: unknown,
): T | null {
  const numericValue = typeof suggestedValue === "number" &&
    Number.isFinite(suggestedValue);
  const executionOrderType = parameterName === "execution.orderType" &&
    (suggestedValue === "MARKET" ||
      suggestedValue === "LIMIT_OFFSET" ||
      suggestedValue === "ADAPTIVE");
  const breakHandling = [
    "trend.trend1hBreakHandling",
    "trend.structure30mBreakHandling",
  ].includes(parameterName) && (
    suggestedValue === "REJECT" ||
    suggestedValue === "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM"
  );
  const liquidationFactorMode =
    parameterName === "liquidationFactors.mode" &&
    (suggestedValue === "SHADOW" || suggestedValue === "LIVE");
  if (
    !APPLYABLE_STRATEGY_SUGGESTION_PATHS.has(parameterName) ||
    (!numericValue &&
      !executionOrderType &&
      !breakHandling &&
      !liquidationFactorMode)
  ) return null;
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const segments = parameterName
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".");
  let cursor: Record<string, unknown> | unknown[] = clone;
  for (const segment of segments.slice(0, -1)) {
    const key = Array.isArray(cursor) ? Number(segment) : segment;
    const next = cursor[key as keyof typeof cursor];
    if (!next || typeof next !== "object") return null;
    cursor = next as Record<string, unknown> | unknown[];
  }
  const finalSegment = segments.at(-1)!;
  const finalKey = Array.isArray(cursor) ? Number(finalSegment) : finalSegment;
  if (!(finalKey in cursor) && !breakHandling) return null;
  if (Array.isArray(cursor))
    cursor[Number(finalKey)] = suggestedValue;
  else
    cursor[String(finalKey)] = suggestedValue;
  return clone as T;
}
