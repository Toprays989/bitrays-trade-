import {
  normalizePositionManagementConfig,
  type LiquidationTrendConfig,
} from "./liquidation-trend-config.ts";
import { unifiedPositionLifecycleMetadata } from "./nexus-trading-architecture.ts";
import { unifiedCapitalEfficiencyExitRule } from "./structure-exit-policy.ts";
import {
  alignOrderQuantityDown,
  alignOrderQuantityUp,
  automatedOrderQuantityFromMinimum,
  effectiveMarketMinimumOrderQuantity,
  effectiveMinimumOrderQuantity,
  MARKET_MIN_NOTIONAL_BUFFER_PERCENT,
  normalizeAutomatedOrderQuantityMultiplier,
  orderQuantityFromTicks,
  orderQuantityTicks,
  quantityStepTolerance,
  resolveMinimumNotionalExitPolicy,
} from "./order-quantity.ts";

export type AdaptiveEntryExecutionContext = Readonly<{
  confirmedPath?: string | null;
  volumeTimingState?: string | null;
  bookAgeMs?: number | null;
  bookStaleAfterMs?: number | null;
  spreadBps?: number | null;
  strategyMaxEntryDistanceAtr?: number | null;
}>;

function resolveAdaptiveEntryExecution(input: {
  baseMaxDistanceAtr: number;
  context?: AdaptiveEntryExecutionContext;
}) {
  const confirmedPath = input.context?.confirmedPath ?? null;
  const volumeTimingState = input.context?.volumeTimingState ?? null;
  const bookAgeMs = finiteNonNegative(input.context?.bookAgeMs);
  const bookStaleAfterMs =
    finitePositive(input.context?.bookStaleAfterMs) ?? 500;
  const spreadBps = finiteNonNegative(input.context?.spreadBps);
  const strategyMaxEntryDistanceAtr =
    finitePositive(input.context?.strategyMaxEntryDistanceAtr);
  const bookFresh = bookAgeMs === null
    ? null
    : bookAgeMs <= bookStaleAfterMs;
  const breakoutContext = confirmedPath === "TREND_BREAKOUT";
  const retestContext = confirmedPath === "SUPPORT_REVERSAL";
  const breakoutEvidenceReady =
    breakoutContext &&
    volumeTimingState === "CURRENT_EXECUTION_CONFIRMED" &&
    bookFresh === true;
  const breakoutMaxDistanceAtr = Math.min(
    strategyMaxEntryDistanceAtr ?? input.baseMaxDistanceAtr,
    input.baseMaxDistanceAtr * 1.5,
  );
  const effectiveMaxDistanceAtr = breakoutEvidenceReady
    ? breakoutMaxDistanceAtr
    : input.baseMaxDistanceAtr;
  const marketContextEligible = breakoutContext
    ? breakoutEvidenceReady
    : retestContext
      ? false
      : true;

  return {
    confirmedPath,
    volumeTimingState,
    bookAgeMs,
    bookStaleAfterMs,
    bookFresh,
    spreadBps,
    strategyMaxEntryDistanceAtr,
    effectiveMaxDistanceAtr,
    fastBreakoutMarketEligible: breakoutEvidenceReady,
    marketContextEligible,
    gate: breakoutContext
      ? breakoutEvidenceReady
        ? "BREAKOUT_EXECUTION_CONFIRMED"
        : "BREAKOUT_EXECUTION_EVIDENCE_INCOMPLETE"
      : retestContext
        ? "RETEST_LIMIT_ONLY"
        : "DISTANCE_ONLY",
  } as const;
}

export function configuredEntryOrder(input: {
  orderType: LiquidationTrendConfig["execution"]["orderType"];
  markPrice: number;
  limitOffsetPercent: number;
  adaptiveMarketMaxDistanceAtr?: number;
  forceAnalyzedLimit?: boolean;
  explorationProbe?: boolean;
  priceTickSize: number;
  confirmationLevel?: number | null;
  invalidBoundary?: number | null;
  atr5m?: number | null;
  priorSupport?: number | null;
  sweepLow?: number | null;
  adaptiveExecutionContext?: AdaptiveEntryExecutionContext;
}) {
  if (
    !Number.isFinite(input.markPrice) || input.markPrice <= 0 ||
    !Number.isFinite(input.limitOffsetPercent) || input.limitOffsetPercent < 0
  ) return null;
  const confirmationLevel = finitePositive(input.confirmationLevel);
  const invalidBoundary = finitePositive(input.invalidBoundary);
  const atr5m = finitePositive(input.atr5m);
  const priorSupport = finitePositive(input.priorSupport);
  const sweepLow = finitePositive(input.sweepLow);
  const adaptiveMarketMaxDistanceAtr =
    finitePositive(input.adaptiveMarketMaxDistanceAtr) ?? 0.2;
  const adaptiveExecution = resolveAdaptiveEntryExecution({
    baseMaxDistanceAtr: adaptiveMarketMaxDistanceAtr,
    context: input.adaptiveExecutionContext,
  });
  const distanceAboveConfirmationAtr =
    confirmationLevel !== null && atr5m !== null
      ? (input.markPrice - confirmationLevel) / atr5m
      : null;
  const adaptiveMarketSelected =
    input.orderType === "ADAPTIVE" &&
    input.forceAnalyzedLimit !== true &&
    distanceAboveConfirmationAtr !== null &&
    distanceAboveConfirmationAtr >= 0 &&
    distanceAboveConfirmationAtr <= adaptiveExecution.effectiveMaxDistanceAtr &&
    adaptiveExecution.marketContextEligible;
  const selectedOrderType =
    input.orderType === "ADAPTIVE"
      ? adaptiveMarketSelected
        ? "MARKET"
        : "LIMIT_OFFSET"
      : input.orderType;
  const selectionReason =
    input.orderType === "ADAPTIVE" && input.forceAnalyzedLimit === true
      ? "首次限价未成交后的二次委托只重新计算承接限价，禁止追市价"
      : input.orderType !== "ADAPTIVE"
      ? "策略按固定委托方式执行"
      : distanceAboveConfirmationAtr === null
        ? "确认位或ATR证据不完整，采用限价承接，避免无依据追价"
        : distanceAboveConfirmationAtr < 0
          ? "价格尚未站稳确认位，采用限价承接"
          : adaptiveExecution.gate === "RETEST_LIMIT_ONLY"
            ? "支撑反转路径保留回踩限价，禁止把反转假设当作突破追价"
          : adaptiveExecution.gate ===
              "BREAKOUT_EXECUTION_EVIDENCE_INCOMPLETE"
            ? "突破路径缺少当前成交量延续或新鲜盘口，采用限价等待最新事实"
          : adaptiveMarketSelected
            ? `突破、当前成交量与盘口均确认，且距确认位不超过 ${adaptiveExecution.effectiveMaxDistanceAtr} ATR，采用市价跟随`
            : `价格距确认位已超过 ${adaptiveExecution.effectiveMaxDistanceAtr} ATR，采用限价等待回踩`;
  if (selectedOrderType === "MARKET")
    return {
      orderType: "MARKET" as const,
      price: null,
      analysis: {
        mode: "CONFIRMED_MARKET" as const,
        analyzedEntryPrice: input.markPrice,
        requestedMode: input.orderType,
        selectedOrderType: "MARKET" as const,
        selectionReason,
        confirmationLevel,
        atr5m,
        adaptiveMarketMaxDistanceAtr:
          input.orderType === "ADAPTIVE"
            ? adaptiveMarketMaxDistanceAtr
            : null,
        effectiveAdaptiveMarketMaxDistanceAtr:
          input.orderType === "ADAPTIVE"
            ? adaptiveExecution.effectiveMaxDistanceAtr
            : null,
        adaptiveExecutionContext: adaptiveExecution,
        distanceAboveConfirmationAtr,
      },
    };
  // Binance validates a market order against the live instrument when it is
  // submitted. A local price tick is only needed to construct a limit price;
  // a temporarily stale/missing contract-pool tick must never block an
  // otherwise valid market entry.
  if (
    !Number.isFinite(input.priceTickSize) ||
    input.priceTickSize <= 0
  ) return null;
  const offsetPrice = input.markPrice * (1 - input.limitOffsetPercent / 100);
  // A long-entry limit is an auditable retest price, not merely “current price
  // minus x%”.  The confirmation level is the first structural anchor.  A
  // configured offset may seek a deeper fill, but never below the invalidation
  // boundary plus a small ATR buffer; such an order would be betting after the
  // original analysis had already failed.
  const invalidationRecoveryFloor =
    invalidBoundary !== null && atr5m !== null
      ? invalidBoundary + atr5m * 0.1
      : invalidBoundary;
  const sweepRecoveryFloor =
    sweepLow !== null && atr5m !== null
      ? sweepLow + atr5m * 0.15
      : sweepLow;
  // A learning probe is explicitly authorized before the reclaim structure
  // has fully closed. Requiring the sweep-recovery floor here would contradict
  // that authorization and turn every fresh downswing into a terminal
  // "invalid price" rejection. It still respects the ATR invalidation floor;
  // the looser rule only removes the unconfirmed reclaim requirement.
  const structuralFloor = input.explorationProbe
    ? invalidationRecoveryFloor
    : maxFinitePositive(
        invalidationRecoveryFloor,
        sweepRecoveryFloor,
      );
  const structuralRetestAnchor = input.explorationProbe
    ? input.markPrice
    : minFinitePositive(
        confirmationLevel,
        priorSupport,
      ) ?? input.markPrice;
  const desiredPrice = Math.min(
    input.markPrice,
    structuralRetestAnchor,
    offsetPrice,
  );
  const rawPrice =
    structuralFloor !== null
      ? Math.max(desiredPrice, structuralFloor)
      : desiredPrice;
  if (rawPrice > input.markPrice + input.priceTickSize * 1e-8) return null;
  const ticks = Math.floor(
    (rawPrice + input.priceTickSize * 1e-8) / input.priceTickSize,
  );
  const price = Number((ticks * input.priceTickSize).toPrecision(15));
  return price > 0
    ? {
        orderType: "LIMIT" as const,
        price,
        analysis: {
          mode: "STRUCTURAL_RETEST_LIMIT" as const,
          analyzedEntryPrice: price,
          requestedMode: input.orderType,
          selectedOrderType: "LIMIT" as const,
          selectionReason,
          explorationProbe: input.explorationProbe === true,
          currentMarkPrice: input.markPrice,
          configuredOffsetPercent: input.limitOffsetPercent,
          mechanicalOffsetPrice: offsetPrice,
          confirmationLevel,
          priorSupport,
          sweepLow,
          invalidBoundary,
          atr5m,
          structuralRetestAnchor,
          invalidationRecoveryFloor,
          sweepRecoveryFloor,
          structuralFloor,
          adaptiveMarketMaxDistanceAtr:
            input.orderType === "ADAPTIVE"
              ? adaptiveMarketMaxDistanceAtr
              : null,
          effectiveAdaptiveMarketMaxDistanceAtr:
            input.orderType === "ADAPTIVE"
              ? adaptiveExecution.effectiveMaxDistanceAtr
              : null,
          adaptiveExecutionContext: adaptiveExecution,
          distanceAboveConfirmationAtr,
          invalidatesBelow: invalidBoundary,
          thesis:
            "多头爆仓确认下行压力后，只在已收回结构的回踩承接区挂单；继续破位则撤单重算。",
        },
      }
    : null;
}

export function configuredShortEntryOrder(input: {
  orderType: LiquidationTrendConfig["execution"]["orderType"];
  markPrice: number;
  limitOffsetPercent: number;
  adaptiveMarketMaxDistanceAtr?: number;
  priceTickSize: number;
  brokenSupport?: number | null;
  atr5m?: number | null;
  forceAnalyzedLimit?: boolean;
  adaptiveExecutionContext?: AdaptiveEntryExecutionContext;
}) {
  if (
    !Number.isFinite(input.markPrice) ||
    input.markPrice <= 0 ||
    !Number.isFinite(input.limitOffsetPercent) ||
    input.limitOffsetPercent < 0
  ) return null;
  const brokenSupport = finitePositive(input.brokenSupport);
  const atr5m = finitePositive(input.atr5m);
  const adaptiveMarketMaxDistanceAtr =
    finitePositive(input.adaptiveMarketMaxDistanceAtr) ?? 0.2;
  const adaptiveExecution = resolveAdaptiveEntryExecution({
    baseMaxDistanceAtr: adaptiveMarketMaxDistanceAtr,
    context: input.adaptiveExecutionContext,
  });
  const distanceBelowBrokenSupportAtr =
    brokenSupport !== null && atr5m !== null
      ? (brokenSupport - input.markPrice) / atr5m
      : null;
  const adaptiveMarketSelected =
    input.orderType === "ADAPTIVE" &&
    input.forceAnalyzedLimit !== true &&
    distanceBelowBrokenSupportAtr !== null &&
    distanceBelowBrokenSupportAtr >= 0 &&
    distanceBelowBrokenSupportAtr <= adaptiveExecution.effectiveMaxDistanceAtr &&
    adaptiveExecution.marketContextEligible;
  const selectedOrderType =
    input.orderType === "ADAPTIVE"
      ? adaptiveMarketSelected
        ? "MARKET"
        : "LIMIT"
      : input.orderType === "LIMIT_OFFSET"
        ? "LIMIT"
        : "MARKET";
  const common = {
    requestedMode: input.orderType,
    selectedOrderType,
    brokenSupport,
    atr5m,
    adaptiveMarketMaxDistanceAtr:
      input.orderType === "ADAPTIVE"
        ? adaptiveMarketMaxDistanceAtr
        : null,
    effectiveAdaptiveMarketMaxDistanceAtr:
      input.orderType === "ADAPTIVE"
        ? adaptiveExecution.effectiveMaxDistanceAtr
        : null,
    adaptiveExecutionContext: adaptiveExecution,
    distanceBelowBrokenSupportAtr,
  };
  if (selectedOrderType === "MARKET")
    return {
      orderType: "MARKET" as const,
      price: null,
      analysis: {
        ...common,
        mode: "CONFIRMED_MARKET" as const,
        analyzedEntryPrice: input.markPrice,
        selectionReason:
          input.orderType === "ADAPTIVE"
            ? "破位、当前成交量与盘口均确认，且价格尚未远离结构，采用市价成交"
            : "策略按固定市价执行",
      },
    };
  if (
    !Number.isFinite(input.priceTickSize) ||
    input.priceTickSize <= 0
  ) return null;
  const mechanicalOffsetPrice =
    input.markPrice * (1 + input.limitOffsetPercent / 100);
  const structuralRetestPrice =
    input.orderType === "ADAPTIVE" &&
      brokenSupport !== null &&
      brokenSupport > input.markPrice
      ? Math.min(brokenSupport, mechanicalOffsetPrice)
      : mechanicalOffsetPrice;
  const rawPrice = Math.max(input.markPrice, structuralRetestPrice);
  const ticks = Math.ceil(
    (rawPrice - input.priceTickSize * 1e-8) / input.priceTickSize,
  );
  const price = Number((ticks * input.priceTickSize).toPrecision(15));
  return price > 0
    ? {
        orderType: "LIMIT" as const,
        price,
        analysis: {
          ...common,
          mode: "FAILED_RETEST_LIMIT" as const,
          analyzedEntryPrice: price,
          currentMarkPrice: input.markPrice,
          mechanicalOffsetPrice,
          structuralRetestPrice,
          selectionReason:
            input.orderType === "ADAPTIVE" && input.forceAnalyzedLimit === true
              ? "首次限价未成交后的二次委托只重新计算承接限价，禁止追市价"
              : adaptiveExecution.gate === "RETEST_LIMIT_ONLY"
              ? "支撑反转路径保留反抽限价，禁止把反转假设当作突破追空"
              : adaptiveExecution.gate ===
                  "BREAKOUT_EXECUTION_EVIDENCE_INCOMPLETE"
              ? "破位路径缺少当前成交量延续或新鲜盘口，采用限价等待最新事实"
              : input.orderType === "ADAPTIVE"
              ? "价格已远离破位结构，限价等待反抽，不追空"
              : "策略按固定限价偏移执行",
        },
      }
    : null;
}

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finiteNonNegative(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function minFinitePositive(...values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length ? Math.min(...valid) : null;
}

function maxFinitePositive(...values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length ? Math.max(...valid) : null;
}

export function isKnownFokNotFilled(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; executionUnknown?: unknown; message?: unknown };
  if (value.executionUnknown === true) return false;
  return value.code === -5021 ||
    (typeof value.message === "string" && /FOK order has been rejected|could not be filled immediately/i.test(value.message));
}

export const LIQUIDATION_PILOT_LIMITS = {
  minRestRemainingWeightBeforeEntry: 100,
} as const;

export function smallestPilotQuantity(input: {
  markPrice: number;
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
  leverage: number;
  /** Persisted legacy name; business meaning is target initial margin. */
  targetNotionalUsdt: number;
  /** Persisted legacy name; business meaning is maximum initial margin. */
  maxOrderNotionalUsdt: number;
  minimumOrderQuantityMultiplier?: number;
}) {
  const {
    markPrice,
    minOrderQty,
    quantityStep,
    minNotionalUsdt,
    leverage,
    targetNotionalUsdt,
    maxOrderNotionalUsdt,
    minimumOrderQuantityMultiplier = 1,
  } = input;
  if (
    !Number.isFinite(markPrice) || markPrice <= 0 ||
    !Number.isFinite(minOrderQty) || minOrderQty <= 0 ||
    !Number.isFinite(quantityStep) || quantityStep <= 0 ||
    !Number.isFinite(minNotionalUsdt) || minNotionalUsdt <= 0 ||
    !Number.isFinite(leverage) || leverage < 1 ||
    !Number.isFinite(targetNotionalUsdt) || targetNotionalUsdt <= 0 ||
    !Number.isFinite(maxOrderNotionalUsdt) || maxOrderNotionalUsdt <= 0
  ) return null;
  // The persisted target-margin fields are retained as capital ceilings and
  // historical evidence only. Automated strategy orders always start from
  // Binance's minimum executable quantity, optionally expanded by the
  // strategy's explicit 1-5x minimum-quantity multiplier. Leverage never
  // enlarges notional size by itself.
  const targetOrderNotionalUsdt = targetNotionalUsdt * leverage;
  const maximumOrderNotionalUsdt = maxOrderNotionalUsdt * leverage;
  const normalizedMinimumOrderQuantityMultiplier =
    normalizeAutomatedOrderQuantityMultiplier(
      minimumOrderQuantityMultiplier,
    );
  const exchangeMinimum = effectiveMinimumOrderQuantity(
    minOrderQty,
    quantityStep,
    minNotionalUsdt,
    markPrice,
  );
  const quantity = automatedOrderQuantityFromMinimum(
    exchangeMinimum,
    quantityStep,
    normalizedMinimumOrderQuantityMultiplier,
  );
  const notional = quantity * markPrice;
  const requiredMargin = notional / leverage;
  if (
    !Number.isFinite(quantity) ||
    quantity < minOrderQty - 1e-12 ||
    notional < minNotionalUsdt - 1e-10 ||
    requiredMargin > maxOrderNotionalUsdt + 1e-10
  ) return null;
  return {
    quantity,
    notional,
    requiredMargin,
    targetMargin: targetNotionalUsdt,
    maximumMargin: maxOrderNotionalUsdt,
    targetOrderNotionalUsdt,
    maximumOrderNotionalUsdt,
  };
}

export function capRiskSizedEntryToConfiguredMargin(input: {
  riskSizedQuantity: number;
  entryPrice: number;
  leverage: number;
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
  targetMarginUsdt: number;
  maxOrderMarginUsdt: number;
  sizingCapitalUsdt: number;
  equityAllocationPercent: number;
  minimumPositionNotionalUsdt: number;
  explorationProbe: boolean;
  forceExchangeMinimumQuantity?: boolean;
  marketOrder: boolean;
  minimumOrderQuantityMultiplier?: number;
}) {
  const {
    riskSizedQuantity,
    entryPrice,
    leverage,
    minOrderQty,
    quantityStep,
    minNotionalUsdt,
    targetMarginUsdt,
    maxOrderMarginUsdt,
    sizingCapitalUsdt,
    equityAllocationPercent,
    minimumPositionNotionalUsdt,
    explorationProbe,
    forceExchangeMinimumQuantity = false,
    marketOrder,
    minimumOrderQuantityMultiplier = 1,
  } = input;
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(leverage) ||
    leverage < 1 ||
    !Number.isFinite(targetMarginUsdt) ||
    targetMarginUsdt <= 0 ||
    !Number.isFinite(maxOrderMarginUsdt) ||
    maxOrderMarginUsdt <= 0 ||
    !Number.isFinite(sizingCapitalUsdt) ||
    sizingCapitalUsdt <= 0 ||
    !Number.isFinite(equityAllocationPercent) ||
    equityAllocationPercent <= 0 ||
    equityAllocationPercent > 100 ||
    !Number.isFinite(minimumPositionNotionalUsdt) ||
    minimumPositionNotionalUsdt <= 0
  ) return null;

  // Strategy capital is controlled by the explicit per-order margin ceiling.
  // Historical daily turnover is telemetry only and must not shrink a new
  // order. Portfolio/direction/correlation budgets remain advisory.
  const configuredMarginCeiling = maxOrderMarginUsdt;
  if (configuredMarginCeiling <= 0) return null;
  const normalizedMinimumOrderQuantityMultiplier =
    normalizeAutomatedOrderQuantityMultiplier(
      minimumOrderQuantityMultiplier,
    );
  const equityTargetMarginUsdt =
    sizingCapitalUsdt * equityAllocationPercent / 100;
  const evidenceAdjustedTargetMarginUsdt =
    equityTargetMarginUsdt * normalizedMinimumOrderQuantityMultiplier;
  const approvedTargetMarginUsdt = Math.min(
    evidenceAdjustedTargetMarginUsdt,
    configuredMarginCeiling,
  );
  const approvedTargetNotionalUsdt = approvedTargetMarginUsdt * leverage;
  const minimumExecutableEntry = minimumExecutableConfiguredEntryMargin({
    entryPrice,
    leverage,
    minOrderQty,
    quantityStep,
    minNotionalUsdt,
    minimumPositionNotionalUsdt: forceExchangeMinimumQuantity
      ? minNotionalUsdt
      : minimumPositionNotionalUsdt,
    marketOrder,
  });
  if (!minimumExecutableEntry) return null;
  const {
    effectiveMinimumPositionNotionalUsdt,
    quantity: exchangeMinimumQuantity,
  } = minimumExecutableEntry;
  if (
    approvedTargetNotionalUsdt + 1e-10 <
      effectiveMinimumPositionNotionalUsdt
  ) return null;
  const maximumQuantity = alignOrderQuantityDown(
    approvedTargetNotionalUsdt / entryPrice,
    quantityStep,
  );
  const minimumQuantity = exchangeMinimumQuantity;
  if (
    !Number.isFinite(maximumQuantity) ||
    !Number.isFinite(minimumQuantity) ||
    maximumQuantity < minimumQuantity - quantityStepTolerance(quantityStep)
  ) return null;

  // New entries are sized from the configured share of account equity. Strong
  // evidence may apply the existing 1-2x multiplier, but the per-order margin
  // remains the hard ceiling. Falling below the effective
  // notional floor rejects entry instead of silently upsizing the order.
  const configuredTargetQuantityBeforeExchangeMinimum = alignOrderQuantityUp(
    targetMarginUsdt * leverage / entryPrice,
    minOrderQty,
    quantityStep,
  );
  const targetQuantity = maximumQuantity;
  // Exploration probes retain the strategy notional floor. A probability
  // decision may explicitly request the exchange minimum instead; that is a
  // separate sizing contract and must not be silently raised back to the
  // normal strategy floor.
  const minimumQuantityOnly =
    explorationProbe || forceExchangeMinimumQuantity;
  const quantity = minimumQuantityOnly ? minimumQuantity : maximumQuantity;
  if (
    !Number.isFinite(quantity) ||
    quantity < minimumQuantity - quantityStepTolerance(quantityStep)
  ) return null;
  const notionalUsdt = quantity * entryPrice;
  const requiredMarginUsdt = notionalUsdt / leverage;
  const exchangeMinimumForced =
    Math.abs(quantity - minimumQuantity) <=
      quantityStepTolerance(quantityStep);
  const wasClamped =
    approvedTargetMarginUsdt + 1e-10 <
      evidenceAdjustedTargetMarginUsdt;
  const sizingBasis = "ACCOUNT_EQUITY_PERCENT" as const;
  return {
    quantity,
    notionalUsdt,
    requiredMarginUsdt,
    configuredMarginCeiling,
    configuredTargetMarginUsdt: targetMarginUsdt,
    configuredTargetQuantity: targetQuantity,
    configuredTargetQuantityBeforeExchangeMinimum,
    configuredTargetNotionalUsdt:
      configuredTargetQuantityBeforeExchangeMinimum * entryPrice,
    sizingCapitalUsdt,
    equityAllocationPercent,
    equityTargetMarginUsdt,
    evidenceAdjustedTargetMarginUsdt,
    approvedTargetMarginUsdt,
    approvedTargetNotionalUsdt,
    minimumPositionNotionalUsdt,
    effectiveMinimumPositionNotionalUsdt,
    minimumQuantity,
    exchangeMinimumQuantity,
    exchangeMinimumNotionalUsdt: exchangeMinimumQuantity * entryPrice,
    minimumOrderQuantityMultiplier: normalizedMinimumOrderQuantityMultiplier,
    exchangeMinimumForced,
    sizingBasis,
    riskAdvisoryQuantity:
      Number.isFinite(riskSizedQuantity) && riskSizedQuantity > 0
        ? riskSizedQuantity
        : null,
    wasClamped,
    explorationProbe,
    forceExchangeMinimumQuantity,
    minimumQuantityOnly,
    minimumNotionalBufferPercent: marketOrder
      ? MARKET_MIN_NOTIONAL_BUFFER_PERCENT
      : 0,
  };
}

export function minimumExecutableConfiguredEntryMargin(input: {
  entryPrice: number;
  leverage: number;
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
  minimumPositionNotionalUsdt: number;
  marketOrder: boolean;
}) {
  const entryPrice = Number(input.entryPrice);
  const leverage = Number(input.leverage);
  const minOrderQty = Number(input.minOrderQty);
  const quantityStep = Number(input.quantityStep);
  const effectiveMinimumPositionNotionalUsdt = Math.max(
    Number(input.minNotionalUsdt),
    Number(input.minimumPositionNotionalUsdt),
  );
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(leverage) ||
    leverage < 1 ||
    !Number.isFinite(minOrderQty) ||
    minOrderQty <= 0 ||
    !Number.isFinite(quantityStep) ||
    quantityStep <= 0 ||
    !Number.isFinite(effectiveMinimumPositionNotionalUsdt) ||
    effectiveMinimumPositionNotionalUsdt <= 0
  ) return null;
  const quantity = input.marketOrder
    ? effectiveMarketMinimumOrderQuantity(
        minOrderQty,
        quantityStep,
        effectiveMinimumPositionNotionalUsdt,
        entryPrice,
      )
    : effectiveMinimumOrderQuantity(
        minOrderQty,
        quantityStep,
        effectiveMinimumPositionNotionalUsdt,
        entryPrice,
      );
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const notionalUsdt = quantity * entryPrice;
  return {
    quantity,
    notionalUsdt,
    requiredMarginUsdt: notionalUsdt / leverage,
    effectiveMinimumPositionNotionalUsdt,
  };
}

export function buildPilotRiskPlan(
  config: LiquidationTrendConfig,
  quantity: number,
  minOrderQty: number,
  quantityStep: number,
  executionRule?: {
    referencePrice: number;
    minNotionalUsdt: number;
  },
) {
  const positionManagement = normalizePositionManagementConfig(
    config.risk.positionManagement,
    config.execution?.targetOrderNotionalUsdt ?? 5.1,
  );
  const tailWaveExit = {
    ruleVersion: 1,
    enabled: positionManagement.tailWaveExitEnabled,
    initialQuantity: quantity,
    observationMinutes: positionManagement.tailWaveObservationMinutes,
    maximumTailPositionPercent:
      positionManagement.tailWaveMaximumPositionPercent,
    peakGivebackAtr: positionManagement.tailWavePeakGivebackAtr,
  };
  const takeProfits: Array<{
    triggerPercent: number;
    closePercent: number;
    closeQuantity: number;
  }> = [];
  const quantityTicks = orderQuantityTicks(quantity, quantityStep);
  const notionalExitPolicy = resolveMinimumNotionalExitPolicy({
    positionQuantity: quantity,
    referencePrice: executionRule?.referencePrice ?? Number.NaN,
    minNotionalUsdt: executionRule?.minNotionalUsdt ?? Number.NaN,
    plannedExitLegCount: config.risk.takeProfitSteps.length,
  });
  const executableMinimumQuantity = executionRule
    ? effectiveMinimumOrderQuantity(
        minOrderQty,
        quantityStep,
        executionRule.minNotionalUsdt,
        executionRule.referencePrice,
      )
    : minOrderQty;
  const minimumTicks = Math.max(
    1,
    Math.ceil(executableMinimumQuantity / quantityStep - 1e-10),
  );
  if (!Number.isSafeInteger(quantityTicks) || quantityTicks < minimumTicks)
    return {
      calculationMode: "ROE" as const,
      positionLifecycle: unifiedPositionLifecycleMetadata(),
      capitalEfficiencyExit: unifiedCapitalEfficiencyExitRule(),
      structureExitExecutionMode: "EXECUTE" as const,
      minimumObservationMinutes:
        config.risk.minimumObservationMinutes ?? 60,
      liquidationGuardBufferPercent:
        config.risk.liquidationGuardBufferPercent ?? 5,
      dynamicProfitProtectionEnabled:
        config.risk.dynamicTrailingEnabled ?? true,
      tailWaveExit,
      capitalPreservationStopVersion:
        "nexus-capital-preservation-stop-v1" as const,
      capitalPreservationStopRoePercent: config.risk.stopLossPercent,
      notionalExitPolicy,
      takeProfits: [],
      stopLosses: [],
    };
  const totalClosePercent = Math.min(
    100,
    config.risk.takeProfitSteps.reduce(
      (sum, step) => sum + step.closePercent,
      0,
    ),
  );
  if (
    notionalExitPolicy.mode === "SINGLE_FULL_EXIT" &&
    config.risk.takeProfitSteps.length > 0
  ) {
    takeProfits.push({
      triggerPercent: config.risk.takeProfitSteps[0].profitPercent,
      closePercent: 100,
      closeQuantity: orderQuantityFromTicks(quantityTicks, quantityStep),
    });
  }
  let targetCloseTicks = Math.floor(
    (quantityTicks * totalClosePercent) / 100 + 1e-10,
  );
  const targetRemainderTicks = quantityTicks - targetCloseTicks;
  if (targetRemainderTicks > 0 && targetRemainderTicks < minimumTicks)
    targetCloseTicks = quantityTicks;
  let allocatedTicks = 0;
  let cumulativeClosePercent = 0;
  for (
    let index = 0;
    notionalExitPolicy.mode === "STAGED" &&
      index < config.risk.takeProfitSteps.length;
    index += 1
  ) {
    const step = config.risk.takeProfitSteps[index];
    cumulativeClosePercent = Math.min(100, cumulativeClosePercent + step.closePercent);
    const last = index === config.risk.takeProfitSteps.length - 1;
    const cumulativeTargetTicks = last
      ? targetCloseTicks
      : Math.min(
          targetCloseTicks,
          Math.floor(
            (quantityTicks * cumulativeClosePercent) / 100 + 1e-10,
          ),
        );
    const closeTicks = cumulativeTargetTicks - allocatedTicks;
    // Invalid small allocations are carried forward and merged into the next
    // configured target instead of changing the strategy's total exit ratio.
    if (closeTicks < minimumTicks) continue;
    const remainingBeforeTicks = quantityTicks - allocatedTicks;
    const remainingAfterTicks = remainingBeforeTicks - closeTicks;
    const closeQuantity = orderQuantityFromTicks(closeTicks, quantityStep);
    takeProfits.push({
      triggerPercent: step.profitPercent,
      closePercent: remainingAfterTicks <= 0
        ? 100
        : Number(((closeTicks / remainingBeforeTicks) * 100).toFixed(6)),
      closeQuantity,
    });
    allocatedTicks = cumulativeTargetTicks;
    if (allocatedTicks >= targetCloseTicks) break;
  }
  // If the entire configured take-profit share is below the exchange minimum,
  // the position cannot be split. Close it once at the first configured target.
  if (!takeProfits.length) {
    const first = config.risk.takeProfitSteps[0];
    takeProfits.push({
      triggerPercent: first.profitPercent,
      closePercent: 100,
      closeQuantity: orderQuantityFromTicks(quantityTicks, quantityStep),
    });
  } else if (
    notionalExitPolicy.mode === "STAGED" &&
    allocatedTicks < targetCloseTicks
  ) {
    // A final sub-minimum remainder is merged into the last executable level.
    const tailTicks = targetCloseTicks - allocatedTicks;
    const last = takeProfits.at(-1)!;
    const lastTicks = orderQuantityTicks(last.closeQuantity, quantityStep);
    const mergedTicks = lastTicks + tailTicks;
    last.closeQuantity = orderQuantityFromTicks(mergedTicks, quantityStep);
    const remainingBeforeTicks =
      quantityTicks - (allocatedTicks - lastTicks);
    last.closePercent = targetCloseTicks >= quantityTicks
      ? 100
      : Number(((mergedTicks / remainingBeforeTicks) * 100).toFixed(6));
  }
  const dynamicProfitProtectionEnabled =
    config.risk.dynamicTrailingEnabled ?? true;
  return {
    calculationMode: "ROE",
    positionLifecycle: unifiedPositionLifecycleMetadata(),
    capitalEfficiencyExit: unifiedCapitalEfficiencyExitRule(),
    structureExitExecutionMode: "EXECUTE" as const,
    minimumObservationMinutes:
      config.risk.minimumObservationMinutes ?? 60,
    liquidationGuardBufferPercent:
      config.risk.liquidationGuardBufferPercent ?? 5,
    dynamicProfitProtectionEnabled,
    tailWaveExit,
    capitalPreservationStopVersion:
      "nexus-capital-preservation-stop-v1" as const,
    capitalPreservationStopRoePercent: config.risk.stopLossPercent,
    notionalExitPolicy,
    takeProfits,
    stopLosses: dynamicProfitProtectionEnabled
      ? []
      : [{
        triggerPercent: config.risk.stopLossPercent,
        closePercent: 100,
        closeQuantity: orderQuantityFromTicks(quantityTicks, quantityStep),
      }],
  };
}
