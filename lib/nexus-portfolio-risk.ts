import { effectiveMinimumOrderQuantity } from "./order-quantity.ts";
import { dynamicProfitProtection } from "./dynamic-profit-protection.ts";
import {
  positionRoePercent,
  priceAtRoePercent,
} from "./position-roe.ts";

export const NEXUS_PORTFOLIO_RISK_VERSION = "nexus-portfolio-risk-v3-advisory" as const;

export type NexusRiskClass = "STANDARD" | "LEARNING_PROBE";
export type NexusPositionRiskBasis =
  | "DYNAMIC_PROTECTION"
  | "FIXED_STOP_GRID"
  | "STRUCTURE_INVALIDATION"
  | "MARGIN_FALLBACK";

export type NexusPortfolioRiskConfig = {
  perTradeRiskPercent: number;
  strategyRiskBudgetPercent: number;
  learningProbeRiskBudgetPercent: number;
  maxPortfolioRiskPercent: number;
  maxDirectionalRiskPercent: number;
  maxCorrelationGroupRiskPercent: number;
  drawdownCautionPercent: number;
  drawdownReducedPercent: number;
  drawdownHaltPercent: number;
  cautionMultiplier: number;
  reducedMultiplier: number;
};

export const DEFAULT_NEXUS_PORTFOLIO_RISK: NexusPortfolioRiskConfig = {
  perTradeRiskPercent: 1,
  strategyRiskBudgetPercent: 4,
  learningProbeRiskBudgetPercent: 3,
  maxPortfolioRiskPercent: 8,
  maxDirectionalRiskPercent: 6,
  maxCorrelationGroupRiskPercent: 4,
  drawdownCautionPercent: 3,
  drawdownReducedPercent: 6,
  drawdownHaltPercent: 10,
  cautionMultiplier: 0.5,
  reducedMultiplier: 0.25,
};

export type NexusPortfolioExposure = {
  strategyId: number;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  correlationGroup: string;
  riskUsdt: number;
  riskClass?: NexusRiskClass;
  riskBasis?: NexusPositionRiskBasis | "RESERVED_INTENT";
  protectionPrice?: number | null;
};

export type NexusPositionStrategyBinding = {
  positionId: string | number | null;
  strategyId: number;
  symbol: string;
  state: string;
};

/**
 * Portfolio risk budgets are observation-only facts for automated strategies.
 *
 * Manual and semi-automatic positions still affect account equity and
 * available margin, but they must not consume a NEXUS brain's independent
 * strategy/portfolio allocation. Account drawdown is recorded for operations
 * and review; configured strategy margin limits own order admission and sizing.
 */
export function nexusAutomatedStrategyExposures(
  exposures: NexusPortfolioExposure[],
) {
  return exposures.filter(
    (exposure) =>
      Number.isInteger(exposure.strategyId) &&
      exposure.strategyId > 0 &&
      Number.isFinite(exposure.riskUsdt) &&
      exposure.riskUsdt > 0,
  );
}

export type NexusPortfolioDrawdownState =
  | "NORMAL"
  | "CAUTION"
  | "REDUCED"
  | "HALTED";

export type NexusPortfolioRiskPlan = {
  version: typeof NEXUS_PORTFOLIO_RISK_VERSION;
  shadowOnly: true;
  orderAffecting: false;
  status: "SIZED" | "REJECTED";
  reasonCode:
    | "RISK_SIZED"
    | "MINIMUM_ORDER_FLOOR_SIZED"
    | "PORTFOLIO_RISK_EXHAUSTED"
    | "DIRECTION_RISK_EXHAUSTED"
    | "CORRELATION_RISK_EXHAUSTED"
    | "STRATEGY_RISK_EXHAUSTED"
    | "LEARNING_PROBE_RISK_EXHAUSTED"
    | "DRAWDOWN_HALTED"
    | "INVALIDATION_DISTANCE_INVALID"
    | "MINIMUM_ORDER_EXCEEDS_RISK_BUDGET"
    | "INVALID_INPUT";
  reason: string;
  drawdownState: NexusPortfolioDrawdownState;
  drawdownPercent: number;
  correlationGroup: string;
  riskClass: NexusRiskClass;
  baseRiskBudgetUsdt: number;
  approvedRiskBudgetUsdt: number;
  quantity: number;
  notionalUsdt: number;
  requiredMarginUsdt: number;
  estimatedLossAtInvalidationUsdt: number;
  unitLossAtInvalidationUsdt: number;
  effectiveMinimumQuantity: number;
  currentRisk: {
    totalUsdt: number;
    portfolioUsdt: number;
    strategyUsdt: number;
    learningProbeUsdt: number;
    directionUsdt: number;
    correlationGroupUsdt: number;
  };
  remainingRisk: {
    portfolioUsdt: number;
    strategyUsdt: number;
    learningProbeUsdt: number;
    directionUsdt: number;
    correlationGroupUsdt: number;
  };
  limitSummary: string;
};

export const NEXUS_PORTFOLIO_RISK_CAPACITY_REASON_CODES = [
  "PORTFOLIO_RISK_EXHAUSTED",
  "DIRECTION_RISK_EXHAUSTED",
  "CORRELATION_RISK_EXHAUSTED",
  "STRATEGY_RISK_EXHAUSTED",
  "LEARNING_PROBE_RISK_EXHAUSTED",
] as const satisfies ReadonlyArray<NexusPortfolioRiskPlan["reasonCode"]>;

export const NEXUS_PORTFOLIO_RISK_CAPACITY_RESULT_CODES =
  NEXUS_PORTFOLIO_RISK_CAPACITY_REASON_CODES.map(
    (reasonCode) => `NEXUS_PORTFOLIO_RISK:${reasonCode}`,
  );

const NEXUS_PORTFOLIO_RISK_CAPACITY_WAIT_REASONS = new Set<
  NexusPortfolioRiskPlan["reasonCode"]
>(NEXUS_PORTFOLIO_RISK_CAPACITY_REASON_CODES);

/**
 * Compatibility helper for historical frozen traces that were blocked by risk
 * budgets. Current entry routes keep these codes as observation evidence only.
 */
export function isNexusPortfolioRiskCapacityWait(
  reasonCode: NexusPortfolioRiskPlan["reasonCode"],
) {
  return NEXUS_PORTFOLIO_RISK_CAPACITY_WAIT_REASONS.has(reasonCode);
}

export function calculateNexusPortfolioRiskPlan(input: {
  config?: Partial<NexusPortfolioRiskConfig>;
  strategyId: number;
  accountEquityUsdt: number;
  peakAccountEquityUsdt: number;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  correlationGroup?: string | null;
  entryPrice: number;
  invalidationPrice?: number | null;
  fallbackStopRoePercent: number;
  leverage: number;
  roundTripCostRate?: number;
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
  currentExposures?: NexusPortfolioExposure[];
  reservedExposures?: NexusPortfolioExposure[];
  minimumOrderFloorMode?: "REJECT" | "ALLOW_WITH_MARGIN_GATE";
  riskClass?: NexusRiskClass;
}): NexusPortfolioRiskPlan {
  const config = normalizeNexusPortfolioRiskConfig(input.config);
  const accountEquityUsdt = finitePositive(input.accountEquityUsdt);
  const peakAccountEquityUsdt = Math.max(
    finitePositive(input.peakAccountEquityUsdt),
    accountEquityUsdt,
  );
  const entryPrice = finitePositive(input.entryPrice);
  const leverage = finitePositive(input.leverage);
  const correlationGroup = nexusCorrelationGroup(
    input.symbol,
    input.correlationGroup,
  );
  const riskClass: NexusRiskClass =
    input.riskClass === "LEARNING_PROBE"
      ? "LEARNING_PROBE"
      : "STANDARD";
  const drawdownPercent = peakAccountEquityUsdt > 0
    ? Math.max(
        0,
        (peakAccountEquityUsdt - accountEquityUsdt) /
          peakAccountEquityUsdt *
          100,
      )
    : 100;
  const drawdown = nexusPortfolioDrawdownState(drawdownPercent, config);
  const exposures = [
    ...(input.currentExposures ?? []),
    ...(input.reservedExposures ?? []),
  ].filter((item) => Number.isFinite(item.riskUsdt) && item.riskUsdt > 0);
  const standardExposures = exposures.filter(
    (item) => item.riskClass !== "LEARNING_PROBE",
  );
  const probeExposures = exposures.filter(
    (item) => item.riskClass === "LEARNING_PROBE",
  );
  const totalRisk = sumRisk(exposures);
  const portfolioRisk = sumRisk(standardExposures);
  const strategyRisk = sumRisk(
    standardExposures.filter(
      (item) => item.strategyId === input.strategyId,
    ),
  );
  const learningProbeRisk = sumRisk(
    probeExposures.filter(
      (item) => item.strategyId === input.strategyId,
    ),
  );
  // Standard orders and minimum learning probes own separate risk lanes.
  // Otherwise a legacy/standard position can consume the direction or
  // correlation cap and accidentally disable the probe budget that was
  // explicitly reserved for collecting live evidence.
  const classScopedExposures =
    riskClass === "LEARNING_PROBE" ? probeExposures : standardExposures;
  const directionRisk = sumRisk(
    classScopedExposures.filter(
      (item) => item.positionSide === input.positionSide,
    ),
  );
  const correlationRisk = sumRisk(
    classScopedExposures.filter(
      (item) => item.correlationGroup === correlationGroup,
    ),
  );
  const remaining = {
    portfolioUsdt: remainingBudget(
      accountEquityUsdt,
      config.maxPortfolioRiskPercent,
      portfolioRisk,
    ),
    strategyUsdt: remainingBudget(
      accountEquityUsdt,
      config.strategyRiskBudgetPercent,
      strategyRisk,
    ),
    learningProbeUsdt: remainingBudget(
      accountEquityUsdt,
      config.learningProbeRiskBudgetPercent,
      learningProbeRisk,
    ),
    directionUsdt: remainingBudget(
      accountEquityUsdt,
      config.maxDirectionalRiskPercent,
      directionRisk,
    ),
    correlationGroupUsdt: remainingBudget(
      accountEquityUsdt,
      config.maxCorrelationGroupRiskPercent,
      correlationRisk,
    ),
  };
  const baseRiskBudgetUsdt =
    accountEquityUsdt * config.perTradeRiskPercent / 100 * drawdown.multiplier;
  const common = {
    version: NEXUS_PORTFOLIO_RISK_VERSION,
    shadowOnly: true as const,
    orderAffecting: false as const,
    drawdownState: drawdown.state,
    drawdownPercent,
    correlationGroup,
    riskClass,
    baseRiskBudgetUsdt,
    currentRisk: {
      totalUsdt: totalRisk,
      portfolioUsdt: portfolioRisk,
      strategyUsdt: strategyRisk,
      learningProbeUsdt: learningProbeRisk,
      directionUsdt: directionRisk,
      correlationGroupUsdt: correlationRisk,
    },
    remainingRisk: remaining,
    limitSummary: "",
  };
  common.limitSummary = formatNexusPortfolioRiskLimits({
    riskClass,
    accountEquityUsdt,
    config,
    currentRisk: common.currentRisk,
    remainingRisk: remaining,
    positionSide: input.positionSide,
    correlationGroup,
    drawdownPercent,
    drawdownState: drawdown.state,
  });
  const reject = (
    reasonCode: Exclude<
      NexusPortfolioRiskPlan["reasonCode"],
      "RISK_SIZED" | "MINIMUM_ORDER_FLOOR_SIZED"
    >,
    reason: string,
    approvedRiskBudgetUsdt = 0,
    unitLossAtInvalidationUsdt = 0,
    effectiveMinimumQuantity = 0,
  ): NexusPortfolioRiskPlan => ({
    ...common,
    status: "REJECTED",
    reasonCode,
    reason: `${reason}；${common.limitSummary}`,
    approvedRiskBudgetUsdt,
    quantity: 0,
    notionalUsdt: 0,
    requiredMarginUsdt: 0,
    estimatedLossAtInvalidationUsdt: 0,
    unitLossAtInvalidationUsdt,
    effectiveMinimumQuantity,
  });

  if (
    !Number.isInteger(input.strategyId) ||
    input.strategyId <= 0 ||
    !accountEquityUsdt ||
    !entryPrice ||
    !leverage ||
    !Number.isFinite(input.minOrderQty) ||
    input.minOrderQty <= 0 ||
    !Number.isFinite(input.quantityStep) ||
    input.quantityStep <= 0
  )
    return reject("INVALID_INPUT", "组合风险计算缺少有效账户、价格或交易规则");
  if (drawdown.state === "HALTED")
    return reject(
      "DRAWDOWN_HALTED",
      `账户峰值回撤已达到 ${config.drawdownHaltPercent.toFixed(2)}% 停止线`,
    );
  const sizingGuides = [
    ...(riskClass === "LEARNING_PROBE"
      ? [{
          value: remaining.learningProbeUsdt,
          code: "LEARNING_PROBE_RISK_EXHAUSTED" as const,
          reason: "当前大脑学习探针独立风险预算已用尽",
        }]
      : [
        {
          value: remaining.portfolioUsdt,
          code: "PORTFOLIO_RISK_EXHAUSTED" as const,
          reason: "组合常规风险预算已用尽",
        },
        {
          value: remaining.strategyUsdt,
          code: "STRATEGY_RISK_EXHAUSTED" as const,
          reason: "当前大脑常规风险预算已用尽",
        },
      ]),
    {
      value: remaining.directionUsdt,
      code: "DIRECTION_RISK_EXHAUSTED" as const,
      reason: `${input.positionSide === "LONG" ? "多头" : "空头"}方向风险预算已用尽`,
    },
    {
      value: remaining.correlationGroupUsdt,
      code: "CORRELATION_RISK_EXHAUSTED" as const,
      reason: `${correlationGroup} 关联组风险预算已用尽`,
    },
  ];
  const approvedRiskBudgetUsdt = Math.min(
    baseRiskBudgetUsdt,
    ...sizingGuides.map((item) => Math.max(0, item.value)),
  );
  const exhaustedGuides = sizingGuides
    .filter((item) => item.value <= 1e-10)
    .map((item) => item.reason);
  const exhaustedGuide = sizingGuides.find((item) => item.value <= 1e-10);
  if (exhaustedGuide)
    return reject(
      exhaustedGuide.code,
      exhaustedGuide.reason,
      approvedRiskBudgetUsdt,
    );

  const structuralUnitLoss = structuralLossPerUnit(
    entryPrice,
    input.invalidationPrice,
    input.positionSide,
  );
  const fallbackUnitLoss =
    entryPrice *
    finitePositive(input.fallbackStopRoePercent) /
    100 /
    leverage;
  const priceLossPerUnit = structuralUnitLoss ?? fallbackUnitLoss;
  const costPerUnit =
    entryPrice * Math.max(0, Number(input.roundTripCostRate) || 0);
  const unitLossAtInvalidationUsdt = priceLossPerUnit + costPerUnit;
  if (
    !Number.isFinite(unitLossAtInvalidationUsdt) ||
    unitLossAtInvalidationUsdt <= 0
  )
    return reject(
      "INVALIDATION_DISTANCE_INVALID",
      "结构失效距离和止损ROE均无法形成有效单位风险",
      approvedRiskBudgetUsdt,
    );

  const effectiveMinimumQuantity = effectiveMinimumOrderQuantity(
    input.minOrderQty,
    input.quantityStep,
    input.minNotionalUsdt,
    entryPrice,
  );
  const rawQuantity = approvedRiskBudgetUsdt / unitLossAtInvalidationUsdt;
  const riskSizedQuantity = alignQuantityDown(
    rawQuantity,
    input.quantityStep,
  );
  if (
    !Number.isFinite(effectiveMinimumQuantity) ||
    effectiveMinimumQuantity <= 0
  )
    return reject(
      "MINIMUM_ORDER_EXCEEDS_RISK_BUDGET",
      "交易所最小下单量无效，无法形成可执行数量",
      approvedRiskBudgetUsdt,
      unitLossAtInvalidationUsdt,
      effectiveMinimumQuantity,
    );
  const usesMinimumOrderFloor =
    riskSizedQuantity + 1e-12 < effectiveMinimumQuantity;
  if (
    usesMinimumOrderFloor &&
    input.minimumOrderFloorMode !== "ALLOW_WITH_MARGIN_GATE"
  )
    return reject(
      "MINIMUM_ORDER_EXCEEDS_RISK_BUDGET",
      "交易所最低有效量的失效风险超过当前配置预算",
      approvedRiskBudgetUsdt,
      unitLossAtInvalidationUsdt,
      effectiveMinimumQuantity,
    );
  // The result records whether a risk-sized suggestion can reach the exchange
  // minimum. Automated entry routes consume this result as observation only;
  // configured strategy margin remains the execution authority.
  const quantity = usesMinimumOrderFloor
    ? effectiveMinimumQuantity
    : riskSizedQuantity;
  const estimatedLossAtInvalidationUsdt =
    quantity * unitLossAtInvalidationUsdt;
  const notionalUsdt = quantity * entryPrice;
  return {
    ...common,
    status: "SIZED",
    reasonCode: usesMinimumOrderFloor
      ? "MINIMUM_ORDER_FLOOR_SIZED"
      : "RISK_SIZED",
    reason: `${
      usesMinimumOrderFloor
        ? exhaustedGuides.length
          ? `风险预算仅作仓位建议（${exhaustedGuides.join(
              "、",
            )}），已缩至交易所最低可执行量继续验证大脑判断`
          : "风险建议数量低于交易所最低量，已采用最低可执行量继续验证大脑判断"
        : riskClass === "LEARNING_PROBE"
          ? "已按学习探针风险参考、失效距离和当前敞口计算建议下单量"
          : "已按账户权益、失效距离和当前敞口计算建议下单量"
    }；${common.limitSummary}`,
    approvedRiskBudgetUsdt,
    quantity,
    notionalUsdt,
    requiredMarginUsdt: notionalUsdt / leverage,
    estimatedLossAtInvalidationUsdt,
    unitLossAtInvalidationUsdt,
    effectiveMinimumQuantity,
  };
}

export function normalizeNexusPortfolioRiskConfig(
  value?: Partial<NexusPortfolioRiskConfig>,
): NexusPortfolioRiskConfig {
  const merged = { ...DEFAULT_NEXUS_PORTFOLIO_RISK, ...(value ?? {}) };
  return {
    perTradeRiskPercent: bounded(merged.perTradeRiskPercent, 0.01, 100),
    strategyRiskBudgetPercent: bounded(
      merged.strategyRiskBudgetPercent,
      0.01,
      100,
    ),
    learningProbeRiskBudgetPercent: bounded(
      merged.learningProbeRiskBudgetPercent,
      0.01,
      100,
    ),
    maxPortfolioRiskPercent: bounded(
      merged.maxPortfolioRiskPercent,
      0.01,
      100,
    ),
    maxDirectionalRiskPercent: bounded(
      merged.maxDirectionalRiskPercent,
      0.01,
      100,
    ),
    maxCorrelationGroupRiskPercent: bounded(
      merged.maxCorrelationGroupRiskPercent,
      0.01,
      100,
    ),
    drawdownCautionPercent: bounded(
      merged.drawdownCautionPercent,
      0.01,
      100,
    ),
    drawdownReducedPercent: bounded(
      merged.drawdownReducedPercent,
      merged.drawdownCautionPercent,
      100,
    ),
    drawdownHaltPercent: bounded(
      merged.drawdownHaltPercent,
      merged.drawdownReducedPercent,
      100,
    ),
    cautionMultiplier: bounded(merged.cautionMultiplier, 0, 1),
    reducedMultiplier: bounded(merged.reducedMultiplier, 0, 1),
  };
}

export function nexusPortfolioDrawdownState(
  drawdownPercent: number,
  config: NexusPortfolioRiskConfig,
) {
  if (drawdownPercent >= config.drawdownHaltPercent)
    return { state: "HALTED" as const, multiplier: 0 };
  if (drawdownPercent >= config.drawdownReducedPercent)
    return {
      state: "REDUCED" as const,
      multiplier: config.reducedMultiplier,
    };
  if (drawdownPercent >= config.drawdownCautionPercent)
    return {
      state: "CAUTION" as const,
      multiplier: config.cautionMultiplier,
    };
  return { state: "NORMAL" as const, multiplier: 1 };
}

export function nexusCorrelationGroup(
  symbol: string,
  configuredGroup?: string | null,
) {
  if (configuredGroup?.trim())
    return configuredGroup.trim().toUpperCase().slice(0, 40);
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "BTCUSDT") return "BENCHMARK_BTC";
  if (normalized === "ETHUSDT") return "BENCHMARK_ETH";
  if (/^(DOGE|SHIB|PEPE|BONK|WIF|FLOKI|MEME)/.test(normalized))
    return "MEME_HIGH_BETA";
  if (/^(SOL|SUI|AVAX|APT|SEI|NEAR|ADA|DOT|ATOM)/.test(normalized))
    return "L1_HIGH_BETA";
  // 没有协方差/相关性证据时，只聚合同一币种，不能把所有普通山寨币
  // 粗暴算成一个风险组。后续可通过 configuredGroup 注入实证相关组。
  return `ALT_SYMBOL_${normalized}`.slice(0, 40);
}

export function nexusBoundStrategyId(input: {
  positionId: number;
  symbol: string;
  bindings: NexusPositionStrategyBinding[];
}) {
  const normalizedSymbol = input.symbol.trim().toUpperCase();
  const strategyIds = [
    ...new Set(
      input.bindings
        .filter(
          (binding) =>
            binding.state === "POSITION_OPEN" &&
            Number(binding.positionId) === input.positionId &&
            binding.symbol.trim().toUpperCase() === normalizedSymbol &&
            Number.isSafeInteger(binding.strategyId) &&
            binding.strategyId > 0,
        )
        .map((binding) => binding.strategyId),
    ),
  ];
  // 无绑定、历史绑定、币种不匹配或多个策略争抢同一仓位时，都不把仓位
  // 计入某个大脑的独立风险预算；异常归属应由核对流程单独处理。
  return strategyIds.length === 1 ? strategyIds[0] : 0;
}

export function nexusPositionRiskExposure(input: {
  strategyId: number;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  riskPlanJson?: string | null;
  executedRiskPlanJson?: string | null;
  favorablePrice?: number | null;
  trailingActivationPercent?: number | null;
  trailingStopPercent?: number | null;
  correlationGroup?: string | null;
}): NexusPortfolioExposure | null {
  const quantity = finitePositive(input.quantity);
  const entryPrice = finitePositive(input.entryPrice);
  const markPrice = finitePositive(input.markPrice);
  const leverage = finitePositive(input.leverage);
  if (!quantity || !entryPrice || !markPrice || !leverage) return null;
  const plan = parseRecord(input.riskPlanJson);
  const executed = parseExecutedRiskPlan(input.executedRiskPlanJson);
  const riskClass = positionRiskClass(plan);
  const dynamic = currentDynamicProtection({
    plan,
    quantity,
    entryPrice,
    markPrice,
    favorablePrice: finitePositive(input.favorablePrice) || entryPrice,
    leverage,
    positionSide: input.positionSide,
    trailingActivationPercent:
      finitePositive(input.trailingActivationPercent),
    trailingStopPercent: finitePositive(input.trailingStopPercent),
  });
  const fixedGrid = dynamic
    ? null
    : currentFixedStopGridRisk({
        plan,
        executedStopIndexes: executed.stopLosses,
        quantity,
        entryPrice,
        markPrice,
        leverage,
        positionSide: input.positionSide,
      });
  const structurePrice = structureInvalidationPrice(
    plan,
    input.positionSide,
  );
  const structureRisk =
    !dynamic &&
      !fixedGrid &&
      structurePrice !== null &&
      isEffectiveProtectionPrice(
        markPrice,
        structurePrice,
        input.positionSide,
      )
      ? {
          riskUsdt:
            quantity *
            currentLossToProtection(
              markPrice,
              structurePrice,
              input.positionSide,
            ),
          protectionPrice: structurePrice,
          riskBasis: "STRUCTURE_INVALIDATION" as const,
        }
      : null;
  const protection = dynamic ?? fixedGrid ?? structureRisk;
  const riskUsdt = protection?.riskUsdt ??
    quantity * markPrice / leverage;
  return {
    strategyId:
      Number.isInteger(input.strategyId) && input.strategyId > 0
        ? input.strategyId
        : 0,
    symbol: input.symbol.toUpperCase(),
    positionSide: input.positionSide,
    correlationGroup: nexusCorrelationGroup(
      input.symbol,
      input.correlationGroup,
    ),
    riskUsdt,
    riskClass,
    riskBasis: protection?.riskBasis ?? "MARGIN_FALLBACK",
    protectionPrice: protection?.protectionPrice ?? null,
  };
}

export function nexusStopLossRoeFromRiskPlan(
  value: string | null | undefined,
  fallback = 100,
) {
  try {
    const parsed = JSON.parse(value ?? "{}") as {
      stopLosses?: Array<{ triggerPercent?: unknown }>;
    };
    const triggers = (parsed.stopLosses ?? [])
      .map((item) => Number(item.triggerPercent))
      .filter((item) => Number.isFinite(item) && item > 0);
    return triggers.length ? Math.max(...triggers) : finitePositive(fallback);
  } catch {
    return finitePositive(fallback);
  }
}

export function formatNexusPortfolioRiskLimits(input: {
  riskClass: NexusRiskClass;
  accountEquityUsdt: number;
  config: NexusPortfolioRiskConfig;
  currentRisk: NexusPortfolioRiskPlan["currentRisk"];
  remainingRisk: NexusPortfolioRiskPlan["remainingRisk"];
  positionSide: "LONG" | "SHORT";
  correlationGroup: string;
  drawdownPercent: number;
  drawdownState: NexusPortfolioDrawdownState;
}) {
  const cap = (
    label: string,
    used: number,
    percent: number,
    remaining: number,
    applicable: boolean,
  ) =>
    `${label}${applicable ? "" : "（本单不占用）"} ` +
    `${formatRiskAmount(used)}/${formatRiskAmount(
      input.accountEquityUsdt * percent / 100,
    )} USDT，余 ${formatRiskAmount(remaining)}`;
  return [
    `风险仓位参考[${input.riskClass === "LEARNING_PROBE" ? "学习探针" : "常规订单"}]`,
    `单笔基准 ${formatRiskAmount(
      input.accountEquityUsdt * input.config.perTradeRiskPercent / 100,
    )} USDT（${input.config.perTradeRiskPercent.toFixed(2)}%权益）`,
    `探针满额容量约 ${Math.floor(
      input.config.learningProbeRiskBudgetPercent /
        input.config.perTradeRiskPercent,
    )} 个（实际按交易所最低量、保护线与剩余风险动态计算）`,
    cap(
      "组合常规",
      input.currentRisk.portfolioUsdt,
      input.config.maxPortfolioRiskPercent,
      input.remainingRisk.portfolioUsdt,
      input.riskClass === "STANDARD",
    ),
    cap(
      "当前大脑常规",
      input.currentRisk.strategyUsdt,
      input.config.strategyRiskBudgetPercent,
      input.remainingRisk.strategyUsdt,
      input.riskClass === "STANDARD",
    ),
    cap(
      "当前大脑探针",
      input.currentRisk.learningProbeUsdt,
      input.config.learningProbeRiskBudgetPercent,
      input.remainingRisk.learningProbeUsdt,
      input.riskClass === "LEARNING_PROBE",
    ),
    cap(
      input.positionSide === "LONG" ? "多头方向" : "空头方向",
      input.currentRisk.directionUsdt,
      input.config.maxDirectionalRiskPercent,
      input.remainingRisk.directionUsdt,
      true,
    ),
    cap(
      `${input.correlationGroup}关联组`,
      input.currentRisk.correlationGroupUsdt,
      input.config.maxCorrelationGroupRiskPercent,
      input.remainingRisk.correlationGroupUsdt,
      true,
    ),
    `账户峰值回撤 ${input.drawdownPercent.toFixed(2)}%（${input.drawdownState}，仅记录为运营观察）`,
    "组合、大脑、方向和关联组预算仅作运营观察，不参与拒单或缩量",
    "亏损停止条件仅使用策略配置的每日最大亏损额",
    `全部持仓风险 ${formatRiskAmount(input.currentRisk.totalUsdt)} USDT`,
  ].join("；");
}

function currentDynamicProtection(input: {
  plan: Record<string, unknown>;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  favorablePrice: number;
  leverage: number;
  positionSide: "LONG" | "SHORT";
  trailingActivationPercent: number;
  trailingStopPercent: number;
}) {
  const enabled =
    input.plan.dynamicProfitProtectionEnabled !== false &&
    input.trailingStopPercent > 0;
  if (!enabled) return null;
  const currentRoePercent = positionRoePercent(
    input.entryPrice,
    input.markPrice,
    input.leverage,
    input.positionSide,
  );
  const favorableRoePercent = positionRoePercent(
    input.entryPrice,
    input.favorablePrice,
    input.leverage,
    input.positionSide,
  );
  const protection = dynamicProfitProtection({
    enabled,
    entryPrice: input.entryPrice,
    leverage: input.leverage,
    currentRoePercent,
    favorableRoePercent,
    atrPrice: riskPlanAtrPrice(input.plan),
    configuredActivationRoePercent: input.trailingActivationPercent,
    configuredGivebackRoePoints: input.trailingStopPercent,
  });
  if (protection.effectiveFloorRoePercent === null) return null;
  const protectionPrice = priceAtRoePercent(
    input.entryPrice,
    protection.effectiveFloorRoePercent,
    input.leverage,
    input.positionSide,
  );
  if (
    !isEffectiveProtectionPrice(
      input.markPrice,
      protectionPrice,
      input.positionSide,
    )
  )
    return null;
  return {
    riskUsdt:
      input.quantity *
      currentLossToProtection(
        input.markPrice,
        protectionPrice,
        input.positionSide,
      ),
    protectionPrice,
    riskBasis: "DYNAMIC_PROTECTION" as const,
  };
}

function currentFixedStopGridRisk(input: {
  plan: Record<string, unknown>;
  executedStopIndexes: number[];
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  positionSide: "LONG" | "SHORT";
}) {
  const executed = new Set(input.executedStopIndexes);
  const levels = Array.isArray(input.plan.stopLosses)
    ? input.plan.stopLosses
        .map((value, index) => {
          const level = record(value);
          return {
            index,
            triggerPercent: finitePositive(level.triggerPercent),
            closeQuantity: finitePositive(level.closeQuantity),
            closePercent: finitePositive(level.closePercent),
            protectionPrice: priceAtRoePercent(
              input.entryPrice,
              -finitePositive(level.triggerPercent),
              input.leverage,
              input.positionSide,
            ),
          };
        })
        .filter(
          (level) =>
            !executed.has(level.index) &&
            level.triggerPercent > 0 &&
            isEffectiveProtectionPrice(
              input.markPrice,
              level.protectionPrice,
              input.positionSide,
            ),
        )
        .sort((a, b) => a.triggerPercent - b.triggerPercent)
    : [];
  if (!levels.length) return null;
  let remainingQuantity = input.quantity;
  let riskUsdt = 0;
  let nearestProtectionPrice: number | null = null;
  for (let index = 0; index < levels.length && remainingQuantity > 0; index += 1) {
    const level = levels[index];
    const protectionPrice = level.protectionPrice;
    nearestProtectionPrice ??= protectionPrice;
    const isLast = index === levels.length - 1;
    const requestedQuantity = level.closeQuantity > 0
      ? level.closeQuantity
      : level.closePercent > 0
        ? remainingQuantity * Math.min(100, level.closePercent) / 100
        : isLast
          ? remainingQuantity
          : 0;
    const closeQuantity = isLast
      ? remainingQuantity
      : Math.min(remainingQuantity, requestedQuantity);
    riskUsdt +=
      closeQuantity *
      currentLossToProtection(
        input.markPrice,
        protectionPrice,
        input.positionSide,
      );
    remainingQuantity -= closeQuantity;
  }
  if (remainingQuantity > 1e-12) {
    const deepest = levels.at(-1)!;
    const deepestPrice = priceAtRoePercent(
      input.entryPrice,
      -deepest.triggerPercent,
      input.leverage,
      input.positionSide,
    );
    riskUsdt +=
      remainingQuantity *
      currentLossToProtection(
        input.markPrice,
        deepestPrice,
        input.positionSide,
      );
  }
  return {
    riskUsdt,
    protectionPrice: nearestProtectionPrice,
    riskBasis: "FIXED_STOP_GRID" as const,
  };
}

function structureInvalidationPrice(
  plan: Record<string, unknown>,
  positionSide: "LONG" | "SHORT",
) {
  const opportunityContext = record(plan.opportunityContext);
  const entryAnchorResolution = record(plan.entryAnchorResolution);
  const opportunityEntryAnchorResolution = record(
    opportunityContext.entryAnchorResolution,
  );
  const entryOrderAnalysis = record(plan.entryOrderAnalysis);
  for (const candidate of [
    plan.structureInvalidationPrice,
    plan.invalidationPrice,
    entryAnchorResolution.invalidBoundary,
    opportunityEntryAnchorResolution.invalidBoundary,
    entryOrderAnalysis.invalidBoundary,
  ]) {
    const price = finitePositive(candidate);
    if (price > 0) return price;
  }
  const baselines = [
    record(plan.entryStructureBaseline),
    record(opportunityContext.entryStructureBaseline),
    record(plan.entryEvidence),
  ];
  const key = positionSide === "LONG" ? "priorSupport" : "priorResistance";
  for (const baseline of baselines) {
    const price = finitePositive(baseline[key]);
    if (price > 0) return price;
  }
  return null;
}

function currentLossToProtection(
  markPrice: number,
  protectionPrice: number,
  positionSide: "LONG" | "SHORT",
) {
  return Math.max(
    0,
    positionSide === "LONG"
      ? markPrice - protectionPrice
      : protectionPrice - markPrice,
  );
}

function isEffectiveProtectionPrice(
  markPrice: number,
  protectionPrice: number,
  positionSide: "LONG" | "SHORT",
) {
  return positionSide === "LONG"
    ? protectionPrice < markPrice
    : protectionPrice > markPrice;
}

function positionRiskClass(plan: Record<string, unknown>): NexusRiskClass {
  if (
    plan.riskClass === "LEARNING_PROBE" ||
    plan.explorationProbe === true ||
    record(plan.explorationOrderFirst).allowed === true
  )
    return "LEARNING_PROBE";
  return "STANDARD";
}

function parseExecutedRiskPlan(value: string | null | undefined) {
  const parsed = parseRecord(value);
  return {
    stopLosses: Array.isArray(parsed.stopLosses)
      ? parsed.stopLosses
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item >= 0)
      : [],
  };
}

function riskPlanAtrPrice(plan: Record<string, unknown>) {
  const opportunityContext = record(plan.opportunityContext);
  for (const candidate of [
    record(plan.entryStructureBaseline).atr5m,
    record(opportunityContext.entryStructureBaseline).atr5m,
    record(plan.entryEvidence).atr5m,
  ]) {
    const atr = finitePositive(candidate);
    if (atr > 0) return atr;
  }
  return null;
}

function parseRecord(value: string | null | undefined) {
  try {
    return record(JSON.parse(value ?? "{}"));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function formatRiskAmount(value: number) {
  return (Number.isFinite(value) ? Math.max(0, value) : 0).toFixed(2);
}

function structuralLossPerUnit(
  entryPrice: number,
  invalidationPrice: number | null | undefined,
  positionSide: "LONG" | "SHORT",
) {
  const invalidation = finitePositive(invalidationPrice);
  if (!invalidation) return null;
  const distance = positionSide === "LONG"
    ? entryPrice - invalidation
    : invalidation - entryPrice;
  return distance > 0 ? distance : null;
}

function alignQuantityDown(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0)
    return 0;
  return Number((Math.floor(value / step + 1e-10) * step).toPrecision(15));
}

function sumRisk(exposures: NexusPortfolioExposure[]) {
  return exposures.reduce((sum, item) => sum + positiveOrZero(item.riskUsdt), 0);
}

function remainingBudget(equity: number, percent: number, used: number) {
  return Math.max(0, equity * percent / 100 - used);
}

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveOrZero(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function bounded(value: number, minimum: number, maximum: number) {
  const finite = Number(value);
  if (!Number.isFinite(finite)) return minimum;
  return Math.min(Math.max(finite, minimum), maximum);
}
