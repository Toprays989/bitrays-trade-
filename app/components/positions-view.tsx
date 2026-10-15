"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { summarizePositionExposure } from "../../lib/position-exposure";
import { resolveMinimumNotionalExitPolicy } from "../../lib/order-quantity";
import {
  liveExecutedRiskPlanSummary,
  liveProfitProtectionStageSummary,
  liveRiskPlanSummary,
  type LivePosition,
} from "../client/workspace-model";
import { formatCompactDecimal } from "../client/display-number";
import { NumberStepper } from "./number-stepper";

type PositionActionTarget = {
  position: LivePosition;
  orderType: "MARKET" | "LIMIT";
};

type LiveRiskEditForm = {
  takeStart: number;
  takeEnd: number;
  takeGrids: number;
  stopStart: number;
  stopEnd: number;
  stopGrids: number;
  minimumObservationMinutes: number;
  liquidationGuardBufferPercent: number;
  trailingActivation: number;
  trailingCallback: number;
};

type RiskGridLevel = {
  triggerPercent: number;
  closePercent: number;
  closeQuantity: number;
};

type PositionSortMode = "PNL_DESC" | "QUANTITY_DESC" | "SYMBOL_ASC";

function positionPnl(position: LivePosition) {
  return (
    (position.positionSide === "LONG"
      ? position.markPrice - position.entryPrice
      : position.entryPrice - position.markPrice) * position.quantity
  );
}

function stablePositionCompare(
  left: LivePosition,
  right: LivePosition,
  mode: PositionSortMode,
) {
  const primary =
    mode === "PNL_DESC"
      ? positionPnl(right) - positionPnl(left)
      : mode === "QUANTITY_DESC"
        ? right.quantity - left.quantity
        : left.symbol.localeCompare(right.symbol, "en");
  if (Math.abs(primary) > Number.EPSILON) return primary;
  const symbolOrder = left.symbol.localeCompare(right.symbol, "en");
  if (symbolOrder !== 0) return symbolOrder;
  const sideOrder = left.positionSide.localeCompare(right.positionSide, "en");
  if (sideOrder !== 0) return sideOrder;
  return left.id - right.id;
}

type PositionsViewProps = {
  livePositions: LivePosition[];
  positionsLoaded: boolean;
  strategyNames: Record<number, string>;
  portfolioAccountFilter: string;
  accountFilterControl: ReactNode;
  positionsBusy: boolean;
  loadPositions: () => Promise<void>;
  can: (permission: string) => boolean;
  openLiveRiskEditor: (position: LivePosition) => void;
  openLiveCloseConfirmation: (position: LivePosition, orderType: "MARKET" | "LIMIT") => void;
  openLiveAddConfirmation: (position: LivePosition) => void;
  liveRiskEditTarget: LivePosition | null;
  setLiveRiskEditTarget: (value: LivePosition | null) => void;
  liveRiskEditForm: LiveRiskEditForm;
  setLiveRiskEditForm: (value: LiveRiskEditForm) => void;
  liveTakeProfitPlan: RiskGridLevel[];
  liveStopLossPlan: RiskGridLevel[];
  saveLivePositionRisk: () => Promise<void>;
  liveAddTarget: PositionActionTarget | null;
  setLiveAddTarget: (value: PositionActionTarget | null) => void;
  liveAddSubmitting: boolean;
  liveAddQuantity: number;
  setLiveAddQuantity: (value: number) => void;
  liveAddQuantityMinimum: number;
  liveAddExactQuantityMinimum: number;
  liveAddQuantityStep: number;
  liveAddPrice: number;
  setLiveAddPrice: (value: number) => void;
  liveAddQuantityValid: boolean;
  liveAddMarket: { minNotionalUsdt?: number } | null;
  liveAddPoolBusy: boolean;
  addLiveAddSymbolToPool: (symbol: string) => Promise<void>;
  confirmLivePositionAdd: () => Promise<void>;
  liveCloseTarget: PositionActionTarget | null;
  setLiveCloseTarget: (value: PositionActionTarget | null) => void;
  liveCloseSubmitting: boolean;
  liveCloseQuantity: number;
  setLiveCloseQuantity: (value: number) => void;
  liveCloseQuantityMinimum: number;
  liveCloseQuantityStep: number;
  liveClosePrice: number;
  setLiveClosePrice: (value: number) => void;
  liveCloseQuantityValid: boolean;
  liveCloseLeavesDust: boolean;
  liveCloseAll: boolean;
  liveCloseRemainingQuantity: number;
  liveCloseQuantityAdjusted: boolean;
  liveCloseNormalizedQuantity: number;
  confirmLivePositionClose: () => Promise<void>;
};

function quantityStepDecimals(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 8;
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Math.min(12, Number(text.split("e-")[1]) || 0);
  return Math.min(12, (text.split(".")[1] ?? "").length);
}

function formatQuantityByStep(value: number, step: number) {
  return formatCompactDecimal(value, quantityStepDecimals(step));
}

function formatPositionPrice(value: number) {
  return formatCompactDecimal(value, 8);
}

function liquidationPriceStatusLabel(position: LivePosition) {
  if (position.liquidationPriceStatus === "EXCHANGE_NOT_PROVIDED") return null;
  return {
    AVAILABLE: "Binance 强平价",
    DIRECTION_INVALID: "方向校验异常",
    MARK_PRICE_INVALID: "标记价无效",
    POSITION_NOT_FOUND: "等待仓位对账",
    UNKNOWN: "等待首次同步",
  }[position.liquidationPriceStatus ?? "UNKNOWN"];
}

type PositionMicrostructureView = {
  facts: {
    positionMoveFromEntryPercent?: number;
    observedAtMs?: number;
    windows?: Record<
      "5s" | "15s" | "30s",
      {
        amplitudePercent?: number | null;
        positionDirectionalChangePercent?: number | null;
        direction?: string;
        sampleCount?: number;
      }
    >;
  };
  protection?: {
    monitoringStartRoePercent?: number;
    monitoring?: boolean;
    state?: string;
    earlyProtectionAuthorized?: boolean;
    lossExitUrgency?: boolean;
    reason?: string;
  };
  entryProbe?: {
    status?: string;
    elapsedSeconds?: number;
    maximumObservationSeconds?: number;
    exitAuthorized?: boolean;
    reason?: string;
  };
};

function readPositionMicrostructure(
  value: string | undefined,
): PositionMicrostructureView | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PositionMicrostructureView;
    return parsed && typeof parsed === "object" && parsed.facts
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function microstructureDirectionLabel(direction: string | undefined) {
  return {
    FAVORABLE: "顺仓",
    ADVERSE: "逆仓",
    MIXED: "震荡",
    FLAT: "平稳",
    INSUFFICIENT: "采集中",
  }[direction ?? ""] ?? "采集中";
}

function microstructureProtectionLabel(
  protection: PositionMicrostructureView["protection"],
) {
  const monitoringStartRoePercent = Number.isFinite(
    Number(protection?.monitoringStartRoePercent),
  )
    ? Number(protection?.monitoringStartRoePercent)
    : 1;
  const monitoringLine = `+${monitoringStartRoePercent.toFixed(0)}%`;
  if (protection?.monitoring !== true)
    return `等待本仓达到 ${monitoringLine} · 秒级监控未激活`;
  return {
    WARMING: `本仓已达到 ${monitoringLine} · 秒级监控预热`,
    FAVORABLE_CONTINUATION: "本仓秒级监控中 · 顺仓延续",
    ADVERSE_ACCELERATION: "本仓秒级监控中 · 逆仓加速",
    REVERSAL_WARNING: "本仓秒级监控中 · 反转警告",
    RANGE_OR_MIXED: "本仓秒级监控中 · 震荡观察",
  }[protection?.state ?? ""] ?? "本仓秒级监控中 · 事实采集";
}

function entryProbeLabel(probe: PositionMicrostructureView["entryProbe"]) {
  if (!probe) return null;
  const elapsedSeconds = Math.max(0, Number(probe.elapsedSeconds) || 0);
  const maximumObservationSeconds = Math.max(
    1,
    Number(probe.maximumObservationSeconds) || 90,
  );
  return {
    WARMING: `开仓试探预热 ${elapsedSeconds.toFixed(0)}秒`,
    WATCHING: `开仓试探观察 ${elapsedSeconds.toFixed(0)}/${maximumObservationSeconds.toFixed(0)}秒`,
    FAILED: "开仓试探失败·退出已授权",
    EXPIRED: "开仓试探已确认结束·进入常规持仓管理",
    UNAVAILABLE: "开仓试探边界待补",
  }[probe.status ?? ""] ?? null;
}

export function PositionsView({
  livePositions,
  positionsLoaded,
  strategyNames,
  portfolioAccountFilter,
  accountFilterControl,
  positionsBusy,
  loadPositions,
  can,
  openLiveRiskEditor,
  openLiveCloseConfirmation,
  openLiveAddConfirmation,
  liveRiskEditTarget,
  setLiveRiskEditTarget,
  liveRiskEditForm,
  setLiveRiskEditForm,
  liveTakeProfitPlan,
  liveStopLossPlan,
  saveLivePositionRisk,
  liveAddTarget,
  setLiveAddTarget,
  liveAddSubmitting,
  liveAddQuantity,
  setLiveAddQuantity,
  liveAddQuantityMinimum,
  liveAddExactQuantityMinimum,
  liveAddQuantityStep,
  liveAddPrice,
  setLiveAddPrice,
  liveAddQuantityValid,
  liveAddMarket,
  liveAddPoolBusy,
  addLiveAddSymbolToPool,
  confirmLivePositionAdd,
  liveCloseTarget,
  setLiveCloseTarget,
  liveCloseSubmitting,
  liveCloseQuantity,
  setLiveCloseQuantity,
  liveCloseQuantityMinimum,
  liveCloseQuantityStep,
  liveClosePrice,
  setLiveClosePrice,
  liveCloseQuantityValid,
  liveCloseLeavesDust,
  liveCloseAll,
  liveCloseRemainingQuantity,
  liveCloseQuantityAdjusted,
  liveCloseNormalizedQuantity,
  confirmLivePositionClose,
}: PositionsViewProps) {
  const [entryValidationPositionId, setEntryValidationPositionId] = useState<
    number | null
  >(null);
  const [positionSortMode, setPositionSortMode] =
    useState<PositionSortMode>("SYMBOL_ASC");
  const open = useMemo(
    () =>
      livePositions
        .filter(
          (position) =>
            position.status !== "CLOSED" &&
            (portfolioAccountFilter === "ALL" ||
              position.accountId === portfolioAccountFilter),
        )
        .sort((left, right) =>
          stablePositionCompare(left, right, positionSortMode),
        ),
    [livePositions, portfolioAccountFilter, positionSortMode],
  );
  const exposure = summarizePositionExposure(open);
  const entryValidationPosition =
    entryValidationPositionId === null
      ? null
      : livePositions.find(
          (position) => position.id === entryValidationPositionId,
        ) ?? null;
  const entryValidationLearning = entryValidationPosition?.learning;
  const entryValidationPnl = entryValidationPosition
    ? (entryValidationPosition.positionSide === "LONG"
        ? entryValidationPosition.markPrice -
          entryValidationPosition.entryPrice
        : entryValidationPosition.entryPrice -
          entryValidationPosition.markPrice) * entryValidationPosition.quantity
    : 0;
  const entryValidationMargin = entryValidationPosition
    ? (entryValidationPosition.entryPrice *
        entryValidationPosition.quantity) /
      Math.max(entryValidationPosition.leverage, 1)
    : 0;
  const entryValidationRoe =
    entryValidationMargin > 0
      ? (entryValidationPnl / entryValidationMargin) * 100
      : 0;

  useEffect(() => {
    if (entryValidationPositionId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEntryValidationPositionId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [entryValidationPositionId]);

  return (
      <div className="work-page">
        <section className="panel control-panel live-position-panel">
          <div className="panel-head">
            <div>
              <h2>Binance 实盘持仓</h2>
              <p>止盈止损由系统内部监控，触发后立即向 Binance 市价减仓</p>
            </div>
            <div className="panel-actions">
              <div className="detail-account-toolbar">
                {accountFilterControl}
                <label className="position-sort-control">
                  <span>排序</span>
                  <select
                    value={positionSortMode}
                    onChange={(event) =>
                      setPositionSortMode(event.target.value as PositionSortMode)
                    }
                  >
                    <option value="PNL_DESC">盈亏金额</option>
                    <option value="QUANTITY_DESC">持仓数量</option>
                    <option value="SYMBOL_ASC">合约字母</option>
                  </select>
                </label>
                <span>
                  {positionsLoaded
                    ? `当前 ${open.length} 个仓位`
                    : "正在同步仓位…"}
                </span>
              </div>
              <button
                onClick={() => void loadPositions()}
                disabled={positionsBusy}
                aria-busy={positionsBusy}
                className="position-refresh-button"
              >
                刷新实盘仓位
              </button>
              <span className="source-tag danger-source">
                LIVE {positionsLoaded ? open.length : "同步中"}
              </span>
            </div>
          </div>
          {exposure.twoSided.length > 0 && (
            <div className="analytics-note">
              <b>同币种双向持仓：</b>{" "}
              {exposure.twoSided.map((item) => (
                <span key={`${item.accountId}-${item.symbol}`}>
                  {item.accountId} · {item.symbol} 多 {item.longNotional.toFixed(2)} / 空 {item.shortNotional.toFixed(2)} USDT，
                  净敞口 {item.netNotional.toFixed(2)}，双向重叠 {item.overlappingNotional.toFixed(2)} USDT（{item.overlapPercent.toFixed(0)}%）
                </span>
              ))}
              <small>双向重叠会同时占用保证金并产生双边交易成本；这里只提示，不自动调整仓位。</small>
            </div>
          )}
          <div className="data-table">
            <table>
              <thead>
                <tr>
                  <th>仓位</th>
                  <th>数量 / 杠杆</th>
                  <th>开仓 / 持仓 / 标记</th>
                  <th>强平价</th>
                  <th>盈亏 / ROE</th>
                  <th>入场验证</th>
                  <th>止盈 / 止损</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {!positionsLoaded && (
                  <tr>
                    <td colSpan={8} className="empty-table-cell">
                      正在读取 Binance 实盘仓位核心账本…
                    </td>
                  </tr>
                )}
                {positionsLoaded && open.length === 0 && (
                  <tr>
                    <td colSpan={8} className="empty-table-cell">
                      当前账户没有实盘仓位
                    </td>
                  </tr>
                )}
                {open.map((position) => {
                  const plan = liveRiskPlanSummary(position.riskPlanJson);
                  const marketMicrostructure = readPositionMicrostructure(
                    position.marketMicrostructureJson,
                  );
                  const currentNotionalExitPolicy =
                    resolveMinimumNotionalExitPolicy({
                      positionQuantity: position.quantity,
                      referencePrice: position.markPrice,
                      minNotionalUsdt:
                        position.executionRule?.minNotionalUsdt ?? Number.NaN,
                      plannedExitLegCount: plan.takeProfits.length,
                    });
                  const singleFullExit =
                    plan.notionalExitPolicy?.mode === "SINGLE_FULL_EXIT" ||
                    currentNotionalExitPolicy.mode === "SINGLE_FULL_EXIT";
                  const effectiveTakeProfits =
                    singleFullExit && plan.takeProfits.length > 0
                      ? [{
                          ...plan.takeProfits[0],
                          closeQuantity: position.quantity,
                        }]
                      : plan.takeProfits;
                  const executedPlan = liveExecutedRiskPlanSummary(
                    position.executedRiskPlanJson,
                  );
                  const rowPnl =
                    (position.positionSide === "LONG"
                      ? position.markPrice - position.entryPrice
                      : position.entryPrice - position.markPrice) *
                    position.quantity;
                  const initialMargin =
                    (position.entryPrice * position.quantity) /
                    Math.max(position.leverage, 1);
                  const rowRoe =
                    initialMargin > 0 ? (rowPnl / initialMargin) * 100 : 0;
                  const profitProtection = liveProfitProtectionStageSummary({
                    enabled:
                      plan.dynamicProfitProtectionEnabled &&
                      position.trailingStopPercent > 0,
                    currentQuantity: position.quantity,
                    currentRoePercent: rowRoe,
                    progress: executedPlan.dynamicProfitReduction,
                  });
                  const profitProtectionDetail =
                    profitProtection.state === "DISABLED"
                      ? "不参与首档止盈前动态减仓；不影响秒级监控和结构失效退出"
                      : profitProtection.state === "WAITING"
                        ? `当前 ${rowRoe >= 0 ? "+" : ""}${rowRoe.toFixed(2)}% ROE · 与1%秒级监控独立`
                        : profitProtection.historicalProgressRetained
                          ? `本规则已激活；激活前累计减仓 ${(profitProtection.cumulativeRatio * 100).toFixed(0)}%，不计入新阶段`
                          : profitProtection.forwardStage > 0
                            ? `本规则已执行 ${formatQuantityByStep(
                                profitProtection.executedQuantity,
                                position.executionRule?.quantityStep ??
                                  0.00000001,
                              )} / 基准 ${formatQuantityByStep(
                                profitProtection.anchorQuantity,
                                position.executionRule?.quantityStep ??
                                  0.00000001,
                              )}`
                            : `当前 ${rowRoe >= 0 ? "+" : ""}${rowRoe.toFixed(2)}% ROE · 等待真实回撤证据`;
                  const tailWaveExit = executedPlan.tailWaveExit;
                  const tailWaveExitDetail = tailWaveExit
                    ? tailWaveExit.phase === "OBSERVING"
                      ? `硬保护仍有效 · 最晚观察至 ${
                          tailWaveExit.deadlineAtMs
                            ? new Date(tailWaveExit.deadlineAtMs)
                                .toLocaleTimeString("zh-CN", { hour12: false })
                            : "—"
                        }`
                      : `首波峰 ${
                          tailWaveExit.rebreakPeakRoePercent !== null
                            ? `${tailWaveExit.rebreakPeakRoePercent >= 0 ? "+" : ""}${tailWaveExit.rebreakPeakRoePercent.toFixed(2)}% ROE`
                            : "采集中"
                        } · 峰值只上移`
                    : null;
                  const closeReconciliationPending =
                    position.status === "EXECUTION_UNKNOWN" ||
                    Boolean(position.pendingCloseClientOrderId);
                  const liquidationObservedAt = Number.isFinite(
                      Number(position.liquidationPriceObservedAt),
                    )
                    ? Number(position.liquidationPriceObservedAt)
                    : Date.parse(String(position.liquidationPriceObservedAt ?? ""));
                  return (
                    <Fragment key={position.id}>
                    <tr className="position-record-row">
                      <td className="position-identity-cell">
                        <span className="position-record-label">持仓记录</span>
                        <b>{position.symbol}</b>
                        <small>
                          {position.accountId} · #{position.id}
                        </small>
                        <span
                          className={
                            position.positionSide === "LONG"
                              ? "source-tag auto"
                              : "source-tag danger-source"
                          }
                        >
                          {position.positionSide === "LONG" ? "多仓" : "空仓"}
                        </span>
                      </td>
                      <td className="position-quantity-cell">
                        <b>
                          {formatQuantityByStep(
                            position.quantity,
                            position.executionRule?.quantityStep ?? 0.00000001,
                          )}
                        </b>
                        <small>{position.leverage}× 杠杆</small>
                      </td>
                      <td className="position-price-cell">
                        <span>
                          <small>开仓</small>
                          <b>
                            {Number.isFinite(position.allocationEntryPrice) &&
                            Number(position.allocationEntryPrice) > 0
                              ? formatPositionPrice(
                                  Number(position.allocationEntryPrice),
                                )
                              : "—"}
                          </b>
                        </span>
                        <span className="position-holding-price">
                          <small>持仓</small>
                          <b>
                            {Number.isFinite(
                              position.exchangeEntryPrice ??
                                position.entryPrice,
                            ) &&
                            Number(
                              position.exchangeEntryPrice ??
                                position.entryPrice,
                            ) > 0
                              ? formatPositionPrice(
                                  Number(
                                    position.exchangeEntryPrice ??
                                      position.entryPrice,
                                  ),
                                )
                              : "—"}
                          </b>
                        </span>
                        <span className="position-mark-price">
                          <small>标记</small>
                          <b>{formatPositionPrice(position.markPrice)}</b>
                        </span>
                      </td>
                      <td className="negative position-liquidation-cell">
                        {position.liquidationPriceStatus === "AVAILABLE" &&
                        Number(position.liquidationPrice) > 0 ? (
                          <>
                            <b>{formatPositionPrice(Number(position.liquidationPrice))}</b>
                            <small>
                              距标记价{" "}
                              {Math.abs(
                                ((position.markPrice - Number(position.liquidationPrice)) /
                                  Math.max(position.markPrice, Number.EPSILON)) *
                                  100,
                              ).toFixed(2)}
                              %
                            </small>
                            {Number.isFinite(liquidationObservedAt) && (
                              <small>
                                同步于 {new Date(liquidationObservedAt).toLocaleTimeString(
                                  "zh-CN",
                                  { hour12: false },
                                )}
                              </small>
                            )}
                          </>
                        ) : (
                          <>
                            <b>
                              {position.liquidationPriceStatus ===
                              "EXCHANGE_NOT_PROVIDED"
                                ? "-"
                                : "—"}
                            </b>
                            {liquidationPriceStatusLabel(position) && (
                              <small>{liquidationPriceStatusLabel(position)}</small>
                            )}
                            {position.liquidationPriceStatus ===
                                "DIRECTION_INVALID" &&
                              Number(position.liquidationPriceRaw) > 0 && (
                                <small>
                                  原始 {formatPositionPrice(
                                    Number(position.liquidationPriceRaw),
                                  )}
                                </small>
                              )}
                          </>
                        )}
                      </td>
                      <td className={rowPnl >= 0 ? "positive" : "negative"}>
                        <b>
                          {rowPnl >= 0 ? "+" : ""}
                          {rowPnl.toFixed(2)} USDT
                        </b>
                        <small>
                          {rowRoe >= 0 ? "+" : ""}
                          {rowRoe.toFixed(2)}%
                        </small>
                      </td>
                      <td className="position-learning-cell position-learning-cell-compact">
                        <button
                          type="button"
                          className="position-validation-trigger"
                          aria-label={`查看 ${position.symbol} 入场验证 #${position.id}`}
                          onClick={() =>
                            setEntryValidationPositionId(position.id)
                          }
                        >
                          <span>验证 #{position.id}</span>
                          <small>
                            {position.learning?.source === "STRATEGY"
                              ? position.learning.strategyId
                                ? `策略单 · ${
                                    strategyNames[
                                      position.learning.strategyId
                                    ] ??
                                    `NEXUS 大脑 #${position.learning.strategyId}`
                                  }`
                                : "策略单"
                              : position.learning?.source === "SEMI_AUTO"
                                ? "半自动"
                                : "人工单"}
                          </small>
                          <b
                            className={
                              position.learning?.verdict === "FAVORABLE"
                                ? "positive"
                                : position.learning?.verdict === "ADVERSE"
                                  ? "negative"
                                  : ""
                            }
                          >
                            {position.learning?.latestMinute
                              ? `${position.learning.latestMinute}分 · ${
                                  position.learning.latestRoePercent !== null &&
                                  position.learning.latestRoePercent !==
                                    undefined &&
                                  position.learning.latestRoePercent >= 0
                                    ? "+"
                                    : ""
                                }${position.learning.latestRoePercent?.toFixed(2) ?? "—"}%`
                              : position.learning?.collection?.label ??
                                "采集中"}
                          </b>
                        </button>
                        <div>
                          <span className={`source-tag ${position.learning?.source === "STRATEGY" ? "auto" : "protect"}`}>
                            {position.learning?.source === "STRATEGY" ? "策略单" : "人工单"}
                          </span>
                          {position.learning?.strategyId && (
                            <span
                              className="position-owner-chip"
                              title={`策略编号 ${position.learning.strategyId}`}
                            >
                              {strategyNames[position.learning.strategyId] ??
                                `NEXUS 大脑 #${position.learning.strategyId}`}
                            </span>
                          )}
                          <b className={position.learning?.verdict === "FAVORABLE" ? "positive" : position.learning?.verdict === "ADVERSE" ? "negative" : ""}>
                            {position.learning?.latestMinute
                              ? `第 ${position.learning.latestMinute} 分钟 ${position.learning.latestRoePercent !== null && position.learning.latestRoePercent !== undefined && position.learning.latestRoePercent >= 0 ? "+" : ""}${position.learning.latestRoePercent?.toFixed(2) ?? "—"}%`
                              : position.learning?.collection?.label ??
                                "学习摘要重试中"}
                          </b>
                        </div>
                        <small>
                          最优 {position.learning?.mfeRoePercent !== null && position.learning?.mfeRoePercent !== undefined ? `${position.learning.mfeRoePercent >= 0 ? "+" : ""}${position.learning.mfeRoePercent.toFixed(2)}%` : "—"}
                          {" · "}最差 {position.learning?.maeRoePercent !== null && position.learning?.maeRoePercent !== undefined ? `${position.learning.maeRoePercent >= 0 ? "+" : ""}${position.learning.maeRoePercent.toFixed(2)}%` : "—"}
                        </small>
                        <small
                          title="只有具备计划时间、采样时间且处于实时因果窗口内的样本参与当前判断；旧样本仅用于历史复盘。"
                        >
                          实时样本 {position.learning?.sampleCount ?? 0}
                          {position.learning?.historicalSampleCount
                            ? ` · 历史参考 ${position.learning.historicalSampleCount}`
                            : ""}
                        </small>
                        <small title={position.learning?.entryEvidenceSummary}>
                          {position.learning?.entryEvidenceSummary}
                        </small>
                        <small title={position.learning?.suggestion}>
                          {position.learning?.comparison ?? "后台将维护开仓后短周期与延长波段数据"}
                        </small>
                        <small className="position-learning-suggestion">
                          建议：{position.learning?.suggestion ??
                            "后台样本继续采集；下次刷新自动恢复，不需要重新下单"}
                        </small>
                        {position.learning?.positionManagementDecision && (
                          <small
                            className={
                              position.learning.positionManagementDecision.state === "TREND_INVALIDATED" ||
                              position.learning.positionManagementDecision.state === "LOSS_WAIT_BOTTOM"
                                ? "negative"
                                : position.learning.positionManagementDecision.state === "PROFIT_CONTINUATION" ||
                                    position.learning.positionManagementDecision.state === "BOTTOM_REBOUND_CONFIRMED"
                                  ? "positive"
                                  : ""
                            }
                            title={String(position.learning.positionManagementDecision.reason ?? "")}
                          >
                            持仓判断：{String(position.learning.positionManagementDecision.label ?? "继续观察")}
                            {position.learning.positionManagementDecision.action === "ADD_ELIGIBLE" ||
                            position.learning.positionManagementDecision.action === "SCALE_IN_ELIGIBLE"
                              ? position.learning.positionManagementDecision.opportunityExpired
                                ? "（当时加仓窗口已结束，仅保留复盘）"
                                : position.learning.positionManagementDecision.action === "SCALE_IN_ELIGIBLE"
                                  ? "（盈利奖励加仓条件已满足，按策略参数执行账户、资金与幂等核验）"
                                  : "（补仓条件已满足，按策略参数执行账户、资金与幂等核验）"
                              : ""}
                          </small>
                        )}
                        {position.learning?.positionManagementDecision
                          ?.contractTrendProfile && (
                          <small
                            className="position-learning-suggestion"
                            title={String(
                              position.learning.positionManagementDecision
                                .contractTrendProfile.reason ?? "",
                            )}
                          >
                            持仓周期：
                            {String(
                              position.learning.positionManagementDecision
                                .contractTrendProfile.baseHorizon ?? "未指定",
                            )}
                            {position.learning.positionManagementDecision
                                .contractTrendProfile.effectiveHorizon &&
                            position.learning.positionManagementDecision
                                .contractTrendProfile.effectiveHorizon !==
                              position.learning.positionManagementDecision
                                .contractTrendProfile.baseHorizon
                              ? ` → ${String(
                                  position.learning.positionManagementDecision
                                    .contractTrendProfile.effectiveHorizon,
                                )}`
                              : ""}
                            {` · 多小时${String(
                              position.learning.positionManagementDecision
                                .contractTrendProfile.status ?? "UNAVAILABLE",
                            )}`}
                          </small>
                        )}
                        {position.learning?.structureProtection && (
                          <small
                            className={
                              position.learning.structureProtection.stage ===
                                "WARNING" ||
                              position.learning.structureProtection.stage ===
                                "CONFIRMED"
                                ? "negative"
                                : position.learning.structureProtection.stage ===
                                      "SUBMITTED"
                                  ? "warning-text"
                                  : position.learning.structureProtection.stage ===
                                        "RECONCILED"
                                    ? "positive"
                                    : ""
                            }
                            title={position.learning.structureProtection.reason}
                          >
                            结构保护：
                            {position.learning.structureProtection.label}
                            {position.learning.structureProtection.stage ===
                              "WARNING"
                              ? `（完整1分钟收盘 ${position.learning.structureProtection.consecutiveClosedMinutes}/${position.learning.structureProtection.requiredClosedMinutes}）`
                              : ""}
                          </small>
                        )}
                        {position.learning?.positionManagementDecision?.rotationPlan && (
                          <small
                            className="position-learning-suggestion"
                            title={String(
                              position.learning.positionManagementDecision
                                .rotationPlan.reason ?? "",
                            )}
                          >
                            轮动/对冲：
                            {String(
                              position.learning.positionManagementDecision
                                .rotationPlan.label ?? "继续观察",
                            )}
                          </small>
                        )}
                        {position.learning?.positionManagementExecutionBinding && (
                          <small
                            className={
                              position.learning.positionManagementExecutionBinding
                                .status === "BOUND"
                                ? "positive"
                                : position.learning
                                      .positionManagementExecutionBinding
                                      .status === "DISABLED" ||
                                    position.learning
                                      .positionManagementExecutionBinding
                                      .status === "OBSERVATION_ONLY"
                                  ? "negative"
                                  : ""
                            }
                            title={
                              position.learning
                                .positionManagementExecutionBinding.summary
                            }
                          >
                            动作绑定：
                            {position.learning
                              .positionManagementExecutionBinding.summary}
                          </small>
                        )}
                        {position.learning?.positionAdditionExecution && (
                          <small
                            className={
                              position.learning.positionAdditionExecution.executed
                                ? "positive"
                                : position.learning.positionAdditionExecution.attempted
                                  ? "negative"
                                  : ""
                            }
                            title={
                              [
                                position.learning.positionAdditionExecution
                                  .evaluatedAtMs
                                  ? new Date(
                                      position.learning.positionAdditionExecution
                                        .evaluatedAtMs,
                                    ).toLocaleString("zh-CN", { hour12: false })
                                  : "",
                                position.learning.positionAdditionExecution
                                  .detail ?? "",
                              ].filter(Boolean).join(" · ")
                            }
                          >
                            补仓执行：
                            {position.learning.positionAdditionExecution.label}
                            {position.learning.positionAdditionExecution
                              .evaluatedAtMs
                              ? ` · ${new Date(
                                  position.learning.positionAdditionExecution
                                    .evaluatedAtMs,
                                ).toLocaleTimeString("zh-CN", { hour12: false })}`
                              : ""}
                          </small>
                        )}
                        {(position.additionSummary?.count ?? 0) > 0 && (
                          <small className="positive">
                            已完成补仓 {position.additionSummary?.count} 次
                            {position.additionSummary?.latest?.entryPrice
                              ? ` · 最近成交 ${formatPositionPrice(position.additionSummary.latest.entryPrice)}`
                              : ""}
                          </small>
                        )}
                        {position.additionSummary?.latest?.learning && (
                          <small
                            className={
                              position.additionSummary.latest.learning.verdict === "IMPROVED"
                                ? "positive"
                                : position.additionSummary.latest.learning.verdict === "WORSENED"
                                  ? "negative"
                                  : ""
                            }
                          >
                            补仓验证：{position.additionSummary.latest.learning.comparison}
                          </small>
                        )}
                        {position.additionSummary?.latest?.status === "EXECUTION_UNKNOWN" && (
                          <small className="negative">
                            最近补仓成交状态对账中，系统禁止重复补仓
                          </small>
                        )}
                      </td>
                      <td className="position-risk-summary">
                        <div className="position-risk-line positive">
                          <b>止盈</b>
                          {effectiveTakeProfits.length > 0 ? (
                            <div className="position-take-profit-progress">
                              {effectiveTakeProfits.map((item, index) => {
                                const completed =
                                  executedPlan.takeProfits.includes(index);
                                const partial =
                                  !completed &&
                                  (executedPlan.takeProfitQuantities[
                                    String(index)
                                  ] ?? 0) > 0;
                                return (
                                  <span
                                    key={`${position.id}-take-profit-${index}`}
                                    className={
                                      completed
                                        ? "completed"
                                        : partial
                                          ? "partial"
                                          : "pending"
                                    }
                                    title={`当前剩余第${index + 1}格 · +${item.triggerPercent}% ROE · 数量 ${
                                      Number.isFinite(Number(item.closeQuantity))
                                        ? formatQuantityByStep(
                                            Number(item.closeQuantity),
                                            position.executionRule?.quantityStep ?? 0.00000001,
                                          )
                                        : "—"
                                    } · ${
                                      completed
                                        ? "已完成止盈"
                                        : partial
                                          ? "部分成交，尚未完成"
                                          : "尚未触发"
                                    }`}
                                  >
                                    +{item.triggerPercent}% · {Number.isFinite(Number(item.closeQuantity))
                                      ? formatQuantityByStep(
                                          Number(item.closeQuantity),
                                          position.executionRule?.quantityStep ?? 0.00000001,
                                        )
                                      : "—"} · {completed
                                        ? "已完成"
                                        : partial
                                          ? "部分成交"
                                          : "待触发"}
                                  </span>
                                );
                              })}
                            </div>
                          ) : (
                            <span>未设置</span>
                          )}
                        </div>
                        {singleFullExit && plan.takeProfits.length > 0 && (
                          <small className="position-note">
                            实际执行：首档整仓退出（最小名义价值保护）
                          </small>
                        )}
                        <div className="position-risk-line negative">
                          <b>止损</b>
                          {plan.stopLosses.length > 0 ? (
                            <div className="position-stop-loss-progress">
                              {plan.stopLosses.map((item, index) => {
                                const completed =
                                  executedPlan.stopLosses.includes(index);
                                return (
                                  <span
                                    key={`${position.id}-stop-loss-${index}`}
                                    className={completed ? "completed" : "pending"}
                                    title={`当前剩余第${index + 1}格 · -${item.triggerPercent}% ROE · 数量 ${
                                      Number.isFinite(Number(item.closeQuantity))
                                        ? formatQuantityByStep(
                                            Number(item.closeQuantity),
                                            position.executionRule?.quantityStep ?? 0.00000001,
                                          )
                                        : "—"
                                    } · ${
                                      completed ? "已执行止损" : "尚未触发"
                                    }`}
                                  >
                                    -{item.triggerPercent}% · {Number.isFinite(Number(item.closeQuantity))
                                      ? formatQuantityByStep(
                                          Number(item.closeQuantity),
                                          position.executionRule?.quantityStep ?? 0.00000001,
                                        )
                                      : "—"} · {completed ? "已执行" : "待触发"}
                                  </span>
                                );
                              })}
                            </div>
                          ) : (
                            <span>
                              {plan.capitalPreservationStopRoePercent !== null
                                ? `-${plan.capitalPreservationStopRoePercent}% · 本金保护 · 待触发`
                                : "未设置"}
                            </span>
                          )}
                        </div>
                        <small className="position-note">
                          观察 {plan.minimumObservationMinutes} 分钟 · 强平缓冲 {plan.liquidationGuardBufferPercent}%
                        </small>
                        <small className="position-note">
                          移动止损：
                          {position.trailingStopPercent > 0
                            ? `+${position.trailingActivationPercent}% 启动，回撤 ${position.trailingStopPercent} 点`
                            : "关闭"}
                        </small>
                      </td>
                      <td>
                        <div className="live-position-actions">
                          <button
                            className="text-action"
                            disabled={
                              position.status !== "OPEN" ||
                              !can("trade:position:risk_edit")
                            }
                            onClick={() => openLiveRiskEditor(position)}
                          >
                            修改参数
                          </button>
                          <button
                            className="text-action danger-text"
                            disabled={
                              liveCloseSubmitting ||
                              position.status !== "OPEN" ||
                              !can("trade:position:close")
                            }
                            onClick={() =>
                              openLiveCloseConfirmation(position, "MARKET")
                            }
                          >
                            {closeReconciliationPending
                              ? "成交对账中"
                              : "市价平仓"}
                          </button>
                          <button
                            className="text-action"
                            disabled={
                              liveAddSubmitting ||
                              position.status !== "OPEN" ||
                              !can("trade:manual:create")
                            }
                            title="仅通过仓位管理补仓；成交后重新核对均价、强平价和保护网格"
                            onClick={() => openLiveAddConfirmation(position)}
                          >
                            人工补仓
                          </button>
                          <button
                            className="text-action danger-text"
                            disabled={
                              liveCloseSubmitting ||
                              position.status !== "OPEN" ||
                              !can("trade:position:close")
                            }
                            onClick={() =>
                              openLiveCloseConfirmation(position, "LIMIT")
                            }
                          >
                            限价平仓
                          </button>
                        </div>
                      </td>
                    </tr>
                    <tr className="position-status-row position-monitor-row">
                      <td colSpan={8} className="position-status-detail-cell">
                        <div className="position-monitor-header">
                          <b>动态监控</b>
                          <span>秒级事实 · 保护状态 · 只针对本仓</span>
                        </div>
                        <div className="position-status-detail">
                          <span
                            className={`source-tag ${position.status === "OPEN" ? "auto" : "danger-source"}`}
                          >
                            {position.status === "OPEN"
                              ? position.protectionState === "POST_ADD_REVALIDATION"
                                ? "补仓后待重建保护"
                                : position.protectionState === "ERROR"
                                  ? "保护版本异常"
                                  : "后台保护中"
                              : position.status === "EXECUTION_UNKNOWN"
                                ? "成交状态未知"
                                : "风控异常"}
                          </span>
                          <div
                            className={`position-profit-protection ${profitProtection.state.toLowerCase()}`}
                            title={
                              profitProtection.activatedAtMs
                                ? `激活时间 ${new Date(
                                    profitProtection.activatedAtMs,
                                  ).toLocaleString("zh-CN", { hour12: false })}`
                                : profitProtectionDetail
                            }
                          >
                            <b>{profitProtection.label}</b>
                            <small>{profitProtectionDetail}</small>
                          </div>
                          {tailWaveExit && (
                            <div
                              className="position-profit-protection armed"
                              title="仅适用于已经真实盈利止盈且剩余仓位不超过策略上限的新仓；固定止损、强平保护与费用硬保护不会被延迟。"
                            >
                              <b>
                                {tailWaveExit.phase === "OBSERVING"
                                  ? "尾仓调整观察中"
                                  : "再突破首波峰跟踪中"}
                              </b>
                              <small>{tailWaveExitDetail}</small>
                            </div>
                          )}
                          {marketMicrostructure ? (
                            <div
                              className={`position-profit-protection ${
                                marketMicrostructure.protection
                                  ?.earlyProtectionAuthorized
                                  ? "armed"
                                  : "waiting"
                              }`}
                              title={
                                marketMicrostructure.protection?.reason ??
                                "秒级价格事实仅确认既有持仓证据，不单独触发平仓或反向订单。"
                              }
                            >
                              <b>
                                {microstructureProtectionLabel(
                                  marketMicrostructure.protection,
                                )}
                              </b>
                              <small>
                                +1%仅激活观察，不单独止损或减仓；只有原入场证据同步恶化才允许保护执行
                              </small>
                              {entryProbeLabel(marketMicrostructure.entryProbe) && (
                                <small
                                  className={marketMicrostructure.entryProbe?.exitAuthorized
                                    ? "negative"
                                    : undefined}
                                  title={marketMicrostructure.entryProbe?.reason}
                                >
                                  {entryProbeLabel(marketMicrostructure.entryProbe)}
                                </small>
                              )}
                              <small>
                                相对开仓价 {Number(
                                  marketMicrostructure.facts
                                    .positionMoveFromEntryPercent ?? 0,
                                ) >= 0 ? "+" : ""}
                                {Number(
                                  marketMicrostructure.facts
                                    .positionMoveFromEntryPercent ?? 0,
                                ).toFixed(3)}%
                              </small>
                              <small>
                                {(["5s", "15s", "30s"] as const).map(
                                  (windowKey) => {
                                    const window = marketMicrostructure.facts
                                      .windows?.[windowKey];
                                    const directionalChange = Number(
                                      window?.positionDirectionalChangePercent ??
                                        0,
                                    );
                                    return `${windowKey} ${microstructureDirectionLabel(
                                      window?.direction,
                                    )} ${directionalChange >= 0 ? "+" : ""}${directionalChange.toFixed(3)}% / 振幅 ${Number(
                                      window?.amplitudePercent ?? 0,
                                    ).toFixed(3)}%`;
                                  },
                                ).join(" · ")}
                              </small>
                            </div>
                          ) : (
                            <div
                              className="position-profit-protection waiting"
                              title="秒级事实按本仓开仓价格独立计算；数据尚未同步时不产生止损、减仓或反向订单。"
                            >
                              <b>本仓秒级监控同步中</b>
                              <small>
                                +1%仅激活观察，不单独止损或减仓
                              </small>
                            </div>
                          )}
                          {position.status === "OPEN" &&
                            position.protectionState === "POST_ADD_REVALIDATION" && (
                              <small className="negative">
                                旧ROE止损和旧移动止损已停用；强平缓冲继续生效，请按新均价重新配置保护
                              </small>
                            )}
                          {position.lastError && (
                            <small className="negative">
                              {position.lastError}
                            </small>
                          )}
                        </div>
                      </td>
                    </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {!positionsBusy && open.length === 0 && (
              <div className="empty">暂无系统托管的实盘持仓。</div>
            )}
          </div>
        </section>
        {entryValidationPosition && (
          <div
            className="context-popover-layer position-validation-layer"
            role="dialog"
            aria-labelledby="position-validation-title"
            onMouseDown={() => setEntryValidationPositionId(null)}
          >
            <div
              className="context-popover-card position-validation-modal"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="config-title position-validation-title">
                <div>
                  <h2 id="position-validation-title">
                    入场验证 #{entryValidationPosition.id}
                  </h2>
                  <p>
                    {entryValidationPosition.symbol} ·{" "}
                    {entryValidationPosition.accountId} ·{" "}
                    {entryValidationPosition.positionSide === "LONG"
                      ? "多仓"
                      : "空仓"}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="关闭入场验证"
                  onClick={() => setEntryValidationPositionId(null)}
                >
                  ×
                </button>
              </div>

              <div className="position-validation-summary">
                <div>
                  <span>来源</span>
                  <b>
                    {entryValidationLearning?.source === "STRATEGY"
                      ? "策略单"
                      : entryValidationLearning?.source === "SEMI_AUTO"
                        ? "半自动单"
                        : "人工单"}
                  </b>
                </div>
                <div>
                  <span>归属大脑</span>
                  <b>
                    {entryValidationLearning?.strategyId
                      ? strategyNames[entryValidationLearning.strategyId] ??
                        `NEXUS 大脑 #${entryValidationLearning.strategyId}`
                      : "独立仓位"}
                  </b>
                </div>
                <div>
                  <span>当前盈亏</span>
                  <b
                    className={
                      entryValidationPnl >= 0 ? "positive" : "negative"
                    }
                  >
                    {entryValidationPnl >= 0 ? "+" : ""}
                    {entryValidationPnl.toFixed(2)} USDT
                  </b>
                </div>
                <div>
                  <span>当前 ROE</span>
                  <b
                    className={
                      entryValidationRoe >= 0 ? "positive" : "negative"
                    }
                  >
                    {entryValidationRoe >= 0 ? "+" : ""}
                    {entryValidationRoe.toFixed(2)}%
                  </b>
                </div>
                <div>
                  <span>验证进度</span>
                  <b>
                    {entryValidationLearning?.latestMinute
                      ? `第 ${entryValidationLearning.latestMinute} 分钟`
                      : entryValidationLearning?.collection?.label ?? "采集中"}
                  </b>
                  <small>
                    实时 {entryValidationLearning?.sampleCount ?? 0} 条
                    {entryValidationLearning?.historicalSampleCount
                      ? ` · 历史参考 ${entryValidationLearning.historicalSampleCount} 条`
                      : ""}
                  </small>
                </div>
                <div>
                  <span>阶段表现</span>
                  <b>
                    最优{" "}
                    {entryValidationLearning?.mfeRoePercent !== null &&
                    entryValidationLearning?.mfeRoePercent !== undefined
                      ? `${entryValidationLearning.mfeRoePercent >= 0 ? "+" : ""}${entryValidationLearning.mfeRoePercent.toFixed(2)}%`
                      : "—"}
                    {" · "}最差{" "}
                    {entryValidationLearning?.maeRoePercent !== null &&
                    entryValidationLearning?.maeRoePercent !== undefined
                      ? `${entryValidationLearning.maeRoePercent >= 0 ? "+" : ""}${entryValidationLearning.maeRoePercent.toFixed(2)}%`
                      : "—"}
                  </b>
                </div>
              </div>

              <div className="position-validation-detail-list">
                <section>
                  <h3>入场证据</h3>
                  <p>
                    {entryValidationLearning?.entryEvidenceSummary ||
                      "入场证据正在由后台持续采集。"}
                  </p>
                </section>
                <section>
                  <h3>验证结论</h3>
                  <p>
                    {entryValidationLearning?.comparison ??
                      "后台将维护开仓后的短周期与延长波段数据。"}
                  </p>
                  <small>
                    建议：
                    {entryValidationLearning?.suggestion ??
                      entryValidationLearning?.collection?.nextAction ??
                      "继续采集，不需要重新下单。"}
                  </small>
                </section>
                {entryValidationLearning?.positionManagementDecision && (
                  <section>
                    <h3>持仓判断</h3>
                    <p>
                      {entryValidationLearning.positionManagementDecision
                        .label ?? "继续观察"}
                    </p>
                    <small>
                      {
                        entryValidationLearning.positionManagementDecision
                          .reason
                      }
                    </small>
                  </section>
                )}
                {entryValidationLearning?.structureProtection && (
                  <section>
                    <h3>结构保护</h3>
                    <p>{entryValidationLearning.structureProtection.label}</p>
                    <small>
                      {entryValidationLearning.structureProtection.reason}
                    </small>
                  </section>
                )}
                {entryValidationLearning?.positionManagementDecision
                  ?.rotationPlan && (
                  <section>
                    <h3>轮动 / 对冲</h3>
                    <p>
                      {entryValidationLearning.positionManagementDecision
                        .rotationPlan.label ?? "继续观察"}
                    </p>
                    <small>
                      {
                        entryValidationLearning.positionManagementDecision
                          .rotationPlan.reason
                      }
                    </small>
                  </section>
                )}
                {entryValidationLearning?.positionManagementExecutionBinding && (
                  <section>
                    <h3>动作绑定</h3>
                    <p>
                      {
                        entryValidationLearning
                          .positionManagementExecutionBinding.summary
                      }
                    </p>
                  </section>
                )}
                {entryValidationLearning?.positionAdditionExecution && (
                  <section>
                    <h3>补仓执行</h3>
                    <p>
                      {entryValidationLearning.positionAdditionExecution.label}
                    </p>
                    {entryValidationLearning.positionAdditionExecution
                      .detail && (
                      <small>
                        {
                          entryValidationLearning.positionAdditionExecution
                            .detail
                        }
                      </small>
                    )}
                  </section>
                )}
                {(entryValidationPosition.additionSummary?.count ?? 0) > 0 && (
                  <section>
                    <h3>补仓验证</h3>
                    <p>
                      已完成补仓{" "}
                      {entryValidationPosition.additionSummary?.count} 次
                      {entryValidationPosition.additionSummary?.latest
                        ?.entryPrice
                        ? ` · 最近成交 ${formatPositionPrice(entryValidationPosition.additionSummary.latest.entryPrice)}`
                        : ""}
                    </p>
                    {entryValidationPosition.additionSummary?.latest
                      ?.learning && (
                      <small>
                        {
                          entryValidationPosition.additionSummary.latest
                            .learning.comparison
                        }
                      </small>
                    )}
                  </section>
                )}
              </div>

              <div className="config-actions">
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => setEntryValidationPositionId(null)}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
        {liveRiskEditTarget && (
          <div className="context-popover-layer" role="dialog">
            <div className="context-popover-card risk-editor-popover">
              <div className="config-title">
                <div>
                  <h2>修改实盘自动风控</h2>
                  <p>{liveRiskEditTarget.symbol} · 保存后后台立即生效</p>
                </div>
                <button
                  aria-label="关闭"
                  onClick={() => setLiveRiskEditTarget(null)}
                >
                  ×
                </button>
              </div>
              <div className="config-grid">
                <label>
                  <span>止盈起始 ROE</span>
                  <input
                    type="number"
                    min="0.00000001"
                    step="0.1"
                    value={liveRiskEditForm.takeStart}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        takeStart: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>止盈结束 ROE</span>
                  <input
                    type="number"
                    min="0.00000001"
                    step="0.1"
                    value={liveRiskEditForm.takeEnd}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        takeEnd: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>止盈格数</span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={liveRiskEditForm.takeGrids}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        takeGrids: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>止损起始 ROE</span>
                  <input
                    type="number"
                    min="0.00000001"
                    step="0.1"
                    value={liveRiskEditForm.stopStart}
                    disabled={liveRiskEditForm.trailingCallback > 0}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        stopStart: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>止损结束 ROE</span>
                  <input
                    type="number"
                    min="0.00000001"
                    step="0.1"
                    value={liveRiskEditForm.stopEnd}
                    disabled={liveRiskEditForm.trailingCallback > 0}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        stopEnd: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>止损格数</span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={liveRiskEditForm.stopGrids}
                    disabled={liveRiskEditForm.trailingCallback > 0}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        stopGrids: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>动态移动止损</span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={liveRiskEditForm.trailingCallback > 0}
                      onChange={(event) =>
                        setLiveRiskEditForm({
                          ...liveRiskEditForm,
                          trailingCallback: event.target.checked
                            ? Math.max(liveRiskEditForm.trailingCallback, 3)
                            : 0,
                        })
                      }
                    />
                    <i></i>
                  </span>
                  <small>
                    开启：固定止损网格无效；关闭：仅执行固定止损。分批止盈和强平保护始终有效。
                  </small>
                </label>
                <label>
                  <span>动态保护启动 ROE</span>
                  <input
                    type="number"
                    min="0.1"
                    max="100"
                    step="0.1"
                    value={liveRiskEditForm.trailingActivation}
                    disabled={liveRiskEditForm.trailingCallback === 0}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        trailingActivation: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>完整周期观察时长</span>
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    step="5"
                    value={liveRiskEditForm.minimumObservationMinutes}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        minimumObservationMinutes: Number(event.target.value),
                      })
                    }
                  />
                  <small>仅用于延后参数优化结论，所有已配置保护线照常执行。</small>
                </label>
                <label>
                  <span>距强平价保护缓冲</span>
                  <input
                    type="number"
                    min="0.1"
                    max="50"
                    step="0.1"
                    value={liveRiskEditForm.liquidationGuardBufferPercent}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        liquidationGuardBufferPercent: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>动态保护最小回撤空间</span>
                  <input
                    type="number"
                    min="0.1"
                    max="50"
                    step="0.1"
                    value={liveRiskEditForm.trailingCallback}
                    disabled={liveRiskEditForm.trailingCallback === 0}
                    onChange={(event) =>
                      setLiveRiskEditForm({
                        ...liveRiskEditForm,
                        trailingCallback: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="config-safety">
                <b>实际拆分</b>
                <span>
                  止盈{" "}
                  {liveTakeProfitPlan
                    .map(
                      (item) =>
                        `${item.triggerPercent}% ROE/${formatQuantityByStep(
                          item.closeQuantity,
                          liveRiskEditTarget.executionRule?.quantityStep ??
                            0.00000001,
                        )}`,
                    )
                    .join("、")}
                  ；止损{" "}
                  {liveStopLossPlan
                    .map(
                      (item) =>
                        `${item.triggerPercent}% ROE/${formatQuantityByStep(
                          item.closeQuantity,
                          liveRiskEditTarget.executionRule?.quantityStep ??
                            0.00000001,
                        )}`,
                    )
                    .join("、")}
                  。每档自动满足最小量和步长。
                </span>
              </div>
              <div className="config-actions">
                <button onClick={() => setLiveRiskEditTarget(null)}>
                  取消
                </button>
                <button
                  className="primary-btn"
                  disabled={
                    positionsBusy ||
                    liveRiskEditForm.takeStart >= liveRiskEditForm.takeEnd ||
                    liveRiskEditForm.stopStart >= liveRiskEditForm.stopEnd
                  }
                  onClick={() => void saveLivePositionRisk()}
                >
                  {positionsBusy ? "保存中…" : "保存并立即生效"}
                </button>
              </div>
            </div>
          </div>
        )}
        {liveAddTarget && (
          <div
            className="context-popover-layer live-close-popover-layer"
            role="alertdialog"
            aria-labelledby="live-add-title"
          >
            <div className="context-popover-card live-close-confirm-modal">
              <div className="config-title live-close-title">
                <div>
                  <h2 id="live-add-title">人工补仓确认</h2>
                  <p>Binance 实盘 · 成交后重算均价、强平价和保护计划</p>
                </div>
                <button
                  aria-label="关闭"
                  disabled={liveAddSubmitting}
                  onClick={() => setLiveAddTarget(null)}
                >
                  ×
                </button>
              </div>
              <div className="live-close-summary-table">
                <span>合约</span>
                <b>{liveAddTarget.position.symbol}</b>
                <span>方向</span>
                <b>
                  {liveAddTarget.position.positionSide === "LONG"
                    ? "做多"
                    : "做空"}
                </b>
                <span>当前持仓</span>
                <b>
                  {formatQuantityByStep(
                    liveAddTarget.position.quantity,
                    liveAddTarget.position.executionRule?.quantityStep ??
                      0.00000001,
                  )}
                </b>
                <span>当前均价</span>
                <b>{formatPositionPrice(liveAddTarget.position.entryPrice)}</b>
                <span>强平价</span>
                <b>
                  {liveAddTarget.position.liquidationPrice
                    ? formatPositionPrice(
                        liveAddTarget.position.liquidationPrice,
                      )
                    : "-"}
                </b>
                <span>补仓方式</span>
                <b>{liveAddTarget.orderType === "MARKET" ? "市价补仓" : "限价补仓（FOK）"}</b>
              </div>
              <div className="live-close-control-row">
                <b>委托方式</b>
                <div className="segmented inline-segmented">
                  {(["MARKET", "LIMIT"] as const).map((orderType) => (
                    <button
                      key={orderType}
                      type="button"
                      className={liveAddTarget.orderType === orderType ? "active" : ""}
                      disabled={liveAddSubmitting}
                      onClick={() =>
                        setLiveAddTarget({ ...liveAddTarget, orderType })
                      }
                    >
                      {orderType === "MARKET" ? "市价" : "限价 FOK"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="live-close-control-row">
                <b>补仓数量</b>
                <NumberStepper
                  label="补仓数量"
                  value={liveAddQuantity}
                  min={liveAddQuantityMinimum}
                  step={liveAddQuantityStep}
                  readOnly={liveAddSubmitting}
                  allowEmpty
                  onChange={setLiveAddQuantity}
                />
              </div>
              <div className="live-close-hint">
                Binance 最小下单量 {formatQuantityByStep(liveAddExactQuantityMinimum, liveAddQuantityStep)} {liveAddTarget.position.symbol.replace("USDT", "")}
                {liveAddTarget.orderType === "MARKET"
                  ? ` · 市价安全下单量 ${formatQuantityByStep(liveAddQuantityMinimum, liveAddQuantityStep)}（含 2% 安全垫）`
                  : ""}
                {` · 数量步长 ${formatQuantityByStep(liveAddQuantityStep, liveAddQuantityStep)}`}
                {(liveAddTarget.position.executionRule?.minNotionalUsdt ?? liveAddMarket?.minNotionalUsdt)
                  ? ` · 最小金额 ${liveAddTarget.position.executionRule?.minNotionalUsdt ?? liveAddMarket?.minNotionalUsdt} USDT`
                  : ""}
                。可清空后重新输入，系统提交前会再次按 Binance 规则校验。
              </div>
              {!liveAddMarket && (
                <div className="live-add-pool-warning">
                  <span>
                    <b>{liveAddTarget.position.symbol}</b> 当前不在合约池；已有仓位仍受保护，加入后恢复行情同步与策略扫描。
                  </span>
                  {can("trade:symbol_pool:edit") && (
                    <button
                      type="button"
                      disabled={liveAddPoolBusy || liveAddSubmitting}
                      onClick={() =>
                        void addLiveAddSymbolToPool(liveAddTarget.position.symbol)
                      }
                    >
                      {liveAddPoolBusy ? "加入中…" : "加入合约池"}
                    </button>
                  )}
                </div>
              )}
              {liveAddTarget.orderType === "LIMIT" && (
                <div className="live-close-control-row live-close-limit-row">
                  <b>限价价格</b>
                  <input
                    aria-label="限价补仓价格"
                    type="number"
                    min="0.00000001"
                    step="any"
                    value={liveAddPrice}
                    disabled={liveAddSubmitting}
                    onChange={(event) =>
                      setLiveAddPrice(Number(event.target.value))
                    }
                  />
                </div>
              )}
              <div className="live-close-hint">
                补仓只增加当前同方向仓位；成交后以 Binance 真实持仓均价和强平价为准，并按新数量重新拆分止盈止损。
              </div>
              <div className="config-actions">
                <button
                  disabled={liveAddSubmitting}
                  onClick={() => setLiveAddTarget(null)}
                >
                  取消
                </button>
                <button
                  className="primary-btn"
                  disabled={
                    liveAddSubmitting ||
                    !liveAddQuantityValid ||
                    (liveAddTarget.orderType === "LIMIT" &&
                      (!Number.isFinite(liveAddPrice) || liveAddPrice <= 0))
                  }
                  onClick={() => void confirmLivePositionAdd()}
                >
                  {liveAddSubmitting ? "提交中…" : "确认补仓"}
                </button>
              </div>
            </div>
          </div>
        )}
        {liveCloseTarget && (
          <div
            className="context-popover-layer live-close-popover-layer"
            role="alertdialog"
            aria-labelledby="live-close-title"
          >
            <div className="context-popover-card live-close-confirm-modal">
              <div className="config-title live-close-title">
                <div>
                  <h2 id="live-close-title">平仓确认</h2>
                  <p>Binance 实盘 · 确认后立即提交</p>
                </div>
                <button
                  aria-label="关闭"
                  disabled={liveCloseSubmitting}
                  onClick={() => setLiveCloseTarget(null)}
                >
                  ×
                </button>
              </div>
              <div className="live-close-summary-table">
                <span>合约</span>
                <b>{liveCloseTarget.position.symbol}</b>
                <span>方向</span>
                <b>
                  {liveCloseTarget.position.positionSide === "LONG"
                    ? "做多"
                    : "做空"}
                </b>
                <span>当前持仓</span>
                <b>
                  {formatQuantityByStep(
                    liveCloseTarget.position.quantity,
                    liveCloseQuantityStep,
                  )}
                </b>
                <span>本次平仓</span>
                <b>
                  {Number.isFinite(liveCloseNormalizedQuantity)
                    ? formatQuantityByStep(
                        liveCloseNormalizedQuantity,
                        liveCloseQuantityStep,
                      )
                    : "—"}
                  {liveCloseAll ? "（全部）" : ""}
                </b>
                <span>预计剩余</span>
                <b>
                  {Number.isFinite(liveCloseRemainingQuantity)
                    ? formatQuantityByStep(
                        Math.max(0, liveCloseRemainingQuantity),
                        liveCloseQuantityStep,
                      )
                    : "—"}
                </b>
                <span>平仓方式</span>
                <b>
                  {liveCloseTarget.orderType === "MARKET"
                    ? "市价平仓"
                    : "限价平仓（FOK）"}
                </b>
              </div>
              <div className="live-close-control-row">
                <b>平仓数量</b>
                <NumberStepper
                  label="平仓数量"
                  value={liveCloseQuantity}
                  min={liveCloseQuantityMinimum}
                  max={liveCloseTarget.position.quantity}
                  step={liveCloseQuantityStep}
                  readOnly={liveCloseSubmitting}
                  allowEmpty
                  onChange={setLiveCloseQuantity}
                />
              </div>
              <div className="live-close-ratio-actions" aria-label="快捷平仓比例">
                {[25, 50, 75, 100].map((percent) => (
                  <button
                    type="button"
                    key={percent}
                    disabled={liveCloseSubmitting}
                    onClick={() => {
                      const quantity = liveCloseTarget.position.quantity;
                      if (percent === 100) {
                        setLiveCloseQuantity(quantity);
                        return;
                      }
                      const stepped = Math.floor(
                        (quantity * percent) /
                          100 /
                          liveCloseQuantityStep +
                          1e-8,
                      ) * liveCloseQuantityStep;
                      setLiveCloseQuantity(
                        Number(
                          Math.max(
                            liveCloseQuantityMinimum,
                            stepped,
                          ).toFixed(12),
                        ),
                      );
                    }}
                  >
                    {percent === 100 ? "全部" : `${percent}%`}
                  </button>
                ))}
              </div>
              {liveCloseTarget.orderType === "LIMIT" && (
                <div className="live-close-control-row live-close-limit-row">
                  <b>限价价格</b>
                  <input
                    aria-label="限价平仓价格"
                    type="number"
                    min="0.00000001"
                    step="any"
                    value={liveClosePrice}
                    disabled={liveCloseSubmitting}
                    onChange={(event) =>
                      setLiveClosePrice(Number(event.target.value))
                    }
                  />
                </div>
              )}
              <div className="live-close-hint">
                {liveCloseAll
                  ? "全部平仓将以提交瞬间 Binance 真实仓位为准；即使页面数量刚发生变化，也会按最新真实数量一次性减仓。"
                  : liveCloseQuantityAdjusted
                  ? `将按交易所步长自动调整为 ${formatQuantityByStep(liveCloseNormalizedQuantity, liveCloseQuantityStep)}；步长为 1 时取整数，若留下不足最小量的尾仓则自动合并为全部平仓。`
                  : liveCloseLeavesDust
                  ? `当前数量会留下低于最小下单量 ${formatQuantityByStep(liveCloseQuantityMinimum, liveCloseQuantityStep)} 的尾仓，请减少平仓数量或直接全部平仓。`
                  : liveCloseTarget.orderType === "MARKET"
                  ? "按 Binance 当前市场价格立即减仓；部分平仓后按剩余真实数量重排止盈止损，数量不足时自动合并格子。"
                  : "FOK 限价必须立即全部成交，否则自动撤销；部分成交后的剩余仓位会自动重排止盈止损格子。"}
              </div>
              <div className="config-actions">
                <button
                  disabled={liveCloseSubmitting}
                  onClick={() => setLiveCloseTarget(null)}
                >
                  取消
                </button>
                <button
                  className="primary-btn live-close-submit"
                  disabled={
                    liveCloseSubmitting ||
                    !liveCloseQuantityValid ||
                    (liveCloseTarget.orderType === "LIMIT" &&
                      (!Number.isFinite(liveClosePrice) || liveClosePrice <= 0))
                  }
                  onClick={() => void confirmLivePositionClose()}
                >
                  {liveCloseSubmitting
                    ? "成交确认中…"
                    : liveCloseAll
                      ? "确认全部平仓"
                      : "确认平仓"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  
}

