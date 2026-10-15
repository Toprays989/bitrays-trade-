export type ClosedStrategyPosition = {
  id: number;
  status: string;
  exitReason: string | null;
  realizedPnl: number;
  closedAt: Date | null;
};

export type StrategyPositionReductionEvidence = {
  reductionId: number;
  positionId: number;
  symbol: string;
  positionSide: string;
  reason: string;
  quantity: number;
  exitPrice: number;
  grossRealizedPnl: number;
  netRealizedPnl: number | null;
  exactNetAvailable: boolean;
  exitCommission: number | null;
  entryCommissionAllocated: number | null;
  fundingIncome: number | null;
  createdAt: Date;
  dynamicProfitReduction?: {
    stage: number;
    targetCumulativeRatio: number;
    givebackRoePoints: number;
    reason: string;
    softActivationRuleVersion: number | null;
    softActivatedAtMs: number | null;
    softActivationRoePercent: number | null;
  } | null;
};

export type StrategyProfitProtectionActivationEvidence = {
  positionId: number;
  symbol: string;
  positionSide: string;
  currentRoePercent: number;
  anchorQuantity: number;
  executedQuantity: number;
  completedStages: number[];
  softActivationRuleVersion: number | null;
  softActivatedAtMs: number | null;
  softActivationRoePercent: number | null;
  previousSoftActivatedAtMs: number | null;
};

const REDUCTION_EVENT_TYPES: Record<string, string> = {
  TAKE_PROFIT: "POSITION_TAKE_PROFIT_FILLED",
  STOP_LOSS: "POSITION_STOP_LOSS_FILLED",
  TRAILING_STOP: "POSITION_TRAILING_STOP_FILLED",
  TIME_EXIT: "POSITION_TIME_EXIT_FILLED",
  MANUAL: "POSITION_MANUAL_REDUCTION_FILLED",
  EXTERNAL: "POSITION_EXTERNAL_REDUCTION_RECORDED",
};

const REDUCTION_LABELS: Record<string, string> = {
  TAKE_PROFIT: "分批止盈",
  STOP_LOSS: "止损",
  TRAILING_STOP: "移动止损",
  TIME_EXIT: "180秒到时退出",
  MANUAL: "人工减仓",
  EXTERNAL: "外部减仓",
};

export function strategyPositionReductionEvent(
  reduction: StrategyPositionReductionEvidence,
) {
  if (
    !Number.isInteger(reduction.reductionId) ||
    reduction.reductionId <= 0 ||
    !Number.isInteger(reduction.positionId) ||
    reduction.positionId <= 0 ||
    !Number.isFinite(reduction.quantity) ||
    reduction.quantity <= 0 ||
    !Number.isFinite(reduction.exitPrice) ||
    reduction.exitPrice <= 0
  )
    return null;

  const reason = reduction.reason || "UNKNOWN";
  const dynamicStage =
    reason === "TRAILING_STOP" &&
      Number.isInteger(reduction.dynamicProfitReduction?.stage) &&
      Number(reduction.dynamicProfitReduction?.stage) >= 1 &&
      Number(reduction.dynamicProfitReduction?.stage) <= 3
      ? Number(reduction.dynamicProfitReduction?.stage)
      : 0;
  const eventType = dynamicStage > 0
    ? `POSITION_PROFIT_PROTECTION_STAGE_${dynamicStage}_FILLED`
    : REDUCTION_EVENT_TYPES[reason] ?? "POSITION_REDUCTION_RECORDED";
  const label = dynamicStage === 1
    ? "首档止盈前保护第1阶段"
    : dynamicStage === 2
      ? "首档止盈前保护第2阶段"
      : dynamicStage === 3
        ? "首档止盈前尾仓保护"
        : REDUCTION_LABELS[reason] ?? "仓位减仓";
  const pnl = reduction.exactNetAvailable &&
      Number.isFinite(reduction.netRealizedPnl)
    ? reduction.netRealizedPnl
    : reduction.grossRealizedPnl;
  const pnlLabel = reduction.exactNetAvailable ? "净收益" : "毛收益";
  return {
    eventType,
    outcome: pnl !== null && Number.isFinite(pnl) && pnl < 0
      ? "INFO" as const
      : "PASSED" as const,
    message:
      `${label}已成交：${reduction.quantity} ${reduction.symbol.replace(/USDT$/, "")}，` +
      `${dynamicStage > 0
        ? `累计目标 ${(Number(reduction.dynamicProfitReduction?.targetCumulativeRatio ?? 0) * 100).toFixed(0)}%，`
        : ""}` +
      `${pnlLabel} ${Number.isFinite(pnl) ? pnl!.toFixed(6) : "待补"} USDT`,
    eventAt: reduction.createdAt,
    detail: {
      eventKey: `position-reduction:${reduction.reductionId}`,
      reductionId: reduction.reductionId,
      positionId: reduction.positionId,
      symbol: reduction.symbol,
      positionSide: reduction.positionSide,
      reason,
      quantity: reduction.quantity,
      exitPrice: reduction.exitPrice,
      grossRealizedPnl: Number.isFinite(reduction.grossRealizedPnl)
        ? reduction.grossRealizedPnl
        : null,
      netRealizedPnl:
        reduction.exactNetAvailable &&
          Number.isFinite(reduction.netRealizedPnl)
          ? reduction.netRealizedPnl
          : null,
      exactNetAvailable: reduction.exactNetAvailable,
      exitCommission: Number.isFinite(reduction.exitCommission)
        ? reduction.exitCommission
        : null,
      entryCommissionAllocated: Number.isFinite(
          reduction.entryCommissionAllocated,
        )
        ? reduction.entryCommissionAllocated
        : null,
      fundingIncome: Number.isFinite(reduction.fundingIncome)
        ? reduction.fundingIncome
        : null,
      profitProtectionStage: dynamicStage || null,
      dynamicProfitReduction:
        dynamicStage > 0 ? reduction.dynamicProfitReduction : null,
    },
  };
}

export function strategyProfitProtectionActivationEvent(
  evidence: StrategyProfitProtectionActivationEvidence,
) {
  if (
    !Number.isInteger(evidence.positionId) ||
    evidence.positionId <= 0 ||
    !Number.isFinite(evidence.currentRoePercent) ||
    evidence.previousSoftActivatedAtMs !== null ||
    evidence.softActivationRuleVersion !== 1 ||
    !Number.isFinite(evidence.softActivatedAtMs) ||
    Number(evidence.softActivatedAtMs) <= 0
  ) return null;
  const anchorQuantity = Math.max(0, Number(evidence.anchorQuantity) || 0);
  const executedQuantity = Math.max(0, Number(evidence.executedQuantity) || 0);
  const historicalReductionRatio = anchorQuantity > 0
    ? Math.min(1, executedQuantity / anchorQuantity)
    : 0;
  const historicalNote = historicalReductionRatio > 0
    ? `；激活前已有累计减仓 ${(historicalReductionRatio * 100).toFixed(0)}%，仅保留历史，不计入本规则新阶段`
    : "";
  return {
    eventType: "POSITION_PROFIT_PROTECTION_ARMED",
    outcome: "INFO" as const,
    message:
      `首档止盈前利润保护已激活：当前ROE ${evidence.currentRoePercent.toFixed(2)}%，` +
      `后续仅在真实回撤阶段记录减仓${historicalNote}。`,
    eventAt: new Date(Number(evidence.softActivatedAtMs)),
    detail: {
      eventKey:
        `profit-protection-armed:${evidence.positionId}:${evidence.softActivatedAtMs}`,
      positionId: evidence.positionId,
      symbol: evidence.symbol,
      positionSide: evidence.positionSide,
      currentRoePercent: evidence.currentRoePercent,
      activationRoePercent:
        Number.isFinite(evidence.softActivationRoePercent)
          ? evidence.softActivationRoePercent
          : 6,
      softActivationRuleVersion: evidence.softActivationRuleVersion,
      softActivatedAtMs: evidence.softActivatedAtMs,
      anchorQuantity,
      executedQuantity,
      completedStages: evidence.completedStages,
      historicalReductionRatio,
    },
  };
}

export function closedStrategyTraceResult(
  position: ClosedStrategyPosition,
  fallbackCompletedAt: Date,
) {
  if (
    position.status !== "CLOSED" ||
    !Number.isInteger(position.id) ||
    position.id <= 0
  )
    return null;

  const exitReason = position.exitReason ?? "UNKNOWN";
  return {
    state: "CLOSED" as const,
    resultCode: "POSITION_CLOSED",
    resultMessage: `实盘仓位已结束：${exitReason}`,
    completedAt: position.closedAt ?? fallbackCompletedAt,
    detail: {
      positionId: position.id,
      exitReason,
      grossRealizedPnl: Number.isFinite(position.realizedPnl)
        ? position.realizedPnl
        : null,
    },
  };
}

export function strategyTerminalObservationMinute(
  openedAt: Date,
  closedAt: Date,
) {
  const elapsedMs = closedAt.getTime() - openedAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return Math.max(1, Math.floor(elapsedMs / 60_000));
}
