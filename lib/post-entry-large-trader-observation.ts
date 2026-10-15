export type PostEntryLargeTraderStatus =
  | "SUPPORT_CONTINUES"
  | "CAPITAL_WITHDRAWAL"
  | "MIXED"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE"
  | "NOT_SCHEDULED";

export type PostEntryLargeTraderObservation = {
  status: PostEntryLargeTraderStatus;
  label: string;
  observationOnly: true;
  sampledMinute: number;
  sourceLabel: "BINANCE_TOP_TRADER_AGGREGATE_NOT_WALLET";
  entryStatus: string | null;
  currentStatus: string | null;
  openInterestChangeFromEntryPercent: number | null;
  topPositionRatioChangeFromEntryPercent: number | null;
  topAccountRatioChangeFromEntryPercent: number | null;
  currentTakerBuySellRatio: number | null;
  reason: string;
};

export function analyzePostEntryLargeTraderObservation(input: {
  positionSide: "LONG" | "SHORT";
  sampledMinute: number;
  entryPositioning: unknown;
  currentPositioning: unknown;
}): PostEntryLargeTraderObservation {
  const entry = record(input.entryPositioning);
  const current = record(input.currentPositioning);
  const entryDetail = record(entry.detail);
  const currentDetail = record(current.detail);
  const common = {
    observationOnly: true as const,
    sampledMinute: Math.max(0, Math.trunc(input.sampledMinute)),
    sourceLabel: "BINANCE_TOP_TRADER_AGGREGATE_NOT_WALLET" as const,
    entryStatus: text(entry.status),
    currentStatus: text(current.status),
    openInterestChangeFromEntryPercent: percentChange(
      currentDetail.openInterestValue,
      entryDetail.openInterestValue,
    ),
    topPositionRatioChangeFromEntryPercent: percentChange(
      currentDetail.topPositionLongShortRatio,
      entryDetail.topPositionLongShortRatio,
    ),
    topAccountRatioChangeFromEntryPercent: percentChange(
      currentDetail.topAccountLongShortRatio,
      entryDetail.topAccountLongShortRatio,
    ),
    currentTakerBuySellRatio: finitePositive(
      currentDetail.takerBuySellRatio,
    ),
  };
  if (input.positionSide !== "LONG")
    return {
      ...common,
      status: "NOT_APPLICABLE",
      label: "非多仓不适用",
      reason: "当前聚合仓位延续验证只用于本策略多仓。",
    };
  const scheduledMinutes = new Set<number>([
    ...POST_ENTRY_MODEL_MINUTES,
    ...POST_ENTRY_LONG_HOLD_MINUTES,
  ]);
  if (!scheduledMinutes.has(common.sampledMinute))
    return {
      ...common,
      status: "NOT_SCHEDULED",
      label: "等待已安排检查点",
      reason:
        "大户聚合数据只在5/30/60分钟及稀疏长周期检查点读取，避免无意义高频访问。",
    };
  if (
    entry.status !== "SUPPORTS_LONG" ||
    current.status === "UNAVAILABLE" ||
    common.openInterestChangeFromEntryPercent === null ||
    common.topPositionRatioChangeFromEntryPercent === null ||
    common.currentTakerBuySellRatio === null
  )
    return {
      ...common,
      status: "UNAVAILABLE",
      label: "聚合仓位证据不足",
      reason: "入场或当前大户聚合数据不完整，本次不推断资金延续或撤退。",
    };
  const coordinatedWithdrawal =
    common.openInterestChangeFromEntryPercent <= -0.5 &&
    common.topPositionRatioChangeFromEntryPercent <= -0.5 &&
    common.currentTakerBuySellRatio < 1;
  if (current.status === "CONFLICTS_LONG" || coordinatedWithdrawal)
    return {
      ...common,
      status: "CAPITAL_WITHDRAWAL",
      label: "承接资金撤退",
      reason:
        current.status === "CONFLICTS_LONG"
          ? "当前大户聚合状态已转为加空冲突，原多头承接假设失去资金确认。"
          : `相对入场未平仓价值下降 ${Math.abs(common.openInterestChangeFromEntryPercent).toFixed(2)}%，` +
            `头部净多持仓比下降 ${Math.abs(common.topPositionRatioChangeFromEntryPercent).toFixed(2)}%，且主动卖量占优。`,
    };
  const supportContinues =
    current.status === "SUPPORTS_LONG" &&
    common.openInterestChangeFromEntryPercent >= -0.5 &&
    common.topPositionRatioChangeFromEntryPercent >= -0.5 &&
    common.currentTakerBuySellRatio >= 1;
  if (supportContinues)
    return {
      ...common,
      status: "SUPPORT_CONTINUES",
      label: "承接资金延续",
      reason: "未平仓价值与头部净多持仓未明显撤退，当前主动买量仍不弱。",
    };
  return {
    ...common,
    status: "MIXED",
    label: "资金信号分歧",
    reason: "当前聚合仓位没有形成一致的延续或撤退证据，只记录不改变仓位。",
  };
}

export function unavailablePostEntryLargeTraderObservation(
  positionSide: "LONG" | "SHORT",
  sampledMinute: number,
  reason: string,
): PostEntryLargeTraderObservation {
  return analyzePostEntryLargeTraderObservation({
    positionSide,
    sampledMinute,
    entryPositioning: {},
    currentPositioning: {
      status: "UNAVAILABLE",
      message: reason,
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function percentChange(current: unknown, entry: unknown) {
  const currentValue = finitePositive(current);
  const entryValue = finitePositive(entry);
  return currentValue === null || entryValue === null
    ? null
    : ((currentValue - entryValue) / entryValue) * 100;
}
import {
  POST_ENTRY_LONG_HOLD_MINUTES,
  POST_ENTRY_MODEL_MINUTES,
} from "./post-entry-observation-schedule.ts";
