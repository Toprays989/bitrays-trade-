"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  StrategyLearningReviewDecision,
  StrategyLearningReviewItem,
  StrategyLearningReviewSummary,
} from "../../lib/strategy-learning-review";
import { readJsonResponse } from "../client/runtime";
import type { StoredStrategyParameterSuggestion } from "../client/strategy-view";

type LearningReviewResponse = {
  error?: string;
  strategy?: {
    id: number;
    name: string;
    brainKey: string;
    configVersion: number;
  };
  summary?: StrategyLearningReviewSummary;
  items?: StrategyLearningReviewItem[];
  suggestions?: Array<StoredStrategyParameterSuggestion & {
    status: string;
    reviewedAt: string | number | null;
  }>;
  configValidation?: {
    status:
      | "NOT_APPLICABLE"
      | "COLLECTING"
      | "PROMOTION_READY"
      | "ROLLBACK_REQUIRED"
      | "PROMOTED"
      | "ROLLED_BACK";
    configVersion: number;
    sourceConfigVersion: number | null;
    completedCycles: number;
    targetCycles: number;
    exactNetPnlUsdt: number | null;
    wins: number;
    losses: number;
    outcome: string;
    candidate: ValidationMetrics;
    baseline: ValidationMetrics;
    deteriorationReasons: string[];
    promotionReasons: string[];
    operatorConfirmed: boolean;
    lastEvaluatedAt: string | number | null;
  };
  page?: {
    filter: ReviewFilter;
    offset: number;
    limit: number;
    hasMore: boolean;
    total: number;
  };
};

type ValidationMetrics = {
  sampleCount: number;
  exactNetPnlUsdt: number | null;
  averageNetPnlUsdt: number | null;
  wins: number;
  losses: number;
  profitFactor: number | null;
  maximumDrawdownUsdt: number | null;
};

type ReviewFilter = "READY" | "CONFIRMED" | "NOISE" | "DEFERRED" | "ALL";

export function StrategyLearningReviewPanel({
  strategyId,
  onSelectTrace,
  onApplySuggestion,
}: {
  strategyId: number;
  onSelectTrace?: (traceId: string) => void;
  onApplySuggestion: (suggestion: StoredStrategyParameterSuggestion) => void;
}) {
  const [data, setData] = useState<LearningReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<StrategyLearningReviewDecision | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>("READY");
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [promotionArmed, setPromotionArmed] = useState(false);
  const [promotionBusy, setPromotionBusy] = useState(false);

  const load = useCallback(async (offset = 0, append = false) => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/control/strategies/learning-reviews?strategyId=${strategyId}&filter=${filter}&offset=${offset}&limit=40`,
        { cache: "no-store" },
      );
      const result = await readJsonResponse(response) as LearningReviewResponse;
      if (!response.ok) throw new Error(result.error ?? "学习样本读取失败");
      setData((current) => append
        ? {
            ...result,
            items: [...(current?.items ?? []), ...(result.items ?? [])],
          }
        : result
      );
      setSelectedKey((current) =>
        append && current
          ? current
          : current && result.items?.some((item) => item.learningKey === current)
          ? current
          : result.items?.[0]?.learningKey ?? null
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "学习样本读取失败");
    } finally {
      setLoading(false);
    }
  }, [filter, strategyId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visibleItems = useMemo(() => data?.items ?? [], [data?.items]);
  const selected = visibleItems.find(
    (item) => item.learningKey === selectedKey,
  ) ?? visibleItems[0] ?? null;

  async function review(action: StrategyLearningReviewDecision) {
    if (!selected || busyAction) return;
    setBusyAction(action);
    setMessage(null);
    try {
      const response = await fetch("/api/control/strategies/learning-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategyId,
          learningKey: selected.learningKey,
          action,
          comment,
        }),
      });
      const result = await readJsonResponse(response) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "学习复核保存失败");
      setMessage(result.message ?? "学习复核已保存");
      setComment("");
      await load(0, false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "学习复核保存失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function promoteCandidate() {
    const validation = data?.configValidation;
    if (!validation || validation.status !== "PROMOTION_READY" || promotionBusy)
      return;
    setPromotionBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/control/strategies/learning-reviews", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategyId,
          candidateVersion: validation.configVersion,
          action: "PROMOTE_VALIDATED_CONFIG",
          confirmation: "PROMOTE_VALIDATED_CONFIG",
        }),
      });
      const result = await readJsonResponse(response) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "候选版本晋升失败");
      setMessage(result.message ?? "候选版本已晋升");
      setPromotionArmed(false);
      await load(0, false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "候选版本晋升失败");
    } finally {
      setPromotionBusy(false);
    }
  }

  const summary = data?.summary;
  const capability = summary?.capability;

  return (
    <section className="strategy-learning-center" aria-label="策略学习运营中心">
      <div className="strategy-learning-center-head">
        <div>
          <h3>学习运营中心</h3>
          <p>终局结果已先由大脑自动吸收；人工确认只认证归因并形成经验，不直接修改实盘参数。</p>
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>
          {loading ? "同步中…" : "刷新样本"}
        </button>
      </div>

      <div className="strategy-learning-metrics">
        <article className={summary?.readyForReview ? "attention" : ""}>
          <span>待运营复核</span>
          <b>{summary?.readyForReview ?? 0}</b>
          <small>点击样本查看完整生命周期</small>
        </article>
        <article>
          <span>大脑正式经验</span>
          <b>{capability?.promotedExperiences ?? 0}</b>
          <small>费用后完整 {capability?.exactNetExperiences ?? 0} 笔</small>
        </article>
        <article>
          <span>经验净胜率</span>
          <b>
            {capability?.exactNetWinRatePercent == null
              ? "--"
              : `${capability.exactNetWinRatePercent.toFixed(1)}%`}
          </b>
          <small>{capability?.wins ?? 0} 盈 / {capability?.losses ?? 0} 亏</small>
        </article>
        <article>
          <span>经验精确净收益</span>
          <b className={(capability?.exactNetPnlUsdt ?? 0) >= 0 ? "positive" : "negative"}>
            {(capability?.exactNetPnlUsdt ?? 0) >= 0 ? "+" : ""}
            {(capability?.exactNetPnlUsdt ?? 0).toFixed(4)}
          </b>
          <small>USDT · 不代表未来收益</small>
        </article>
        <article>
          <span>参数建议 / 验证</span>
          <b>{summary?.pendingSuggestions ?? 0}</b>
          <small>
            {data?.configValidation?.status === "COLLECTING"
              ? `小样本 ${data.configValidation.completedCycles}/${data.configValidation.targetCycles}`
              : data?.configValidation?.status === "PROMOTION_READY"
                ? "达到晋升规则，待人工确认"
                : data?.configValidation?.status === "ROLLED_BACK"
                  ? "已回退并重新学习"
                  : data?.configValidation?.status === "PROMOTED"
                    ? "已晋升为稳定基线"
                : "暂无验证批次"}
          </small>
        </article>
      </div>

      {data?.configValidation &&
        data.configValidation.status !== "NOT_APPLICABLE" && (
          <ConfigValidationCard
            validation={data.configValidation}
            promotionArmed={promotionArmed}
            promotionBusy={promotionBusy}
            onArmPromotion={() => setPromotionArmed(true)}
            onCancelPromotion={() => setPromotionArmed(false)}
            onPromote={() => void promoteCandidate()}
          />
        )}

      <ExperienceSuggestionList
        suggestions={data?.suggestions ?? []}
        onApplySuggestion={onApplySuggestion}
      />

      <div className="strategy-learning-filters" aria-label="学习样本筛选">
        {([
          ["READY", "待确认", summary?.readyForReview ?? 0],
          ["CONFIRMED", "已形成经验", summary?.confirmed ?? 0],
          ["NOISE", "噪音", summary?.noise ?? 0],
          ["DEFERRED", "暂缓", summary?.deferred ?? 0],
          ["ALL", "全部", data?.items?.length ?? 0],
        ] as Array<[ReviewFilter, string, number]>).map(([value, label, count]) => (
          <button
            type="button"
            key={value}
            className={filter === value ? "active" : ""}
            onClick={() => {
              setFilter(value);
              setSelectedKey(null);
              setMessage(null);
              setData(null);
            }}
          >
            {label} <span>{count}</span>
          </button>
        ))}
      </div>

      {message && <div className="strategy-learning-message">{message}</div>}

      <div className="strategy-learning-workspace">
        <div className="strategy-learning-list">
          {visibleItems.map((item) => (
            <button
              type="button"
              key={item.learningKey}
              className={item.learningKey === selected?.learningKey ? "active" : ""}
              onClick={() => {
                setSelectedKey(item.learningKey);
                setComment(item.review?.reviewComment ?? "");
                if (item.traceId) onSelectTrace?.(item.traceId);
              }}
            >
              <span>
                <b>{item.symbol}</b>
                <small>V{item.configVersion} · {directionLabel(item.direction)} · {sourceLabel(item.orderSource)}</small>
              </span>
              <span className={`strategy-learning-outcome ${item.outcome.toLowerCase()}`}>
                {outcomeLabel(item)}
              </span>
              <small>
                {reviewLabel(item)} · {formatDateTime(item.updatedAt)}
              </small>
            </button>
          ))}
          {!loading && visibleItems.length === 0 && (
            <div className="empty">当前分类没有学习样本</div>
          )}
          {data?.page?.hasMore && (
            <button
              type="button"
              className="strategy-learning-load-more"
              disabled={loading}
              onClick={() => void load(visibleItems.length, true)}
            >
              {loading ? "加载中…" : `继续加载（已显示 ${visibleItems.length}/${data.page.total}）`}
            </button>
          )}
        </div>

        <div className="strategy-learning-detail">
          {!selected && <div className="empty">选择一条样本查看完整证据</div>}
          {selected && (
            <>
              <div className="strategy-learning-detail-title">
                <div>
                  <h4>{selected.symbol} · {directionLabel(selected.direction)}</h4>
                  <p>{selected.summary}</p>
                </div>
                <span className={`source-tag ${selected.review?.decision === "CONFIRMED" ? "auto" : selected.review?.decision === "NOISE" ? "danger-source" : "protect"}`}>
                  {reviewLabel(selected)}
                </span>
              </div>
              <div className="strategy-learning-evidence-grid">
                <article>
                  <span>终局收益</span>
                  <b className={selected.outcome === "WIN" ? "positive" : selected.outcome === "LOSS" ? "negative" : ""}>
                    {selected.exactNetAvailable ? "精确净" : "毛收益·费用待补"} {formatPnl(selected.exactNetAvailable ? selected.exactNetPnlUsdt : selected.observedPnlUsdt)}
                  </b>
                  <small>{selected.exitReasons.join("、") || "退出原因待补"}</small>
                </article>
                <article>
                  <span>持仓路径</span>
                  <b>{selected.holdingDurationMinutes == null ? "--" : `${selected.holdingDurationMinutes} 分钟`}</b>
                  <small>MFE {formatPercent(selected.mfeRoePercent)} / MAE {formatPercent(selected.maeRoePercent)}</small>
                </article>
                <article>
                  <span>检查点证据</span>
                  <b>{selected.observedCheckpointMinutes.length}/{selected.requiredCheckpointMinutes.length}</b>
                  <small>{selected.missingCheckpointMinutes.length ? `缺 ${selected.missingCheckpointMinutes.join("/")} 分钟` : "所需检查点完整"}</small>
                </article>
                <article>
                  <span>归因完整性</span>
                  <b>{selected.evidenceComplete ? "完整" : "部分证据"}</b>
                  <small>{selected.timingAttribution} · {selected.fastLearningStatus}</small>
                </article>
                <article>
                  <span>策略与触发器</span>
                  <b>V{selected.configVersion} · {selected.attribution.triggerKind}</b>
                  <small>{selected.attribution.triggerVersion}</small>
                </article>
                <article>
                  <span>证据可信状态</span>
                  <b>{learningConfidenceLabel(selected.attribution.evidenceConfidence)}</b>
                  <small>{selected.attribution.evidenceSampleCount} 个终局/检查点事实</small>
                </article>
              </div>
              <div className="strategy-learning-memory-result">
                <b>本周期归因与经验</b>
                <span>{selected.attribution.learnedRule}</span>
                <small>
                  入场依据：{selected.attribution.entryReasons.join("、") || "历史样本未保存结构化理由"}
                </small>
                <small>
                  市场环境：{selected.attribution.marketContext.join(" · ") || "历史样本未保存环境标签"}
                </small>
                <small>
                  参数建议：{selected.attribution.parameterSuggestions.length
                    ? selected.attribution.parameterSuggestions.map((suggestion) =>
                        `${suggestion.parameterName}（${suggestion.sampleCount}笔，${suggestion.status}）`
                      ).join("；")
                    : "本配置版本暂无达到样本门槛的建议"}
                  </small>
              </div>
              {selected.attribution.exitQuality && (
                <div className="strategy-learning-memory-result">
                  <b>退出后价格路径（仅作历史标签）</b>
                  <span>{selected.attribution.exitQuality.summary}</span>
                  <small>
                    {selected.attribution.exitQuality.latestExitReason} ·
                    {` ${selected.attribution.exitQuality.latestHorizonMinutes ?? "--"}分钟`} ·
                    {` 原方向 ${formatPercent(selected.attribution.exitQuality.directionReturnPercent)}`} ·
                    {` MFE ${formatPercent(selected.attribution.exitQuality.postExitMfePercent)}`} ·
                    {` MAE ${formatPercent(selected.attribution.exitQuality.postExitMaePercent)}`}
                  </small>
                  <small>
                    有效变化阈值 {formatPercent(selected.attribution.exitQuality.materialMovePercent)} ·
                    成交量比 {formatRatio(selected.attribution.exitQuality.postExitVolumeRatio)} ·
                    尾盘退出原因 {selected.attribution.exitQuality.tailWaveReasonCode ?? "未记录"}
                  </small>
                  <small>这些价格发生在退出之后，绝不倒灌为原订单事实；只用于同策略、同配置版本的相似结构复盘。</small>
                </div>
              )}
              {selected.review?.decision === "CONFIRMED" && (
                <div className="strategy-learning-memory-result">
                  <b>大脑经验 #{selected.review.memoryVersion ?? "--"}</b>
                  <span>
                    {selected.review.promotionStatus === "PROMOTED"
                      ? "精确结算经验已形成"
                      : "终局经验已形成，精确费用补齐后自动升级同一版本"}
                  </span>
                  <small>该经验不直接改变当前下单；能力变化由同类样本组和小规模实盘验证确认。</small>
                  {selected.review.needsSettlementRefresh && (
                    <small className="negative">精确结算已更新，认证经验正在同步；当前不重复生成新版本。</small>
                  )}
                </div>
              )}
              {selected.reviewReady && (!selected.review || selected.review.decision === "DEFERRED") ? (
                <div className="strategy-learning-review-actions">
                  <label>
                    <span>运营备注（可选）</span>
                    <textarea
                      value={comment}
                      maxLength={500}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="记录归因依据、异常数据或暂缓原因"
                    />
                  </label>
                  <div>
                    <button
                      type="button"
                      disabled={Boolean(busyAction)}
                      onClick={() => void review("DEFERRED")}
                    >
                      {busyAction === "DEFERRED" ? "保存中…" : "暂缓确认"}
                    </button>
                    <button
                      type="button"
                      className="danger-btn"
                      disabled={Boolean(busyAction)}
                      onClick={() => void review("NOISE")}
                    >
                      {busyAction === "NOISE" ? "保存中…" : "标记噪音"}
                    </button>
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={Boolean(busyAction)}
                      onClick={() => void review("CONFIRMED")}
                    >
                      {busyAction === "CONFIRMED" ? "通知大脑中…" : "确认有效经验"}
                    </button>
                  </div>
                </div>
              ) : selected.review ? (
                <div className="strategy-learning-reviewed-meta">
                  <span>复核人 {selected.review.reviewedBy}</span>
                  <span>{formatDateTime(selected.review.reviewedAt)}</span>
                  {selected.review.reviewComment && <p>{selected.review.reviewComment}</p>}
                </div>
              ) : (
                <div className="strategy-learning-reviewed-meta">
                  <span>终局事实仍在由大脑吸收，完成后才开放运营复核。</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function learningConfidenceLabel(
  value: StrategyLearningReviewItem["attribution"]["evidenceConfidence"],
) {
  if (value === "EXACT_COMPLETE") return "精确完整";
  if (value === "OBSERVATION_ONLY") return "仅观察";
  return "终局已吸收·证据待补";
}

function ConfigValidationCard({
  validation,
  promotionArmed,
  promotionBusy,
  onArmPromotion,
  onCancelPromotion,
  onPromote,
}: {
  validation: NonNullable<LearningReviewResponse["configValidation"]>;
  promotionArmed: boolean;
  promotionBusy: boolean;
  onArmPromotion: () => void;
  onCancelPromotion: () => void;
  onPromote: () => void;
}) {
  const reasons = validation.status === "ROLLBACK_REQUIRED" ||
      validation.status === "ROLLED_BACK"
    ? validation.deteriorationReasons
    : validation.promotionReasons;
  return (
    <section className={`strategy-config-validation ${validation.status.toLowerCase()}`}>
      <div className="strategy-config-validation-head">
        <div>
          <h4>候选参数实盘验证 · V{validation.configVersion}</h4>
          <p>
            {validationStatusLabel(validation.status)} · 已完成 {validation.completedCycles}/{validation.targetCycles} 个费用后完整周期
          </p>
          <small>
            {validation.operatorConfirmed
              ? "人工确认快照有效"
              : "缺少有效人工确认，候选禁止继续开新仓"}
            {validation.lastEvaluatedAt
              ? ` · 最近评估 ${formatDateTime(validation.lastEvaluatedAt)}`
              : " · 等待首个完整周期评估"}
          </small>
        </div>
        <span>{validation.sourceConfigVersion ? `稳定基线 V${validation.sourceConfigVersion}` : "无可比基线"}</span>
      </div>
      <div className="strategy-config-validation-metrics">
        <ValidationMetric title="候选净收益" metrics={validation.candidate} />
        <ValidationMetric title="稳定基线" metrics={validation.baseline} />
      </div>
      {reasons.length > 0 && (
        <ul>
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      {validation.status === "COLLECTING" && (
        <small>继续收集真实结果；候选恶化会自动停止该版本新开仓并回退，晋升不会自动执行。</small>
      )}
      {validation.status === "ROLLED_BACK" && (
        <small>候选失败事实已保留为纠偏经验；新建议会从恢复后的稳定版本重新学习，不复用失败候选。</small>
      )}
      {validation.status === "PROMOTION_READY" && !promotionArmed && (
        <button type="button" className="primary-btn" onClick={onArmPromotion}>
          人工确认晋升
        </button>
      )}
      {validation.status === "PROMOTION_READY" && promotionArmed && (
        <div className="strategy-config-validation-confirm">
          <span>确认将 V{validation.configVersion} 设为新的稳定基线？</span>
          <button type="button" disabled={promotionBusy} onClick={onCancelPromotion}>取消</button>
          <button type="button" className="primary-btn" disabled={promotionBusy} onClick={onPromote}>
            {promotionBusy ? "晋升中…" : "确认晋升"}
          </button>
        </div>
      )}
    </section>
  );
}

function ValidationMetric({
  title,
  metrics,
}: {
  title: string;
  metrics: ValidationMetrics;
}) {
  return (
    <article>
      <b>{title}</b>
      <span>{formatPnl(metrics.exactNetPnlUsdt)}</span>
      <small>
        {metrics.sampleCount} 笔 · 胜负 {metrics.wins}/{metrics.losses} · 利润因子 {formatMetric(metrics.profitFactor)} · 最大回撤 {formatMetric(metrics.maximumDrawdownUsdt)} USDT
      </small>
    </article>
  );
}

function ExperienceSuggestionList({
  suggestions,
  onApplySuggestion,
}: {
  suggestions: NonNullable<LearningReviewResponse["suggestions"]>;
  onApplySuggestion: (suggestion: StoredStrategyParameterSuggestion) => void;
}) {
  const actionable = suggestions.filter((suggestion) =>
    suggestion.status === "PENDING" &&
    suggestion.evidence.learningEligible === true &&
    suggestion.evidence.action !== "OBSERVE"
  );
  if (!actionable.length) return null;
  return (
    <section className="strategy-experience-suggestions">
      <div>
        <h4>经验消费形成的单变量建议</h4>
        <p>只生成候选草稿；人工带入参数并发布后，进入可回退的小规模验证。</p>
      </div>
      {actionable.slice(0, 3).map((suggestion) => (
        <article key={suggestion.id}>
          <div>
            <b>{String(suggestion.evidence.label ?? suggestion.parameterName)}</b>
            <button
              type="button"
              onClick={() => onApplySuggestion(suggestion)}
            >
              带入参数草稿
            </button>
          </div>
          <span>{suggestion.parameterName}</span>
          <small>
            {formatSuggestionValue(suggestion.currentValue)} → {formatSuggestionValue(suggestion.suggestedValue)}
          </small>
          <small>{String(suggestion.evidence.reason ?? "等待更多同类精确样本")}</small>
        </article>
      ))}
    </section>
  );
}

function validationStatusLabel(
  status: NonNullable<LearningReviewResponse["configValidation"]>["status"],
) {
  if (status === "PROMOTION_READY") return "达到晋升规则，等待人工确认";
  if (status === "ROLLBACK_REQUIRED") return "已触发恶化线，正在隔离回退";
  if (status === "ROLLED_BACK") return "已恢复稳定版本并重新学习";
  if (status === "PROMOTED") return "已晋升为稳定基线";
  return "验证中";
}

function formatMetric(value: number | null) {
  if (value === Number.POSITIVE_INFINITY) return "无亏损";
  return value === null || !Number.isFinite(value) ? "--" : value.toFixed(4);
}

function formatSuggestionValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value))
    return Number(value.toFixed(6)).toString();
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function directionLabel(direction: StrategyLearningReviewItem["direction"]) {
  return direction === "LONG" ? "做多" : direction === "SHORT" ? "做空" : "方向待补";
}

function sourceLabel(source: string) {
  return source === "STRATEGY" ? "策略单" : source === "SEMI_AUTO" ? "半自动" : "人工单";
}

function reviewLabel(item: StrategyLearningReviewItem) {
  if (!item.review) return "待运营确认";
  if (item.review.decision === "CONFIRMED")
    return item.review.promotionStatus === "PROMOTED" ? "经验已形成" : "经验待精确升级";
  if (item.review.decision === "NOISE") return "仅保留事实";
  return "暂缓确认";
}

function outcomeLabel(item: StrategyLearningReviewItem) {
  if (item.outcome === "WIN") return "盈利";
  if (item.outcome === "LOSS") return "亏损";
  if (item.outcome === "BREAKEVEN") return "持平";
  return "待结算";
}

function formatPnl(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)} USDT`;
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatRatio(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}×`;
}

function formatDateTime(value: string | number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
