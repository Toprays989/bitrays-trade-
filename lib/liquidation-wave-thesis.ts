import { hasCompleteNetProfitPath } from "./strategy-payoff.ts";

export type WaveThesisChecklistItem = {
  code: string;
  required: boolean;
  passed: boolean;
  observed: string;
};

export type LiquidationWaveThesis = {
  schemaVersion: "liquidation-wave-thesis-v1";
  thesisId: string;
  objective: "VALIDATE_DOMINANT_WAVE_FOLLOW_THROUGH";
  direction: "LONG";
  setup:
    | "TREND_BREAKOUT_FOLLOW_THROUGH"
    | "SUPPORT_REVERSAL_RECLAIM"
    | "EXPLORATION_PROBE";
  authorizationMode: "CONFIRMED_EYE" | "EXPLORATION_PROBE";
  status: "CONFIRMED" | "INCOMPLETE";
  statement: string;
  confirmationChecklist: WaveThesisChecklistItem[];
  entryPlan: {
    mode: "CONFIRMED_MARKET" | "STRUCTURAL_RETEST_LIMIT";
    analyzedEntryPrice: number | null;
    confirmationLevel: number | null;
    invalidBoundary: number | null;
  };
  invalidationRules: string[];
  profitValidation: {
    firstTakeProfitRoePercent: number | null;
    trailingActivationRoePercent: number | null;
    estimatedRoundTripFeePercent: number;
    netRiskRewardRatio: number | null;
    breakEvenWinRatePercent: number | null;
    completeExitConfigured: boolean;
    observationMinutes: readonly [1, 3, 5, 10];
  };
};

export type WaveThesisOutcome =
  | "INSUFFICIENT"
  | "FOLLOW_THROUGH"
  | "FAILED_STRUCTURE"
  | "CAPITAL_WITHDRAWAL"
  | "PROFIT_GIVEBACK"
  | "UNRESOLVED";

export function buildLiquidationWaveThesis(input: {
  traceId: string;
  symbol: string;
  eventTimeMs: number;
  evidence: Record<string, unknown>;
  entryOrderAnalysis: Record<string, unknown>;
  firstTakeProfitRoePercent?: number | null;
  trailingActivationRoePercent?: number | null;
  profitabilityBaseline?: unknown;
  authorizationMode?: "CONFIRMED_EYE" | "EXPLORATION_PROBE";
}): LiquidationWaveThesis {
  const signalCluster = record(input.evidence.signalCluster);
  const largeTrader = record(input.evidence.largeTraderPositioning);
  const entryAnchorResolution = record(
    input.evidence.entryAnchorResolution,
  );
  const signalEventCount = finite(signalCluster.eventCount);
  const signalNotional = finite(signalCluster.totalNotional);
  const confirmationLevel =
    finite(input.entryOrderAnalysis.confirmationLevel) ??
    finite(entryAnchorResolution.confirmationLevel);
  const invalidBoundary =
    finite(input.entryOrderAnalysis.invalidBoundary) ??
    finite(entryAnchorResolution.invalidBoundary);
  const analyzedEntryPrice =
    finite(input.entryOrderAnalysis.analyzedEntryPrice);
  const mode = input.entryOrderAnalysis.mode === "STRUCTURAL_RETEST_LIMIT"
    ? "STRUCTURAL_RETEST_LIMIT" as const
    : "CONFIRMED_MARKET" as const;
  const profitabilityBaseline = record(input.profitabilityBaseline);
  const completeExitConfigured =
    profitabilityBaseline.completeExitConfigured === true;
  const netRiskRewardRatio =
    finite(profitabilityBaseline.netRiskRewardRatio);
  const breakEvenWinRatePercent =
    finite(profitabilityBaseline.breakEvenWinRatePercent);
  const authorizationMode = input.authorizationMode ?? "CONFIRMED_EYE";
  const explorationProbe = authorizationMode === "EXPLORATION_PROBE";
  const anchorSource = String(
    input.entryOrderAnalysis.anchorSource ??
      entryAnchorResolution.source ??
      "CONFIRMED_STRUCTURE",
  );
  const marketEye = record(input.evidence.nexusMarketEyeDecision);
  const volumeTiming = record(input.evidence.nexusVolumeTiming);
  const selectedPath = String(marketEye.selectedPath ?? "");
  const explorationOrder = record(input.evidence.explorationOrderFirst);
  const setup = explorationProbe
    ? "EXPLORATION_PROBE" as const
    : selectedPath === "SUPPORT_REVERSAL"
      ? "SUPPORT_REVERSAL_RECLAIM" as const
      : "TREND_BREAKOUT_FOLLOW_THROUGH" as const;
  const checklist: WaveThesisChecklistItem[] = [
    {
      code: "LIQUIDATION_PRESSURE",
      required: true,
      passed: (signalEventCount ?? 0) > 0 && (signalNotional ?? 0) > 0,
      observed:
        `${format(signalEventCount)}个事件 / ${format(signalNotional)} USDT`,
    },
    {
      code: explorationProbe
        ? "EXPLORATION_RISK_BOUNDARY_AVAILABLE"
        : "SELECTED_PATH_ANCHORS_AVAILABLE",
      required: true,
      passed:
        confirmationLevel !== null &&
        invalidBoundary !== null &&
        confirmationLevel > invalidBoundary,
      observed:
        explorationProbe
          ? `观察锚 ${format(confirmationLevel)} / 风险边界 ${format(invalidBoundary)} / ${anchorSource}`
          : `${selectedPath || "未选择路径"}：确认 ${format(confirmationLevel)} / 失效 ${format(invalidBoundary)}`,
    },
    {
      code: "AGGREGATE_LARGE_TRADER_SUPPORT",
      required: false,
      passed: largeTrader.status === "SUPPORTS_LONG",
      observed: String(largeTrader.status ?? "UNAVAILABLE"),
    },
    {
      code: authorizationMode === "EXPLORATION_PROBE"
        ? "EXPLORATION_PROBE_AUTHORIZED"
        : "MARKET_EYE_CONFIRMED",
      required: true,
      passed: authorizationMode === "EXPLORATION_PROBE"
        ? explorationOrder.allowed === true
        : marketEye.verdict === "CONFIRMED",
      observed: authorizationMode === "EXPLORATION_PROBE"
        ? String(explorationOrder.reason ?? "未授权探索探针")
        : String(marketEye.summary ?? marketEye.verdict ?? "眼睛未确认"),
    },
    {
      code: "CURRENT_VOLUME_TIMING",
      required: false,
      passed:
        !volumeTiming.state ||
        volumeTiming.state === "CURRENT_EXECUTION_CONFIRMED",
      observed: String(
        volumeTiming.summary ?? volumeTiming.state ?? "旧样本未记录量价时序",
      ),
    },
    {
      code: "NET_PROFIT_CAPTURE_PATH",
      required: true,
      passed: hasCompleteNetProfitPath(profitabilityBaseline),
      observed:
        `完整退出 ${completeExitConfigured ? "是" : "否"} / 净盈亏比 ${
          format(netRiskRewardRatio)
        } / 保本胜率 ${format(breakEvenWinRatePercent)}%`,
    },
  ];
  const status = checklist.every((item) => !item.required || item.passed)
    ? "CONFIRMED" as const
    : "INCOMPLETE" as const;
  return {
    schemaVersion: "liquidation-wave-thesis-v1",
    thesisId: `${input.symbol}:${Math.trunc(input.eventTimeMs)}:${input.traceId}`,
    objective: "VALIDATE_DOMINANT_WAVE_FOLLOW_THROUGH",
    direction: "LONG",
    setup,
    authorizationMode,
    status,
    statement: explorationProbe
      ? "多头爆仓触发最小探索探针；尚未闭合的结构证据只作为观察项，订单使用ATR风险边界并在成交后持续验证，不把探索锚伪装成确认结构。"
      : setup === "SUPPORT_REVERSAL_RECLAIM"
        ? "多头爆仓揭示下行压力；支撑反转状态机完成扫盘、收回和量价确认后，由市场眼睛选择该路径并冻结确认位与失效位。"
        : "爆仓触发关注后，趋势突破状态机只接受已收盘K线突破与量价闭合；市场眼睛选择该路径后冻结确认位与失效位，不再叠加旧位置分析器。",
    confirmationChecklist: checklist,
    entryPlan: {
      mode,
      analyzedEntryPrice,
      confirmationLevel,
      invalidBoundary,
    },
    invalidationRules: [
      "委托成交前价格跌破结构失效边界，立即撤销本次假设",
      "成交后连续完整1分钟收盘失守且SELL强平压力同步出现，标记为结构失败",
      "限价单过期后必须重新分析，不允许自动追市价",
    ],
    profitValidation: {
      firstTakeProfitRoePercent: finite(input.firstTakeProfitRoePercent),
      trailingActivationRoePercent: finite(input.trailingActivationRoePercent),
      estimatedRoundTripFeePercent:
        finite(profitabilityBaseline.estimatedRoundTripFeePercent) ?? 0.08,
      netRiskRewardRatio,
      breakEvenWinRatePercent,
      completeExitConfigured,
      observationMinutes: [1, 3, 5, 10],
    },
  };
}

export function evaluateLiquidationWaveThesis(input: {
  sampleCount: number;
  latestRoePercent: number | null;
  bestRoePercent: number | null;
  positiveMinuteRatio: number | null;
  breakdownPressureRatio: number | null;
  largeTraderWithdrawalRatio?: number | null;
  firstTakeProfitRoePercent: number;
}): {
  outcome: WaveThesisOutcome;
  summary: string;
} {
  if (input.sampleCount < 3)
    return {
      outcome: "INSUFFICIENT",
      summary: "持仓后有效样本不足3个，波段假设尚不能判定。",
    };
  if ((input.breakdownPressureRatio ?? 0) >= 0.4)
    return {
      outcome: "FAILED_STRUCTURE",
      summary: "持仓后支撑连续失守并伴随SELL强平压力，原承接波段假设被价格行为否定。",
    };
  if ((input.largeTraderWithdrawalRatio ?? 0) >= 0.5)
    return {
      outcome: "CAPITAL_WITHDRAWAL",
      summary: "持仓后聚合未平仓量、头部净多持仓或主动买量显示承接资金撤退，原资金延续假设失效。",
    };
  const meaningfulProfit = Math.max(
    0.5,
    Math.max(0, input.firstTakeProfitRoePercent) * 0.6,
  );
  if (
    (input.bestRoePercent ?? Number.NEGATIVE_INFINITY) >= meaningfulProfit &&
    (input.latestRoePercent ?? 0) <= 0
  )
    return {
      outcome: "PROFIT_GIVEBACK",
      summary: "方向一度被市场验证，但利润已全部回吐；问题更偏向退出保护而非入场方向。",
    };
  if (
    (input.latestRoePercent ?? 0) > 0 &&
    (input.positiveMinuteRatio ?? 0) >= 2 / 3
  )
    return {
      outcome: "FOLLOW_THROUGH",
      summary: "多数观察分钟保持正ROE，当前价格行为支持承接波段假设。",
    };
  return {
    outcome: "UNRESOLVED",
    summary: "价格尚未形成持续跟随，也未满足结构失败条件，继续按原失效边界观察。",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function format(value: number | null) {
  return value === null ? "—" : Number(value.toFixed(4)).toString();
}
