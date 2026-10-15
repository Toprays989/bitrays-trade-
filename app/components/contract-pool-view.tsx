"use client";

import { useMemo, useState } from "react";

export type ContractPoolItem = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  high: number;
  low: number;
  volume: string | number;
  enabled: boolean;
  minOrderQty: number;
  effectiveMinOrderQty: number | null;
  effectiveMarketMinOrderQty: number | null;
  quantityStep: number;
  minNotionalUsdt: number;
  priceTickSize: number;
  maxLeverage: number | null;
  updatedAt: string;
};

export type ContractCatalogItem = {
  symbol: string;
  name: string;
  included: boolean;
  price: number;
  change: number;
  volume: number;
  minOrderQty: number;
  effectiveMinOrderQty: number | null;
  effectiveMarketMinOrderQty: number | null;
  quantityStep: number;
  minNotionalUsdt: number;
  maxLeverage: number | null;
};

type ContractPoolViewProps = {
  pool: ContractPoolItem[];
  filteredPool: ContractPoolItem[];
  poolQuery: string;
  setPoolQuery: (value: string) => void;
  poolStatus: string;
  setPoolStatus: (value: string) => void;
  poolSort: "SYMBOL" | "VOLUME_DESC" | "CHANGE_DESC" | "CHANGE_ASC";
  setPoolSort: (value: "SYMBOL" | "VOLUME_DESC" | "CHANGE_DESC" | "CHANGE_ASC") => void;
  poolBusy: string;
  marketStatus: {
    reachable: boolean;
    error: string | null;
    updatedAt: string;
    thresholdUsdt: number;
  } | null;
  can: (permission: string) => boolean;
  synchronizeSymbolPool: () => Promise<void>;
  updateSymbolPool: (symbol: string, patch: { isActive: boolean }) => Promise<void>;
  removeSymbol: (symbol: string) => Promise<void>;
  showAddSymbol: boolean;
  setShowAddSymbol: (value: boolean) => void;
  catalog: ContractCatalogItem[];
  createSymbol: (symbol: string) => Promise<void>;
};

export function ContractPoolView({
  pool,
  filteredPool,
  poolQuery,
  setPoolQuery,
  poolStatus,
  setPoolStatus,
  poolSort,
  setPoolSort,
  poolBusy,
  marketStatus,
  can,
  synchronizeSymbolPool,
  updateSymbolPool,
  removeSymbol,
  showAddSymbol,
  setShowAddSymbol,
  catalog,
  createSymbol,
}: ContractPoolViewProps) {
  const automaticThresholdWan = (
    (marketStatus?.thresholdUsdt ?? 15_000_000) / 10_000
  ).toLocaleString("zh-CN", {
    maximumFractionDigits: 0,
    useGrouping: false,
  });
  const formatQuantity = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? value.toLocaleString("en-US", {
          maximumFractionDigits: 12,
          useGrouping: false,
        })
      : "--";
  const [catalogQuery, setCatalogQuery] = useState("");
  const [removeTarget, setRemoveTarget] = useState<ContractPoolItem | null>(null);
  const catalogMatches = useMemo(() => {
    const query = catalogQuery.trim().toUpperCase();
    if (!query) return [];
    return catalog
      .filter(
        (item) =>
          !item.included &&
          (item.symbol.includes(query) || item.name.toUpperCase().includes(query)),
      )
      .sort((left, right) => right.volume - left.volume)
      .slice(0, 20);
  }, [catalog, catalogQuery]);

  return (
      <div className="work-page">
        <section className="panel control-panel">
          <div className="panel-head">
            <div>
              <h2>自动流动性合约池</h2>
              <p>
                24h 成交额达到 {automaticThresholdWan} 万 USDT 自动加入；人工加入和本次 TradFi 全量加入不受交易额限制
              </p>
            </div>
            <div className="panel-actions">
              <span
                className={
                  marketStatus?.reachable ? "guard" : "source-tag danger-source"
                }
              >
                {marketStatus?.reachable
                  ? "实盘行情缓存正常"
                  : "行情缓存不可用"}
              </span>
              <button
                onClick={() => void synchronizeSymbolPool()}
                disabled={Boolean(poolBusy) || !can("trade:symbol_pool:edit")}
              >
                {poolBusy === "SYNC" ? "同步中…" : "↻ 立即同步 Binance"}
              </button>
              <button
                className="primary-btn"
                onClick={() => {
                  setCatalogQuery("");
                  setShowAddSymbol(true);
                }}
                disabled={!can("trade:symbol_pool:edit")}
              >
                ＋ 搜索添加合约
              </button>
            </div>
          </div>
          <div className="symbol-pool-summary" aria-label="合约池概览">
            <span>总数 <b>{pool.length}</b></span>
            <span>正在监控与交易 <b>{pool.filter((item) => item.enabled).length}</b></span>
            <span>
              已暂停{" "}
              <b className={pool.some((item) => !item.enabled) ? "negative" : "positive"}>
                {pool.filter((item) => !item.enabled).length}
              </b>
            </span>
            <span>已移除 <b>{catalog.filter((item) => !item.included).length}</b></span>
            <span>当前显示 <b>{filteredPool.length}</b></span>
          </div>
          <div className="filterbar">
            <label>
              ⌕{" "}
              <input
                value={poolQuery}
                onChange={(event) => setPoolQuery(event.target.value)}
                placeholder="搜索合约代码或名称"
              />
            </label>
            <select
              value={poolStatus}
              onChange={(event) => setPoolStatus(event.target.value)}
            >
              <option value="ALL">全部状态</option>
              <option value="ACTIVE">运行中</option>
              <option value="INACTIVE">已暂停</option>
            </select>
            <select
              value={poolSort}
              onChange={(event) =>
                setPoolSort(
                  event.target.value as
                    | "SYMBOL"
                    | "VOLUME_DESC"
                    | "CHANGE_DESC"
                    | "CHANGE_ASC",
                )
              }
            >
              <option value="VOLUME_DESC">按交易金额从高到低</option>
              <option value="CHANGE_DESC">按涨幅从高到低</option>
              <option value="CHANGE_ASC">按跌幅从高到低</option>
              <option value="SYMBOL">按合约名称排序</option>
            </select>
            <span>自动加入 ≥{automaticThresholdWan} 万 USDT · 人工与 TradFi 一次性加入不受限制</span>
          </div>
          <div className="data-table symbol-pool-table">
            <table>
              <thead>
                <tr>
                  <th>合约</th>
                  <th>最新价格</th>
                  <th>24h 成交额</th>
                  <th>当日最高</th>
                  <th>当日最低</th>
                  <th>24h 涨跌</th>
                  <th>实际最小下单量</th>
                  <th>数量步长</th>
                  <th>Binance 最大杠杆</th>
                  <th>监控与交易</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredPool.map((m) => (
                  <tr key={m.symbol}>
                    <td>
                      <b>{m.symbol}</b>
                      <small>{m.name}</small>
                    </td>
                    <td>
                      {m.price
                        ? m.price.toLocaleString("en-US", {
                            maximumFractionDigits: 8,
                          })
                        : "待同步"}
                    </td>
                    <td>
                      {typeof m.volume === "number"
                        ? m.volume.toLocaleString("en-US", {
                            maximumFractionDigits: 0,
                          })
                        : m.volume}
                    </td>
                    <td>
                      {m.high
                        ? m.high.toLocaleString("en-US", {
                            maximumFractionDigits: 8,
                          })
                        : "待同步"}
                    </td>
                    <td>
                      {m.low
                        ? m.low.toLocaleString("en-US", {
                            maximumFractionDigits: 8,
                          })
                        : "待同步"}
                    </td>
                    <td className={m.change >= 0 ? "positive" : "negative"}>
                      {m.price
                        ? `${m.change >= 0 ? "+" : ""}${m.change.toFixed(2)}%`
                        : "待同步"}
                    </td>
                    <td className="contract-minimum-cell">
                      <b className="mono">
                        市价 {formatQuantity(m.effectiveMarketMinOrderQty)}
                      </b>
                      <small>
                        限价 {formatQuantity(m.effectiveMinOrderQty)} · 交易所数量下限{" "}
                        {formatQuantity(m.minOrderQty)}
                      </small>
                    </td>
                    <td className="mono">{m.quantityStep}</td>
                    <td className="mono">
                      {m.maxLeverage ? `${m.maxLeverage}×` : "待同步"}
                    </td>
                    <td>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          disabled={
                            poolBusy === m.symbol ||
                            !can("trade:symbol_pool:edit")
                          }
                          onChange={() =>
                            void updateSymbolPool(m.symbol, {
                              isActive: !m.enabled,
                            })
                          }
                        />
                        <i></i>
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="table-remove-btn"
                        disabled={
                          poolBusy === m.symbol ||
                          !can("trade:symbol_pool:edit")
                        }
                        onClick={() => setRemoveTarget(m)}
                      >
                        移除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredPool.length === 0 && (
              <div className="empty">没有符合当前筛选条件的合约</div>
            )}
          </div>
        </section>
        {showAddSymbol && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="symbol-modal-title"
          >
            <div className="modal symbol-modal">
              <div className="config-title">
                <div>
                  <h2 id="symbol-modal-title">搜索添加合约</h2>
                  <p>从 Binance USDT 永续合约目录中选择，添加后开始参与策略扫描</p>
                </div>
                <button
                  aria-label="关闭"
                  onClick={() => setShowAddSymbol(false)}
                >
                  ×
                </button>
              </div>
              <div className="contract-catalog-search">
                <label>
                  <span>输入合约代码或名称</span>
                  <input
                    autoFocus
                    value={catalogQuery}
                    onChange={(event) => setCatalogQuery(event.target.value.toUpperCase())}
                    placeholder="例如 BTC、ETH、TSLA"
                  />
                </label>
                <div className="contract-catalog-results">
                  {!catalogQuery.trim() && (
                    <div className="empty">输入字母后显示可添加的 Binance 合约</div>
                  )}
                  {catalogQuery.trim() && catalogMatches.length === 0 && (
                    <div className="empty">未找到可添加合约；可先同步 Binance 合约目录</div>
                  )}
                  {catalogMatches.map((item) => (
                    <div className="contract-catalog-row" key={item.symbol}>
                      <div>
                        <b>{item.symbol}</b>
                        <small>
                          {item.name} · 市价最小量{" "}
                          {formatQuantity(item.effectiveMarketMinOrderQty)} · 限价{" "}
                          {formatQuantity(item.effectiveMinOrderQty)}
                        </small>
                      </div>
                      <span>
                        {item.price > 0 ? item.price.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "待同步"}
                      </span>
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={poolBusy === "CREATE"}
                        onClick={() => void createSymbol(item.symbol)}
                      >
                        添加
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="config-actions">
                <button onClick={() => setShowAddSymbol(false)}>取消</button>
                <span>实际最小量按 Binance 名义金额、最新价和数量步长实时计算</span>
              </div>
            </div>
          </div>
        )}
        {removeTarget && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-symbol-title"
          >
            <div className="modal symbol-remove-modal">
              <div className="config-title">
                <div>
                  <h2 id="remove-symbol-title">移除 {removeTarget.symbol}？</h2>
                  <p>移除后停止新策略扫描和新交易；已有仓位、挂单及历史记录不会删除，仓位保护继续运行。</p>
                </div>
                <button aria-label="关闭" onClick={() => setRemoveTarget(null)}>×</button>
              </div>
              <div className="config-actions">
                <button onClick={() => setRemoveTarget(null)}>取消</button>
                <button
                  className="danger-btn"
                  disabled={poolBusy === removeTarget.symbol}
                  onClick={async () => {
                    await removeSymbol(removeTarget.symbol);
                    setRemoveTarget(null);
                  }}
                >
                  {poolBusy === removeTarget.symbol ? "移除中…" : "确认移除"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
}

