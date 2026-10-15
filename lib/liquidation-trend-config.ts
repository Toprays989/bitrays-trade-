import {
  hasCompleteNetProfitPath,
  strategyPayoffProfile,
} from "./strategy-payoff.ts";
import {
  normalizeNexusPortfolioRiskConfig,
  type NexusPortfolioRiskConfig,
} from "./nexus-portfolio-risk.ts";
import { stripRetiredLiquidationFields } from "./nexus-compatibility.ts";
import { normalizeAutomatedOrderQuantityMultiplier } from "./order-quantity.ts";
import {
  normalizeStrategyAssetClassScope,
  STRATEGY_ASSET_CLASS_SCOPES,
  type StrategyAssetClassScope,
} from "./strategy-asset-scope.ts";
import {
  normalizeRelativeStrengthConfig,
  validateRelativeStrengthConfig,
  type RelativeStrengthConfig,
} from "./relative-strength-trend.ts";
import {
  normalizeNexusProbabilityPolicy,
  validateNexusProbabilityPolicy,
  type NexusProbabilityPolicy,
} from "./nexus-net-expectancy.ts";
import {
  DEFAULT_HIGH_POSITION_SHORT_CONFIG,
  normalizeHighPositionShortConfig,
  validateHighPositionShortConfig,
  type HighPositionShortConfig,
} from "./high-position-short.ts";
import {
  liquidationFactorPolicyError,
  type LiquidationFactorPolicy,
} from "./liquidation-derived-factors.ts";

import {
  inferStrategyTriggerKind,
  validateStrategyTriggerIdentity,
  type StrategyTriggerKind,
} from "./strategy-trigger-catalog.ts";
import {
  normalizeLowPositionWindowTriggerConfig,
  validateLowPositionWindowTriggerConfig,
  type LowPositionWindowTriggerConfig,
} from "./strategy-triggers/low-position-config.ts";
import {
  normalizeThreeMinuteProbabilityTriggerConfig,
  validateThreeMinuteProbabilityTriggerConfig,
  type ThreeMinuteProbabilityTriggerConfig,
} from "./strategy-triggers/three-minute-probability-config.ts";
import {
  normalizeGridPriceLevelTriggerConfig,
  validateGridPriceLevelTriggerConfig,
  type GridPriceLevelTriggerConfig,
} from "./strategy-triggers/grid-price-level-config.ts";
import {
  normalizeScheduledScanTriggerConfig,
  validateScheduledScanTriggerConfig,
  type ScheduledScanTriggerConfig,
} from "./strategy-triggers/scheduled-scan-config.ts";
import {
  normalizeBreakoutRetestTriggerConfig,
  validateBreakoutRetestTriggerConfig,
  type BreakoutRetestTriggerConfig,
} from "./strategy-triggers/breakout-retest-config.ts";
import {
  normalizePositionEvidenceRiskConfig,
  type PositionEvidenceRiskConfig,
} from "./position-evidence-risk.ts";

import { normalizeStrategyTriggerScopedExecution } from "./strategy-default-parameters.ts";
import {
  validateStrategyPluginConfig,
  type StrategyPluginId,
} from "./strategy-plugins/registry.ts";

const THREE_MINUTE_LIMIT_ORDER_TTL_MS = 20_000;

export type LiquidationTakeProfitStep = {
  profitPercent: number;
  closePercent: number;
};

export type PositionManagementConfig = {
  profitGivebackRoePoints: number;
  bottomRecoveryRoePoints: number;
  tailWaveExitEnabled: boolean;
  tailWaveObservationMinutes: number;
  tailWaveMaximumPositionPercent: number;
  tailWavePeakGivebackAtr: number;
  addOnEnabled: boolean;
  profitScaleInEnabled: boolean;
  addOnNotionalUsdt: number;
  maxAddOnsPerPosition: number;
  minMinutesBetweenAddOns: number;
  maxAddOnLossRoePercent: number;
  contrarianFallbackEnabled: boolean;
  contrarianProbeNotionalUsdt: number;
  contrarianProfitRoeBeforeHedge: number;
  evidenceRisk: PositionEvidenceRiskConfig;
};

export type LargeTraderConfirmationConfig = {
  minOpenInterestChangePercent: number;
  minTopPositionRatioChangePercent: number;
  minTopAccountRatioChangePercent: number;
  minTakerBuySellRatio: number;
  maxDataAgeMinutes: number;
};

export type HigherTimeframeBreakHandling =
  | "REJECT"
  | "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";

/**
 * All automated strategy entries use one stable leverage. Order quantity is
 * independently derived from the exchange minimum; leverage must never be
 * used to expand the order notional.
 */
export const AUTOMATED_STRATEGY_LEVERAGE = 10;
export const AUTOMATED_STRATEGY_MAX_LEVERAGE = 125;

/**
 * Resting-order lifetime is selected by each strategy brain. The shared
 * executor only validates a bounded operational range and performs the cancel
 * reconciliation requested by that strategy version.
 */
export const ENTRY_ORDER_TTL_MIN_SECONDS = 180;
export const ENTRY_ORDER_TTL_MAX_SECONDS = 1_800;
export const ENTRY_ORDER_TTL_LEGACY_MAX_SECONDS = 1_800;
export const LIQUIDATION_LIMIT_ORDER_TTL_DEFAULT_MS = 1_500;
export const LIQUIDATION_LIMIT_ORDER_TTL_MIN_MS = 500;
export const LIQUIDATION_LIMIT_ORDER_TTL_MAX_MS = 5_000;

export function normalizedEntryOrderTtlSeconds(input: {
  value: unknown;
  marketProfileMode?: "UNIFIED" | "TRADFI" | null;
}) {
  const fallback = ENTRY_ORDER_TTL_MIN_SECONDS;
  const numeric = Number(input.value);
  if (!Number.isFinite(numeric) || numeric < ENTRY_ORDER_TTL_MIN_SECONDS)
    return fallback;
  return Math.max(
    ENTRY_ORDER_TTL_MIN_SECONDS,
    Math.min(ENTRY_ORDER_TTL_MAX_SECONDS, Math.trunc(numeric)),
  );
}

export function effectiveStrategyEntryOrderTtlMs(input: {
  config: LiquidationTrendConfig;
  exchangeOrderType: "MARKET" | "LIMIT";
}) {
  if (
    input.exchangeOrderType === "LIMIT" &&
    inferStrategyTriggerKind(input.config) === "THREE_MINUTE_PROBABILITY"
  ) return THREE_MINUTE_LIMIT_ORDER_TTL_MS;
  if (
    input.exchangeOrderType === "LIMIT" &&
    inferStrategyTriggerKind(input.config) === "LIQUIDATION_WINDOW"
  )
    return Math.max(
      LIQUIDATION_LIMIT_ORDER_TTL_MIN_MS,
      Math.min(
        LIQUIDATION_LIMIT_ORDER_TTL_MAX_MS,
        Math.trunc(
          input.config.execution.liquidationLimitOrderTtlMs ??
            LIQUIDATION_LIMIT_ORDER_TTL_DEFAULT_MS,
        ),
      ),
    );
  return Math.max(5_000, input.config.execution.orderTtlSeconds * 1_000);
}

export const DEFAULT_LARGE_TRADER_CONFIRMATION: LargeTraderConfirmationConfig = {
  minOpenInterestChangePercent: -1,
  minTopPositionRatioChangePercent: 0,
  minTopAccountRatioChangePercent: -3,
  minTakerBuySellRatio: 1,
  maxDataAgeMinutes: 12,
};

export type LiquidationTrendConfig = {
  /** Optional composition profile. It never owns orders or lifecycle state. */
  strategyPlugin?: {
    id: StrategyPluginId;
    version: string;
  };
  /** Identifies the UI/server default profile that initialized this editable config. */
  parameterProfile?: {
    version: string;
    triggerKind: StrategyTriggerKind;
  };
  /** Strategy-specific parameters consumed by the shared NEXUS brain. */
  probabilityPolicy?: NexusProbabilityPolicy;
  /**
   * Direction arbitration is opt-in. Existing BOTH strategies keep their two
   * trigger-directed listeners until a compatible same-snapshot adapter is
   * explicitly selected.
   */
  directionDecision?: {
    mode: "TRIGGER_DIRECTED" | "COMPETING_DIRECTIONS";
    minimumRewardRiskRatio?: number;
    minimumDirectionAdvantageRoePercent?: number;
    maximumUncertaintyRoePercent?: number;
  };
  /**
   * Market distribution belongs to the strategy, not to the shared NEXUS
   * brain.  A specialised profile may narrow the contract universe and the
   * event adapter, but it must not replace the price/volume/structure brain.
   */
  marketProfile?: {
    mode:
      | "UNIFIED"
      | "TRADFI"
      | "RELATIVE_STRENGTH"
      | "TREND_PULLBACK"
      | "HIGH_POSITION_SHORT"
      | "LOW_POSITION_LONG"
      | "THREE_MINUTE_PROBABILITY"
      | "GRID_PRICE"
      | "SCHEDULED_SCAN"
      | "BREAKOUT_RETEST";
    contractType?: "PERPETUAL" | "TRADIFI_PERPETUAL" | "MIXED_PERPETUAL";
    triggerPolicy?:
      | "LIQUIDATION_ONLY"
      | "PRICE_VOLUME_STRUCTURE"
      | "RELATIVE_STRENGTH_CONTINUATION"
      | "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
      | "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
      | "LOW_POSITION_WINDOW"
      | "THREE_MINUTE_PROBABILITY"
      | "GRID_PRICE_LEVEL"
      | "SCHEDULED_SCAN"
      | "BREAKOUT_RETEST";
    orderSizing?: "EXCHANGE_MINIMUM";
    /** TradFi high-position observation threshold; never authorizes an order alone. */
    highPosition72hPercent?: number;
    /** Latest closed 5m real volume versus its preceding 20-candle mean. */
    minimumRelativeVolume5m?: number;
    /** Bounded per-cycle scan prevents a specialised universe from increasing REST pressure. */
    maxWakeCandidatesPerCycle?: number;
    /** Nasdaq/underlying fair value is observable only after a reliable feed is connected. */
    referenceBenchmarkPolicy?: "OBSERVE_WHEN_AVAILABLE";
    /** Strategy-owned liquidity boundary used before expensive K-line reads. */
    minimumQuoteVolume24hUsdt?: number;
  };
  /** Independent strong-long / weak-short pair strategy. */
  relativeStrength?: RelativeStrengthConfig;
  /** Independent parameters for the high-position weakening short mode. */
  highPositionShort?: HighPositionShortConfig;
  direction?: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  shortTrend?: {
    minimumLongLiquidationSharePercent: number;
    minimumMarket60mDropPercent: number;
  };
  selectedSymbols: string[];
  /** Strategy-owned contract universe, evaluated before K-line analysis. */
  assetClassScope?: StrategyAssetClassScope;
  trigger: {
    /** Stable trigger identity; legacy configs infer it from marketProfile. */
    kind?: StrategyTriggerKind;
    /** Same-symbol cumulative liquidation notional inside the configured window. */
    minLiquidationNotionalUsdt: number;
    /** A single same-symbol liquidation that may independently trigger analysis. */
    minSingleLiquidationNotionalUsdt?: number;
    /** Zero disables the corresponding liquidation execution-price boundary. */
    minLiquidationPrice?: number;
    maxLiquidationPrice?: number;
    /** Binance WebSocket transport bucket; this is not the strategy cluster window. */
    aggregationWindowMs: number;
    maxSignalDelayMs: number;
    analysisValiditySeconds: number;
    cooldownMinutes: number;
    /** Zero means the strategy does not cap concurrent pre-order analyses. */
    maxConcurrentAnalyses?: number;
    minClusterEvents?: number;
    maxClusterSpanSeconds?: number;
    maxClusterEventGapSeconds?: number;
    /** Parameters owned only by the low-position trigger adapter. */
    lowPositionWindow?: LowPositionWindowTriggerConfig;
    /** Independent fixed-round probability trigger; never reuses probe quotas. */
    threeMinuteProbability?: ThreeMinuteProbabilityTriggerConfig;
    /** One-contract absolute price grid. It only wakes shared analysis. */
    gridPriceLevel?: GridPriceLevelTriggerConfig;
    /** Periodic market scan backed by shared closed-candle cache. */
    scheduledScan?: ScheduledScanTriggerConfig;
    /** Closed-candle breakout followed by a bounded retest. */
    breakoutRetest?: BreakoutRetestTriggerConfig;
  };
  /** Strategy-owned interpretation of the shared post-liquidation factor snapshot. */
  liquidationFactors?: Partial<LiquidationFactorPolicy>;
  marketPosition: {
    /** Legacy persisted field. Kept for old strategy JSON but no longer gates entry. */
    maxPosition24hPercent?: number;
    maxPosition72hPercent?: number;
  };
  trend: {
    volumeRatio3m: number;
    atrPeriod5m: number;
    maxEntryDistanceAtr: number;
    maxPriorRangeAtr?: number;
    trend1hBreakHandling?: HigherTimeframeBreakHandling;
    structure30mBreakHandling?: HigherTimeframeBreakHandling;
  };
  largeTrader?: LargeTraderConfirmationConfig;
  execution: {
    /** Follow the approved brain direction, or invert only the real order. */
    directionMode?: "FOLLOW_BRAIN" | "INVERSE_BRAIN";
    orderType: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
    /** SHADOW only records the structural alternative; LIVE lets it select the real order type. */
    entryDistanceExecutionMode?: "SHADOW" | "LIVE";
    limitOffsetPercent: number;
    adaptiveMarketMaxDistanceAtr?: number;
    orderTtlSeconds: number;
    /** Millisecond TTL used only by liquidation-triggered resting limits. */
    liquidationLimitOrderTtlMs?: number;
    allowSecondOrder: boolean;
    /** Strategy-owned handling for an already working order on the same leg. */
    sameLegWorkingOrderPolicy?: "BLOCK" | "ALLOW";
    /** Strategy-owned handling for increasing an existing same-direction leg. */
    existingPositionPolicy?: "BLOCK" | "ALLOW_SAME_DIRECTION";
    /** Strategy-owned handling when Binance minimum size exceeds risk sizing. */
    minimumOrderFloorMode?: "REJECT" | "ALLOW_WITH_MARGIN_GATE";
    /** Number of lifetime brain-authorized exploratory orders; zero disables. */
    explorationOrderTarget?: number;
    leverage: number;
    /** Fixed multiplier, or explicit-fact sizing between one and two units. */
    quantitySizingMode?: "FIXED" | "EVIDENCE_1_TO_2";
    /** Integer multiple of Binance's effective minimum quantity for new entries. */
    minimumOrderQuantityMultiplier?: number;
    /** Minimum executable notional for a new strategy position. */
    minimumPositionNotionalUsdt?: number;
    /** Initial margin target as a percentage of current Binance available capital. */
    equityAllocationPercent?: number;
    /** @deprecated 每日下单不再按笔数控制。 */
    maxOrdersPerDay?: number;
    /** Legacy JSON key. Amount of initial margin targeted for one order. */
    targetOrderNotionalUsdt: number;
    /** Legacy JSON key. Maximum initial margin for one order. */
    maxOrderNotionalUsdt: number;
    /** Legacy JSON key. Maximum accumulated initial margin per day. */
    maxDailyNotionalUsdt: number;
  };
  risk: {
    /** @deprecated 固定金额上限已改为账户权益比例。 */
    maxMarginUsageUsdt?: number;
    maxMarginUsagePercent: number;
    dailyLossLimitUsdt: number;
    stopLossPercent: number;
    minimumObservationMinutes?: number;
    liquidationGuardBufferPercent?: number;
    takeProfitSteps: LiquidationTakeProfitStep[];
    atrStopBuffer: number;
    dynamicTrailingEnabled?: boolean;
    trailingActivationPercent: number;
    trailingDrawdownPercent: number;
    portfolioRisk?: NexusPortfolioRiskConfig;
    positionManagement?: PositionManagementConfig;
  };
  validation: {
    minSamplesForSuggestion: number;
  };
};

const SYMBOL_PATTERN = /^[A-Z0-9]{1,16}USDT$/;

export function validateLiquidationTrendConfig(
  value: unknown,
  options: { allowHistoricalLeverage?: boolean } = {},
): string | null {
  if (!isRecord(value)) return "爆仓策略参数无效";
  const config = value as Partial<LiquidationTrendConfig>;
  const strategyPluginError = validateStrategyPluginConfig(value);
  if (strategyPluginError) return strategyPluginError;
  if (config.probabilityPolicy !== undefined) {
    const probabilityError = validateNexusProbabilityPolicy(
      config.probabilityPolicy,
    );
    if (probabilityError) return probabilityError;
  }
  if (config.directionDecision !== undefined) {
    if (
      !isRecord(config.directionDecision) ||
      !["TRIGGER_DIRECTED", "COMPETING_DIRECTIONS"].includes(
        String(config.directionDecision.mode),
      ) ||
      !finiteInRange(
        config.directionDecision.minimumRewardRiskRatio ?? 1.2,
        1,
        20,
      ) ||
      !finiteInRange(
        config.directionDecision.minimumDirectionAdvantageRoePercent ?? 0.15,
        0,
        100,
      ) ||
      !finiteInRange(
        config.directionDecision.maximumUncertaintyRoePercent ?? 1.5,
        0,
        100,
      )
    ) return "多空方向裁决参数无效";
    if (
      config.directionDecision.mode === "COMPETING_DIRECTIONS" &&
      config.direction !== "BOTH"
    ) return "同快照多空竞争只适用于双向策略";
    if (
      config.directionDecision.mode === "COMPETING_DIRECTIONS" &&
      config.marketProfile?.mode === "RELATIVE_STRENGTH"
    ) return "相对强弱双腿策略必须使用独立配对裁决，不能选择单方向胜者";
    if (
      config.directionDecision.mode === "COMPETING_DIRECTIONS" &&
      config.execution?.directionMode === "INVERSE_BRAIN"
    ) return "同快照多空竞争完成后不能再次翻转执行方向";
    if (
      config.directionDecision.mode === "COMPETING_DIRECTIONS" &&
      config.trigger?.kind !== "SCHEDULED_SCAN"
    ) return "当前同快照多空竞争仅由定时扫描适配器支持";
  }
  if (
    config.marketProfile !== undefined &&
    (!isRecord(config.marketProfile) ||
      !["UNIFIED", "TRADFI", "RELATIVE_STRENGTH", "TREND_PULLBACK", "HIGH_POSITION_SHORT", "LOW_POSITION_LONG", "THREE_MINUTE_PROBABILITY", "GRID_PRICE", "SCHEDULED_SCAN", "BREAKOUT_RETEST"].includes(String(config.marketProfile.mode)) ||
      (config.marketProfile.contractType !== undefined &&
        !["PERPETUAL", "TRADIFI_PERPETUAL", "MIXED_PERPETUAL"].includes(
          String(config.marketProfile.contractType),
        )) ||
      (config.marketProfile.triggerPolicy !== undefined &&
        !["LIQUIDATION_ONLY", "PRICE_VOLUME_STRUCTURE", "RELATIVE_STRENGTH_CONTINUATION", "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE", "HIGH_POSITION_PRICE_VOLUME_STRUCTURE", "LOW_POSITION_WINDOW", "THREE_MINUTE_PROBABILITY", "GRID_PRICE_LEVEL", "SCHEDULED_SCAN", "BREAKOUT_RETEST"].includes(
          String(config.marketProfile.triggerPolicy),
        )) ||
      (config.marketProfile.orderSizing !== undefined &&
        config.marketProfile.orderSizing !== "EXCHANGE_MINIMUM") ||
      (config.marketProfile.highPosition72hPercent !== undefined &&
        !finiteInRange(config.marketProfile.highPosition72hPercent, 50, 100)) ||
      (config.marketProfile.minimumRelativeVolume5m !== undefined &&
        !finiteInRange(config.marketProfile.minimumRelativeVolume5m, 1, 10)) ||
      (config.marketProfile.maxWakeCandidatesPerCycle !== undefined &&
        !finiteInRange(config.marketProfile.maxWakeCandidatesPerCycle, 1, 10)) ||
      (config.marketProfile.referenceBenchmarkPolicy !== undefined &&
        config.marketProfile.referenceBenchmarkPolicy !==
          "OBSERVE_WHEN_AVAILABLE") ||
      (config.marketProfile.minimumQuoteVolume24hUsdt !== undefined &&
        !finiteInRange(config.marketProfile.minimumQuoteVolume24hUsdt, 1)))
  )
    return "策略市场分布参数无效";
  if (config.marketProfile?.mode === "RELATIVE_STRENGTH") {
    const relativeError = validateRelativeStrengthConfig(config.relativeStrength);
    if (relativeError) return relativeError;
    if (config.direction !== "BOTH") return "相对强弱策略必须保持双向，分别建立强腿多仓和弱腿空仓";
    if (config.execution?.directionMode === "INVERSE_BRAIN") return "相对强弱策略不能与反人性翻转同时启用";
  }
  if (config.marketProfile?.mode === "TREND_PULLBACK") {
    if (config.direction !== "BOTH") return "高流动性趋势回踩策略必须保持双向";
    if (config.execution?.directionMode === "INVERSE_BRAIN")
      return "高流动性趋势回踩策略必须跟随大脑方向";
    if (
      config.marketProfile.triggerPolicy !==
        "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
    ) return "高流动性趋势回踩策略触发方式无效";
  }
  if (config.marketProfile?.mode === "HIGH_POSITION_SHORT") {
    const highPositionError = validateHighPositionShortConfig(
      config.highPositionShort,
    );
    if (highPositionError) return highPositionError;
    if (config.direction !== "SHORT_ONLY")
      return "高位转弱做空策略必须严格配置为仅做空";
    if (config.execution?.directionMode === "INVERSE_BRAIN")
      return "高位转弱做空策略必须跟随共享大脑方向";
    if (
      config.marketProfile.triggerPolicy !==
        "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
    ) return "高位转弱做空策略触发方式无效";
  }
  if (config.marketProfile?.mode === "LOW_POSITION_LONG") {
    if (config.direction !== "LONG_ONLY")
      return "低位价格策略必须严格配置为仅做多";
    if (config.execution?.directionMode === "INVERSE_BRAIN")
      return "低位价格策略必须跟随共享大脑方向";
    if (config.marketProfile.triggerPolicy !== "LOW_POSITION_WINDOW")
      return "低位价格策略触发方式无效";
    const lowPositionError = validateLowPositionWindowTriggerConfig(
      config.trigger?.lowPositionWindow,
    );
    if (lowPositionError) return lowPositionError;
  }
  if (config.marketProfile?.mode === "THREE_MINUTE_PROBABILITY") {
    if (config.direction !== "BOTH")
      return "3分钟概率轮次策略必须允许大脑选择做多或做空";
    if (config.execution?.directionMode === "INVERSE_BRAIN")
      return "3分钟概率轮次必须执行概率模型确认的方向";
    if (config.marketProfile.triggerPolicy !== "THREE_MINUTE_PROBABILITY")
      return "3分钟概率轮次触发方式无效";
    const roundError = validateThreeMinuteProbabilityTriggerConfig(
      config.trigger?.threeMinuteProbability,
    );
    if (roundError) return roundError;
  }
  if (config.marketProfile?.mode === "GRID_PRICE") {
    if (config.marketProfile.triggerPolicy !== "GRID_PRICE_LEVEL")
      return "网格价位策略触发方式无效";
    if (config.execution?.directionMode === "INVERSE_BRAIN")
      return "网格价位策略必须执行网格触发后由共享大脑确认的方向";
    const gridError = validateGridPriceLevelTriggerConfig(
      config.trigger?.gridPriceLevel,
    );
    if (gridError) return gridError;
  }
  if (config.marketProfile?.mode === "SCHEDULED_SCAN") {
    if (config.marketProfile.triggerPolicy !== "SCHEDULED_SCAN")
      return "定时扫描策略触发方式无效";
    if (config.execution?.directionMode === "INVERSE_BRAIN")
      return "定时扫描策略必须执行共享大脑确认的方向";
    const scheduledError = validateScheduledScanTriggerConfig(
      config.trigger?.scheduledScan,
    );
    if (scheduledError) return scheduledError;
  }
  if (config.marketProfile?.mode === "BREAKOUT_RETEST") {
    if (config.marketProfile.triggerPolicy !== "BREAKOUT_RETEST")
      return "突破回踩策略触发方式无效";
    if (config.execution?.directionMode === "INVERSE_BRAIN")
      return "突破回踩策略必须执行突破方向经共享大脑复核后的方向";
    const breakoutError = validateBreakoutRetestTriggerConfig(
      config.trigger?.breakoutRetest,
    );
    if (breakoutError) return breakoutError;
  }
  if (
    config.direction !== undefined &&
    !["LONG_ONLY", "SHORT_ONLY", "BOTH"].includes(config.direction)
  )
    return "交易方向必须为仅做多、仅做空或双向";
  if (
    config.shortTrend !== undefined &&
    (!isRecord(config.shortTrend) ||
      !finiteInRange(
        config.shortTrend.minimumLongLiquidationSharePercent,
        50,
        100,
      ) ||
      !finiteInRange(
        config.shortTrend.minimumMarket60mDropPercent,
        0.01,
        20,
      ))
  )
    return "做空趋势参数无效";
  if (!Array.isArray(config.selectedSymbols)) return "爆仓策略合约范围无效";
  if (
    config.selectedSymbols.some(
      (symbol) =>
        typeof symbol !== "string" ||
        !SYMBOL_PATTERN.test(symbol.trim().toUpperCase()),
    )
  )
    return "爆仓策略包含无效合约";
  if (
    config.assetClassScope !== undefined &&
    !STRATEGY_ASSET_CLASS_SCOPES.includes(config.assetClassScope)
  ) return "策略资产范围无效";
  if (
    config.assetClassScope === "CUSTOM" &&
    config.selectedSymbols.length === 0
  ) return "自定义资产范围至少需要选择 1 个合约";
  if (
    config.marketProfile?.mode === "GRID_PRICE" &&
    config.selectedSymbols.length !== 1
  ) return "网格价位策略必须且只能选择 1 个合约";

  const trigger = config.trigger;
  if (!isRecord(trigger)) return "请配置爆仓触发参数";
  if (!finiteInRange(trigger.minLiquidationNotionalUsdt, Number.EPSILON))
    return "单币窗口累计爆仓金额必须大于 0";
  if (
    !finiteInRange(
      trigger.minSingleLiquidationNotionalUsdt ??
        trigger.minLiquidationNotionalUsdt,
      Number.EPSILON,
    )
  )
    return "单币单笔爆仓金额必须大于 0";
  if (!finiteInRange(trigger.minLiquidationPrice ?? 0, 0))
    return "最低爆仓价不能小于 0";
  if (!finiteInRange(trigger.maxLiquidationPrice ?? 0, 0))
    return "最高爆仓价不能小于 0";
  if (
    (trigger.maxLiquidationPrice ?? 0) > 0 &&
    (trigger.maxLiquidationPrice ?? 0) <
      (trigger.minLiquidationPrice ?? 0)
  )
    return "最高爆仓价不能低于最低爆仓价";
  if (trigger.aggregationWindowMs !== 1_000)
    return "当前 Binance 全市场强平流固定按 1000 毫秒聚合";
  if (!integerInRange(trigger.maxSignalDelayMs, 100, 10_000))
    return "爆仓信号最大延迟需为 100 至 10000 毫秒";
  if (!integerInRange(trigger.analysisValiditySeconds, 300, 1_800))
    return "分析有效期需为 300 至 1800 秒";
  if (!integerInRange(trigger.cooldownMinutes, 0, 1_440))
    return "同合约冷却时间需为 0 至 1440 分钟";
  if (!integerInRange(trigger.maxConcurrentAnalyses ?? 0, 0, 10_000))
    return "并行分析上限需为 0 至 10000，0 表示不限制";
  if (!integerInRange(trigger.minClusterEvents ?? 1, 1, 20))
    return "单币窗口连续爆仓事件数需为 1 至 20";
  if (!integerInRange(trigger.maxClusterSpanSeconds ?? 3, 1, 300))
    return "单币爆仓累计窗口需为 1 至 300 秒";
  if (!integerInRange(
    trigger.maxClusterEventGapSeconds ??
      trigger.maxClusterSpanSeconds ??
      3,
    1,
    300,
  ))
    return "连续爆仓相邻事件最大间隔需为 1 至 300 秒";
  if (
    (
      trigger.maxClusterEventGapSeconds ??
      trigger.maxClusterSpanSeconds ??
      3
    ) >
    (trigger.maxClusterSpanSeconds ?? 3)
  )
    return "相邻事件最大间隔不能超过累计时间窗口";
  const factorPolicyError = liquidationFactorPolicyError(
    config.liquidationFactors,
  );
  if (factorPolicyError) return factorPolicyError;

  const position = config.marketPosition;
  if (!isRecord(position)) return "请配置 72 小时价格位置";
  if (!finiteInRange(position.maxPosition72hPercent ?? 35, 5, 50))
    return "72 小时低位阈值需为 5% 至 50%";

  const trend = config.trend;
  if (!isRecord(trend)) return "请配置四周期判断参数";
  if (!finiteInRange(trend.volumeRatio3m, 1, 10))
    return "3 分钟成交量倍数需为 1 至 10";
  if (!integerInRange(trend.atrPeriod5m, 2, 100))
    return "5 分钟 ATR 周期需为 2 至 100";
  if (!finiteInRange(trend.maxEntryDistanceAtr, 0.1, 5))
    return "最大入场距离需为 0.1 至 5 ATR";
  if (!finiteInRange(trend.maxPriorRangeAtr ?? 4, 1, 12))
    return "扫盘前震荡区间宽度需为 1 至 12 ATR";
  if (!validBreakHandling(trend.trend1hBreakHandling ?? "REJECT"))
    return "1 小时破位处理方式无效";
  if (!validBreakHandling(trend.structure30mBreakHandling ?? "REJECT"))
    return "30 分钟破位处理方式无效";

  const largeTrader = normalizeLargeTraderConfirmation(config.largeTrader);
  if (!finiteInRange(largeTrader.minOpenInterestChangePercent, -20, 20))
    return "大户确认最低未平仓量变化需为 -20% 至 20%";
  if (!finiteInRange(largeTrader.minTopPositionRatioChangePercent, -20, 20))
    return "大户持仓比变化阈值需为 -20% 至 20%";
  if (!finiteInRange(largeTrader.minTopAccountRatioChangePercent, -20, 20))
    return "大户账户比变化阈值需为 -20% 至 20%";
  if (!finiteInRange(largeTrader.minTakerBuySellRatio, 0.5, 2))
    return "主动买卖比阈值需为 0.5 至 2";
  if (!integerInRange(largeTrader.maxDataAgeMinutes, 5, 30))
    return "大户聚合数据最大延迟需为 5 至 30 分钟";

  const execution = config.execution;
  if (!isRecord(execution)) return "请配置委托参数";
  if (
    execution.directionMode !== undefined &&
    !["FOLLOW_BRAIN", "INVERSE_BRAIN"].includes(execution.directionMode)
  ) return "策略执行方向模式无效";
  if (
    execution.directionMode === "INVERSE_BRAIN" &&
    execution.orderType !== "MARKET"
  ) return "反人性策略当前仅允许市价委托，避免反转方向后复用错误的限价锚点";
  if (
    execution.directionMode === "INVERSE_BRAIN" &&
    config.direction !== "BOTH"
  ) return "反人性策略必须保持双向大脑，真实委托才可逐单反向执行";
  if (!['MARKET', 'LIMIT_OFFSET', 'ADAPTIVE'].includes(String(execution.orderType)))
    return "下单方式无效";
  if (
    execution.entryDistanceExecutionMode !== undefined &&
    !["SHADOW", "LIVE"].includes(execution.entryDistanceExecutionMode)
  ) return "结构距离保护模式无效";
  if (
    execution.entryDistanceExecutionMode === "SHADOW" &&
    execution.orderType === "ADAPTIVE"
  ) return "观察模式需要保留固定市价或固定限价作为真实委托方式";
  if (!finiteInRange(execution.limitOffsetPercent, 0, 5))
    return "限价偏移量需为 0% 至 5%";
  if (!finiteInRange(execution.adaptiveMarketMaxDistanceAtr ?? 0.2, 0.05, 1))
    return "自适应市价距离需为 0.05 至 1 ATR";
  // Values down to five seconds remain readable for historical snapshots.
  // Runtime normalization upgrades every newly submitted resting order to the
  // current 180-300 second policy, so old strategy JSON never disables a live
  // strategy merely because the execution policy evolved.
  if (!integerInRange(execution.orderTtlSeconds, 5, ENTRY_ORDER_TTL_LEGACY_MAX_SECONDS))
    return "限价委托有效期需为 180 至 1800 秒";
  if (
    execution.liquidationLimitOrderTtlMs !== undefined &&
    inferStrategyTriggerKind(config as LiquidationTrendConfig) !==
      "LIQUIDATION_WINDOW"
  ) return "毫秒级接针委托时效只属于爆仓窗口触发器";
  if (
    execution.liquidationLimitOrderTtlMs !== undefined &&
    !integerInRange(
      execution.liquidationLimitOrderTtlMs,
      LIQUIDATION_LIMIT_ORDER_TTL_MIN_MS,
      LIQUIDATION_LIMIT_ORDER_TTL_MAX_MS,
    )
  ) return "爆仓接针限价有效期需为 500 至 5000 毫秒";
  if (execution.orderTtlSeconds >= trigger.analysisValiditySeconds)
    return "限价委托有效期必须小于分析有效期";
  if (typeof execution.allowSecondOrder !== "boolean")
    return "二次委托开关无效";
  if (
    execution.sameLegWorkingOrderPolicy !== undefined &&
    !["BLOCK", "ALLOW"].includes(execution.sameLegWorkingOrderPolicy)
  ) return "同方向工作订单策略无效";
  if (
    execution.existingPositionPolicy !== undefined &&
    !["BLOCK", "ALLOW_SAME_DIRECTION"].includes(
      execution.existingPositionPolicy,
    )
  ) return "已有同方向仓位策略无效";
  if (
    execution.minimumOrderFloorMode !== undefined &&
    !["REJECT", "ALLOW_WITH_MARGIN_GATE"].includes(
      execution.minimumOrderFloorMode,
    )
  ) return "交易所最小量处理方式无效";
  if (!integerInRange(execution.explorationOrderTarget ?? 10, 0, 150))
    return "探索下单名额需为 0 至 150 笔";
  if (
    options.allowHistoricalLeverage &&
    !integerInRange(execution.leverage, 1, 125)
  )
    return "历史策略杠杆必须为 1 至 125 倍";
  if (
    !options.allowHistoricalLeverage &&
    !integerInRange(execution.leverage, 1, AUTOMATED_STRATEGY_MAX_LEVERAGE)
  )
    return `策略自动下单杠杆必须为 1 至 ${AUTOMATED_STRATEGY_MAX_LEVERAGE} 倍`;
  if (!integerInRange(execution.minimumOrderQuantityMultiplier ?? 1, 1, 5))
    return "自动下单最小量倍数必须为 1 至 5 的整数";
  if (!finiteInRange(execution.minimumPositionNotionalUsdt ?? 15, 5))
    return "策略最低开仓名义价值必须不小于 5 USDT";
  if (!finiteInRange(execution.equityAllocationPercent ?? 5, 0.1, 100))
    return "单笔权益分配比例需为 0.1% 至 100%";
  if (
    execution.quantitySizingMode !== undefined &&
    !["FIXED", "EVIDENCE_1_TO_2"].includes(execution.quantitySizingMode)
  ) return "自动下单数量模式无效";
  const targetMargin = execution.targetOrderNotionalUsdt ?? 5.1;
  const maxOrderMargin = execution.maxOrderNotionalUsdt ?? 6;
  if (!finiteInRange(targetMargin, 0.1))
    return "目标单笔保证金必须不小于 0.1 USDT";
  // The target field is retained only for historical evidence compatibility.
  // It no longer sizes automatic orders and therefore cannot constrain the
  // independent per-order initial-margin ceiling.
  if (!finiteInRange(maxOrderMargin, 0.1))
    return "单笔最大保证金必须不小于 0.1 USDT";

  const risk = config.risk;
  if (!isRecord(risk)) return "请配置止盈止损参数";
  if (!finiteInRange(risk.maxMarginUsagePercent ?? 50, 1, 100))
    return "保证金占用参考需为账户权益的 1% 至 100%";
  if (!finiteInRange(risk.dailyLossLimitUsdt ?? 15, 0.1))
    return "策略单日亏损熔断线必须不小于 0.1 USDT";
  if (!finiteInRange(risk.stopLossPercent, Number.EPSILON))
    return "止损比例必须为大于 0 的有效数值";
  if (!integerInRange(risk.minimumObservationMinutes ?? 60, 0, 1_440))
    return "固定止损观察期需为 0 至 1440 分钟";
  if (!finiteInRange(risk.liquidationGuardBufferPercent ?? 5, 0.1, 50))
    return "强平保护缓冲需为 0.1% 至 50%";
  if (!finiteInRange(risk.atrStopBuffer, 0, 10))
    return "ATR 止损缓冲需为 0 至 10 倍";
  if (
    risk.dynamicTrailingEnabled !== undefined &&
    typeof risk.dynamicTrailingEnabled !== "boolean"
  )
    return "动态移动止损开关必须为布尔值";
  if (!finiteInRange(risk.trailingActivationPercent, 0.1))
    return "移动止损启动盈利必须不小于 0.1%";
  if (!finiteInRange(risk.trailingDrawdownPercent, 0.1))
    return "移动止损回撤必须不小于 0.1%";
  if (risk.portfolioRisk !== undefined) {
    if (!isRecord(risk.portfolioRisk)) return "组合风险预算参数无效";
    const portfolio = risk.portfolioRisk;
    for (const [field, raw] of Object.entries(portfolio)) {
      if (!Number.isFinite(Number(raw)))
        return `组合风险参数 ${field} 必须为有效数字`;
    }
    for (const field of [
      "perTradeRiskPercent",
      "strategyRiskBudgetPercent",
      "learningProbeRiskBudgetPercent",
      "maxPortfolioRiskPercent",
      "maxDirectionalRiskPercent",
      "maxCorrelationGroupRiskPercent",
      "drawdownCautionPercent",
      "drawdownReducedPercent",
      "drawdownHaltPercent",
    ] as const) {
      const raw = portfolio[field];
      if (raw !== undefined && !finiteInRange(raw, 0.01, 100))
        return `组合风险参数 ${field} 需为 0.01% 至 100%`;
    }
    for (const field of ["cautionMultiplier", "reducedMultiplier"] as const) {
      const raw = portfolio[field];
      if (raw !== undefined && !finiteInRange(raw, 0, 1))
        return `组合风险参数 ${field} 需为 0 至 1`;
    }
    const normalized = normalizeNexusPortfolioRiskConfig(portfolio);
    if (
      normalized.drawdownCautionPercent >
        normalized.drawdownReducedPercent ||
      normalized.drawdownReducedPercent >
        normalized.drawdownHaltPercent
    )
      return "组合回撤阈值必须按谨慎、缩减、停止依次增大";
  }
  const positionManagement = normalizePositionManagementConfig(
    risk.positionManagement,
    targetMargin,
  );
  if (!finiteInRange(positionManagement.profitGivebackRoePoints, 0.1))
    return "盈利回吐判断阈值必须不小于 0.1 个 ROE 百分点";
  if (!finiteInRange(positionManagement.bottomRecoveryRoePoints, 0.1))
    return "触底反弹确认幅度必须不小于 0.1 个 ROE 百分点";
  if (
    isRecord(risk.positionManagement) &&
    isRecord(risk.positionManagement.evidenceRisk) &&
    risk.positionManagement.evidenceRisk.enabled !== undefined &&
    typeof risk.positionManagement.evidenceRisk.enabled !== "boolean"
  ) return "早期证据减险开关无效";
  const evidenceRisk = positionManagement.evidenceRisk;
  if (!integerInRange(evidenceRisk.warningMinute, 1, 10))
    return "证据恶化预警节点需为 1 至 10 分钟";
  if (
    !integerInRange(evidenceRisk.reductionMinute, 2, 30) ||
    evidenceRisk.reductionMinute <= evidenceRisk.warningMinute
  ) return "部分减险节点必须晚于预警节点，且不超过 30 分钟";
  if (
    !integerInRange(evidenceRisk.exitMinute, 3, 120) ||
    evidenceRisk.exitMinute <= evidenceRisk.reductionMinute
  ) return "失效退出节点必须晚于部分减险节点，且不超过 120 分钟";
  if (!finiteInRange(evidenceRisk.reductionPercent, 1, 99))
    return "证据恶化减仓比例需为 1% 至 99%";
  if (!finiteInRange(evidenceRisk.minimumDeteriorationRoePoints, 0.1, 100))
    return "证据恶化最小扩大幅度需为 0.1 至 100 个 ROE 点";
  if (
    isRecord(risk.positionManagement) &&
    isRecord(risk.positionManagement.evidenceRisk) &&
    risk.positionManagement.evidenceRisk.exitRemainingOnPersistentInvalidation !== undefined &&
    typeof risk.positionManagement.evidenceRisk
      .exitRemainingOnPersistentInvalidation !== "boolean"
  ) return "减险后结构退出余仓开关无效";
  if (
    isRecord(risk.positionManagement) &&
    risk.positionManagement.tailWaveExitEnabled !== undefined &&
    typeof risk.positionManagement.tailWaveExitEnabled !== "boolean"
  ) return "尾仓二次波段退出开关无效";
  if (
    !integerInRange(positionManagement.tailWaveObservationMinutes, 15, 30)
  ) return "尾仓调整观察期需为 15 至 30 分钟";
  if (
    !finiteInRange(
      positionManagement.tailWaveMaximumPositionPercent,
      1,
      35,
    )
  ) return "二次波段退出仅允许用于占初始仓位 1% 至 35% 的尾仓";
  if (!finiteInRange(positionManagement.tailWavePeakGivebackAtr, 0.1, 3))
    return "尾仓首波峰回撤阈值需为 0.1 至 3 ATR";
  if (
    isRecord(risk.positionManagement) &&
    risk.positionManagement.addOnEnabled !== undefined &&
    typeof risk.positionManagement.addOnEnabled !== "boolean"
  )
    return "策略仓位自动补仓开关无效";
  if (
    isRecord(risk.positionManagement) &&
    risk.positionManagement.profitScaleInEnabled !== undefined &&
    typeof risk.positionManagement.profitScaleInEnabled !== "boolean"
  )
    return "盈利延续自动加仓开关无效";
  if (
    positionManagement.addOnEnabled ||
    positionManagement.profitScaleInEnabled
  ) {
    if (!finiteInRange(positionManagement.addOnNotionalUsdt, 0.1))
      return "自动补仓保证金必须不小于 0.1 USDT";
    if (positionManagement.addOnNotionalUsdt > maxOrderMargin)
      return "自动补仓保证金不能超过单笔最大保证金";
    if (!integerInRange(positionManagement.maxAddOnsPerPosition, 1, 10))
      return "单个策略仓位最多自动补仓次数需为 1 至 10";
    if (!integerInRange(positionManagement.minMinutesBetweenAddOns, 1, 1_440))
      return "自动补仓最短间隔需为 1 至 1440 分钟";
    if (!finiteInRange(positionManagement.maxAddOnLossRoePercent, 0.1))
      return "允许自动补仓的最大亏损 ROE 必须不小于 0.1%";
  }
  if (
    isRecord(risk.positionManagement) &&
    risk.positionManagement.contrarianFallbackEnabled !== undefined &&
    typeof risk.positionManagement.contrarianFallbackEnabled !== "boolean"
  )
    return "反向试单开关无效";
  if (
    positionManagement.contrarianFallbackEnabled &&
    config.direction !== "BOTH"
  )
    return "反向试单仅适用于双向策略；仅做多或仅做空必须严格遵守方向配置";
  if (!finiteInRange(positionManagement.contrarianProbeNotionalUsdt, 0.1))
    return "反向试单保证金必须不小于 0.1 USDT";
  if (positionManagement.contrarianProbeNotionalUsdt > maxOrderMargin)
    return "反向试单保证金不能超过单笔最大保证金";
  if (!finiteInRange(positionManagement.contrarianProfitRoeBeforeHedge, 0.1))
    return "反向试单利润保护阈值必须不小于 0.1 个 ROE 百分点";
  if (!Array.isArray(risk.takeProfitSteps) || risk.takeProfitSteps.length < 1)
    return "请至少配置一档分批止盈";
  if (risk.takeProfitSteps.length > 20) return "分批止盈最多配置 20 档";
  let previousProfit = 0;
  let totalClose = 0;
  for (const step of risk.takeProfitSteps) {
    if (!isRecord(step)) return "分批止盈参数无效";
    if (!finiteInRange(step.profitPercent, Number.EPSILON))
      return "每档止盈比例必须大于 0";
    if (step.profitPercent <= previousProfit)
      return "分批止盈比例必须按从小到大排列";
    if (!finiteInRange(step.closePercent, 0.1, 100))
      return "每档平仓比例需为 0.1% 至 100%";
    previousProfit = step.profitPercent;
    totalClose += step.closePercent;
  }
  if (totalClose > 100.000001) return "分批止盈平仓比例合计不能超过 100%";

  const validation = config.validation;
  if (!isRecord(validation)) return "请配置入场后验证参数";
  if (!integerInRange(validation.minSamplesForSuggestion, 30, 1_000))
    return "参数建议最低样本数需为 30 至 1000";
  return null;
}

export function validateLiquidationNetProfitPath(
  value: LiquidationTrendConfig,
): string | null {
  if (value.trigger.kind === "THREE_MINUTE_PROBABILITY") return null;
  const profile = strategyPayoffProfile({
    stopLossRoePercent: value.risk.stopLossPercent,
    takeProfitSteps: value.risk.takeProfitSteps,
    leverage: value.execution.leverage,
  });
  if (!profile) return "止盈止损参数无法形成有效收益结构";
  if (!profile.completeExitConfigured)
    return `分批止盈当前只覆盖 ${profile.configuredClosePercent.toFixed(1)}% 仓位；必须覆盖 100% 后才能启用实盘策略`;
  if (!hasCompleteNetProfitPath(profile))
    return "扣除预估双边手续费后无法形成有效净获利路径，请调整止盈、止损或杠杆";
  return null;
}

export function normalizeLiquidationTrendConfig(
  value: LiquidationTrendConfig,
): LiquidationTrendConfig {
  const direction =
    value.direction === "SHORT_ONLY" || value.direction === "BOTH"
      ? value.direction
      : "LONG_ONLY";
  const selectedSymbols = [
    ...new Set(
      value.selectedSymbols.map((symbol) => symbol.trim().toUpperCase()),
    ),
  ];
  const compatible = stripRetiredLiquidationFields({
    marketPosition: value.marketPosition as Record<string, unknown>,
    execution: value.execution as unknown as Record<string, unknown>,
    risk: value.risk as unknown as Record<string, unknown>,
  });
  const execution = compatible.execution as LiquidationTrendConfig["execution"];
  const risk = compatible.risk as LiquidationTrendConfig["risk"];
  const triggerKind = inferStrategyTriggerKind(value);
  const scopedExecution = normalizeStrategyTriggerScopedExecution(
    execution,
    triggerKind,
  ) as LiquidationTrendConfig["execution"];
  const {
    lowPositionWindow: rawLowPositionWindow,
    threeMinuteProbability: rawThreeMinuteProbability,
    gridPriceLevel: rawGridPriceLevel,
    scheduledScan: rawScheduledScan,
    breakoutRetest: rawBreakoutRetest,
    ...sharedTrigger
  } = value.trigger;
  const positionManagement = normalizePositionManagementConfig(
    value.risk.positionManagement,
    value.execution.targetOrderNotionalUsdt ?? 5.1,
  );
  if (direction !== "BOTH")
    positionManagement.contrarianFallbackEnabled = false;
  return {
    ...(value.strategyPlugin
      ? {
          strategyPlugin: {
            id: String(value.strategyPlugin.id) as StrategyPluginId,
            version: String(value.strategyPlugin.version ?? "").trim(),
          },
        }
      : {}),
    ...(value.parameterProfile
      ? {
          parameterProfile: {
            version: String(value.parameterProfile.version ?? ""),
            triggerKind,
          },
        }
      : {}),
    // Relative-strength pairs have their own two-leg continuation evidence.
    // A stale single-leg probability policy can be left behind by an old UI
    // session, but it must neither block an unrelated edit nor enter runtime.
    probabilityPolicy: normalizeNexusProbabilityPolicy(
      value.marketProfile?.mode === "RELATIVE_STRENGTH"
        ? undefined
        : value.probabilityPolicy,
    ),
    ...(value.directionDecision
      ? {
          directionDecision: {
            mode: value.directionDecision.mode === "COMPETING_DIRECTIONS"
              ? "COMPETING_DIRECTIONS" as const
              : "TRIGGER_DIRECTED" as const,
            minimumRewardRiskRatio:
              value.directionDecision.minimumRewardRiskRatio ?? 1.2,
            minimumDirectionAdvantageRoePercent:
              value.directionDecision.minimumDirectionAdvantageRoePercent ??
                0.15,
            maximumUncertaintyRoePercent:
              value.directionDecision.maximumUncertaintyRoePercent ?? 1.5,
          },
        }
      : {}),
    marketProfile: {
      mode: normalizedMarketProfileMode(value.marketProfile?.mode),
      contractType:
        value.marketProfile?.mode === "RELATIVE_STRENGTH"
          ? "MIXED_PERPETUAL"
          : value.marketProfile?.mode === "TRADFI"
          ? "TRADIFI_PERPETUAL"
          : value.marketProfile?.contractType ?? "PERPETUAL",
      triggerPolicy:
        value.marketProfile?.mode === "RELATIVE_STRENGTH"
          ? "RELATIVE_STRENGTH_CONTINUATION"
          : value.marketProfile?.mode === "TREND_PULLBACK"
            ? "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
          : value.marketProfile?.mode === "HIGH_POSITION_SHORT"
            ? "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
          : value.marketProfile?.mode === "LOW_POSITION_LONG"
            ? "LOW_POSITION_WINDOW"
          : value.marketProfile?.mode === "THREE_MINUTE_PROBABILITY"
            ? "THREE_MINUTE_PROBABILITY"
          : value.marketProfile?.mode === "GRID_PRICE"
            ? "GRID_PRICE_LEVEL"
          : value.marketProfile?.mode === "SCHEDULED_SCAN"
            ? "SCHEDULED_SCAN"
          : value.marketProfile?.mode === "BREAKOUT_RETEST"
            ? "BREAKOUT_RETEST"
          : value.marketProfile?.mode === "TRADFI" &&
        value.marketProfile?.triggerPolicy === "PRICE_VOLUME_STRUCTURE"
          ? "PRICE_VOLUME_STRUCTURE"
          : "LIQUIDATION_ONLY",
      orderSizing: "EXCHANGE_MINIMUM",
      ...(value.marketProfile?.mode === "TRADFI"
        ? {
            highPosition72hPercent:
              value.marketProfile.highPosition72hPercent ?? 85,
            minimumRelativeVolume5m:
              value.marketProfile.minimumRelativeVolume5m ?? 1.2,
            maxWakeCandidatesPerCycle: Math.max(
              1,
              Math.min(
                10,
                Math.trunc(value.marketProfile.maxWakeCandidatesPerCycle ?? 2),
              ),
            ),
            referenceBenchmarkPolicy: "OBSERVE_WHEN_AVAILABLE" as const,
          }
        : {}),
      ...(["TREND_PULLBACK", "HIGH_POSITION_SHORT"].includes(
        String(value.marketProfile?.mode),
      )
        ? {
            minimumQuoteVolume24hUsdt:
              value.marketProfile?.minimumQuoteVolume24hUsdt ?? 300_000_000,
            maxWakeCandidatesPerCycle: Math.max(
              1,
              Math.min(
                10,
                Math.trunc(value.marketProfile?.maxWakeCandidatesPerCycle ?? 2),
              ),
            ),
            ...(value.marketProfile?.mode === "HIGH_POSITION_SHORT"
              ? {
                  highPosition72hPercent:
                    value.highPositionShort?.minimumPosition72hPercent ??
                    DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumPosition72hPercent,
                  minimumRelativeVolume5m:
                    value.highPositionShort?.minimumSellerVolumeRatio3m ??
                    DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumSellerVolumeRatio3m,
                }
              : {}),
          }
        : {}),
    },
    ...(value.marketProfile?.mode === "RELATIVE_STRENGTH"
      ? { relativeStrength: normalizeRelativeStrengthConfig(value.relativeStrength) }
      : {}),
    ...(value.marketProfile?.mode === "HIGH_POSITION_SHORT"
      ? {
          highPositionShort: normalizeHighPositionShortConfig(
            value.highPositionShort,
          ),
        }
      : {}),
    direction,
    shortTrend: {
      minimumLongLiquidationSharePercent:
        value.shortTrend?.minimumLongLiquidationSharePercent ?? 65,
      minimumMarket60mDropPercent:
        value.shortTrend?.minimumMarket60mDropPercent ?? 0.2,
    },
    selectedSymbols,
    assetClassScope: normalizeStrategyAssetClassScope({
      value: value.assetClassScope,
      selectedSymbols,
    }),
    trigger: {
      ...sharedTrigger,
      kind: inferStrategyTriggerKind(value),
      ...(value.marketProfile?.mode === "LOW_POSITION_LONG"
        ? {
            lowPositionWindow: normalizeLowPositionWindowTriggerConfig(
              rawLowPositionWindow,
            ),
          }
        : {}),
      ...(value.marketProfile?.mode === "THREE_MINUTE_PROBABILITY"
        ? {
            threeMinuteProbability:
              normalizeThreeMinuteProbabilityTriggerConfig(
                rawThreeMinuteProbability,
              ),
          }
        : {}),
      ...(value.marketProfile?.mode === "GRID_PRICE"
        ? {
            gridPriceLevel: normalizeGridPriceLevelTriggerConfig(
              rawGridPriceLevel,
            ),
          }
        : {}),
      ...(value.marketProfile?.mode === "SCHEDULED_SCAN"
        ? {
            scheduledScan: normalizeScheduledScanTriggerConfig(
              rawScheduledScan,
            ),
          }
        : {}),
      ...(value.marketProfile?.mode === "BREAKOUT_RETEST"
        ? {
            breakoutRetest: normalizeBreakoutRetestTriggerConfig(
              rawBreakoutRetest,
            ),
          }
        : {}),
      minSingleLiquidationNotionalUsdt:
        value.trigger.minSingleLiquidationNotionalUsdt ??
        value.trigger.minLiquidationNotionalUsdt,
      minLiquidationPrice: value.trigger.minLiquidationPrice ?? 0,
      maxLiquidationPrice: value.trigger.maxLiquidationPrice ?? 0,
      minClusterEvents: Math.max(1, value.trigger.minClusterEvents ?? 3),
      maxClusterSpanSeconds: value.trigger.maxClusterSpanSeconds ?? 120,
      maxClusterEventGapSeconds:
        value.trigger.maxClusterEventGapSeconds ??
        value.trigger.maxClusterSpanSeconds ??
        30,
      maxConcurrentAnalyses: Math.max(
        0,
        Math.trunc(value.trigger.maxConcurrentAnalyses ?? 0),
      ),
    },
    liquidationFactors: value.liquidationFactors,
    marketPosition: {
      ...compatible.marketPosition,
      maxPosition72hPercent: value.marketPosition.maxPosition72hPercent ?? 35,
    },
    trend: {
      ...value.trend,
      maxPriorRangeAtr: value.trend.maxPriorRangeAtr ?? 4,
      trend1hBreakHandling: value.trend.trend1hBreakHandling ??
        "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM",
      structure30mBreakHandling:
        value.trend.structure30mBreakHandling ??
          "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM",
    },
    largeTrader: normalizeLargeTraderConfirmation(value.largeTrader),
    execution: {
      ...scopedExecution,
      directionMode:
        execution.directionMode === "INVERSE_BRAIN"
          ? "INVERSE_BRAIN"
          : "FOLLOW_BRAIN",
      entryDistanceExecutionMode:
        execution.entryDistanceExecutionMode ??
        (execution.orderType === "ADAPTIVE" ? "LIVE" : "SHADOW"),
      // Preserve the exact leverage bound to an existing trace/position.
      // New and edited strategies are validated against the current automatic
      // leverage constant, but historical execution evidence must never be
      // rewritten when that constant changes.
      leverage: execution.leverage ?? AUTOMATED_STRATEGY_LEVERAGE,
      quantitySizingMode:
        execution.quantitySizingMode === "EVIDENCE_1_TO_2"
          ? "EVIDENCE_1_TO_2"
          : "FIXED",
      minimumOrderQuantityMultiplier:
        normalizeAutomatedOrderQuantityMultiplier(
          execution.minimumOrderQuantityMultiplier,
        ),
      minimumPositionNotionalUsdt:
        execution.minimumPositionNotionalUsdt ?? 15,
      equityAllocationPercent:
        execution.equityAllocationPercent ?? 5,
      targetOrderNotionalUsdt: value.execution.targetOrderNotionalUsdt ?? 5.1,
      maxOrderNotionalUsdt: value.execution.maxOrderNotionalUsdt ?? 6,
      maxDailyNotionalUsdt: value.execution.maxDailyNotionalUsdt ?? 60,
      // Market orders have neither an offset nor a resting order. Persisting a
      // stale offset beside MARKET made the UI and execution evidence disagree.
      limitOffsetPercent:
        value.execution.orderType === "MARKET"
          ? 0
          : value.execution.limitOffsetPercent,
      adaptiveMarketMaxDistanceAtr:
        value.execution.adaptiveMarketMaxDistanceAtr ?? 0.2,
      orderTtlSeconds: normalizedEntryOrderTtlSeconds({
        value: execution.orderTtlSeconds,
        marketProfileMode:
          value.marketProfile?.mode === "TRADFI" ? "TRADFI" : "UNIFIED",
      }),
      ...(triggerKind === "LIQUIDATION_WINDOW" &&
          value.execution.orderType !== "MARKET"
        ? {
            liquidationLimitOrderTtlMs: Math.max(
              LIQUIDATION_LIMIT_ORDER_TTL_MIN_MS,
              Math.min(
                LIQUIDATION_LIMIT_ORDER_TTL_MAX_MS,
                Math.trunc(
                  execution.liquidationLimitOrderTtlMs ??
                    LIQUIDATION_LIMIT_ORDER_TTL_DEFAULT_MS,
                ),
              ),
            ),
          }
        : {}),
      allowSecondOrder: value.execution.allowSecondOrder,
      sameLegWorkingOrderPolicy:
        execution.sameLegWorkingOrderPolicy === "ALLOW" ? "ALLOW" : "BLOCK",
      existingPositionPolicy:
        execution.existingPositionPolicy === "ALLOW_SAME_DIRECTION"
          ? "ALLOW_SAME_DIRECTION"
          : "BLOCK",
      minimumOrderFloorMode:
        execution.minimumOrderFloorMode === "ALLOW_WITH_MARGIN_GATE"
          ? "ALLOW_WITH_MARGIN_GATE"
          : "REJECT",
      explorationOrderTarget: Math.max(
        0,
        Math.min(150, Math.trunc(execution.explorationOrderTarget ?? 10)),
      ),
    },
    risk: {
      ...risk,
      maxMarginUsagePercent: value.risk.maxMarginUsagePercent ?? 50,
      dailyLossLimitUsdt: value.risk.dailyLossLimitUsdt ?? 15,
      minimumObservationMinutes:
        value.risk.minimumObservationMinutes ?? 60,
      liquidationGuardBufferPercent:
        value.risk.liquidationGuardBufferPercent ?? 5,
      dynamicTrailingEnabled:
        value.risk.dynamicTrailingEnabled ?? true,
      portfolioRisk: normalizeNexusPortfolioRiskConfig(
        value.risk.portfolioRisk,
      ),
      positionManagement,
      takeProfitSteps: value.risk.takeProfitSteps.map((step) => ({ ...step })),
    },
    validation: { ...value.validation },
  };
}

export type ResolvedLiquidationTrendConfig =
  | { config: LiquidationTrendConfig; error: null }
  | { config: null; error: string };

/**
 * One database/configuration boundary for UI saves, activation and workers.
 * Legacy optional fields are normalized first, then the strategy's own work
 * mode is validated. No caller may silently collapse a specialised mode.
 */
export function resolveLiquidationTrendConfig(
  value: unknown,
  options: { allowHistoricalLeverage?: boolean } = {},
): ResolvedLiquidationTrendConfig {
  if (!isCanonicalConfigShape(value)) {
    return {
      config: null,
      error: "策略参数结构不完整，无法识别策略模式",
    };
  }
  const discriminatorError = validateStrategyDiscriminator(value);
  if (discriminatorError) return { config: null, error: discriminatorError };
  const config = normalizeLiquidationTrendConfig(value);
  const error = validateLiquidationTrendConfig(config, options);
  return error ? { config: null, error } : { config, error: null };
}

function validateStrategyDiscriminator(
  value: LiquidationTrendConfig,
): string | null {
  const triggerIdentityError = validateStrategyTriggerIdentity(value);
  if (triggerIdentityError) return triggerIdentityError;
  const mode = value.marketProfile?.mode ?? "UNIFIED";
  if (![
    "UNIFIED",
    "TRADFI",
    "RELATIVE_STRENGTH",
    "TREND_PULLBACK",
    "HIGH_POSITION_SHORT",
    "LOW_POSITION_LONG",
    "THREE_MINUTE_PROBABILITY",
    "GRID_PRICE",
    "SCHEDULED_SCAN",
    "BREAKOUT_RETEST",
  ].includes(mode)) return "策略市场分布参数无效";
  const triggerPolicy = value.marketProfile?.triggerPolicy;
  if (
    triggerPolicy !== undefined &&
    ![
      "LIQUIDATION_ONLY",
      "PRICE_VOLUME_STRUCTURE",
      "RELATIVE_STRENGTH_CONTINUATION",
      "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE",
      "HIGH_POSITION_PRICE_VOLUME_STRUCTURE",
      "LOW_POSITION_WINDOW",
      "THREE_MINUTE_PROBABILITY",
      "GRID_PRICE_LEVEL",
      "SCHEDULED_SCAN",
      "BREAKOUT_RETEST",
    ].includes(triggerPolicy)
  ) return "策略市场分布参数无效";
  return null;
}

function isCanonicalConfigShape(
  value: unknown,
): value is LiquidationTrendConfig {
  if (!isRecord(value)) return false;
  return Boolean(
    Array.isArray(value.selectedSymbols) &&
      isRecord(value.trigger) &&
      isRecord(value.marketPosition) &&
      isRecord(value.trend) &&
      isRecord(value.execution) &&
      isRecord(value.risk) &&
      isRecord(value.validation),
  );
}

function normalizedMarketProfileMode(
  value: LiquidationTrendConfig["marketProfile"] extends infer T
    ? T extends { mode: infer M } ? M | undefined : never
    : never,
): NonNullable<LiquidationTrendConfig["marketProfile"]>["mode"] {
  return [
    "UNIFIED",
    "TRADFI",
    "RELATIVE_STRENGTH",
    "TREND_PULLBACK",
    "HIGH_POSITION_SHORT",
    "LOW_POSITION_LONG",
    "THREE_MINUTE_PROBABILITY",
    "GRID_PRICE",
    "SCHEDULED_SCAN",
    "BREAKOUT_RETEST",
  ].includes(String(value))
    ? value as NonNullable<LiquidationTrendConfig["marketProfile"]>["mode"]
    : "UNIFIED";
}

export function normalizePositionManagementConfig(
  value: unknown,
  fallbackNotionalUsdt = 5.1,
): PositionManagementConfig {
  const source = isRecord(value) ? value : {};
  return {
    profitGivebackRoePoints: numberOrDefault(
      source.profitGivebackRoePoints,
      3,
    ),
    bottomRecoveryRoePoints: numberOrDefault(
      source.bottomRecoveryRoePoints,
      2,
    ),
    tailWaveExitEnabled:
      typeof source.tailWaveExitEnabled === "boolean"
        ? source.tailWaveExitEnabled
        : true,
    tailWaveObservationMinutes: numberOrDefault(
      source.tailWaveObservationMinutes,
      15,
    ),
    tailWaveMaximumPositionPercent: numberOrDefault(
      source.tailWaveMaximumPositionPercent,
      35,
    ),
    tailWavePeakGivebackAtr: numberOrDefault(
      source.tailWavePeakGivebackAtr,
      0.5,
    ),
    // Duplicate entry and position addition are separate intents. New entries
    // remain unique by account + symbol + side, while a bound strategy position
    // may explicitly enable evidence-driven rebound additions.
    addOnEnabled:
      typeof source.addOnEnabled === "boolean"
        ? source.addOnEnabled
        : false,
    profitScaleInEnabled:
      typeof source.profitScaleInEnabled === "boolean"
        ? source.profitScaleInEnabled
        : false,
    addOnNotionalUsdt: numberOrDefault(
      source.addOnNotionalUsdt,
      fallbackNotionalUsdt,
    ),
    maxAddOnsPerPosition: numberOrDefault(
      source.maxAddOnsPerPosition,
      1,
    ),
    minMinutesBetweenAddOns: numberOrDefault(
      source.minMinutesBetweenAddOns,
      30,
    ),
    maxAddOnLossRoePercent: numberOrDefault(
      source.maxAddOnLossRoePercent,
      20,
    ),
    contrarianFallbackEnabled:
      typeof source.contrarianFallbackEnabled === "boolean"
        ? source.contrarianFallbackEnabled
        : false,
    contrarianProbeNotionalUsdt: numberOrDefault(
      source.contrarianProbeNotionalUsdt,
      fallbackNotionalUsdt,
    ),
    contrarianProfitRoeBeforeHedge: numberOrDefault(
      source.contrarianProfitRoeBeforeHedge,
      3,
    ),
    evidenceRisk: normalizePositionEvidenceRiskConfig(source.evidenceRisk),
  };
}

function validBreakHandling(value: unknown): value is HigherTimeframeBreakHandling {
  return value === "REJECT" ||
    value === "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
}

export function normalizeLargeTraderConfirmation(
  value: unknown,
): LargeTraderConfirmationConfig {
  if (!isRecord(value)) return { ...DEFAULT_LARGE_TRADER_CONFIRMATION };
  return {
    minOpenInterestChangePercent: numberOrDefault(
      value.minOpenInterestChangePercent,
      DEFAULT_LARGE_TRADER_CONFIRMATION.minOpenInterestChangePercent,
    ),
    minTopPositionRatioChangePercent: numberOrDefault(
      value.minTopPositionRatioChangePercent,
      DEFAULT_LARGE_TRADER_CONFIRMATION.minTopPositionRatioChangePercent,
    ),
    minTopAccountRatioChangePercent: numberOrDefault(
      value.minTopAccountRatioChangePercent,
      DEFAULT_LARGE_TRADER_CONFIRMATION.minTopAccountRatioChangePercent,
    ),
    minTakerBuySellRatio: numberOrDefault(
      value.minTakerBuySellRatio,
      DEFAULT_LARGE_TRADER_CONFIRMATION.minTakerBuySellRatio,
    ),
    maxDataAgeMinutes: numberOrDefault(
      value.maxDataAgeMinutes,
      DEFAULT_LARGE_TRADER_CONFIRMATION.maxDataAgeMinutes,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInRange(value: unknown, min: number, max = Number.MAX_VALUE) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integerInRange(value: unknown, min: number, max: number) {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function numberOrDefault(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
