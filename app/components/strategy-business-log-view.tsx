"use client";

import { useMemo, useState } from "react";
import {
  strategyExecutionBranch,
  strategyExecutionEventDetailSummary,
  strategyExecutionDirectionLabel,
  strategyExecutionTriggerLabel,
  strategyExecutionStageLabel,
  strategyExecutionStateLabel,
  type ConfiguredStrategy,
  type StrategyExecutionDetail,
  type StrategyExecutionTrace,
  type StrategyMonitorStatus,
  type StoredStrategyParameterSuggestion,
} from "../client/strategy-view";
import { APPLYABLE_STRATEGY_SUGGESTION_PATHS } from "../client/strategy-config";
import { StrategyEntryShadowPanel } from "./strategy-entry-shadow-panel";
import { StrategyLearningReviewPanel } from "./strategy-learning-review-panel";

type StrategyLogRealtime = {
  status: "IDLE" | "CONNECTING" | "LIVE" | "DELAYED";
  lastSyncAt: number | null;
};

type StrategyBusinessLogViewProps = {
  target: ConfiguredStrategy | null;
  executions: StrategyExecutionTrace[];
  detail: StrategyExecutionDetail | null;
  monitorStatus: StrategyMonitorStatus | null;
  realtime: StrategyLogRealtime;
  loading: boolean;
  detailLoading: boolean;
  onRefresh: () => void;
  onSelect: (traceId: string) => void;
  onApplySuggestion: (suggestion: StoredStrategyParameterSuggestion) => void;
  onBack: () => void;
  initialTab?: LogTab;
};

type LogTab =
  | "ORDERS"
  | "LIQUIDATIONS"
  | "RUNNING"
  | "LEARNING"
  | "ENTRY_SHADOW";

function directionLabel(execution: StrategyExecutionTrace) {
  const direction = strategyExecutionDirectionLabel(execution);
  return strategyExecutionBranch(execution) === "CONTRARIAN_PROBE"
    ? `${direction} · 反向`
    : direction;
}

function triggerDirectionLabel(execution: StrategyExecutionTrace) {
  return strategyExecutionTriggerLabel(execution);
}

function triggerMeasure(execution: StrategyExecutionTrace) {
  if (execution.triggerKind === "LOW_POSITION_WINDOW") {
    const lowPosition = record(execution.entryEvidence.lowPositionWindow);
    const percent = finiteNumber(lowPosition.position72hPercent);
    return `${compactNumber(percent, 2)}% / ${compactNumber(
      execution.triggerReferencePrice ?? execution.liquidationPrice,
      8,
    )}`;
  }
  if (
    execution.triggerKind &&
    execution.triggerKind !== "LIQUIDATION_WINDOW"
  ) {
    const referencePrice =
      Number(execution.triggerReferencePrice) > 0
        ? Number(execution.triggerReferencePrice)
        : execution.liquidationPrice;
    return `参考价 ${compactNumber(referencePrice, 8)}`;
  }
  return `${compactNumber(execution.liquidationNotional)} / ${compactNumber(
    execution.liquidationPrice,
    8,
  )}`;
}

function decisionLabel(execution: StrategyExecutionTrace) {
  if (execution.exchangeOrderId || execution.positionId) return "下单";
  if (["REJECTED", "EXPIRED", "DATA_STALE"].includes(execution.state))
    return "跳过";
  if (execution.state === "EXECUTION_UNKNOWN") return "异常";
  if (execution.state === "CLOSED") return "结束";
  return "等待";
}

function stateClass(state: string) {
  if (["REJECTED", "EXPIRED", "DATA_STALE", "EXECUTION_UNKNOWN"].includes(state))
    return "danger-source";
  if (state === "CLOSED") return "protect";
  return "auto";
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null) return "--";
  return value.toLocaleString("zh-CN", { maximumFractionDigits });
}

function executionEstimate(execution: StrategyExecutionTrace) {
  const snapshot = record(execution.configSnapshot);
  const executionConfig = record(snapshot.execution);
  const configuredSizing = record(
    record(execution.entryEvidence).nexusConfiguredSizing,
  );
  const leverage =
    finiteNumber(executionConfig.leverage) ?? finiteNumber(snapshot.leverage);
  const margin = finiteNumber(configuredSizing.requiredMarginUsdt);
  const notional = finiteNumber(configuredSizing.notionalUsdt);
  const quantity = finiteNumber(configuredSizing.quantity);
  return `${compactNumber(leverage, 0)}x / 保证金 ${compactNumber(margin)} / 名义 ${compactNumber(notional)} / ${compactNumber(quantity)}`;
}

function formatDateTime(value: string | number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function executionHasOrder(execution: StrategyExecutionTrace) {
  return Boolean(
    execution.exchangeOrderId ||
      execution.positionId ||
      [
        "ORDER_SUBMITTED",
        "POSITION_OPEN",
        "POSITION_CLOSED",
        "EXECUTION_UNKNOWN",
      ].includes(execution.state),
  );
}

function formatSuggestionValue(value: unknown) {
  if (typeof value === "number") return Number(value.toFixed(6)).toString();
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function suggestionCanEnterDraft(
  suggestion: StoredStrategyParameterSuggestion,
  detail: StrategyExecutionDetail,
  target: ConfiguredStrategy,
) {
  return (
    suggestion.evidence.action !== "KEEP" &&
    suggestion.evidence.action !== "OBSERVE" &&
    suggestion.evidence.proposalMode === "DRAFT_ONLY" &&
    suggestion.evidence.learningEligible === true &&
    suggestion.evidence.automaticPublishAllowed === false &&
    detail.execution.configVersion === target.configVersion &&
    APPLYABLE_STRATEGY_SUGGESTION_PATHS.has(suggestion.parameterName) &&
    (typeof suggestion.suggestedValue === "number" ||
      (suggestion.parameterName === "liquidationFactors.mode" &&
        suggestion.suggestedValue === "LIVE") ||
      suggestion.suggestedValue === "MARKET" ||
      suggestion.suggestedValue === "LIMIT_OFFSET")
  );
}

export function StrategyBusinessLogView({
  target,
  executions,
  detail,
  monitorStatus,
  realtime,
  loading,
  detailLoading,
  initialTab = "LIQUIDATIONS",
  onRefresh,
  onSelect,
  onApplySuggestion,
  onBack,
}: StrategyBusinessLogViewProps) {
  const [tab, setTab] = useState<LogTab>(initialTab);
  const sortedExecutions = useMemo(
    () =>
      [...executions]
        .filter(
          (execution) =>
            !execution.traceId.startsWith("short-monitor-status:"),
        )
        .sort(
          (left, right) =>
            new Date(right.eventTime).getTime() -
              new Date(left.eventTime).getTime() ||
            new Date(right.updatedAt).getTime() -
              new Date(left.updatedAt).getTime() ||
            right.id - left.id,
        ),
    [executions],
  );
  const orderExecutions = useMemo(
    () =>
      sortedExecutions
        .filter(executionHasOrder)
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() -
              new Date(left.updatedAt).getTime() ||
            right.id - left.id,
        ),
    [sortedExecutions],
  );
  const sortedDetailEvents = useMemo(
    () =>
      [...(detail?.events ?? [])].sort(
        (left, right) =>
          new Date(right.eventAt).getTime() -
            new Date(left.eventAt).getTime() ||
          right.sequence - left.sequence,
      ),
    [detail?.events],
  );

  if (!target) {
    return (
      <section className="panel strategy-log-records">
        <div className="strategy-log-records-head">
          <h2>策略日志</h2>
          <button onClick={onBack}>返回策略列表</button>
        </div>
        <div className="empty">请从策略列表点击“运行日志”</div>
      </section>
    );
  }

  const activeAnalysis = monitorStatus?.activeAnalyses?.[0];
  const currentJudgement = activeAnalysis
    ? `${activeAnalysis.symbol}：${activeAnalysis.resultMessage ?? strategyExecutionStateLabel(activeAnalysis.state)}`
    : monitorStatus?.reason ?? "等待新的有效触发事实";

  const openExecution = (execution: StrategyExecutionTrace) => {
    onSelect(execution.traceId);
    setTab("RUNNING");
  };

  return (
    <section className="panel strategy-log-records">
      <div className="strategy-log-records-head">
        <div>
          <h2>{target.name}</h2>
          <p>
            {target.status === "RUNNING" ? "监听中" : "已暂停"} ·{" "}
            {realtime.status === "LIVE"
              ? "实时更新"
              : realtime.status === "DELAYED"
                ? "同步延迟"
                : "连接中"}
          </p>
        </div>
        <div className="panel-actions">
          <button disabled={loading} onClick={onRefresh}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button onClick={onBack}>返回</button>
        </div>
      </div>

      <nav className="strategy-log-tabs" aria-label="策略日志分类">
        <button
          className={tab === "ORDERS" ? "active" : ""}
          onClick={() => setTab("ORDERS")}
        >
          下单记录 <span>{orderExecutions.length}</span>
        </button>
        <button
          className={tab === "LIQUIDATIONS" ? "active" : ""}
          onClick={() => setTab("LIQUIDATIONS")}
        >
          触发记录{" "}
          <span>
            {sortedExecutions.length} · 实时
            {monitorStatus?.recentLiquidations?.length ?? 0}
          </span>
        </button>
        <button
          className={tab === "RUNNING" ? "active" : ""}
          onClick={() => setTab("RUNNING")}
        >
          运行日志
        </button>
        <button
          className={tab === "LEARNING" ? "active" : ""}
          onClick={() => setTab("LEARNING")}
        >
          学习与建议{" "}
          <span>
            {target.learningReview?.readyForReview ?? 0} 待确认 · {detail?.suggestions.length ?? target.learningReview?.pendingSuggestions ?? 0} 建议
          </span>
        </button>
        <button
          className={tab === "ENTRY_SHADOW" ? "active" : ""}
          onClick={() => setTab("ENTRY_SHADOW")}
        >
          入场影子
        </button>
      </nav>

      <div className="strategy-log-current">
        <b>当前判断</b>
        <span>{currentJudgement}</span>
      </div>

      {tab === "LIQUIDATIONS" && (
        <div className="strategy-log-table-scroll">
          <table className="strategy-log-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>币种</th>
                <th>触发类型</th>
                <th>触发事实 / 价格</th>
                <th>下单测算</th>
                <th>决策</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {(monitorStatus?.recentLiquidations ?? []).map((item) => (
                <tr
                  key={`live-liquidation:${item.sequence}`}
                  className="strategy-log-live-liquidation"
                >
                  <td>
                    {formatDateTime(item.tradeTime)}
                    <small>实时流</small>
                  </td>
                  <td>
                    <b>{item.symbol}</b>
                  </td>
                  <td>
                    {item.side === "SELL" ? "多头爆仓" : "空头爆仓"}
                  </td>
                  <td className="numeric">
                    {compactNumber(item.notional)} /{" "}
                    {compactNumber(item.averagePrice, 8)}
                  </td>
                  <td className="numeric">
                    {item.screeningState === "BRAIN_ACCEPTED"
                      ? "已进入大脑"
                      : item.screeningState === "DIRECTION_SKIPPED"
                        ? "方向跳过"
                        : item.screeningState === "SIGNAL_EXPIRED"
                          ? "信号过期"
                          : "同币累计中"}
                  </td>
                  <td>
                    <span
                      className={`strategy-log-decision ${
                        item.screeningState === "BRAIN_ACCEPTED"
                          ? "auto"
                          : item.screeningState === "ACCUMULATING"
                            ? "protect"
                            : "danger-source"
                      }`}
                    >
                      {item.screeningState === "BRAIN_ACCEPTED"
                        ? "判断"
                        : item.screeningState === "ACCUMULATING"
                          ? "观察"
                          : "跳过"}
                    </span>
                  </td>
                  <td>{item.screeningReason}</td>
                </tr>
              ))}
              {sortedExecutions.map((execution) => (
                <tr
                  key={execution.traceId}
                  className="clickable"
                  onClick={() => openExecution(execution)}
                >
                  <td>{formatDateTime(execution.eventTime)}</td>
                  <td>
                    <b>{execution.symbol}</b>
                  </td>
                  <td>{triggerDirectionLabel(execution)}</td>
                  <td className="numeric">
                    {triggerMeasure(execution)}
                  </td>
                  <td className="numeric">{executionEstimate(execution)}</td>
                  <td>
                    <span
                      className={`strategy-log-decision ${stateClass(execution.state)}`}
                    >
                      {decisionLabel(execution)}
                    </span>
                  </td>
                  <td>{execution.resultMessage ?? "正在判断"}</td>
                </tr>
              ))}
              {!loading &&
                sortedExecutions.length === 0 &&
                (monitorStatus?.recentLiquidations?.length ?? 0) === 0 && (
                <tr>
                  <td className="empty" colSpan={7}>
                    尚无策略触发记录；当前监听判断仍会实时更新
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "ORDERS" && (
        <div className="strategy-log-table-scroll">
          <table className="strategy-log-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>币种</th>
                <th>方向</th>
                <th>订单号</th>
                <th>仓位</th>
                <th>状态</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {orderExecutions.map((execution) => (
                <tr
                  key={execution.traceId}
                  className="clickable"
                  onClick={() => openExecution(execution)}
                >
                  <td>{formatDateTime(execution.updatedAt)}</td>
                  <td>
                    <b>{execution.symbol}</b>
                  </td>
                  <td>{directionLabel(execution)}</td>
                  <td>{execution.exchangeOrderId ?? "--"}</td>
                  <td>{execution.positionId ?? "--"}</td>
                  <td>
                    <span
                      className={`strategy-log-decision ${stateClass(execution.state)}`}
                    >
                      {strategyExecutionStateLabel(execution.state)}
                    </span>
                  </td>
                  <td>{execution.resultMessage ?? "已进入下单链路"}</td>
                </tr>
              ))}
              {!loading && orderExecutions.length === 0 && (
                <tr>
                  <td className="empty" colSpan={7}>
                    尚无该策略的真实下单记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "RUNNING" && (
        <div className="strategy-log-running">
          <div className="strategy-log-running-head">
            <span>
              {detail
                ? `${detail.execution.symbol} · ${directionLabel(detail.execution)} · ${detail.execution.resultMessage ?? "判断中"}`
                : "选择一条触发记录查看完整判断过程"}
            </span>
            <button onClick={() => setTab("LIQUIDATIONS")}>选择其他记录</button>
          </div>
          <div className="strategy-log-table-scroll">
            <table className="strategy-log-table strategy-log-event-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>业务环节</th>
                  <th>判断</th>
                  <th>依据</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {sortedDetailEvents.map((event) => {
                  const evidence = strategyExecutionEventDetailSummary(event);
                  return (
                    <tr key={event.id}>
                      <td>
                        {new Date(event.eventAt).toLocaleTimeString("zh-CN", {
                          hour12: false,
                        })}
                      </td>
                      <td>
                        <b>{strategyExecutionStageLabel(event.stage)}</b>
                      </td>
                      <td>{event.message}</td>
                      <td>{evidence || "--"}</td>
                      <td>
                        <span
                          className={`strategy-log-decision ${
                            event.outcome === "REJECTED" ||
                            event.outcome === "ERROR"
                              ? "danger-source"
                              : event.outcome === "PASSED"
                                ? "auto"
                                : "protect"
                          }`}
                        >
                          {event.outcome === "PASSED"
                            ? "通过"
                            : event.outcome === "REJECTED"
                              ? "拒绝"
                              : event.outcome === "ERROR"
                                ? "异常"
                                : event.outcome === "PENDING"
                                  ? "等待"
                                  : "记录"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!detailLoading && (!detail || detail.events.length === 0) && (
                  <tr>
                    <td className="empty" colSpan={5}>
                      {detail
                        ? "该记录尚未产生业务判断步骤"
                        : "请先在“触发记录”中选择一条记录"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "LEARNING" && (
        <div className="strategy-learning-review">
          <StrategyLearningReviewPanel
            strategyId={target.id}
            onSelectTrace={onSelect}
            onApplySuggestion={onApplySuggestion}
          />
          <div className="strategy-suggestion-safety">
            <b>人工确认入口</b>
            选择建议并点击“带入参数草稿” → 核对参数 → 保存并发布。确认只影响新订单，已有仓位继续使用开仓时版本；系统不会自动改参或发布。
          </div>
          {!detail && !detailLoading && (
            <div className="empty">
              当前没有可展示的订单学习详情。可先到“下单记录”选择一笔订单，再返回本页查看。
            </div>
          )}
          {detailLoading && <div className="empty">正在读取学习证据…</div>}
          {detail && (
            <>
              <div className="strategy-log-running-head">
                <span>
                  {detail.execution.symbol} · V{detail.execution.configVersion} · {detail.postEntryAnalysis?.summary ?? "该订单仍在积累学习证据"}
                </span>
                <button onClick={() => setTab("ORDERS")}>选择其他订单</button>
              </div>
              {detail.postEntryAnalysis?.suggestions?.length ? (
                <div className="post-entry-suggestions">
                  {detail.postEntryAnalysis.suggestions.map((suggestion, index) => (
                    <article
                      key={`${suggestion.parameterName}-${index}`}
                      className={suggestion.action.toLowerCase()}
                    >
                      <div>
                        <b>{suggestion.label}</b>
                        <span>{suggestion.action === "KEEP" ? "保持" : suggestion.action === "TIGHTEN" ? "收紧" : suggestion.action === "LOOSEN" ? "放宽" : "观察"}</span>
                      </div>
                      <p>{suggestion.reason}</p>
                      <small>
                        当前 {formatSuggestionValue(suggestion.currentValue)} → 建议 {formatSuggestionValue(suggestion.suggestedValue)} · 可信度 {(suggestion.confidence * 100).toFixed(0)}%
                      </small>
                    </article>
                  ))}
                </div>
              ) : null}
              {detail.suggestions.length ? (
                <div className="aggregate-strategy-suggestions">
                  <h3>可人工复核的跨订单建议</h3>
                  {detail.suggestions.map((suggestion) => {
                    const canApply = suggestionCanEnterDraft(
                      suggestion,
                      detail,
                      target,
                    );
                    return (
                      <article key={suggestion.id}>
                        <div>
                          <b>{suggestion.evidence.label ?? suggestion.parameterName}</b>
                          {canApply && (
                            <button
                              type="button"
                              onClick={() => onApplySuggestion(suggestion)}
                            >
                              带入参数草稿
                            </button>
                          )}
                        </div>
                        <span>
                          {formatSuggestionValue(suggestion.currentValue)} → {formatSuggestionValue(suggestion.suggestedValue)}
                        </span>
                        <p>{suggestion.evidence.reason ?? "基于完整订单生命周期生成"}</p>
                        <small>
                          {suggestion.sampleCount} 笔完整订单 · 可信度 {((suggestion.evidence.confidence ?? 0) * 100).toFixed(0)}%
                          {!canApply ? " · 当前仅观察或尚未达到人工带入条件" : " · 等待人工确认"}
                        </small>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">
                  当前尚无达到人工复核条件的跨订单参数建议；系统继续积累完整生命周期样本。
                </div>
              )}
              {detail.configValidation &&
                detail.configValidation.status !== "NOT_APPLICABLE" && (
                  <div className="strategy-suggestion-safety">
                    人工建议版本 V{detail.configValidation.configVersion}：
                    {detail.configValidation.status === "COLLECTING"
                      ? `小样本验证中 ${detail.configValidation.completedCycles}/${detail.configValidation.targetCycles}`
                      : detail.configValidation.status === "PROMOTION_READY"
                        ? `达到晋升规则，等待人工确认`
                        : detail.configValidation.status === "ROLLED_BACK"
                          ? "候选已回退并重新学习"
                          : detail.configValidation.status === "PROMOTED"
                            ? "已晋升为稳定基线"
                            : "候选已触发恶化回退"}
                    {detail.configValidation.exactNetPnlUsdt !== null
                      ? ` · 净收益 ${detail.configValidation.exactNetPnlUsdt.toFixed(4)} USDT`
                      : ""}
                  </div>
                )}
            </>
          )}
        </div>
      )}

      {tab === "ENTRY_SHADOW" && (
        <StrategyEntryShadowPanel target={target} />
      )}
    </section>
  );
}
