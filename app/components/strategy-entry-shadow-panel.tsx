"use client";

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Strategy/version changes intentionally refresh this server-backed observation view. */

import { useEffect, useState } from "react";
import { readJsonResponse } from "../client/runtime";
import type { ConfiguredStrategy } from "../client/strategy-view";

type ShadowCheckpoint = {
  minute: 5 | 30 | 60;
  status: "FILLED" | "NOT_FILLED" | "INSUFFICIENT";
  actualRoePercent: number | null;
  shadowOpportunityRoePercent: number | null;
  advantageRoePercent: number | null;
};

type EntryShadowItem = {
  id: number;
  createdAt: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  actualOrderType: "MARKET" | "LIMIT";
  entryExecutionShadow: {
    activationMode: "SHADOW" | "LIVE";
    adaptiveOrderType: "MARKET" | "LIMIT";
    actualRequestedPrice: number;
    adaptiveRequestedPrice: number;
    distanceAtr: number | null;
    marketDistanceThresholdAtr: number;
    recommendationDiffers: boolean;
    selectionReason: string;
  } | null;
  entryPolicyCheckpoints: ShadowCheckpoint[];
};

type EntryShadowSummary = {
  mode: "SHADOW" | "LIVE";
  opportunities: number;
  adaptiveMarket: number;
  adaptiveLimit: number;
  differsFromActual: number;
  minimumComparableOpportunities: number;
  status: "COLLECTING" | "REVIEW_READY";
  note: string;
  horizons: Array<{
    minute: 5 | 30 | 60;
    samples: number;
    shadowFilled: number;
    shadowSkipped: number;
    actualAverageNetRoePercent: number | null;
    shadowAverageNetRoePerOpportunityPercent: number | null;
    averageNetAdvantageRoePercent: number | null;
  }>;
};

type BrainAuxiliaryEvidence = {
  version: "nexus-execution-shadow-brain-evidence-v1";
  evidenceRole: "AUXILIARY_EXECUTION_TIMING_CONTEXT";
  observationOnly: true;
  decisionAuthority: "NONE";
  orderAffecting: false;
  directionAffecting: false;
  quantityAffecting: false;
  parameterAffecting: false;
  rawTraces: number;
  independentWaves: number;
  completeTraces: number;
  holdoutWaves: number;
  minimumIndependentWaves: number;
  minimumHoldoutWaves: number;
  status: "COLLECTING" | "REVIEW_READY";
  findings: {
    SHADOW_ENTRY_PRICE_BETTER: number;
    ACTUAL_ENTRY_PRICE_BETTER: number;
    AVOIDED_ADVERSE_PATH: number;
    MISSED_FAVORABLE_PATH: number;
    NO_CLEAR_DIFFERENCE: number;
    COLLECTING: number;
  };
  horizons: Array<{
    minute: 5 | 30 | 60;
    independentWaves: number;
    actualAverageNetRoePercent: number | null;
    shadowAverageNetRoePerOpportunityPercent: number | null;
    averageNetAdvantageRoePercent: number | null;
    shadowFillRate: number | null;
  }>;
  summary: string;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configuredMode(target: ConfiguredStrategy) {
  const execution = record(target.config.execution);
  if (execution.entryDistanceExecutionMode === "LIVE") return "LIVE" as const;
  if (execution.entryDistanceExecutionMode === "SHADOW") return "SHADOW" as const;
  return execution.orderType === "ADAPTIVE" ? "LIVE" as const : "SHADOW" as const;
}

function signed(value: number | null, suffix = "%") {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function price(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 10 });
}

export function StrategyEntryShadowPanel({
  target,
}: {
  target: ConfiguredStrategy;
}) {
  const [items, setItems] = useState<EntryShadowItem[]>([]);
  const [summary, setSummary] = useState<EntryShadowSummary | null>(null);
  const [brainEvidence, setBrainEvidence] =
    useState<BrainAuxiliaryEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mode = configuredMode(target);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        strategyId: String(target.id),
        configVersion: String(target.configVersion),
        role: "ENTRY",
        limit: "200",
      });
      const response = await fetch(`/api/control/quote-shadows?${params}`, {
        cache: "no-store",
      });
      const result = await readJsonResponse<{
        error?: string;
        items?: EntryShadowItem[];
        entryPolicySummary?: EntryShadowSummary;
        brainAuxiliaryEvidence?: BrainAuxiliaryEvidence;
      }>(response);
      if (!response.ok) throw new Error(result.error || "影子对照加载失败");
      setItems((result.items ?? []).filter((item) => item.entryExecutionShadow));
      setSummary(result.entryPolicySummary ?? null);
      setBrainEvidence(result.brainAuxiliaryEvidence ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "影子对照加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [target.id, target.configVersion]);

  return (
    <div className="strategy-entry-shadow">
      <div className="strategy-entry-shadow-head">
        <div>
          <h3>入场方式影子对照</h3>
          <p>大脑批准后同步计算结构自适应委托；观察模式不发送订单、不改变原下单链路。</p>
        </div>
        <div className="panel-actions">
          <span className={`source-tag ${mode === "LIVE" ? "danger-source" : "protect"}`}>
            {mode === "LIVE" ? "实盘执行" : "仅观察"}
          </span>
          <button disabled={loading} onClick={() => void load()}>
            {loading ? "刷新中…" : "刷新对照"}
          </button>
        </div>
      </div>

      <div className="strategy-entry-shadow-safety">
        当前真实委托：按策略原配置执行；影子只复用同一确认位、ATR和交易所步长计算近处市价或远处回踩限价。切换实盘必须在策略参数中人工保存并发布。
      </div>

      <div className="strategy-entry-shadow-safety">
        <b>大脑辅助证据 · 无决策权</b>
        <span>
          {brainEvidence?.summary ??
            "本配置版本尚无影子执行结果；它不会参与放行、否决、方向、数量或自动调参。"}
        </span>
      </div>

      {error && <div className="inline-error">{error}</div>}

      <div className="strategy-entry-shadow-metrics">
        <article>
          <span>独立观察机会</span>
          <b>{brainEvidence?.independentWaves ?? 0}/{brainEvidence?.minimumIndependentWaves ?? 30}</b>
          <small>原始轨迹 {brainEvidence?.rawTraces ?? 0} · 同波段只计一次</small>
        </article>
        <article>
          <span>近期留出波段</span>
          <b>{brainEvidence?.holdoutWaves ?? 0}/{brainEvidence?.minimumHoldoutWaves ?? 9}</b>
          <small>{brainEvidence?.status === "REVIEW_READY" ? "仅可人工复核" : "继续积累，不自动切换"}</small>
        </article>
        <article>
          <span>影子建议</span>
          <b>{summary?.adaptiveMarket ?? 0} 市价 / {summary?.adaptiveLimit ?? 0} 限价</b>
          <small>与真实委托不同 {summary?.differsFromActual ?? 0} 次</small>
        </article>
        {(summary?.horizons ?? []).map((horizon) => (
          <article key={horizon.minute}>
            <span>{horizon.minute}分钟净ROE</span>
            <b className={(horizon.averageNetAdvantageRoePercent ?? 0) >= 0 ? "positive" : "negative"}>
              真实 {signed(horizon.actualAverageNetRoePercent)} / 影子 {signed(horizon.shadowAverageNetRoePerOpportunityPercent)}
            </b>
            <small>
              净优势 {signed(horizon.averageNetAdvantageRoePercent)} · 可成交 {horizon.shadowFilled}/{horizon.samples}
            </small>
          </article>
        ))}
        <article>
          <span>避免不利 / 错失有利</span>
          <b>{brainEvidence?.findings.AVOIDED_ADVERSE_PATH ?? 0} / {brainEvidence?.findings.MISSED_FAVORABLE_PATH ?? 0}</b>
          <small>只说明成交时机，不评价多空方向</small>
        </article>
      </div>

      <p className="strategy-entry-shadow-note">
        {summary?.note ?? "新版本尚无可比样本；真实委托保持原样。"}
      </p>

      <div className="strategy-log-table-scroll">
        <table className="strategy-log-table strategy-entry-shadow-table">
          <thead>
            <tr>
              <th>时间 / 合约</th>
              <th>距确认位</th>
              <th>真实委托</th>
              <th>影子建议</th>
              <th>5分钟</th>
              <th>30分钟</th>
              <th>60分钟</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const shadow = item.entryExecutionShadow!;
              return (
                <tr key={item.id}>
                  <td>
                    <b>{item.symbol} · {item.positionSide === "LONG" ? "多" : "空"}</b>
                    <small>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</small>
                  </td>
                  <td>
                    <b>{shadow.distanceAtr === null ? "--" : `${shadow.distanceAtr.toFixed(2)} ATR`}</b>
                    <small>市价边界 {shadow.marketDistanceThresholdAtr.toFixed(2)} ATR</small>
                  </td>
                  <td><b>{item.actualOrderType === "MARKET" ? "市价" : "限价"}</b><small>{price(shadow.actualRequestedPrice)}</small></td>
                  <td className={shadow.recommendationDiffers ? "warning-text" : "positive"}><b>{shadow.adaptiveOrderType === "MARKET" ? "市价" : "限价"}</b><small>{price(shadow.adaptiveRequestedPrice)}</small></td>
                  {([5, 30, 60] as const).map((minute) => {
                    const point = item.entryPolicyCheckpoints.find((value) => value.minute === minute);
                    return <td key={minute}><b>{signed(point?.advantageRoePercent ?? null)}</b><small>{point?.status === "FILLED" ? "可成交" : point?.status === "NOT_FILLED" ? "未成交计0" : "待采样"}</small></td>;
                  })}
                  <td title={shadow.selectionReason}>{shadow.selectionReason}</td>
                </tr>
              );
            })}
            {!loading && items.length === 0 && (
              <tr><td className="empty" colSpan={8}>新版本尚无入场影子样本；真实订单不会因此等待或改变。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
