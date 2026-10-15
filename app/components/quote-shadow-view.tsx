"use client";

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Initial and filter-driven reads intentionally synchronize this server-backed operations view. */

import { useEffect, useMemo, useState } from "react";
import { readJsonResponse } from "../client/runtime";

type QuoteShadowItem = {
  id: number;
  createdAt: string;
  accountId: string;
  symbol: string;
  quoteRole: "ENTRY" | "ADD" | "EXIT";
  origin: "MANUAL" | "SEMI_AUTO" | "STRATEGY_LONG" | "STRATEGY_SHORT";
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  actualOrderType: "MARKET" | "LIMIT";
  actualRequestedPrice: number;
  executableReferencePrice: number;
  shadowQuotePrice: number;
  actualDistanceBps: number;
  shadowDistanceBps: number;
  theoreticalImprovementBps: number;
  actualStatus: string;
  actualFillPrice: number | null;
  actualAdverseSlippageBps: number | null;
  operatorVerdict: "UNREVIEWED" | "KEEP_EXISTING" | "PREFER_SHADOW" | "NEEDS_INVESTIGATION";
  operatorComment: string | null;
  model: {
    recommendedOrderType?: "MARKET" | "LIMIT";
    dynamicOffsetBps?: number;
    wallAnchorApplied?: boolean;
    wallAnchorSide?: "BID" | "ASK" | "NONE";
    wallAnchorPrice?: number;
    wallAnchorReliability?: number;
    wallAnchorDistanceBps?: number;
    wallAnchorReason?: string;
    inventorySkewRatio?: number;
    tradeIntensityRatio?: number;
    orderBookImbalance?: number;
    orderFlowEvidenceKind?: "PUBLIC_ORDER_FLOW_PROXY" | "UNAVAILABLE";
    orderFlowProxyState?: string;
    orderFlowEvidenceReady?: boolean;
    orderFlowDepthSampleCount10s?: number;
    orderFlowDepthCoverageMs10s?: number;
    orderFlowTradeCount10s?: number;
    orderFlowConfidence?: number;
    directionalOrderFlowPressure?: number;
    aggressorImbalance3s?: number;
    aggressorImbalance10s?: number;
    priceImpactBps10s?: number;
    bidWallPrice?: number;
    bidWallPersistence?: number;
    askWallPrice?: number;
    askWallPersistence?: number;
    bidWallReliability?: number;
    askWallReliability?: number;
    bidLiquidityPullRatio10s?: number;
    askLiquidityPullRatio10s?: number;
    bidReplenishmentRatio10s?: number;
    askReplenishmentRatio10s?: number;
    directionalLiquidityPressure?: number;
    executableDepthRatio?: number;
    expectedWaitCostPrice?: number;
    reason?: string;
  };
  shadowFillEvidence: { status: string; reason: string };
  orderFlowAttribution: {
    status: "WAITING" | "UNAVAILABLE" | "COMPARABLE";
    outcome: string;
    pressureBias: "ALIGNED" | "OPPOSED" | "MIXED" | "UNAVAILABLE";
    evaluationMinute: number | null;
    evaluationRoePercent: number | null;
    marketChaseObserved: boolean;
    fullCycleComplete: boolean;
    checkpoints: Array<{
      minute: number;
      status: "OBSERVED" | "WAITING";
      roePercent: number | null;
    }>;
    explanation: string;
  };
};

type OrderFlowOutcomeSummary = {
  total: number;
  comparable: number;
  waiting: number;
  unavailable: number;
  alignedContinuation: number;
  alignedExhaustion: number;
  enteredAgainstFlow: number;
  contrarianRecovery: number;
  marketChaseObserved: number;
  fullCycles: number;
};

type QuoteShadowResponse = {
  error?: string;
  items?: QuoteShadowItem[];
  summary?: {
    total: number;
    filled: number;
    exchangeRejected: number;
    shadowFillConfirmed: number;
    marketRecommendations: number;
    limitRecommendations: number;
    averageActualAdverseSlippageBps: number | null;
    averageTheoreticalImprovementBps: number | null;
  };
  orderFlowOutcomeSummary?: OrderFlowOutcomeSummary;
  brainAuxiliaryEvidence?: {
    independentWaves: number;
    completeTraces: number;
    holdoutWaves: number;
    minimumIndependentWaves: number;
    status: "COLLECTING" | "REVIEW_READY";
    decisionAuthority: "NONE";
    findings: {
      AVOIDED_ADVERSE_PATH: number;
      MISSED_FAVORABLE_PATH: number;
    };
    summary: string;
  };
};

const roleLabels = { ENTRY: "开仓", ADD: "补仓", EXIT: "退出" } as const;
const originLabels = {
  MANUAL: "人工",
  SEMI_AUTO: "半自动",
  STRATEGY_LONG: "多头策略",
  STRATEGY_SHORT: "空头策略",
} as const;
const verdictLabels = {
  UNREVIEWED: "待复核",
  KEEP_EXISTING: "现有更优",
  PREFER_SHADOW: "影子更优",
  NEEDS_INVESTIGATION: "需要调查",
} as const;

export function QuoteShadowView({
  tradingAccounts,
  canReview,
  setToast,
}: {
  tradingAccounts: Array<{ accountId: string; name: string }>;
  canReview: boolean;
  setToast: (message: string) => void;
}) {
  const [items, setItems] = useState<QuoteShadowItem[]>([]);
  const [summary, setSummary] = useState<QuoteShadowResponse["summary"]>();
  const [orderFlowSummary, setOrderFlowSummary] = useState<OrderFlowOutcomeSummary>();
  const [brainEvidence, setBrainEvidence] =
    useState<QuoteShadowResponse["brainAuxiliaryEvidence"]>();
  const [accountId, setAccountId] = useState("ALL");
  const [role, setRole] = useState("ALL");
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(false);
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<QuoteShadowItem["operatorVerdict"]>("UNREVIEWED");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (accountId !== "ALL") params.set("accountId", accountId);
      if (role !== "ALL") params.set("role", role);
      if (symbol.trim()) params.set("symbol", symbol.trim().toUpperCase());
      const response = await fetch(`/api/control/quote-shadows?${params}`, {
        cache: "no-store",
      });
      const result = await readJsonResponse<QuoteShadowResponse>(response);
      if (!response.ok) throw new Error(result.error || "报价对比加载失败");
      setItems(result.items ?? []);
      setSummary(result.summary);
      setOrderFlowSummary(result.orderFlowOutcomeSummary);
      setBrainEvidence(result.brainAuxiliaryEvidence);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "报价对比加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [accountId, role]);

  const reviewed = useMemo(
    () => items.filter((item) => item.operatorVerdict !== "UNREVIEWED").length,
    [items],
  );

  function openReview(item: QuoteShadowItem) {
    setReviewingId(item.id);
    setVerdict(item.operatorVerdict);
    setComment(item.operatorComment ?? "");
  }

  async function saveReview() {
    if (!reviewingId) return;
    setSaving(true);
    try {
      const response = await fetch("/api/control/quote-shadows", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reviewingId, verdict, comment }),
      });
      const result = await readJsonResponse<{ error?: string }>(response);
      if (!response.ok) throw new Error(result.error || "运营意见保存失败");
      setReviewingId(null);
      setToast("运营意见已保存，仅用于报价模型验证，不会自动修改策略");
      await load();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "运营意见保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="work-page quote-shadow-page">
      <section className="panel quote-shadow-notice">
        <div>
          <b>影子执行报价 · 仅观察</b>
          <p>现有方向、数量、杠杆、止盈止损和真实委托保持不变；本页用公开盘口深度与主动成交跟踪资金执行痕迹。公开数据不能识别具体机构账户，订单流只作为可验证代理。</p>
        </div>
        <button className="refresh-btn" disabled={loading} onClick={() => void load()}>
          {loading ? "加载中…" : "↻ 刷新对比"}
        </button>
      </section>

      <section className="quote-shadow-metrics">
        <article><span>影子决策记录</span><strong>{summary?.total ?? 0}</strong><small>已复核 {reviewed} · 交易所拒绝 {summary?.exchangeRejected ?? 0}</small></article>
        <article><span>真实已成交</span><strong>{summary?.filled ?? 0}</strong><small>可用于成交路径验证</small></article>
        <article><span>影子可成交证据</span><strong>{summary?.shadowFillConfirmed ?? 0}</strong><small>真实价格曾穿过影子价</small></article>
        <article><span>建议市价 / 限价</span><strong>{summary?.marketRecommendations ?? 0} / {summary?.limitRecommendations ?? 0}</strong><small>只比较，不接管委托</small></article>
        <article><span>理论改善</span><strong>{formatBps(summary?.averageTheoreticalImprovementBps)}</strong><small>平均基点</small></article>
        <article><span>订单流可比较</span><strong>{orderFlowSummary?.comparable ?? 0}</strong><small>完整60分钟 {orderFlowSummary?.fullCycles ?? 0} · 等待 {orderFlowSummary?.waiting ?? 0}</small></article>
        <article><span>顺流延续 / 衰竭</span><strong>{orderFlowSummary?.alignedContinuation ?? 0} / {orderFlowSummary?.alignedExhaustion ?? 0}</strong><small>识别买后跌、卖后涨</small></article>
        <article><span>逆流受损 / 追价</span><strong>{orderFlowSummary?.enteredAgainstFlow ?? 0} / {orderFlowSummary?.marketChaseObserved ?? 0}</strong><small>只归因，不自动调参</small></article>
        <article><span>大脑辅助证据</span><strong>{brainEvidence?.independentWaves ?? 0}/{brainEvidence?.minimumIndependentWaves ?? 30}</strong><small>完整轨迹 {brainEvidence?.completeTraces ?? 0} · 无决策权</small></article>
        <article><span>避免不利 / 错失有利</span><strong>{brainEvidence?.findings.AVOIDED_ADVERSE_PATH ?? 0} / {brainEvidence?.findings.MISSED_FAVORABLE_PATH ?? 0}</strong><small>{brainEvidence?.status === "REVIEW_READY" ? "仅可人工复核" : "继续积累波段样本"}</small></article>
      </section>

      <section className="panel quote-shadow-notice">
        <div>
          <b>影子结果只补充成交时机证据</b>
          <p>{brainEvidence?.summary ?? "等待影子报价与真实5/30/60分钟路径形成可比较证据；不会进入下单放行、方向或参数修改。"}</p>
        </div>
      </section>

      <section className="panel">
        <div className="quote-shadow-filters">
          <label>账户<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="ALL">全部账户</option>{tradingAccounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountId} · {account.name}</option>)}</select></label>
          <label>环节<select value={role} onChange={(event) => setRole(event.target.value)}><option value="ALL">全部环节</option><option value="ENTRY">开仓</option><option value="ADD">补仓</option><option value="EXIT">退出</option></select></label>
          <label>合约<input value={symbol} placeholder="例如 BTC" onChange={(event) => setSymbol(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} /></label>
          <button className="secondary-btn" onClick={() => void load()}>查询</button>
        </div>
        <div className="data-table quote-shadow-table">
          <table>
            <thead><tr><th>时间 / 账户</th><th>环节 / 合约</th><th>真实委托</th><th>影子建议</th><th>实时订单流代理</th><th>成交后验证</th><th>动态依据</th><th>成交对比</th><th>运营意见</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td><b>{formatTime(item.createdAt)}</b><small>{item.accountId} · {originLabels[item.origin]}</small></td>
                  <td><b>{roleLabels[item.quoteRole]} · {item.symbol}</b><small>{item.positionSide === "LONG" ? "多仓" : "空仓"} · {item.side}</small></td>
                  <td><b>{item.actualOrderType === "MARKET" ? "市价" : "限价"} {formatPrice(item.actualRequestedPrice)}</b><small>距标记 {formatBps(item.actualDistanceBps)}</small></td>
                  <td><b className={item.model.recommendedOrderType === "LIMIT" ? "positive" : "warning-text"}>{item.model.recommendedOrderType === "LIMIT" ? "限价" : "市价"} {formatPrice(item.shadowQuotePrice)}</b><small>动态偏移 {formatBps(item.model.dynamicOffsetBps)}</small><small title={item.model.wallAnchorReason}>{item.model.wallAnchorApplied ? `${item.model.wallAnchorSide === "BID" ? "可靠买墙" : "可靠卖墙"}锚定 ${formatPrice(item.model.wallAnchorPrice)} · 可靠 ${formatPercent(item.model.wallAnchorReliability)} · 距离 ${formatBps(item.model.wallAnchorDistanceBps)}` : "未使用墙价锚点"}</small></td>
                  <td><b className={flowClass(item.model.directionalOrderFlowPressure)}>{flowLabel(item.model.orderFlowProxyState, item.model.orderFlowEvidenceKind, item.model.orderFlowEvidenceReady)}</b><small>可信度 {formatPercent(item.model.orderFlowConfidence)} · 同向压力 {formatRatio(item.model.directionalOrderFlowPressure)} · 流动性 {formatRatio(item.model.directionalLiquidityPressure)}</small><small>采集 {formatMilliseconds(item.model.orderFlowDepthCoverageMs10s)} · 盘口 {item.model.orderFlowDepthSampleCount10s ?? 0} 帧 · 成交 {item.model.orderFlowTradeCount10s ?? 0} 笔</small><small>主动成交 3秒 {formatRatio(item.model.aggressorImbalance3s)} / 10秒 {formatRatio(item.model.aggressorImbalance10s)} · 价格影响 {formatBps(item.model.priceImpactBps10s)}</small><small>买墙可靠 {formatPercent(item.model.bidWallReliability)} · 撤回 {formatPercent(item.model.bidLiquidityPullRatio10s)} · 补单 {formatPercent(item.model.bidReplenishmentRatio10s)}</small><small>卖墙可靠 {formatPercent(item.model.askWallReliability)} · 撤回 {formatPercent(item.model.askLiquidityPullRatio10s)} · 补单 {formatPercent(item.model.askReplenishmentRatio10s)}</small></td>
                  <td><b className={outcomeClass(item.orderFlowAttribution.outcome)}>{outcomeLabel(item.orderFlowAttribution.outcome)}</b><small>{formatOutcomeCheckpoints(item.orderFlowAttribution.checkpoints)}</small><small title={item.orderFlowAttribution.explanation}>{item.orderFlowAttribution.marketChaseObserved ? "发现市价追价证据 · " : ""}{item.orderFlowAttribution.fullCycleComplete ? "首小时完整" : "路径收集中"}</small></td>
                  <td><b>库存 {formatRatio(item.model.inventorySkewRatio)} · 盘口 {formatRatio(item.model.orderBookImbalance)}</b><small>成交速度 {formatRatio(item.model.tradeIntensityRatio)} · 深度 {formatRatio(item.model.executableDepthRatio)} · 等待成本 {formatPrice(item.model.expectedWaitCostPrice)}</small></td>
                  <td><b>{item.actualStatus} {item.actualFillPrice ? `· ${formatPrice(item.actualFillPrice)}` : ""}</b><small className={item.shadowFillEvidence.status === "CONFIRMED_AT_ACTUAL_FILL" ? "positive" : "muted"}>{item.actualStatus === "REJECTED" ? "未成交，不计入执行质量样本" : item.shadowFillEvidence.status === "CONFIRMED_AT_ACTUAL_FILL" ? "影子价具备成交证据" : "尚无影子成交证据"}</small></td>
                  <td><button className="text-btn" disabled={!canReview} onClick={() => openReview(item)}>{verdictLabels[item.operatorVerdict]}</button>{item.operatorComment && <small title={item.operatorComment}>{item.operatorComment}</small>}</td>
                </tr>
              ))}
              {!loading && items.length === 0 && <tr><td colSpan={9} className="empty-cell">等待新的真实委托产生影子报价样本</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {reviewingId !== null && (
        <section className="panel quote-shadow-review">
          <div><b>记录 #{reviewingId} · 运营复核</b><p>意见只进入对比样本，不会自动改变委托或策略参数。</p></div>
          <select value={verdict} onChange={(event) => setVerdict(event.target.value as QuoteShadowItem["operatorVerdict"])}><option value="UNREVIEWED">待复核</option><option value="KEEP_EXISTING">现有更优</option><option value="PREFER_SHADOW">影子更优</option><option value="NEEDS_INVESTIGATION">需要调查</option></select>
          <input value={comment} maxLength={1000} placeholder="填写判断依据或后续改进意见" onChange={(event) => setComment(event.target.value)} />
          <button className="secondary-btn" onClick={() => setReviewingId(null)}>取消</button>
          <button className="primary-btn" disabled={saving} onClick={() => void saveReview()}>{saving ? "保存中…" : "保存意见"}</button>
        </section>
      )}
    </div>
  );
}

function formatPrice(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 8 });
}

function formatBps(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return `${Number(value).toFixed(2)} bp`;
}

function formatRatio(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toFixed(2);
}

function formatPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return `${(Number(value) * 100).toFixed(0)}%`;
}

function flowLabel(
  state: string | undefined,
  kind: "PUBLIC_ORDER_FLOW_PROXY" | "UNAVAILABLE" | undefined,
  ready: boolean | undefined,
) {
  if (kind !== "PUBLIC_ORDER_FLOW_PROXY") return "订单流待采集";
  if (!ready) return "证据窗口收集中";
  return {
    PERSISTENT_BUY_EXECUTION: "持续主动买入",
    PERSISTENT_SELL_EXECUTION: "持续主动卖出",
    PASSIVE_BID_ABSORPTION: "买盘承接吸收",
    PASSIVE_ASK_ABSORPTION: "卖盘承接吸收",
    BID_LIQUIDITY_PULLED: "买盘流动性撤回",
    ASK_LIQUIDITY_PULLED: "卖盘流动性撤回",
    MIXED: "多空混合",
    INSUFFICIENT: "样本不足",
  }[state ?? ""] ?? "订单流待确认";
}

function formatMilliseconds(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return `${(Number(value) / 1_000).toFixed(1)}秒`;
}

function flowClass(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "muted";
  if (Number(value) >= 0.2) return "positive";
  if (Number(value) <= -0.2) return "warning-text";
  return "muted";
}

function outcomeLabel(outcome: string) {
  return {
    WAITING_FOR_PATH: "等待价格路径",
    ORDER_FLOW_UNAVAILABLE: "无法归因",
    ORDER_FLOW_MIXED: "订单流混合",
    ALIGNED_CONTINUATION: "顺流延续",
    ALIGNED_EXHAUSTION_REVERSAL: "顺流后衰竭反转",
    ENTERED_AGAINST_ORDER_FLOW: "逆流入场受损",
    CONTRARIAN_RECOVERY: "逆流后反转恢复",
    NO_CLEAR_OUTCOME: "暂未拉开差异",
  }[outcome] ?? "等待验证";
}

function outcomeClass(outcome: string) {
  if (["ALIGNED_CONTINUATION", "CONTRARIAN_RECOVERY"].includes(outcome))
    return "positive";
  if (["ALIGNED_EXHAUSTION_REVERSAL", "ENTERED_AGAINST_ORDER_FLOW"].includes(outcome))
    return "warning-text";
  return "muted";
}

function formatOutcomeCheckpoints(
  checkpoints: QuoteShadowItem["orderFlowAttribution"]["checkpoints"],
) {
  const observed = checkpoints.filter((item) => item.status === "OBSERVED");
  if (!observed.length) return "1/3/5/15/30/60分钟结果待采集";
  return observed
    .map((item) => `${item.minute}m ${formatSignedPercent(item.roePercent)}`)
    .join(" · ");
}

function formatSignedPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "--";
  return `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "--";
}
