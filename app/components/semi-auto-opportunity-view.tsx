"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createClientRequestId,
  readJsonResponse,
} from "../client/runtime";
import type { ExchangeCredential } from "../client/workspace-model";
import type { LivePosition } from "../client/workspace-model";
import type { ConfiguredStrategy } from "../client/strategy-view";
import {
  buildSemiAutoRiskLevels,
  type SemiAutoStoredPlan,
} from "../../lib/nexus-semi-auto-confirmation";

type MarketOption = {
  symbol: string;
  name: string;
  price: number;
  enabled: boolean;
};

export type SemiAutoAdoptedPlan = {
  analysisVersion: string;
  analyzedAt: string;
  strategyId: number;
  brainName: string;
  accountId: string;
  thesis: string;
  horizon: "SCALP" | "INTRADAY" | "SWING";
  verdict: "EXECUTABLE";
  symbol: string;
  direction: "LONG" | "SHORT";
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  cancelAfterMinutes: number | null;
  referencePrice: number;
  leverage: number;
  quantity: number;
  takeProfitSteps: Array<{ profitPercent: number; closePercent: number }>;
  stopLossRoePercent: number;
  trailingActivationRoePercent: number;
  trailingGivebackRoePoints: number;
};

type Analysis = {
  analysisRecordId: number;
  analyzedAt: string;
  confirmationExpiresAt: string;
  operatorInput: {
    thesis: string;
    horizon: "SCALP" | "INTRADAY" | "SWING";
    direction: "LONG" | "SHORT";
  };
  brain: {
    id: number;
    brainKey?: string | null;
    name: string;
    configVersion: number;
    accountId: string;
  };
  market: {
    symbol: string;
    markPrice: number;
    markAgeMs: number;
    bidPrice: number | null;
    askPrice: number | null;
    spreadBps: number | null;
    position24hPercent: number | null;
    change24hPercent: number | null;
    quoteVolume24h: number | null;
  };
  evidence: {
    intervals: Array<{
      interval: string;
      regime: string;
      reason: string;
      fastEma: number | null;
      slowEma: number | null;
    }>;
    btc15m: { label: string; reason: string };
    btc1h: { label: string; reason: string };
    relationship: {
      label: string;
      reason: string;
      relativeVolume: number | null;
      fastCorrelation: number | null;
      beta: number | null;
    };
  };
  decision: {
    version: string;
    verdict: "EXECUTABLE" | "WAIT" | "REJECTED" | "INSUFFICIENT";
    summary: string;
    supportingEvidence: string[];
    counterEvidence: string[];
    missingEvidence: string[];
    invalidation: string[];
  };
  plan: null | {
    accountId: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    orderType: "MARKET" | "LIMIT";
    limitPrice: number | null;
    cancelAfterMinutes: number | null;
    referencePrice: number;
    leverage: number;
    quantity: number;
    minOrderQty: number;
    quantityStep: number;
    notionalUsdt: number;
    estimatedInitialMarginUsdt: number;
    takeProfitSteps: Array<{ profitPercent: number; closePercent: number }>;
    stopLossRoePercent: number;
    trailingActivationRoePercent: number;
    trailingGivebackRoePoints: number;
    entryStructureBaseline: {
      version: 1;
      source: "HISTORICAL_MARK_PRICE_5M_BACKFILL_AT_SIGNAL_TIME";
      capturedAt: string;
      eventTime: string;
      eventBucketOpenTime: number;
      priorSupport: number;
      priorResistance: number;
      atr5m: number;
      priorRangeAtr: number;
      supportLookbackCandles: number;
      atrPeriod: number;
      managementEligibility: true;
      entryAttributionEligibility: "PRICE_STRUCTURE_ONLY";
    };
    scenario: {
      estimatedRoundTripFeeUsdt: number;
      stopLossNetUsdt: number;
      profitScenarios: Array<{
        roePercent: number;
        closePercent: number;
        estimatedNetPnlUsdt: number;
      }>;
    };
  };
};

type SemiAutoAnalysisHistoryItem = {
  id: number;
  accountId: string;
  strategyId: number;
  configVersion: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  horizon: "SCALP" | "INTRADAY" | "SWING";
  verdict: "EXECUTABLE" | "WAIT" | "REJECTED" | "INSUFFICIENT";
  summary: string;
  thesis: string;
  analysisVersion: string;
  evidence: Analysis["evidence"] & {
    market: Analysis["market"];
    decision: Analysis["decision"];
  };
  plan: Analysis["plan"];
  liveOrderEventId: number | null;
  createdAt: string;
  confirmationExpiresAt: string;
  confirmationStatus:
    | "PENDING_CONFIRMATION"
    | "EXPIRED"
    | "SUBMITTED"
    | "NOT_EXECUTABLE";
};

const verdictLabel = {
  EXECUTABLE: "证据支持，可确认",
  WAIT: "等待更多证据",
  REJECTED: "拒绝本次机会",
  INSUFFICIENT: "数据不足",
} as const;

export function SemiAutoOpportunityView({
  strategies,
  markets,
  credentials,
  positions,
  canCreate,
  onExecuted,
  handoff,
  executionEnvironment = "LIVE",
}: {
  strategies: ConfiguredStrategy[];
  markets: MarketOption[];
  credentials: ExchangeCredential[];
  positions: LivePosition[];
  canCreate: boolean;
  onExecuted: (message: string) => void;
  executionEnvironment?: "LIVE" | "PAPER";
}) {
  const [strategyId, setStrategyId] = useState("");
  const [symbol, setSymbol] = useState("");
  const [direction, setDirection] = useState<"LONG" | "SHORT">("LONG");
  const [horizon, setHorizon] =
    useState<"SCALP" | "INTRADAY" | "SWING">("INTRADAY");
  const [thesis, setThesis] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [strategyLoadTimedOut, setStrategyLoadTimedOut] = useState(false);
  const [paperAccounts, setPaperAccounts] = useState<Array<{ accountId: string; name: string; status: string }>>([]);
  const [paperAccountId, setPaperAccountId] = useState("");
  const [analysisHistory, setAnalysisHistory] = useState<
    SemiAutoAnalysisHistoryItem[]
  >([]);

  useEffect(() => {
    if (executionEnvironment !== "PAPER") return;
    void fetch("/api/control/paper-trading", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        const accounts = Array.isArray(payload.accounts) ? payload.accounts.filter((item: { status?: string }) => item.status === "ACTIVE") : [];
        setPaperAccounts(accounts);
        setPaperAccountId((current) => current || accounts[0]?.accountId || "");
      })
      .catch(() => setError("虚拟盘账户加载失败"));
  }, [executionEnvironment]);

  const marketSuggestions = useMemo(() => {
    const query = symbol.trim().toUpperCase();
    return markets
      .filter(
        (item) =>
          item.enabled &&
          (!query ||
            item.symbol.includes(query) ||
            item.name.toUpperCase().includes(query)),
      )
      .slice(0, 12);
  }, [markets, symbol]);

  useEffect(() => {
    if (strategies.length) return;
    const timer = window.setTimeout(() => setStrategyLoadTimedOut(true), 2_500);
    return () => window.clearTimeout(timer);
  }, [strategies.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshAnalysisHistory() {
    try {
      const response = await fetch("/api/control/semi-auto/analyze", {
        cache: "no-store",
      });
      const result = (await readJsonResponse(response)) as {
        analyses?: typeof analysisHistory;
      };
      if (response.ok)
        setAnalysisHistory((result.analyses ?? []).slice(0, 50));
    } catch {
      // 当前分析流程仍可使用；历史列表在下一次进入页面时重试。
    }
  }

  useEffect(() => {
    let active = true;
    async function loadConfirmationQueue() {
      try {
        const response = await fetch("/api/control/semi-auto/analyze", {
          cache: "no-store",
        });
        const result = (await readJsonResponse(response)) as {
          analyses?: typeof analysisHistory;
        };
        if (active && response.ok)
          setAnalysisHistory((result.analyses ?? []).slice(0, 50));
      } catch {
        // 当前分析流程仍可使用；确认列表会在下一轮自动重试。
      }
    }
    void loadConfirmationQueue();
    const timer = window.setInterval(
      () => void loadConfirmationQueue(),
      5_000,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const semiAutoPositions = useMemo(
    () =>
      positions
        .filter((position) => position.learning?.source === "SEMI_AUTO")
        .sort(
          (left, right) =>
            new Date(right.openedAt).getTime() -
            new Date(left.openedAt).getTime(),
        )
        .slice(0, 20),
    [positions],
  );
  const pendingConfirmations = useMemo(
    () =>
      analysisHistory.filter(
        (item) =>
          item.confirmationStatus === "PENDING_CONFIRMATION" &&
          item.plan &&
          new Date(item.confirmationExpiresAt).getTime() > nowMs,
      ),
    [analysisHistory, nowMs],
  );

  function semiAutoMemory(position: LivePosition) {
    const evidence = position.learning?.entryEvidence;
    const raw =
      evidence?.opportunityContext &&
      typeof evidence.opportunityContext === "object" &&
      !Array.isArray(evidence.opportunityContext)
        ? evidence.opportunityContext as Record<string, unknown>
        : {};
    return {
      analysisRecordId: Number(raw.analysisRecordId ?? 0),
      thesis: String(raw.thesis ?? "运营判断已记录"),
      horizon: String(raw.horizon ?? "INTRADAY"),
      analysisVersion: String(raw.analysisVersion ?? "NEXUS"),
    };
  }
  const semiAutoPositionByAnalysisId = useMemo(() => {
    const rows = new Map<number, LivePosition>();
    for (const position of semiAutoPositions) {
      const analysisRecordId = semiAutoMemory(position).analysisRecordId;
      if (analysisRecordId > 0 && !rows.has(analysisRecordId))
        rows.set(analysisRecordId, position);
    }
    return rows;
  }, [semiAutoPositions]);

  function positionPnl(position: LivePosition) {
    if (position.status !== "OPEN") return position.realizedPnl;
    const move =
      position.positionSide === "LONG"
        ? position.markPrice - position.entryPrice
        : position.entryPrice - position.markPrice;
    return move * position.quantity;
  }

  function confirmationSeconds(expiresAt: string) {
    return Math.max(
      0,
      Math.ceil((new Date(expiresAt).getTime() - nowMs) / 1_000),
    );
  }

  function reopenPendingConfirmation(
    item: SemiAutoAnalysisHistoryItem,
  ) {
    if (
      item.confirmationStatus !== "PENDING_CONFIRMATION" ||
      !item.plan ||
      confirmationSeconds(item.confirmationExpiresAt) <= 0
    ) {
      setError("该半自动计划已过确认窗口，请重新分析实时证据");
      return;
    }
    const strategy = strategies.find(
      (candidate) => candidate.id === item.strategyId,
    );
    if (!strategy) {
      setError("该计划关联的大脑已不可用，请重新分析");
      return;
    }
    setAnalysis({
      analysisRecordId: item.id,
      analyzedAt: item.createdAt,
      confirmationExpiresAt: item.confirmationExpiresAt,
      operatorInput: {
        thesis: item.thesis,
        horizon: item.horizon,
        direction: item.direction,
      },
      brain: {
        id: strategy.id,
        brainKey: strategy.brainKey,
        name: strategy.displayName ?? strategy.name,
        configVersion: item.configVersion,
        accountId: item.accountId,
      },
      market: item.evidence.market,
      evidence: {
        intervals: item.evidence.intervals,
        btc15m: item.evidence.btc15m,
        btc1h: item.evidence.btc1h,
        relationship: item.evidence.relationship,
      },
      decision: item.evidence.decision,
      plan: item.plan,
    });
    setError("");
    setConfirming(true);
  }

  async function analyze() {
    setError("");
    setAnalysis(null);
    if (!strategyId) return setError("请选择用于验证的 NEXUS 大脑");
    if (!symbol.trim()) return setError("请选择需要分析的合约");
    if (thesis.trim().length < 8)
      return setError("请描述你观察到的机会、理由和可能失效的情况");
    setBusy(true);
    try {
      const response = await fetch("/api/control/semi-auto/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategyId: Number(strategyId),
          symbol,
          direction,
          thesis,
          horizon,
        }),
      });
      const result = (await readJsonResponse(response)) as Analysis & {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "机会分析失败");
      setAnalysis(result);
      await refreshAnalysisHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "机会分析失败");
      await refreshAnalysisHistory();
    } finally {
      setBusy(false);
    }
  }

  async function confirmOrder() {
    if (!analysis?.plan || submitting) return;
    const plan = analysis.plan;
    if (executionEnvironment === "PAPER") {
      if (!paperAccountId) return setError("请选择 PAPER 虚拟账户");
      setSubmitting(true);
      setError("");
      try {
        const response = await fetch("/api/control/paper-trading", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "PLACE_ORDER", accountId: paperAccountId, symbol: plan.symbol, direction: plan.direction, orderType: plan.orderType, quantity: plan.quantity, limitPrice: plan.limitPrice, sourceBusiness: "SEMI_AUTO", strategyId: analysis.brain.id, brainKey: analysis.brain.brainKey, configVersion: analysis.brain.configVersion, analysisRecordId: analysis.analysisRecordId }),
        });
        const result = (await readJsonResponse(response)) as { error?: string; order?: { status?: string } };
        if (!response.ok) throw new Error(result.error ?? "半自动虚拟订单提交失败");
        onExecuted(`${plan.symbol} 半自动 PAPER 虚拟单已${result.order?.status === "NEW" ? "挂起" : "成交"}`);
        await refreshAnalysisHistory();
        setConfirming(false);
        setAnalysis(null);
        setThesis("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "半自动虚拟订单提交失败");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const credential = credentials.find(
      (item) => item.accountId === plan.accountId,
    );
    if (!credential)
      return setError("该大脑账户没有可用的 Binance 实盘密钥");
    const levels = buildSemiAutoRiskLevels(
      plan as SemiAutoStoredPlan,
    );
    const side = plan.direction === "LONG" ? "BUY" : "SELL";
    const confirmation =
      plan.orderType === "LIMIT"
        ? `LIVE ${plan.accountId} ${plan.symbol} ${side} ${plan.quantity} LIMIT ${plan.limitPrice}`
        : `LIVE ${plan.accountId} ${plan.symbol} ${side} ${plan.quantity}`;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/control/live-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId: credential.id,
          symbol: plan.symbol,
          positionSide: plan.direction,
          orderType: plan.orderType,
          price: plan.limitPrice ?? undefined,
          quantity: plan.quantity,
          leverage: plan.leverage,
          takeProfitPlan: levels.takeProfits,
          stopLossPlan: levels.stopLosses,
          trailingActivationPercent: plan.trailingActivationRoePercent,
          trailingStopPercent: plan.trailingGivebackRoePoints,
          cancelAfterMinutes: plan.cancelAfterMinutes ?? undefined,
          confirmation,
          idempotencyKey: createClientRequestId().replaceAll("-", ""),
          orderContext: {
            origin: "SEMI_AUTO",
            analysisRecordId: analysis.analysisRecordId,
            strategyId: analysis.brain.id,
            strategyConfigVersion: analysis.brain.configVersion,
            analysisVersion: analysis.decision.version,
            analyzedAt: analysis.analyzedAt,
            thesis: analysis.operatorInput.thesis,
            horizon: analysis.operatorInput.horizon,
            verdict: analysis.decision.verdict,
            entryStructureBaseline: plan.entryStructureBaseline,
          },
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        pending?: boolean;
        order?: { clientOrderId?: string };
      };
      if (!response.ok) throw new Error(result.error ?? "半自动实盘订单提交失败");
      onExecuted(
        result.pending
          ? `${plan.symbol} 半自动限价单已挂入 Binance，超时将自动撤单`
          : `${plan.symbol} 半自动实盘订单已成交，已转入统一仓位保护`,
      );
      await refreshAnalysisHistory();
      setConfirming(false);
      setAnalysis(null);
      setThesis("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "半自动实盘订单提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="work-page semi-auto-page">
      <section className="panel semi-auto-input-panel">
        <div className="panel-head">
          <div>
            <h2>半自动下单</h2>
            <p>运营提出机会，大脑只按实时证据验证；结论与计划必须人工确认</p>
          </div>
          <span className="source-tag protect">{executionEnvironment} · 不会自动下单</span>
        </div>
        {executionEnvironment === "PAPER" && <label className="field"><span>PAPER 虚拟账户</span><select value={paperAccountId} onChange={(event) => setPaperAccountId(event.target.value)}><option value="">请选择虚拟账户</option>{paperAccounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountId} · {account.name}</option>)}</select></label>}
        <div className="semi-auto-form">
          <label className="field">
            <span>NEXUS 大脑</span>
            <select
              value={strategyId}
              disabled={!strategies.length}
              onChange={(event) => {
                setStrategyId(event.target.value);
                setAnalysis(null);
              }}
            >
              <option value="">
                {strategies.length
                  ? "选择大脑与账户"
                  : strategyLoadTimedOut
                    ? "未找到已发布大脑，请先创建并发布"
                    : "正在加载大脑与账户…"}
              </option>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.displayName ?? strategy.name} · V
                  {strategy.publishedVersion ?? strategy.configVersion}
                </option>
              ))}
            </select>
          </label>
          <label className="field semi-auto-symbol-field">
            <span>机会合约</span>
            <input
              value={symbol}
              placeholder="输入字母，如 ETH"
              autoComplete="off"
              onFocus={() => setSuggestionsOpen(true)}
              onChange={(event) => {
                setSymbol(event.target.value.toUpperCase());
                setSuggestionsOpen(true);
                setAnalysis(null);
              }}
            />
            {suggestionsOpen && (
              <div className="symbol-suggestions semi-auto-symbol-suggestions">
                {marketSuggestions.map((market) => (
                  <button
                    key={market.symbol}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setSymbol(market.symbol);
                      setSuggestionsOpen(false);
                      setAnalysis(null);
                    }}
                  >
                    <b>{market.symbol}</b>
                    <span>{market.name}</span>
                    <em>{market.price > 0 ? market.price : "—"}</em>
                  </button>
                ))}
                {!marketSuggestions.length && <p>没有匹配的已启用合约</p>}
              </div>
            )}
          </label>
          <div className="field">
            <span>运营判断方向</span>
            <div className="segmented">
              <button
                type="button"
                className={direction === "LONG" ? "active" : ""}
                aria-pressed={direction === "LONG"}
                onClick={() => {
                  setDirection("LONG");
                  setAnalysis(null);
                }}
              >
                做多
              </button>
              <button
                type="button"
                className={direction === "SHORT" ? "active danger" : ""}
                aria-pressed={direction === "SHORT"}
                onClick={() => {
                  setDirection("SHORT");
                  setAnalysis(null);
                }}
              >
                做空
              </button>
            </div>
            <small className={direction === "LONG" ? "positive" : "negative"}>
              当前选择：{direction === "LONG" ? "做多" : "做空"}
            </small>
          </div>
          <label className="field">
            <span>观察周期</span>
            <select
              value={horizon}
              onChange={(event) => {
                setHorizon(
                  event.target.value as "SCALP" | "INTRADAY" | "SWING",
                );
                setAnalysis(null);
              }}
            >
              <option value="SCALP">5–15分钟快进快出</option>
              <option value="INTRADAY">30–60分钟日内波段</option>
              <option value="SWING">1–4小时趋势波段</option>
            </select>
          </label>
          <label className="field semi-auto-thesis">
            <span>运营经验判断</span>
            <textarea
              value={thesis}
              maxLength={1000}
              placeholder="例如：观察到放量突破前高，回踩未破，BTC同步企稳；若5分钟跌回支撑下方则判断失效。"
              onChange={(event) => {
                setThesis(event.target.value);
                setAnalysis(null);
              }}
            />
            <small>{thesis.length}/1000 · 这段文字只作为待验证假设</small>
          </label>
        </div>
        {error && <p className="semi-auto-error">{error}</p>}
        <div className="semi-auto-submit-row">
          <button
            type="button"
            className="primary-btn"
            disabled={busy || !canCreate || !strategies.length}
            onClick={() => void analyze()}
          >
            {busy ? "大脑正在收集证据…" : "让 NEXUS 大脑分析"}
          </button>
          <span>
            {!strategies.length
              ? strategyLoadTimedOut
                ? "未读取到可用大脑，请先确认大脑已发布并绑定实盘账户"
                : "正在同步大脑、账户和实盘配置…"
              : canCreate
              ? "点击后重新核对实时行情、账户与密钥状态，不依赖总览页面刷新时间"
              : "当前登录账号缺少半自动分析或实盘确认权限"}
          </span>
        </div>
      </section>

      <section className="panel semi-auto-confirmation-queue">
        <div className="panel-head">
          <div>
            <h2>半自动待确认</h2>
            <p>只列半自动可执行计划；自动策略不会进入此列表</p>
          </div>
          <span className="source-tag">
            {pendingConfirmations.length} 个待确认
          </span>
        </div>
        {pendingConfirmations.length ? (
          <div className="semi-auto-memory-table-wrap">
            <table className="semi-auto-memory-table">
              <thead>
                <tr>
                  <th>合约 / 方向</th>
                  <th>大脑计划</th>
                  <th>预计保证金</th>
                  <th>确认窗口</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pendingConfirmations.map((item) => (
                  <tr key={`pending-${item.id}`}>
                    <td>
                      <b>{item.symbol}</b>
                      <small>
                        {item.direction === "LONG" ? "做多" : "做空"}
                      </small>
                    </td>
                    <td>
                      <b>
                        {item.plan!.orderType === "MARKET"
                          ? "市价"
                          : `限价 ${item.plan!.limitPrice}`}
                      </b>
                      <small>
                        {item.plan!.quantity} · {item.plan!.leverage}×
                      </small>
                    </td>
                    <td>
                      <b>
                        {item.plan!.estimatedInitialMarginUsdt.toFixed(2)} USDT
                      </b>
                      <small>情景估算，提交前重新校验</small>
                    </td>
                    <td>
                      <b className="warning-text">
                        {confirmationSeconds(item.confirmationExpiresAt)} 秒
                      </b>
                      <small>超时后必须重新分析</small>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary-btn compact-btn"
                        onClick={() => reopenPendingConfirmation(item)}
                      >
                        查看并确认
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="semi-auto-wait">
            当前没有等待人工确认的半自动计划。
          </div>
        )}
      </section>

      {analysis && (
        <section className="panel semi-auto-analysis">
          <div className="semi-auto-decision-head">
            <div>
              <span
                className={`semi-auto-verdict ${analysis.decision.verdict.toLowerCase()}`}
              >
                {verdictLabel[analysis.decision.verdict]}
              </span>
              <h2>{analysis.decision.summary}</h2>
              <p>
                {analysis.market.symbol} · 标记价 {analysis.market.markPrice} ·
                行情延迟 {analysis.market.markAgeMs.toFixed(0)}ms ·{" "}
                {analysis.brain.name} V{analysis.brain.configVersion}
              </p>
            </div>
            <small>
              分析时间{" "}
              {new Date(analysis.analyzedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </small>
          </div>

          <div className="semi-auto-evidence-grid">
            <article>
              <h3>目标币多周期</h3>
              {analysis.evidence.intervals.map((item) => (
                <div key={item.interval}>
                  <b>{item.interval}</b>
                  <span>{item.reason}</span>
                </div>
              ))}
            </article>
            <article>
              <h3>BTC 与资金联动</h3>
              <div>
                <b>BTC 15m</b>
                <span>{analysis.evidence.btc15m.label}</span>
              </div>
              <div>
                <b>BTC 1h</b>
                <span>{analysis.evidence.btc1h.label}</span>
              </div>
              <div>
                <b>联动</b>
                <span>{analysis.evidence.relationship.label}</span>
              </div>
              <div>
                <b>相对量</b>
                <span>
                  {analysis.evidence.relationship.relativeVolume?.toFixed(2) ??
                    "—"}
                  ×
                </span>
              </div>
            </article>
            <article>
              <h3>支持 / 反证</h3>
              {analysis.decision.supportingEvidence.map((item) => (
                <p className="positive" key={`support-${item}`}>
                  ✓ {item}
                </p>
              ))}
              {analysis.decision.counterEvidence.map((item) => (
                <p className="negative" key={`counter-${item}`}>
                  ! {item}
                </p>
              ))}
              {analysis.decision.missingEvidence.map((item) => (
                <p className="warning-text" key={`missing-${item}`}>
                  等待 {item}
                </p>
              ))}
            </article>
          </div>

          {analysis.plan ? (
            <>
              <div className="semi-auto-plan-grid">
                <span>
                  方向 <b>{analysis.plan.direction === "LONG" ? "做多" : "做空"}</b>
                </span>
                <span>
                  委托 <b>{analysis.plan.orderType === "MARKET" ? "市价" : `限价 ${analysis.plan.limitPrice}`}</b>
                </span>
                <span>
                  数量 <b>{analysis.plan.quantity}</b>
                </span>
                <span>
                  杠杆 <b>{analysis.plan.leverage}×</b>
                </span>
                <span>
                  名义价值 <b>{analysis.plan.notionalUsdt.toFixed(2)} USDT</b>
                </span>
                <span>
                  预计保证金 <b>{analysis.plan.estimatedInitialMarginUsdt.toFixed(2)} USDT</b>
                </span>
                <span className="negative">
                  止损情景 <b>-{analysis.plan.scenario.stopLossNetUsdt.toFixed(3)} USDT</b>
                </span>
                {analysis.plan.scenario.profitScenarios.map((scenario) => (
                  <span className="positive" key={scenario.roePercent}>
                    +{scenario.roePercent}% ROE
                    <b>约 +{scenario.estimatedNetPnlUsdt.toFixed(3)} USDT</b>
                  </span>
                ))}
              </div>
              <div className="semi-auto-invalidation">
                <b>计划失效条件</b>
                {analysis.decision.invalidation.join("；") || "按已发布大脑风险参数执行"}
              </div>
              <div className="semi-auto-confirm-row">
                <p>
                  收益和风险为情景估算，不是保证；点击后进入现有实盘确认页，仓位成交后仍由原仓位管理保护。
                </p>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={
                    confirmationSeconds(analysis.confirmationExpiresAt) <= 0
                  }
                  onClick={() => setConfirming(true)}
                >
                  {confirmationSeconds(analysis.confirmationExpiresAt) > 0
                    ? `采用计划，确认半自动下单（${confirmationSeconds(analysis.confirmationExpiresAt)}秒）`
                    : "确认窗口已过期，请重新分析"}
                </button>
              </div>
            </>
          ) : (
            <div className="semi-auto-wait">
              当前不生成下单计划。补齐缺失证据或等待结构变化后重新分析。
            </div>
          )}
        </section>
      )}
      {confirming && analysis?.plan && (
        <div className="modal-backdrop manual-confirm-backdrop">
          <div className="modal manual-order-confirm-modal semi-auto-confirm-modal">
            <span className="modal-icon">!</span>
            <div className="config-title">
              <h2>确认半自动实盘下单</h2>
              <p>运营假设已由 NEXUS 大脑验证；确认后立即发送至 Binance</p>
            </div>
            <div className="manual-order-summary-table">
              <span>来源</span><b>SEMI_AUTO 半自动</b>
              <span>大脑</span><b>{analysis.brain.name} · V{analysis.brain.configVersion}</b>
              <span>合约 / 方向</span><b>{analysis.plan.symbol} · {analysis.plan.direction === "LONG" ? "做多" : "做空"}</b>
              <span>委托</span><b>{analysis.plan.orderType === "MARKET" ? "市价" : `限价 ${analysis.plan.limitPrice}`}</b>
              <span>数量 / 杠杆</span><b>{analysis.plan.quantity} · {analysis.plan.leverage}×</b>
              <span>风险情景</span><b className="negative">约 -{analysis.plan.scenario.stopLossNetUsdt.toFixed(3)} USDT</b>
              <span>确认窗口</span>
              <b className="warning-text">
                {confirmationSeconds(analysis.confirmationExpiresAt)} 秒
              </b>
            </div>
            <p className="manual-confirm-warning">
              系统只执行已显示计划；成交后转入统一仓位管理，运营判断不会覆盖止盈止损。
            </p>
            <div>
              <button disabled={submitting} onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                className="danger-btn"
                disabled={
                  submitting ||
                  confirmationSeconds(analysis.confirmationExpiresAt) <= 0
                }
                onClick={() => void confirmOrder()}
              >
                {submitting ? "提交中…" : "确认实盘下单"}
              </button>
            </div>
          </div>
        </div>
      )}
      <section className="panel semi-auto-analysis-history">
        <div className="panel-head">
          <div>
            <h2>运营判断记录</h2>
            <p>等待、拒绝和可执行分析都单独留存；未下单记录不会伪装成交易样本</p>
          </div>
          <span className="source-tag">最近 {analysisHistory.length} 条</span>
        </div>
        {analysisHistory.length ? (
          <div className="semi-auto-memory-table-wrap">
            <table className="semi-auto-memory-table">
              <thead>
                <tr>
                  <th>时间 / 合约</th>
                  <th>运营判断</th>
                  <th>方向</th>
                  <th>大脑结论</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {analysisHistory.map((item) => {
                  const linkedPosition =
                    semiAutoPositionByAnalysisId.get(item.id);
                  const linkedPnl = linkedPosition
                    ? positionPnl(linkedPosition)
                    : null;
                  return (
                  <tr key={item.id}>
                    <td>
                      <b>{item.symbol}</b>
                      <small>
                        {new Date(item.createdAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </small>
                    </td>
                    <td title={item.thesis}>
                      <span className="semi-auto-memory-thesis">
                        {item.thesis}
                      </span>
                    </td>
                    <td>
                      <b className={item.direction === "LONG" ? "positive" : "negative"}>
                        {item.direction === "LONG" ? "做多" : "做空"}
                      </b>
                    </td>
                    <td>
                      <b>{verdictLabel[item.verdict]}</b>
                      <small>{item.summary}</small>
                    </td>
                    <td>
                      {linkedPosition ? (
                        <>
                          <b
                            className={
                              Number(linkedPnl) >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {Number(linkedPnl) >= 0 ? "+" : ""}
                            {Number(linkedPnl).toFixed(3)} USDT
                          </b>
                          <small>
                            已关联真实订单 ·{" "}
                            {linkedPosition.learning?.sampleCount ?? 0} 个检查点
                            · {linkedPosition.status === "OPEN" ? "持仓中" : "已结束"}
                          </small>
                        </>
                      ) : item.liveOrderEventId ? (
                        <span className="warning-text">
                          订单已提交，等待仓位成交对账
                        </span>
                      ) : (
                        <span>未下单 · 仅作反事实对照</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="semi-auto-wait">暂无运营分析记录。</div>
        )}
      </section>
      <section className="panel semi-auto-memory-panel">
        <div className="panel-head">
          <div>
            <h2>大脑记忆与结果回归</h2>
            <p>只显示半自动链路；保存运营假设、验证版本及入场后事实，不与人工或自动策略样本混合</p>
          </div>
          <span className="source-tag">{semiAutoPositions.length} 个样本</span>
        </div>
        {semiAutoPositions.length ? (
          <div className="semi-auto-memory-table-wrap">
            <table className="semi-auto-memory-table">
              <thead>
                <tr>
                  <th>时间 / 合约</th>
                  <th>运营假设</th>
                  <th>方向 / 周期</th>
                  <th>当前结果</th>
                  <th>眼睛验证</th>
                  <th>大脑结论</th>
                </tr>
              </thead>
              <tbody>
                {semiAutoPositions.map((position) => {
                  const memory = semiAutoMemory(position);
                  const pnl = positionPnl(position);
                  return (
                    <tr key={position.id}>
                      <td>
                        <b>{position.symbol}</b>
                        <small>
                          {new Date(position.openedAt).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </small>
                      </td>
                      <td title={memory.thesis}>
                        <span className="semi-auto-memory-thesis">
                          {memory.thesis}
                        </span>
                        <small>{memory.analysisVersion}</small>
                      </td>
                      <td>
                        <b className={position.positionSide === "LONG" ? "positive" : "negative"}>
                          {position.positionSide === "LONG" ? "做多" : "做空"}
                        </b>
                        <small>{memory.horizon}</small>
                      </td>
                      <td>
                        <b className={pnl >= 0 ? "positive" : "negative"}>
                          {pnl >= 0 ? "+" : ""}
                          {pnl.toFixed(3)} USDT
                        </b>
                        <small>
                          {position.entryPrice} → {position.markPrice} ·{" "}
                          {position.status === "OPEN" ? "持仓中" : "已结束"}
                        </small>
                      </td>
                      <td>
                        <b>
                          {position.learning?.sampleCount ?? 0} 个检查点
                        </b>
                        <div className="semi-auto-checkpoints">
                          {(position.learning?.checkpoints ?? [])
                            .filter((item) =>
                              [1, 3, 5, 15, 30, 60].includes(item.minute),
                            )
                            .map((item) => (
                              <span
                                key={`${position.id}-${item.minute}`}
                                className={
                                  Number(item.roePercent) >= 0
                                    ? "positive"
                                    : "negative"
                                }
                                title={`标记价 ${item.markPrice}`}
                              >
                                {item.minute}m{" "}
                                {item.roePercent === null ||
                                item.roePercent === undefined
                                  ? "—"
                                  : `${item.roePercent >= 0 ? "+" : ""}${item.roePercent.toFixed(1)}%`}
                              </span>
                            ))}
                        </div>
                        <small>
                          最新 {position.learning?.latestMinute ?? 0} 分钟 ·
                          价格与 ROE 同步留档
                        </small>
                      </td>
                      <td>
                        <b>{position.learning?.comparison ?? "等待事实"}</b>
                        <small>{position.learning?.suggestion ?? "继续观察"}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="semi-auto-wait">
            暂无半自动实盘样本。分析本身不会伪造记忆；只有人工确认并真实成交后才进入结果回归。
          </div>
        )}
      </section>
    </div>
  );
}
