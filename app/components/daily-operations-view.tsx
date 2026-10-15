"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  clientRequestErrorMessage,
  fetchWithTransientRetry,
  readJsonResponse,
} from "../client/runtime";

type ReportRow = {
  key: string;
  sourceType: "STRATEGY" | "MANUAL";
  strategyId: number | null;
  strategyName: string;
  configVersion: number | null;
  accountId: string;
  accountName: string;
  orderCount: number;
  filledOrderCount: number;
  orderNotional: number;
  closeCount: number;
  automaticCloseCount: number;
  manualCloseCount: number;
  realizedPnl: number;
  automaticClosePnl: number;
  openPositionCount: number;
  unrealizedPnl: number;
};

type ReportResponse = {
  range: { from: string; to: string; timezone: string };
  generatedAt: string;
  currentPositionPricing: {
    source: string;
    complete: boolean;
    markedPositions: number;
    totalPositions: number;
  };
  total: Omit<ReportRow, "key" | "strategyName" | "accountId" | "accountName">;
  rows: ReportRow[];
  error?: string;
};

function chinaDate(daysAgo = 0) {
  return new Date(Date.now() + 8 * 60 * 60 * 1_000 - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function signedMoney(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} USDT`;
}

function totalForRows(rows: ReportRow[]) {
  return rows.reduce(
    (sum, row) => ({
      orderCount: sum.orderCount + row.orderCount,
      filledOrderCount: sum.filledOrderCount + row.filledOrderCount,
      orderNotional: sum.orderNotional + row.orderNotional,
      closeCount: sum.closeCount + row.closeCount,
      automaticCloseCount:
        sum.automaticCloseCount + row.automaticCloseCount,
      manualCloseCount: sum.manualCloseCount + row.manualCloseCount,
      realizedPnl: sum.realizedPnl + row.realizedPnl,
      automaticClosePnl:
        sum.automaticClosePnl + row.automaticClosePnl,
      openPositionCount: sum.openPositionCount + row.openPositionCount,
      unrealizedPnl: sum.unrealizedPnl + row.unrealizedPnl,
    }),
    {
      orderCount: 0,
      filledOrderCount: 0,
      orderNotional: 0,
      closeCount: 0,
      automaticCloseCount: 0,
      manualCloseCount: 0,
      realizedPnl: 0,
      automaticClosePnl: 0,
      openPositionCount: 0,
      unrealizedPnl: 0,
    },
  );
}

export function DailyOperationsView({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [from, setFrom] = useState(() => chinaDate());
  const [to, setTo] = useState(() => chinaDate());
  const [appliedRange, setAppliedRange] = useState(() => ({
    from: chinaDate(),
    to: chinaDate(),
  }));
  const [sourceFilter, setSourceFilter] = useState<"ALL" | "STRATEGY" | "MANUAL">("ALL");
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const forceRefreshRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchWithTransientRetry(
      `/api/control/daily-operations?from=${encodeURIComponent(appliedRange.from)}&to=${encodeURIComponent(appliedRange.to)}${forceRefreshRef.current ? "&refresh=1" : ""}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const payload = await readJsonResponse<ReportResponse>(response);
        if (!response.ok) throw new Error(payload.error ?? "日报加载失败");
        setReport(payload);
        setError("");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          clientRequestErrorMessage(cause, "日报加载失败"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          forceRefreshRef.current = false;
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, [appliedRange, refreshVersion, refreshSignal]);

  useEffect(() => {
    const today = chinaDate();
    if (appliedRange.from > today || appliedRange.to < today) return;
    const refreshCurrentDay = () => {
      if (document.visibilityState === "visible")
        setRefreshVersion((value) => value + 1);
    };
    const timer = window.setInterval(refreshCurrentDay, 15_000);
    document.addEventListener("visibilitychange", refreshCurrentDay);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshCurrentDay);
    };
  }, [appliedRange]);

  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (report?.rows ?? []).filter((row) =>
      (sourceFilter === "ALL" || row.sourceType === sourceFilter) &&
      (!normalized ||
        `${row.strategyName} ${row.accountName} ${row.accountId} ${row.configVersion ?? ""}`
          .toLowerCase()
          .includes(normalized))
    );
  }, [query, report?.rows, sourceFilter]);
  const visibleTotal = useMemo(() => totalForRows(visibleRows), [visibleRows]);

  function applyRange(nextFrom = from, nextTo = to) {
    if (nextFrom > nextTo) {
      setError("开始日期不能晚于结束日期");
      return;
    }
    setError("");
    setBusy(true);
    setFrom(nextFrom);
    setTo(nextTo);
    setAppliedRange({ from: nextFrom, to: nextTo });
  }

  return (
    <div className="work-page daily-operations-page">
      <section className="panel control-panel">
        <div className="panel-head">
          <div>
            <h2>每日运营数据报表</h2>
            <p>按建仓来源归属到具体策略版本或人工操作，平仓收益按真实成交账本汇总</p>
          </div>
          <div className="panel-actions">
            <span className="guard">
              {report
                ? `${error ? "上次成功 " : ""}${report.range.from} 至 ${report.range.to}`
                : "等待数据"}
            </span>
            <button
              onClick={() => {
                setError("");
                setBusy(true);
                forceRefreshRef.current = true;
                setRefreshVersion((value) => value + 1);
              }}
              disabled={busy}
            >
              {busy ? "同步中…" : "刷新报表"}
            </button>
          </div>
        </div>

        <div className="daily-report-filters">
          <label>
            <span>开始日期</span>
            <input type="date" value={from} max={chinaDate()} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            <span>结束日期</span>
            <input type="date" value={to} max={chinaDate()} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button className="primary-btn" onClick={() => applyRange()} disabled={busy}>查询</button>
          <div className="daily-quick-range">
            <button onClick={() => applyRange(chinaDate(), chinaDate())}>今日</button>
            <button onClick={() => applyRange(chinaDate(6), chinaDate())}>近 7 天</button>
            <button onClick={() => applyRange(chinaDate(29), chinaDate())}>近 30 天</button>
          </div>
        </div>

        {error && (
          <div className="daily-report-error">
            <b>{error}</b>
            {report && (
              <small>
                下方为上次成功报表（{report.range.from} 至 {report.range.to}），本次查询未覆盖下方数据。
              </small>
            )}
          </div>
        )}

        <div className="daily-report-summary">
          <article>
            <span>下单 / 成交</span>
            <b>{visibleTotal.orderCount} <i>/</i> {visibleTotal.filledOrderCount}</b>
            <small>名义价值 {visibleTotal.orderNotional.toFixed(2)} USDT</small>
          </article>
          <article>
            <span>平仓 / 自动平仓</span>
            <b>{visibleTotal.closeCount} <i>/</i> {visibleTotal.automaticCloseCount}</b>
            <small>人工或外部 {visibleTotal.manualCloseCount} 笔</small>
          </article>
          <article>
            <span>已实现 / 自动平仓盈亏</span>
            <b className={visibleTotal.realizedPnl >= 0 ? "positive" : "negative"}>
              {signedMoney(visibleTotal.realizedPnl)}
            </b>
            <small className={visibleTotal.automaticClosePnl >= 0 ? "positive" : "negative"}>
              / {signedMoney(visibleTotal.automaticClosePnl)}
            </small>
          </article>
          <article>
            <span>当前未平仓 / 未实现盈亏</span>
            <b>{visibleTotal.openPositionCount} <i>/</i>{" "}
              <em className={visibleTotal.unrealizedPnl >= 0 ? "positive" : "negative"}>
                {signedMoney(visibleTotal.unrealizedPnl)}
              </em>
            </b>
            <small>
              {report?.currentPositionPricing.complete
                ? "Binance 实时标记价"
                : `实时标记价 ${report?.currentPositionPricing.markedPositions ?? 0}/${report?.currentPositionPricing.totalPositions ?? 0} · 其余使用仓位缓存`}
            </small>
          </article>
        </div>

        <div className="filterbar daily-report-source-filter">
          <label>
            ⌕{" "}
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="策略名称 / 账户 / 版本" />
          </label>
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}>
            <option value="ALL">全部下单类型</option>
            <option value="STRATEGY">策略自动下单</option>
            <option value="MANUAL">人工下单</option>
          </select>
          <span>当前 {visibleRows.length} 个来源</span>
        </div>

        <div className="data-table daily-report-table">
          <table>
            <thead>
              <tr>
                <th>下单来源</th>
                <th>账户</th>
                <th>下单数量</th>
                <th>平仓数量</th>
                <th>已实现盈亏</th>
                <th>当前未平仓</th>
                <th>当前未实现盈亏</th>
              </tr>
            </thead>
            <tbody>
              <tr className="daily-total-row">
                <td><b>合计</b><small>筛选范围</small></td>
                <td>全部账户</td>
                <td><b>{visibleTotal.orderCount}</b><small>/ 成交 {visibleTotal.filledOrderCount}</small></td>
                <td><b>{visibleTotal.closeCount}</b><small>/ 自动 {visibleTotal.automaticCloseCount}</small></td>
                <td className={visibleTotal.realizedPnl >= 0 ? "positive" : "negative"}>
                  <b>{signedMoney(visibleTotal.realizedPnl)}</b>
                  <small>/ 自动 {signedMoney(visibleTotal.automaticClosePnl)}</small>
                </td>
                <td><b>{visibleTotal.openPositionCount}</b></td>
                <td className={visibleTotal.unrealizedPnl >= 0 ? "positive" : "negative"}>
                  <b>{signedMoney(visibleTotal.unrealizedPnl)}</b>
                </td>
              </tr>
              {visibleRows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <b>{row.strategyName}</b>
                    <small>
                      {row.sourceType === "STRATEGY"
                        ? `策略自动下单 / V${row.configVersion}`
                        : "人工下单"}
                    </small>
                  </td>
                  <td><b>{row.accountName}</b><small>{row.accountId}</small></td>
                  <td><b>{row.orderCount}</b><small>/ 成交 {row.filledOrderCount} · {row.orderNotional.toFixed(2)} USDT</small></td>
                  <td><b>{row.closeCount}</b><small>/ 自动 {row.automaticCloseCount} · 人工/外部 {row.manualCloseCount}</small></td>
                  <td className={row.realizedPnl >= 0 ? "positive" : "negative"}>
                    <b>{signedMoney(row.realizedPnl)}</b>
                    <small>/ 自动 {signedMoney(row.automaticClosePnl)}</small>
                  </td>
                  <td><b>{row.openPositionCount}</b></td>
                  <td className={row.unrealizedPnl >= 0 ? "positive" : "negative"}><b>{signedMoney(row.unrealizedPnl)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!busy && !error && visibleRows.length === 0 && (
            <div className="empty">当前时间范围和筛选条件下暂无运营记录</div>
          )}
        </div>

        <div className="analytics-note daily-report-note">
          下单数量只统计建仓委托，不把减仓重复算作下单；平仓数量按真实减仓/平仓成交笔数统计。当前未平仓和未实现盈亏始终按现有仓位归属展示，不受历史时间筛选影响。
        </div>
      </section>
    </div>
  );
}
