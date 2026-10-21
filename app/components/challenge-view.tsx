"use client";

import { useCallback, useEffect, useState } from "react";

type Challenge = {
  id: number;
  accountId: string;
  credentialId: number;
  whitelistVersionId: number;
  capitalUsdt: number;
  status: string;
  equityUsdt: number | null;
  netPnlUsdt: number | null;
  successProbability: number | null;
  failureProbability: number | null;
  riskUsedPercent: number | null;
  createdAt: string;
};

type WhitelistVersion = {
  id: number;
  version: string;
  status: string;
  symbols: { symbol: string; eligible: boolean; operatorSelected: boolean }[];
};

type SpotAccount = {
  accountId: string;
  name: string;
  credentialId: number;
  label: string;
  apiKeyMask: string;
  lastVerifiedAt: string | null;
};

export function ChallengeView({ setToast, executionEnvironment = "LIVE" }: { setToast: (message: string) => void; executionEnvironment?: "LIVE" | "PAPER" }) {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [versions, setVersions] = useState<WhitelistVersion[]>([]);
  const [capitals, setCapitals] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [whitelistVersionId, setWhitelistVersionId] = useState("");
  const [capitalUsdt, setCapitalUsdt] = useState("1000");
  const [spotAccounts, setSpotAccounts] = useState<SpotAccount[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<Record<number, number[]>>({});
  const [scanning, setScanning] = useState(false);
  const [whitelistPage, setWhitelistPage] = useState(false);
  const [paperAccounts, setPaperAccounts] = useState<Array<{ accountId: string; name: string; status: string }>>([]);

  useEffect(() => {
    if (executionEnvironment !== "PAPER") return;
    void fetch("/api/control/paper-trading", { cache: "no-store" }).then((response) => response.json()).then((payload) => {
      const accounts = Array.isArray(payload.accounts) ? payload.accounts.filter((item: { status?: string }) => item.status === "ACTIVE") : [];
      setPaperAccounts(accounts);
      setAccountId((current) => current || accounts[0]?.accountId || "");
      setCredentialId("0");
    }).catch(() => setToast("虚拟盘账户加载失败"));
  }, [executionEnvironment, setToast]);

  const load = useCallback(async () => {
    const response = await fetch("/api/control/challenges", { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "挑战赛数据加载失败");
    setChallenges(result.challenges || []);
    setVersions(result.whitelistVersions || []);
    setCapitals(result.capitals || []);
    setSpotAccounts(result.spotAccounts || []);
    setSelectedSymbols(Object.fromEntries((result.whitelistVersions || []).map((version: WhitelistVersion) => [version.id, version.symbols.filter((symbol) => symbol.eligible && symbol.operatorSelected).map((symbol) => (symbol as WhitelistVersion["symbols"][number] & { id?: number }).id).filter((id): id is number => typeof id === "number")] )));
  }, []);

  useEffect(() => {
    // Initial data hydration is intentionally started from the mount effect;
    // the request updates the view only after the API response resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((error) => setToast(error instanceof Error ? error.message : "挑战赛数据加载失败"));
  }, [load, setToast]);

  async function createChallenge() {
    setBusy(true);
    try {
      const response = await fetch("/api/control/challenges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, credentialId: Number(credentialId), whitelistVersionId: Number(whitelistVersionId), capitalUsdt: Number(capitalUsdt) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "挑战创建失败");
      setToast("挑战草稿已创建");
      await load();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "挑战创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function scanWhitelist() {
    setScanning(true);
    try {
      const response = await fetch("/api/control/challenges/whitelist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "SCAN" }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "现货扫描失败");
      setToast(`扫描完成，共发现 ${result.scannedCount ?? 0} 个 USDT 交易对`);
      await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "现货扫描失败"); }
    finally { setScanning(false); }
  }

  async function importContractSpotWhitelist() {
    setScanning(true);
    try {
      const response = await fetch("/api/control/challenges/whitelist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "IMPORT_CONTRACT_SPOT" }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "合约现货交集导入失败");
      setToast(`导入完成：${result.importedCount ?? result.scannedCount ?? 0} 个现货交易对，已分批写入`);
      await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "合约现货交集导入失败"); }
    finally { setScanning(false); }
  }

  async function importEligibleSpotWhitelist() {
    setScanning(true);
    try {
      const response = await fetch("/api/control/challenges/whitelist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "IMPORT_ELIGIBLE_SPOT" }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "合格现货导入失败");
      setToast(`导入完成：${result.importedCount ?? result.scannedCount ?? 0} 个合格现货交易对，已分批写入`);
      await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "合格现货导入失败"); }
    finally { setScanning(false); }
  }

  async function cleanEmptyWhitelistVersions() {
    setScanning(true);
    try {
      const response = await fetch("/api/control/challenges/whitelist", { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "空白名单清理失败");
      setToast(`已清理 ${result.deleted ?? 0} 个重复草稿，保留最新版本`);
      await load();
    } catch (error) { setToast(error instanceof Error ? error.message : "空白名单清理失败"); }
    finally { setScanning(false); }
  }

  async function publishWhitelist(versionId: number) {
    const symbolIds = selectedSymbols[versionId] || [];
    const select = await fetch("/api/control/challenges/whitelist", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId, action: "SELECT", symbolIds }) });
    if (!select.ok) throw new Error("白名单勾选保存失败");
    const publish = await fetch("/api/control/challenges/whitelist", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId, action: "PUBLISH" }) });
    const result = await publish.json().catch(() => ({}));
    if (!publish.ok) throw new Error(result.error || "白名单发布失败");
    setToast("白名单版本已发布");
    await load();
  }

  async function changeStatus(id: number, action: "START" | "REDUCE_ONLY" | "CANCEL") {
    const response = await fetch("/api/control/challenges", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "挑战状态更新失败");
    await load();
  }

  const activeChallenge = challenges.find((challenge) => ["RUNNING", "CAUTION", "PROTECT", "REDUCE_ONLY", "CLEARING"].includes(challenge.status)) || challenges[0];
  const activeCapital = activeChallenge?.capitalUsdt || Number(capitalUsdt) || 0;
  const activeEquity = activeChallenge?.equityUsdt ?? activeCapital;
  const gainPercent = activeCapital > 0 ? ((activeEquity - activeCapital) / activeCapital) * 100 : 0;
  const challengeProgress = Math.max(0, Math.min(100, ((activeEquity - activeCapital * 0.97) / (activeCapital * 0.15)) * 100));
  const money = (value: number) => `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

  return (
    <div className="work-page">
      <style>{`.challenge-hero{display:grid;grid-template-columns:minmax(260px,1.4fr) repeat(3,minmax(150px,1fr));gap:18px;align-items:end}.challenge-hero-main h2{font-size:26px;margin:0 0 4px}.challenge-hero-main p{margin:0;color:var(--muted)}.challenge-equity{font-size:38px;line-height:1.05;font-weight:750;letter-spacing:0}.challenge-equity-sub{margin-top:8px;font-size:16px;font-weight:650}.challenge-equity-sub.positive{color:#18864b}.challenge-equity-sub.negative{color:#c43d42}.challenge-stat{border-left:1px solid var(--line);padding-left:18px}.challenge-stat-label{color:var(--muted);font-size:12px}.challenge-stat-value{font-size:20px;font-weight:700;margin-top:5px}.challenge-progress-wrap{margin-top:22px}.challenge-progress-track{height:12px;border-radius:8px;background:linear-gradient(90deg,#d54b54 0 20%,#e9edf1 20% 22%,#198754 22% 100%);position:relative;overflow:hidden}.challenge-progress-fill{position:absolute;inset:0 auto 0 0;background:#198754;opacity:.55}.challenge-progress-marker{position:absolute;top:50%;width:17px;height:17px;border-radius:50%;background:#fff;border:3px solid #198754;transform:translate(-50%,-50%);box-shadow:0 1px 3px rgba(0,0,0,.2)}.challenge-progress-labels{display:flex;justify-content:space-between;margin-top:7px;color:var(--muted);font-size:12px}.challenge-progress-labels strong{color:#c43d42}.challenge-progress-labels .target{color:#198754}.challenge-mini-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}.challenge-mini{border:1px solid var(--line);padding:12px 14px;background:var(--soft)}.challenge-mini b{display:block;font-size:17px;margin-top:4px}.challenge-mini span{font-size:12px;color:var(--muted)}.challenge-symbols{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.challenge-symbol{border:1px solid var(--line);padding:4px 8px;font-size:12px;background:#fff}.challenge-symbol input{margin-right:5px}@media(max-width:900px){.challenge-hero{grid-template-columns:1fr 1fr}.challenge-hero-main{grid-column:1/-1}.challenge-mini-grid{grid-template-columns:1fr 1fr}}`}</style>
      {!whitelistPage && <>
      {!whitelistPage && <section className="panel control-panel">
        <div className="challenge-hero">
          <div className="challenge-hero-main"><h2>挑战赛运营</h2><p>{activeChallenge ? `挑战 #${activeChallenge.id} · ${activeChallenge.status}` : "尚未启动挑战，先发布现货白名单"}</p><div className="challenge-equity">{money(activeEquity)}</div><div className={`challenge-equity-sub ${gainPercent >= 0 ? "positive" : "negative"}`}>{gainPercent >= 0 ? "+" : ""}{gainPercent.toFixed(2)}%</div></div>
          <div className="challenge-stat"><div className="challenge-stat-label">挑战本金</div><div className="challenge-stat-value">{money(activeCapital)}</div></div>
          <div className="challenge-stat"><div className="challenge-stat-label">成功目标</div><div className="challenge-stat-value">{money(activeCapital * 1.12)}</div></div>
          <div className="challenge-stat"><div className="challenge-stat-label">失败线</div><div className="challenge-stat-value">{money(activeCapital * 0.97)}</div></div>
        </div>
        <div className="challenge-progress-wrap"><div className="challenge-progress-track"><div className="challenge-progress-fill" style={{ width: `${challengeProgress}%` }} /><div className="challenge-progress-marker" style={{ left: `${challengeProgress}%` }} /></div><div className="challenge-progress-labels"><strong>未通过 {money(activeCapital * 0.97)}</strong><span>当前 {money(activeEquity)}</span><span className="target">通过 {money(activeCapital * 1.12)}</span></div></div>
        <div className="challenge-mini-grid"><div className="challenge-mini"><span>成功概率</span><b>{activeChallenge?.successProbability == null ? "—" : `${(activeChallenge.successProbability * 100).toFixed(1)}%`}</b></div><div className="challenge-mini"><span>失败概率</span><b>{activeChallenge?.failureProbability == null ? "—" : `${(activeChallenge.failureProbability * 100).toFixed(1)}%`}</b></div><div className="challenge-mini"><span>压力失败概率</span><b>{activeChallenge?.stressFailureProbability == null ? "—" : `${(activeChallenge.stressFailureProbability * 100).toFixed(1)}%`}</b></div><div className="challenge-mini"><span>风险预算使用</span><b>{activeChallenge?.riskUsedPercent == null ? "—" : `${activeChallenge.riskUsedPercent.toFixed(2)}%`}</b></div></div>
      </section>}
      <section className="panel control-panel">
          <div className="panel-head">
          <div>
            <h2>{executionEnvironment === "PAPER" ? "PAPER 现货挑战赛" : "现货挑战赛"}</h2>
            <p>{executionEnvironment === "PAPER" ? "使用虚拟本金和独立账本验证白名单、风险阈值与挑战状态，不读取现货密钥。" : "固定本金、锁定白名单、组合风险自动计算。下单不需要人工审批，风险引擎通过后直接执行。"}</p>
          </div>
          <div className="panel-actions"><button className="ghost-btn" onClick={() => setWhitelistPage(true)}>管理现货白名单</button><span className="guard">v1 · 手续费 0.04%/边</span></div>
        </div>
        <div className="config-grid">
          <label>{executionEnvironment === "PAPER" ? "PAPER 虚拟账户" : "已校验现货账号"}<select value={accountId} onChange={(event) => { if (executionEnvironment === "PAPER") { setAccountId(event.target.value); setCredentialId("0"); return; } const selected = spotAccounts.find((account) => account.accountId === event.target.value); setAccountId(selected?.accountId || ""); setCredentialId(selected ? String(selected.credentialId) : ""); }}><option value="">请选择{executionEnvironment === "PAPER" ? "虚拟账户" : "已校验账号"}</option>{executionEnvironment === "PAPER" ? paperAccounts.map((account) => <option value={account.accountId} key={account.accountId}>{account.accountId} · {account.name}</option>) : spotAccounts.map((account) => <option value={account.accountId} key={account.accountId}>{account.accountId} · {account.name} · {account.label}</option>)}</select>{executionEnvironment === "LIVE" && accountId && <small>密钥 {spotAccounts.find((account) => account.accountId === accountId)?.apiKeyMask || ""} · 已校验</small>}</label>
          <label>白名单版本<select value={whitelistVersionId} onChange={(event) => setWhitelistVersionId(event.target.value)}><option value="">请选择已发布版本</option>{versions.filter((version) => version.status === "PUBLISHED").map((version) => <option value={version.id} key={version.id}>{version.version} · {version.symbols.filter((symbol) => symbol.eligible && symbol.operatorSelected).length} 个交易对</option>)}</select></label>
          <label>挑战本金<select value={capitalUsdt} onChange={(event) => setCapitalUsdt(event.target.value)}>{(capitals.length ? capitals : [100, 200, 500, 1000, 5000, 10000]).map((capital) => <option value={capital} key={capital}>{capital} USDT</option>)}</select></label>
        </div>
        <button className="primary-btn" disabled={busy || !accountId || !credentialId || !whitelistVersionId} onClick={() => void createChallenge()}>{busy ? "创建中…" : "创建挑战草稿"}</button>
      </section>
      </>}

      {whitelistPage && <section className="panel control-panel">
        <div className="panel-head"><div><h2>现货白名单管理</h2><p>可导入合约与现货交集，也可直接导入全部满足成交量和交易状态要求的 Binance Spot。</p></div><div className="panel-actions"><button className="ghost-btn" onClick={() => setWhitelistPage(false)}>返回挑战赛</button><button className="ghost-btn" disabled={scanning} onClick={() => void cleanEmptyWhitelistVersions()}>{scanning ? "处理中…" : "清理重复草稿"}</button><button className="ghost-btn" disabled={scanning} onClick={() => void importEligibleSpotWhitelist()}>{scanning ? "导入中…" : "导入全部合格现货"}</button><button className="ghost-btn" disabled={scanning} onClick={() => void importContractSpotWhitelist()}>{scanning ? "导入中…" : "从合约名单导入现货"}</button><button className="ghost-btn" disabled={scanning} onClick={() => void scanWhitelist()}>{scanning ? "扫描中…" : "扫描币安现货"}</button></div></div>
        {versions.map((version) => <div className="config-safety" key={version.id}><div className="panel-head"><div><b>{version.version}</b><span className="source-tag auto">{version.status}</span><p>{version.symbols.length} 个扫描结果，合格 {version.symbols.filter((symbol) => symbol.eligible).length} 个</p></div>{version.status === "DRAFT" && <button className="primary-btn" disabled={!((selectedSymbols[version.id] || []).length)} onClick={() => void publishWhitelist(version.id).catch((error) => setToast(error instanceof Error ? error.message : "白名单发布失败"))}>发布版本</button>}</div><div className="symbol-chip-list">{version.symbols.filter((symbol) => symbol.eligible).slice(0, 120).map((symbol) => { const ids = selectedSymbols[version.id] || []; const selected = symbol.operatorSelected || ids.includes((symbol as WhitelistVersion["symbols"][number] & { id?: number }).id || -1); const id = (symbol as WhitelistVersion["symbols"][number] & { id?: number }).id; return <label className="symbol-chip" key={symbol.symbol}><input type="checkbox" checked={selected} disabled={version.status !== "DRAFT" || typeof id !== "number"} onChange={() => { if (typeof id !== "number") return; setSelectedSymbols((current) => ({ ...current, [version.id]: selected ? ids.filter((value) => value !== id) : [...ids, id] })); }} />{symbol.symbol}</label>; })}</div></div>)}{versions.length === 0 && <div className="empty">尚未扫描白名单</div>}
      </section>}

      {!whitelistPage && <section className="panel control-panel">
        <div className="panel-head"><div><h2>挑战实例</h2><p>成功线 +12%，失败线 -3%；达到阈值后自动进入清仓流程。</p></div></div>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>ID</th><th>账户</th><th>本金</th><th>状态</th><th>净权益</th><th>成功概率</th><th>失败概率</th><th>操作</th></tr></thead><tbody>{challenges.map((challenge) => <tr key={challenge.id}><td>#{challenge.id}</td><td>{challenge.accountId}</td><td>{challenge.capitalUsdt.toFixed(2)} USDT</td><td><span className="source-tag auto">{challenge.status}</span></td><td>{challenge.equityUsdt == null ? "—" : `${challenge.equityUsdt.toFixed(2)} USDT`}</td><td>{challenge.successProbability == null ? "—" : `${(challenge.successProbability * 100).toFixed(1)}%`}</td><td>{challenge.failureProbability == null ? "—" : `${(challenge.failureProbability * 100).toFixed(1)}%`}</td><td className="panel-actions">{challenge.status === "DRAFT" && <button className="ghost-btn" onClick={() => void changeStatus(challenge.id, "START").catch((error) => setToast(error instanceof Error ? error.message : "启动失败"))}>启动</button>}{["RUNNING", "CAUTION", "PROTECT"].includes(challenge.status) && <button className="ghost-btn" onClick={() => void changeStatus(challenge.id, "REDUCE_ONLY").catch((error) => setToast(error instanceof Error ? error.message : "切换失败"))}>只减仓</button>}{!["SUCCEEDED", "FAILED", "CLEARING"].includes(challenge.status) && <button className="danger-btn" onClick={() => void changeStatus(challenge.id, "CANCEL").catch((error) => setToast(error instanceof Error ? error.message : "结束失败"))}>结束</button>}</td></tr>)}</tbody></table>{challenges.length === 0 && <div className="empty">暂无挑战实例</div>}</div>
      </section>}
    </div>
  );
}
