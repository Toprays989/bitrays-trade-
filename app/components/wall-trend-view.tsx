"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type WallRow = {
  symbol: string;
  quoteVolume24h: number;
  status: string;
  businessState?: "READY" | "WAIT" | "INVALIDATED";
  direction?: "LONG" | "SHORT" | null;
  brain?: { long: string; short: string; selected: string; reason: string; factCount: number };
  marketEye?: { status: "READY" | "WAIT" | "INVALIDATED"; reason: string };
  waitReason?: string | null;
  score?: number;
  price?: number;
  bidDistanceBps?: number | null;
  askDistanceBps?: number | null;
  orderFlow?: {
    fresh: boolean;
    bidWallPrice: number;
    bidWallNotional: number;
    bidWallReliability: number;
    askWallPrice: number;
    askWallNotional: number;
    askWallReliability: number;
    flowDirection: string;
    absorption: string;
    proxyState: string;
    confidence: number;
    priceImpactBps10s: number;
    aggressorImbalance10s: number;
    ageMs: number;
  } | null;
};

type PhaseTwoSummary = { ready: number; waiting: number; invalidated: number; brainReady: number; eyeReady: number };
const WALL_TREND_SCAN_ENABLED = false;

export type WallTrendHandoff = {
  symbol: string;
  direction: "LONG" | "SHORT";
  thesis: string;
  requestId: number;
};

function money(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function price(value: number | undefined) {
  return value && Number.isFinite(value) ? value.toPrecision(8) : "-";
}

export function WallTrendView({ setToast, onHandoff, executionEnvironment = "LIVE", setExecutionEnvironment }: { setToast: (message: string) => void; onHandoff?: (handoff: WallTrendHandoff) => void; executionEnvironment?: "LIVE" | "PAPER"; setExecutionEnvironment?: (environment: "LIVE" | "PAPER") => void }) {
  const [rows, setRows] = useState<WallRow[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(WALL_TREND_SCAN_ENABLED);
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<PhaseTwoSummary>({ ready: 0, waiting: 0, invalidated: 0, brainReady: 0, eyeReady: 0 });
  const [paperAccounts, setPaperAccounts] = useState<Array<{ accountId: string; name: string }>>([]);
  const [paperAccountId, setPaperAccountId] = useState("");
  const autoPaperSubmitted = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/control/wall-trend", { cache: "no-store" });
      const payload = await response.json() as { rows?: WallRow[]; ready?: boolean; summary?: PhaseTwoSummary; error?: string };
      if (!response.ok) throw new Error(payload.error || "买卖墙趋势数据加载失败");
      setRows(Array.isArray(payload.rows) ? payload.rows : []);
      setReady(payload.ready === true);
      if (payload.summary) setSummary(payload.summary);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "买卖墙趋势数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [setToast]);

  useEffect(() => {
    if (!WALL_TREND_SCAN_ENABLED) {
      return;
    }
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (executionEnvironment !== "PAPER") return;
    void fetch("/api/control/paper-trading", { cache: "no-store" }).then((response) => response.json()).then((payload: { accounts?: Array<{ accountId: string; name: string }> }) => {
      setPaperAccounts(payload.accounts ?? []);
      if (payload.accounts?.[0]) setPaperAccountId((current) => current || payload.accounts![0].accountId);
    }).catch(() => setPaperAccounts([]));
  }, [executionEnvironment]);

  async function paperOrder(row: WallRow) {
    if (executionEnvironment !== "PAPER" || !paperAccountId || !row.price || !row.direction) return setToast("请先选择 PAPER 虚拟账户并等待 READY 信号");
    const long = row.direction === "LONG";
    const body = { action: "PLACE_ORDER", accountId: paperAccountId, symbol: row.symbol, direction: row.direction, orderType: "MARKET", quantity: 0.001, sourceBusiness: "WALL_TREND_AUTO_PAPER", takeProfitPlan: [row.price * (long ? 1.01 : 0.99)], stopLossPlan: [row.price * (long ? 0.99 : 1.01)] };
    const response = await fetch("/api/control/paper-trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) return setToast(payload.error || "买卖墙 PAPER 模拟下单失败");
    setToast(`${row.symbol} 买卖墙 PAPER 模拟单已创建，已挂入止盈止损保护`);
  }

  useEffect(() => {
    if (executionEnvironment !== "PAPER" || !paperAccountId) return;
    for (const row of rows) {
      const key = `${paperAccountId}:${row.symbol}:${row.direction ?? ""}`;
      if (row.businessState === "READY" && row.direction && !autoPaperSubmitted.current.has(key)) {
        autoPaperSubmitted.current.add(key);
        void paperOrder(row).catch(() => autoPaperSubmitted.current.delete(key));
      }
      if (row.businessState !== "READY") autoPaperSubmitted.current.delete(key);
    }
  }, [executionEnvironment, paperAccountId, rows]);

  const visibleRows = useMemo(() => rows.filter((row) => row.symbol.includes(query.trim().toUpperCase())), [rows, query]);

  return (
    <div className="work-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>买卖墙趋势</h2>
            {!WALL_TREND_SCAN_ENABLED ? <p className="warning-text">买卖墙扫描已临时停用，以释放 Binance 行情权重；挑战赛、风控和人工下单不受影响。</p> : null}
            <p>独立业务监控层，复用公共行情订单流；当前只读，不触发下单。转交半自动后沿用当前环境，PAPER 订单与实盘账本隔离。</p>
          </div>
          <div className="panel-actions">
            <label className="environment-switcher" title="买卖墙转交后的执行环境">
              <span>测试环境</span>
              <select value={executionEnvironment} onChange={(event) => setExecutionEnvironment?.(event.target.value === "PAPER" ? "PAPER" : "LIVE")}>
                <option value="LIVE">LIVE 实盘</option>
                <option value="PAPER">PAPER 虚拟盘</option>
              </select>
            </label>
            {executionEnvironment === "PAPER" && <label className="environment-switcher"><span>PAPER 账户</span><select value={paperAccountId} onChange={(event) => setPaperAccountId(event.target.value)}><option value="">请选择</option>{paperAccounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountId} · {account.name}</option>)}</select></label>}
            <span className={`status-pill ${ready ? "positive" : "warning"}`}>{ready ? "WebSocket 就绪" : "监听预热中"}</span>
          </div>
        </div>
        <div className="panel-actions">
          <input aria-label="筛选合约" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选合约，例如 BTC" />
          <button type="button" className="ghost-btn" onClick={() => void load()} disabled={loading}>{loading ? "读取中…" : "刷新数据"}</button>
        </div>
        <div className="stats-grid">
          <article><span>READY</span><strong>{summary.ready}</strong><small>大脑与眼睛均满足</small></article>
          <article><span>WAIT</span><strong>{summary.waiting}</strong><small>等待证据闭合</small></article>
          <article><span>INVALIDATED</span><strong>{summary.invalidated}</strong><small>墙体或结构已失效</small></article>
          <article><span>大脑 / 眼睛</span><strong>{summary.brainReady} / {summary.eyeReady}</strong><small>只读影子确认数</small></article>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h3>实时候选监控</h3><p>按 24 小时成交量优先占用现有订单流监听名额。</p></div><span>{visibleRows.length} 个合约</span></div>
        <div className="table-shell">
          <table>
            <thead><tr><th>合约</th><th>业务状态</th><th>大脑 / 眼睛</th><th>价格</th><th>买墙</th><th>卖墙</th><th>主动成交</th><th>可靠性</th><th>评分</th></tr></thead>
            <tbody>{visibleRows.map((row) => {
              const flow = row.orderFlow;
              return <tr key={row.symbol}>
                <td><strong>{row.symbol}</strong><small>24h {money(row.quoteVolume24h)} USDT</small></td>
                <td><span className={`status-pill ${row.businessState === "READY" ? "positive" : row.businessState === "INVALIDATED" ? "negative" : "warning"}`}>{row.businessState ?? row.status}</span><small>{row.direction === "LONG" ? "做多候选" : row.direction === "SHORT" ? "做空候选" : "双向观察"}</small>{row.businessState === "READY" && row.direction && executionEnvironment === "PAPER" ? <small className="source-tag protect">PAPER 自动下单已启用</small> : null}{row.businessState === "READY" && row.direction && onHandoff ? <button type="button" className="table-action-btn" onClick={() => onHandoff({ symbol: row.symbol, direction: row.direction as "LONG" | "SHORT", thesis: `买卖墙趋势监控确认：${row.symbol} 出现${row.direction === "LONG" ? "买墙承接" : "卖墙压制"}，请结合实时证据验证；墙体变化即视为失效。`, requestId: Date.now() })}>交给大脑</button> : null}</td>
                <td>{row.brain ? <><strong>{row.brain.selected}</strong><small>眼睛 {row.marketEye?.status ?? "WAIT"} · 事实 {row.brain.factCount}</small><small>{row.businessState === "WAIT" ? (row.waitReason ?? row.marketEye?.reason ?? "等待证据闭合") : row.marketEye?.reason}</small></> : "等待大脑事实"}</td>
                <td>{price(row.price)}<small>{flow ? `${flow.ageMs}ms` : "-"}</small></td>
                <td>{flow ? <><strong>{price(flow.bidWallPrice)}</strong><small>{money(flow.bidWallNotional)} · {row.bidDistanceBps?.toFixed(1)} bps</small></> : "-"}</td>
                <td>{flow ? <><strong>{price(flow.askWallPrice)}</strong><small>{money(flow.askWallNotional)} · {row.askDistanceBps?.toFixed(1)} bps</small></> : "-"}</td>
                <td>{flow ? <><strong>{flow.flowDirection}</strong><small>冲击 {flow.priceImpactBps10s.toFixed(2)} bps</small></> : "-"}</td>
                <td>{flow ? <><small>买 {flow.bidWallReliability.toFixed(2)} / 卖 {flow.askWallReliability.toFixed(2)}</small><small>{flow.absorption}</small></> : "-"}</td>
                <td>{row.score == null ? "-" : row.score.toFixed(0)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
