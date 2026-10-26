import {
  liveReductionAccounting,
  type LivePosition,
  type LivePositionReduction,
} from "./workspace-model.ts";

export type ClosedPositionHistoryRow = {
  positionId: number;
  accountId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  openQuantity: number;
  closeQuantity: number;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  grossPnl: number;
  displayPnl: number;
  exactNetAvailable: boolean;
  exitCommission: number | null;
  entryCommissionAllocated: number | null;
  fundingIncome: number | null;
  reason: string;
  reasonDetail: string | null;
  closedAt: string | number;
};

function exitTrigger(reduction: LivePositionReduction | undefined) {
  if (!reduction?.responseJson) return null;
  try {
    const response = JSON.parse(reduction.responseJson) as Record<string, unknown>;
    const trigger = typeof response.protectionTrigger === "string"
      ? response.protectionTrigger
      : null;
    if (trigger === "ENTRY_THESIS_INVALIDATION" || response.structureExit === true)
      return "ENTRY_THESIS_INVALIDATION";
    return trigger;
  } catch {
    return null;
  }
}

export function positionExitReasonDetail(trigger: string | null | undefined) {
  return {
    ENTRY_THESIS_INVALIDATION: "结构失效提前退出（正常风控）",
    CAPITAL_PRESERVATION_HARD_STOP: "本金保护硬止损",
    THREE_MINUTE_HARD_STOP: "动态硬止损",
    THREE_MINUTE_LOCKED_LOSS_FLOOR: "锁定亏损保护",
    EVIDENCE_RISK_FULL_EXIT: "证据风险退出",
    EVIDENCE_RISK_PARTIAL_REDUCTION: "证据风险减仓",
    THREE_MINUTE_LOCKED_PROFIT_FLOOR: "锁定利润保护",
    THREE_MINUTE_DYNAMIC_PROFIT_TARGET: "动态止盈",
  }[String(trigger)] ?? null;
}

export function buildClosedPositionHistory(
  positions: LivePosition[],
  reductions: LivePositionReduction[],
): ClosedPositionHistoryRow[] {
  const reductionsByPosition = new Map<number, LivePositionReduction[]>();
  for (const reduction of reductions) {
    const group = reductionsByPosition.get(reduction.positionId) ?? [];
    group.push(reduction);
    reductionsByPosition.set(reduction.positionId, group);
  }

  return positions
    .filter((position) => position.status === "CLOSED")
    .map((position) => {
      const legs = reductionsByPosition.get(position.id) ?? [];
      const closeQuantity = legs.length
        ? legs.reduce((sum, leg) => sum + leg.quantity, 0)
        : position.quantity;
      const weightedExitNotional = legs.reduce(
        (sum, leg) => sum + leg.exitPrice * leg.quantity,
        0,
      );
      const exitPrice =
        closeQuantity > 0 && weightedExitNotional > 0
          ? weightedExitNotional / closeQuantity
          : position.markPrice;
      const accounting = legs.map(liveReductionAccounting);
      const exactNetAvailable =
        accounting.length > 0 &&
        accounting.every(
          (item) =>
            item.exactNetAvailable && item.netRealizedPnl !== null,
        );
      const grossPnl = legs.length
        ? accounting.reduce(
            (sum, item) => sum + item.grossRealizedPnl,
            0,
          )
        : position.realizedPnl;
      const displayPnl = exactNetAvailable
        ? accounting.reduce(
            (sum, item) => sum + (item.netRealizedPnl ?? 0),
            0,
          )
        : grossPnl;
      const exitCommission = exactNetAvailable
        ? accounting.reduce(
            (sum, item) => sum + (item.exitCommission ?? 0),
            0,
          )
        : null;
      const entryCommissionAllocated = exactNetAvailable
        ? accounting.reduce(
            (sum, item) => sum + (item.entryCommissionAllocated ?? 0),
            0,
          )
        : null;
      const fundingIncome = exactNetAvailable
        ? accounting.reduce(
            (sum, item) => sum + (item.fundingIncome ?? 0),
            0,
          )
        : null;
      const latestReduction = legs
        .slice()
        .sort(
          (left, right) =>
            new Date(right.createdAt).getTime() -
            new Date(left.createdAt).getTime(),
        )[0];
      const detail = positionExitReasonDetail(exitTrigger(latestReduction));

      return {
        positionId: position.id,
        accountId: position.accountId,
        symbol: position.symbol,
        side: position.positionSide,
        openQuantity: closeQuantity,
        closeQuantity,
        entryPrice: position.entryPrice,
        exitPrice,
        leverage: position.leverage,
        grossPnl,
        displayPnl,
        exactNetAvailable,
        exitCommission,
        entryCommissionAllocated,
        fundingIncome,
        reason:
          position.exitReason ??
          legs.at(-1)?.reason ??
          "EXTERNAL",
        reasonDetail: detail,
        closedAt: position.closedAt ?? position.updatedAt,
      };
    })
    .sort(
      (left, right) =>
        new Date(right.closedAt).getTime() -
        new Date(left.closedAt).getTime(),
    );
}

export function positionHistoryRoePercent(
  row: ClosedPositionHistoryRow,
) {
  const initialMargin =
    row.leverage > 0
      ? (row.entryPrice * row.openQuantity) / row.leverage
      : 0;
  return initialMargin > 0
    ? (row.displayPnl / initialMargin) * 100
    : null;
}
