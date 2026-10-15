"use client";

/* eslint-disable react-hooks/set-state-in-effect -- Tabs initialize from the asynchronously loaded live contract pool. */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { readJsonResponse } from "../client/runtime";
import type { ContractPoolItem } from "./contract-pool-view";
import {
  ManualMarketHistoryChart,
  type ManualMarketHistoryPoint,
} from "./manual-market-history-chart";

type MarketHistoryViewProps = {
  markets: ContractPoolItem[];
  refreshVersion: number;
  marketStatus: {
    reachable: boolean;
    error: string | null;
    updatedAt: string;
  } | null;
};

type MarketTab = {
  id: number;
  symbol: string;
  query: string;
};

type HistoryState = {
  points: ManualMarketHistoryPoint[];
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
};

const EMPTY_HISTORY: HistoryState = {
  points: [],
  loading: false,
  error: null,
  updatedAt: null,
};
const MARKET_TABS_STORAGE_KEY = "nexus-quant-market-history-tabs-v1";

function storedTabs(value: unknown): MarketTab[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tabs = (value as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs) || tabs.length < 1 || tabs.length > 8) return null;
  const normalized = tabs.map((tab) => {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return null;
    const source = tab as Partial<MarketTab>;
    const id = Number(source.id);
    if (!Number.isInteger(id) || id < 1) return null;
    return {
      id,
      symbol: typeof source.symbol === "string" ? source.symbol : "",
      query: typeof source.query === "string" ? source.query : "",
    };
  });
  if (normalized.some((tab) => tab === null)) return null;
  const valid = normalized as MarketTab[];
  if (new Set(valid.map((tab) => tab.id)).size !== valid.length) return null;
  return valid;
}

function marketVolume(market: ContractPoolItem) {
  const value = Number(market.volume);
  return Number.isFinite(value) ? value : 0;
}

function initialSymbols(markets: ContractPoolItem[]) {
  const enabled = markets.filter((market) => market.enabled);
  const priority = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]
    .map((symbol) => enabled.find((market) => market.symbol === symbol))
    .filter((market): market is ContractPoolItem => Boolean(market));
  const remaining = [...enabled]
    .sort((left, right) => marketVolume(right) - marketVolume(left))
    .filter(
      (market) => !priority.some((item) => item.symbol === market.symbol),
    );
  return [...priority, ...remaining].slice(0, 4).map((market) => market.symbol);
}

function formatPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "--";
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function MarketHistoryView({
  markets,
  refreshVersion,
  marketStatus,
}: MarketHistoryViewProps) {
  const [tabs, setTabs] = useState<MarketTab[]>([
    { id: 1, symbol: "", query: "" },
  ]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [historyBySymbol, setHistoryBySymbol] = useState<
    Record<string, HistoryState>
  >({});
  const [queryError, setQueryError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [storageReady, setStorageReady] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const initializedRef = useRef(false);
  const nextTabIdRef = useRef(2);

  const enabledMarkets = useMemo(
    () => markets.filter((market) => market.enabled),
    [markets],
  );
  const marketBySymbol = useMemo(
    () => new Map(enabledMarkets.map((market) => [market.symbol, market])),
    [enabledMarkets],
  );
  const activeTab =
    tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const activeMarket = activeTab?.symbol
    ? marketBySymbol.get(activeTab.symbol) ?? null
    : null;
  const activeHistory = activeTab?.symbol
    ? historyBySymbol[activeTab.symbol] ?? EMPTY_HISTORY
    : EMPTY_HISTORY;

  useEffect(() => {
    try {
      const stored = JSON.parse(
        window.localStorage.getItem(MARKET_TABS_STORAGE_KEY) ?? "null",
      ) as { tabs?: unknown; activeTabId?: unknown } | null;
      const restoredTabs = storedTabs(stored);
      if (restoredTabs) {
        const restoredActiveId = Number(stored?.activeTabId);
        setTabs(restoredTabs);
        setActiveTabId(
          restoredTabs.some((tab) => tab.id === restoredActiveId)
            ? restoredActiveId
            : restoredTabs[0].id,
        );
        nextTabIdRef.current = Math.max(...restoredTabs.map((tab) => tab.id)) + 1;
        initializedRef.current = true;
        setPersistenceReady(true);
      }
    } catch {
      window.localStorage.removeItem(MARKET_TABS_STORAGE_KEY);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (
      !storageReady ||
      initializedRef.current ||
      enabledMarkets.length === 0
    )
      return;
    const symbols = initialSymbols(enabledMarkets);
    if (!symbols.length) return;
    const initialTabs = symbols.map((symbol, index) => ({
      id: index + 1,
      symbol,
      query: symbol,
    }));
    initializedRef.current = true;
    nextTabIdRef.current = initialTabs.length + 1;
    setTabs(initialTabs);
    setActiveTabId(initialTabs[0].id);
    setPersistenceReady(true);
  }, [enabledMarkets, storageReady]);

  useEffect(() => {
    if (!storageReady || !persistenceReady) return;
    window.localStorage.setItem(
      MARKET_TABS_STORAGE_KEY,
      JSON.stringify({ version: 1, tabs, activeTabId }),
    );
  }, [activeTabId, persistenceReady, storageReady, tabs]);

  useEffect(() => {
    const symbol = activeTab?.symbol;
    if (!symbol) return;
    const controller = new AbortController();
    setHistoryBySymbol((current) => ({
      ...current,
      [symbol]: {
        points: current[symbol]?.points ?? [],
        loading: true,
        error: null,
        updatedAt: current[symbol]?.updatedAt ?? null,
      },
    }));
    void fetch(
      `/api/control/symbols/history?symbol=${encodeURIComponent(symbol)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await readJsonResponse(response)) as {
          error?: string;
          points?: ManualMarketHistoryPoint[];
          updatedAt?: string;
        };
        if (!response.ok)
          throw new Error(result.error ?? "96小时合约走势加载失败");
        setHistoryBySymbol((current) => ({
          ...current,
          [symbol]: {
            points: result.points ?? [],
            loading: false,
            error: null,
            updatedAt: result.updatedAt ?? new Date().toISOString(),
          },
        }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setHistoryBySymbol((current) => ({
          ...current,
          [symbol]: {
            points: current[symbol]?.points ?? [],
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "96小时合约走势加载失败",
            updatedAt: current[symbol]?.updatedAt ?? null,
          },
        }));
      });
    return () => controller.abort();
  }, [activeTab?.symbol, refreshVersion, reloadVersion]);

  function updateActiveTabQuery(query: string) {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId ? { ...tab, query } : tab,
      ),
    );
    setQueryError(null);
  }

  function resolveMarket(query: string) {
    const normalized = query.trim().toUpperCase().replace(/\s+/g, "");
    if (!normalized) return null;
    const exact = enabledMarkets.find(
      (market) =>
        market.symbol.toUpperCase() === normalized ||
        market.name.trim().toUpperCase() === normalized,
    );
    if (exact) return exact;
    const matches = enabledMarkets.filter(
      (market) =>
        market.symbol.toUpperCase().includes(normalized) ||
        market.name.trim().toUpperCase().includes(normalized),
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function queryActiveTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTab) return;
    const market = resolveMarket(activeTab.query);
    if (!market) {
      setQueryError("未找到唯一的已启用合约，请输入完整合约代码，例如 BTCUSDT");
      return;
    }
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId
          ? { ...tab, symbol: market.symbol, query: market.symbol }
          : tab,
      ),
    );
    setQueryError(null);
    setReloadVersion((current) => current + 1);
  }

  function addTab() {
    if (tabs.length >= 8) {
      setQueryError("最多同时保留 8 个行情卡片");
      return;
    }
    const id = nextTabIdRef.current++;
    setTabs((current) => [...current, { id, symbol: "", query: "" }]);
    setActiveTabId(id);
    setQueryError(null);
  }

  function closeTab(tabId: number) {
    if (tabs.length === 1) {
      setTabs([{ id: tabs[0].id, symbol: "", query: "" }]);
      setQueryError(null);
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId) {
      setActiveTabId(nextTabs[Math.max(0, index - 1)]?.id ?? nextTabs[0].id);
    }
    setQueryError(null);
  }

  return (
    <div className="market-history-workspace">
      <section className="panel market-history-controls">
        <div className="panel-head">
          <div>
            <h2>多合约 96 小时行情</h2>
            <p>每个卡片独立选择合约；默认查看最新 48 小时，按住图表左右拖动可回看完整 96 小时</p>
          </div>
          <span
            className={marketStatus?.reachable ? "guard" : "source-tag danger-source"}
          >
            {marketStatus?.reachable
              ? `行情正常 · ${enabledMarkets.length} 个合约`
              : "行情连接异常"}
          </span>
        </div>

        <div className="market-history-tabs" role="tablist" aria-label="合约行情卡片">
          {tabs.map((tab, index) => {
            const market = tab.symbol ? marketBySymbol.get(tab.symbol) : null;
            return (
              <div
                className={`market-history-tab-card ${tab.id === activeTabId ? "active" : ""}`}
                key={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                  onClick={() => {
                    setActiveTabId(tab.id);
                    setQueryError(null);
                  }}
                >
                  <small>行情 {index + 1}</small>
                  <b>{tab.symbol || "点击查询合约"}</b>
                  <span>
                    {market ? formatPrice(market.price) : "输入合约名称"}
                    {market && (
                      <em className={market.change >= 0 ? "positive" : "negative"}>
                        {market.change >= 0 ? "+" : ""}
                        {market.change.toFixed(2)}%
                      </em>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="market-history-tab-close"
                  aria-label={`关闭行情 ${index + 1}`}
                  onClick={() => closeTab(tab.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="market-history-add-tab"
            onClick={addTab}
          >
            ＋ 新增行情卡
          </button>
        </div>

        <form className="market-history-query" onSubmit={queryActiveTab}>
          <label>
            <span>当前卡片合约</span>
            <input
              type="search"
              list="market-history-symbols"
              value={activeTab?.query ?? ""}
              placeholder="输入 BTCUSDT 或合约名称"
              onChange={(event) => updateActiveTabQuery(event.target.value)}
            />
          </label>
          <datalist id="market-history-symbols">
            {enabledMarkets.map((market) => (
              <option key={market.symbol} value={market.symbol}>
                {market.name}
              </option>
            ))}
          </datalist>
          <button type="submit" className="primary-btn">
            查询 96 小时行情
          </button>
          {activeTab?.symbol && (
            <button
              type="button"
              onClick={() => setReloadVersion((current) => current + 1)}
            >
              刷新当前卡片
            </button>
          )}
          {queryError && <small className="negative">{queryError}</small>}
        </form>
      </section>

      <ManualMarketHistoryChart
        symbol={activeTab?.symbol ?? ""}
        points={activeHistory.points}
        loading={activeHistory.loading}
        error={activeHistory.error}
        updatedAt={activeHistory.updatedAt}
      />
      {!activeMarket && activeTab?.symbol && (
        <div className="security-note market-history-pool-note">
          <b>合约池状态</b>
          <span>该合约当前不在已启用合约池，请重新查询其他合约。</span>
        </div>
      )}
    </div>
  );
}
