"use client";

import { useCallback, useEffect, useState } from "react";

type PaperAccount = { id: number; accountId: string; name: string; balanceUsdt: number; availableBalanceUsdt: number; status: string };
type PaperOrder = { id: number; paperAccountId: number; symbol: string; direction: "LONG" | "SHORT"; orderType: "MARKET" | "LIMIT"; quantity: number; averagePrice: number | null; status: string; createdAt: string };
type PaperPosition = { id: number; paperAccountId: number; symbol: string; direction: "LONG" | "SHORT"; quantity: number; entryPrice: number; realizedPnlUsdt: number; status: string };

export function PaperTradingView({ setToast }: { setToast: (message: string) => void }) {
  const [accounts, setAccounts] = useState<PaperAccount[]>([]);
  const [orders, setOrders] = useState<PaperOrder[]>([]);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [accountId, setAccountId] = useState("");
  const [newAccountId, setNewAccountId] = useState("PAPER-04");
  const [newAccountName, setNewAccountName] = useState("04 模型验证虚拟盘");
  const [initialBalance, setInitialBalance] = useState("10000");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [direction, setDirection] = useState<"LONG" | "SHORT">("LONG");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [quantity, setQuantity] = useState("0.001");
  const [limitPrice, setLimitPrice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/control/paper-trading", { cache: "no-store" });
    const payload = await response.json() as { accounts?: PaperAccount[]; orders?: PaperOrder[]; positions?: PaperPosition[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "虚拟盘数据加载失败");
    setAccounts(payload.accounts ?? []);
    setOrders(payload.orders ?? []);
    setPositions(payload.positions ?? []);
    if (payload.accounts?.[0]) setAccountId((current) => current || payload.accounts![0].accountId);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((error) => setToast(error instanceof Error ? error.message : "虚拟盘数据加载失败"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, setToast]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetch("/api/control/paper-trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "EVALUATE_PROTECTION" }) })
        .then((response) => response.json() as Promise<{ triggered?: Array<{ symbol: string; reason: string }> }>)
        .then((payload) => {
          if (payload.triggered?.length) {
            setToast(payload.triggered.map((item) => `${item.symbol} ${item.reason === "TAKE_PROFIT" ? "止盈" : "止损"}`).join("；"));
            void load();
          }
        })
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load, setToast]);

  async function submit(body: Record<string, unknown>, success: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/control/paper-trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "虚拟盘操作失败");
      setToast(success);
      await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "虚拟盘操作失败"); }
    finally { setBusy(false); }
  }

  async function updatePaper(body: Record<string, unknown>, success: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/control/paper-trading", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "虚拟盘操作失败");
      setToast(success);
      await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "虚拟盘操作失败"); }
    finally { setBusy(false); }
  }

  return <div className="work-page">
    <section className="panel">
      <div className="panel-head"><div><h2>虚拟盘测试</h2><p>使用真实公共行情驱动独立虚拟账本，不读取交易密钥，不发送 Binance 订单。</p></div><span className="status-pill positive">PAPER · 隔离环境</span></div>
      <div className="paper-grid">
        <label className="field"><span>虚拟账户编号</span><input value={newAccountId} onChange={(event) => setNewAccountId(event.target.value.toUpperCase())} /></label>
        <label className="field"><span>账户名称</span><input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} /></label>
        <label className="field"><span>初始余额 USDT</span><input type="number" min="1" value={initialBalance} onChange={(event) => setInitialBalance(event.target.value)} /></label>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit({ action: "CREATE_ACCOUNT", accountId: newAccountId, name: newAccountName, initialBalanceUsdt: Number(initialBalance) }, "虚拟账户已创建")}>创建虚拟账户</button>
      </div>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h3>虚拟订单测试</h3><p>市价单会按当前公共标记价格立即虚拟成交；限价单先进入虚拟挂单。</p></div></div>
      <div className="paper-grid">
        <label className="field"><span>虚拟账户</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">请选择</option>{accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountId} · {account.name}</option>)}</select></label>
        <label className="field"><span>合约</span><input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label>
        <div className="field"><span>方向 <b className="paper-direction-selected">当前：{direction === "LONG" ? "做多" : "做空"}</b></span><div className="segmented"><button type="button" aria-pressed={direction === "LONG"} className={direction === "LONG" ? "long-side" : ""} onClick={() => setDirection("LONG")}>做多{direction === "LONG" ? " ✓" : ""}</button><button type="button" aria-pressed={direction === "SHORT"} className={direction === "SHORT" ? "short-side" : ""} onClick={() => setDirection("SHORT")}>做空{direction === "SHORT" ? " ✓" : ""}</button></div></div>
        <label className="field"><span>类型</span><select value={orderType} onChange={(event) => setOrderType(event.target.value as "MARKET" | "LIMIT")}><option value="MARKET">市价</option><option value="LIMIT">限价</option></select></label>
        <label className="field"><span>数量</span><input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        {orderType === "LIMIT" && <label className="field"><span>限价</span><input type="number" min="0" step="any" value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} /></label>}
        <button type="button" className="primary-btn" disabled={busy || !accountId} onClick={() => void submit({ action: "PLACE_ORDER", accountId, symbol, direction, orderType, quantity: Number(quantity), limitPrice: Number(limitPrice), sourceBusiness: "PAPER_TRADING" }, "虚拟订单已创建")}>创建虚拟订单</button>
      </div>
    </section>
    <section className="panel"><div className="stats-grid">{accounts.map((account) => <article key={account.accountId}><span>{account.accountId}</span><strong>{account.balanceUsdt.toFixed(2)}</strong><small>USDT · 可用 {account.availableBalanceUsdt.toFixed(2)}</small></article>)}</div></section>
    <section className="panel"><div className="panel-head"><div><h3>虚拟持仓</h3><p>独立账本，不计入实盘仓位；平仓按当前公共标记价格结算。</p></div></div><div className="table-shell"><table><thead><tr><th>账户</th><th>合约</th><th>方向</th><th>数量</th><th>开仓价</th><th>已实现盈亏</th><th>状态</th><th>操作</th></tr></thead><tbody>{positions.length ? positions.map((position) => <tr key={position.id}><td>{accounts.find((account) => account.id === position.paperAccountId)?.accountId ?? "-"}</td><td>{position.symbol}</td><td>{position.direction === "LONG" ? "做多" : "做空"}</td><td>{position.quantity}</td><td>{position.entryPrice}</td><td>{position.realizedPnlUsdt.toFixed(4)}</td><td>{position.status}</td><td>{position.status === "OPEN" ? <button type="button" className="table-action-btn paper-close-action" disabled={busy} onClick={() => void updatePaper({ action: "CLOSE_POSITION", id: position.id }, "虚拟持仓已按实时标记价平仓")}>立即平仓</button> : "已结束"}</td></tr>) : <tr><td colSpan={8}>暂无虚拟持仓</td></tr>}</tbody></table></div></section>
    <section className="panel"><div className="panel-head"><div><h3>最近虚拟订单</h3><p>可用于验证模型来源、成交和订单生命周期。</p></div></div><div className="table-shell"><table><thead><tr><th>合约</th><th>方向</th><th>类型</th><th>数量</th><th>成交价</th><th>状态</th><th>操作</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td>{order.symbol}</td><td>{order.direction === "LONG" ? "做多" : "做空"}</td><td>{order.orderType}</td><td>{order.quantity}</td><td>{order.averagePrice ?? "等待成交"}</td><td>{order.status}</td><td>{order.status === "NEW" ? <button type="button" className="table-action-btn" disabled={busy} onClick={() => void updatePaper({ action: "CANCEL_ORDER", id: order.id }, "虚拟限价单已撤销")}>撤单</button> : "-"}</td></tr>)}</tbody></table></div></section>
  </div>;
}
