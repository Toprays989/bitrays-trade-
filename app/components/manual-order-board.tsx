"use client";

/* eslint-disable react-hooks/set-state-in-effect -- board state mirrors local draft, pool hydration, and polling responses. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClientRequestId, readJsonResponse } from "../client/runtime";
import type {
  ExchangeCredential,
  TradingAccount,
} from "../client/workspace-model";
import type { ContractPoolItem } from "./contract-pool-view";

type Side = "LONG" | "SHORT";
type ChartInterval = "1m" | "5m" | "15m" | "1h";
type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
};
type Position = {
  positionSide: Side;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  status: string;
};
type MarketRow = {
  symbol: string;
  rule: {
    displayName?: string;
    price?: number;
    change?: number;
    high?: number;
    low?: number;
    minOrderQty: number;
    quantityStep: number;
    minNotionalUsdt: number;
    maxLeverage?: number | null;
  } | null;
  candles: Candle[];
  markPrice: number;
  fundingRate: number | null;
  receivedAt: number | null;
  positions: Position[];
  error: string | null;
  chartError?: string | null;
  ruleError?: string | null;
};
type WindowConfig = {
  symbol: string;
  notionalUsdt: number;
  leverage: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingEnabled: boolean;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
  interval: ChartInterval;
};

const STORAGE_KEY = "nexus.manual-order-board.v1";
const EMPTY_CONFIG: WindowConfig = {
  symbol: "",
  notionalUsdt: 20,
  leverage: 3,
  takeProfitPercent: 4,
  stopLossPercent: 8,
  trailingEnabled: false,
  trailingActivationPercent: 2,
  trailingDrawdownPercent: 1,
  interval: "1m",
};

function defaultConfigs() {
  return Array.from({ length: 6 }, () => ({ ...EMPTY_CONFIG }));
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function loadStoredConfigs(): WindowConfig[] {
  if (typeof window === "undefined") return defaultConfigs();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(parsed)) return defaultConfigs();
    return defaultConfigs().map((fallback, index) => {
      const value = parsed[index];
      if (!value || typeof value !== "object") return fallback;
      const source = value as Record<string, unknown>;
      return {
        ...fallback,
        symbol: typeof source.symbol === "string" ? source.symbol.toUpperCase() : "",
        notionalUsdt: finiteNumber(source.notionalUsdt, fallback.notionalUsdt),
        leverage: Math.max(1, Math.round(finiteNumber(source.leverage, fallback.leverage))),
        takeProfitPercent: Math.max(0.1, finiteNumber(source.takeProfitPercent, fallback.takeProfitPercent)),
        stopLossPercent: Math.max(0.1, finiteNumber(source.stopLossPercent, fallback.stopLossPercent)),
        trailingEnabled: source.trailingEnabled === true,
        trailingActivationPercent: Math.max(0.1, finiteNumber(source.trailingActivationPercent, fallback.trailingActivationPercent)),
        trailingDrawdownPercent: Math.max(0.1, finiteNumber(source.trailingDrawdownPercent, fallback.trailingDrawdownPercent)),
        interval: ["1m", "5m", "15m", "1h"].includes(String(source.interval))
          ? source.interval as ChartInterval
          : fallback.interval,
      };
    });
  } catch {
    return defaultConfigs();
  }
}

function roundUpQuantity(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0)
    return 0;
  const stepText = String(step).toLowerCase();
  const exponent = stepText.includes("e") ? Number(stepText.split("e")[1]) : 0;
  const precision = Math.max(
    0,
    Math.min(18, (stepText.split(".")[1]?.split("e")[0] ?? "").length - exponent),
  );
  return Number((Math.ceil((value - 1e-12) / step) * step).toFixed(precision));
}

function aggregateCandles(candles: Candle[], interval: ChartInterval) {
  const bucket = interval === "1m" ? 60_000 : interval === "5m" ? 300_000 : interval === "15m" ? 900_000 : 3_600_000;
  const groups = new Map<number, Candle>();
  for (const candle of candles) {
    const key = Math.floor(candle.openTime / bucket) * bucket;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...candle, openTime: key });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.quoteVolume += candle.quoteVolume;
  }
  const sorted = [...groups.values()].sort((a, b) => a.openTime - b.openTime);
  if (sorted.length < 2) return sorted;

  // Binance may omit empty time buckets. Fill only gaps between the first and
  // last real candle with a zero-volume carry-forward candle so hourly views
  // remain continuous without fabricating a new price beyond observed data.
  const continuous: Candle[] = [sorted[0]];
  for (const candle of sorted.slice(1)) {
    const previous = continuous[continuous.length - 1];
    for (let openTime = previous.openTime + bucket; openTime < candle.openTime; openTime += bucket) {
      const close = previous.close;
      continuous.push({ openTime, open: close, high: close, low: close, close, volume: 0, quoteVolume: 0 });
    }
    continuous.push(candle);
  }
  return continuous;
}

function formatPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 100) return value.toFixed(3);
  if (value >= 10) return value.toFixed(4);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.1) return value.toFixed(6);
  if (value >= 0.01) return value.toFixed(7);
  return value.toPrecision(8);
}

function formatPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) return "—";
  return `${value! >= 0 ? "+" : ""}${value!.toFixed(2)}%`;
}

function MiniCandleChart({
  candles,
  interval,
  markPrice,
}: {
  candles: Candle[];
  interval: ChartInterval;
  markPrice: number;
}) {
  const [pan, setPan] = useState(0);
  const [dragX, setDragX] = useState<number | null>(null);
  // Repaint the latest candle from the 2-second mark-price snapshot. This
  // keeps the current candle visually live without issuing extra kline calls.
  const liveCandles = candles.length && Number.isFinite(markPrice) && markPrice > 0
    ? candles.map((candle, index) => {
        if (index !== candles.length - 1) return candle;
        return {
          ...candle,
          high: Math.max(candle.high, markPrice),
          low: Math.min(candle.low, markPrice),
          close: markPrice,
        };
      })
    : candles;
  const points = aggregateCandles(liveCandles, interval);
  const visibleCount = interval === "1m" ? 60 : interval === "5m" ? 48 : interval === "15m" ? 36 : 24;
  const maxPan = Math.max(0, points.length - visibleCount);
  const safePan = Math.min(pan, maxPan);
  const end = Math.max(visibleCount, points.length - safePan);
  const visible = points.slice(Math.max(0, end - visibleCount), end);

  useEffect(() => {
    setPan(0);
    setDragX(null);
  }, [interval, candles.length, candles[0]?.openTime, candles.at(-1)?.openTime]);

  if (!visible.length) return null;

  const width = 620;
  const height = 320;
  // Candles use the full left side and intentionally stop before the right
  // price-axis area, matching the reference layout: only the latest-candle
  // side has a visual blank region.
  const plotLeft = 2;
  const plotRight = width - 142;
  const gridRight = width - 32;
  const axisX = width - 8;
  // Keep a dedicated header strip for the enlarged mark-price label. The
  // visible price range must start below it so a high wick cannot be hidden
  // behind the label when the live mark price is near the session high.
  const plotTop = Math.max(62, Math.round(height * 0.2));
  const plotBottom = height - 44;
  const values = visible.flatMap((item) => [item.low, item.high]);
  if (Number.isFinite(markPrice) && markPrice > 0) values.push(markPrice);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(high - low, high * 0.0001, 1e-9);
  // Keep more room above the latest wick because the live mark label occupies
  // the chart header strip. A smaller bottom margin preserves price detail
  // while preventing a strong candle from being pinned to the top edge.
  const topPadding = Math.max(range * 0.12, high * 0.00005);
  const bottomPadding = Math.max(range * 0.07, high * 0.00003);
  const paddedLow = low - bottomPadding;
  const paddedHigh = high + topPadding;
  const paddedRange = paddedHigh - paddedLow;
  const x = (index: number) => plotLeft + (index / Math.max(visible.length - 1, 1)) * (plotRight - plotLeft);
  const y = (price: number) => plotTop + (1 - (price - paddedLow) / paddedRange) * (plotBottom - plotTop);
  const tickValues = Array.from({ length: 7 }, (_, index) => paddedHigh - (paddedRange * index) / 6);
  const candleWidth = Math.max(2.2, Math.min(interval === "1h" ? 14 : 9, (plotRight - plotLeft) / Math.max(visible.length, 1) * 0.68));
  const timeTickCount = Math.min(interval === "1h" ? 8 : 6, visible.length);
  const timeIndexes = [...new Set(Array.from(
    { length: timeTickCount },
    (_, index) => Math.round(index * (visible.length - 1) / Math.max(timeTickCount - 1, 1)),
  ))];
  const markAnchor = candles.at(-1)?.close ?? markPrice;
  const markIsUp = markPrice >= markAnchor;

  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragX(event.clientX);
  }
  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (dragX === null || !maxPan) return;
    const pixelsPerCandle = (plotRight - plotLeft) / Math.max(visible.length - 1, 1);
    const delta = Math.round((dragX - event.clientX) / Math.max(pixelsPerCandle, 1));
    if (delta !== 0) {
      setPan((current) => Math.max(0, Math.min(maxPan, current + delta)));
      setDragX(event.clientX);
    }
  }
  function stopDragging() {
    setDragX(null);
  }

  return (
    <div className="manual-board-chart-scroll">
      <svg
        className={`manual-board-chart${dragX === null ? "" : " is-dragging"}`}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="实时标记价格K线"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        {tickValues.map((value, index) => (
          <g key={`tick-${index}`}>
            <line x1={plotLeft} x2={gridRight} y1={y(value)} y2={y(value)} className="manual-board-chart-grid" />
            <text x={axisX} y={y(value) + 4} textAnchor="end" className="manual-board-chart-axis-label">{formatPrice(value)}</text>
          </g>
        ))}
        {visible.map((item, index) => {
          const candleX = x(index);
          const bodyTop = y(Math.max(item.open, item.close));
          const bodyBottom = y(Math.min(item.open, item.close));
          const rising = item.close >= item.open;
          return (
            <g key={item.openTime} className={rising ? "is-up" : "is-down"}>
              <line x1={candleX} x2={candleX} y1={y(item.high)} y2={y(item.low)} />
              <rect x={Math.max(plotLeft, candleX - candleWidth / 2)} y={bodyTop} width={candleWidth} height={Math.max(1.5, bodyBottom - bodyTop)} />
            </g>
          );
        })}
        {Number.isFinite(markPrice) && markPrice > 0 && markPrice >= paddedLow && markPrice <= paddedHigh && (
          <g className={`manual-board-mark-line ${markIsUp ? "is-up" : "is-down"}`}>
            <line x1={plotLeft} x2={gridRight} y1={y(markPrice)} y2={y(markPrice)} />
            <text
              x={axisX - 4}
              y="18"
              textAnchor="end"
              dominantBaseline="middle"
              className="manual-board-mark-label"
            >
              标记价格：{formatPrice(markPrice)}
            </text>
          </g>
        )}
        {timeIndexes.map((index) => (
          <text key={`time-${visible[index].openTime}`} x={x(index)} y={height - 8} textAnchor={index === 0 ? "start" : index === visible.length - 1 ? "end" : "middle"} className="manual-board-chart-time-label">
            {new Date(visible[index].openTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function ManualOrderBoard({
  tradingAccounts,
  exchangeCredentials,
  selectedAccountId,
  setSelectedAccountId,
  pool,
  setToast,
}: {
  tradingAccounts: TradingAccount[];
  exchangeCredentials: ExchangeCredential[];
  selectedAccountId: string;
  setSelectedAccountId: (value: string) => void;
  pool: ContractPoolItem[];
  setToast: (value: string) => void;
}) {
  const [windowCount, setWindowCount] = useState<4 | 5 | 6>(6);
  const [columns, setColumns] = useState<2 | 3>(3);
  const [fullScreen, setFullScreen] = useState(false);
  const [configs, setConfigs] = useState<WindowConfig[]>(defaultConfigs);
  const [configsHydrated, setConfigsHydrated] = useState(false);
  const [rows, setRows] = useState<Record<string, MarketRow>>({});
  const [clockNow, setClockNow] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [settingsIndex, setSettingsIndex] = useState<number | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<WindowConfig | null>(null);
  const requestBusy = useRef(false);
  const quoteBusy = useRef(false);

  const eligibleAccounts = useMemo(
    () => tradingAccounts.filter((account) => account.accountType !== "MAIN" && account.isActive),
    [tradingAccounts],
  );
  const selectedAccount = useMemo(
    () => eligibleAccounts.find((account) => account.accountId === selectedAccountId) ?? null,
    [eligibleAccounts, selectedAccountId],
  );
  const credential = useMemo(
    () => exchangeCredentials.find((item) => item.accountId === selectedAccountId) ?? null,
    [exchangeCredentials, selectedAccountId],
  );
  const symbols = useMemo(
    () => configs.slice(0, windowCount).map((config) => config.symbol.trim().toUpperCase()).filter(Boolean),
    [configs, windowCount],
  );
  const symbolKey = symbols.join(",");

  useEffect(() => {
    setConfigs(loadStoredConfigs());
    setConfigsHydrated(true);
  }, []);

  useEffect(() => {
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onFullScreenChange = () => setFullScreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onFullScreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullScreenChange);
  }, []);

  useEffect(() => {
    if (!selectedAccountId && eligibleAccounts[0]) setSelectedAccountId(eligibleAccounts[0].accountId);
  }, [eligibleAccounts, selectedAccountId, setSelectedAccountId]);

  useEffect(() => {
    if (!pool.length) return;
    setConfigs((current) => {
      let changed = false;
      const used = new Set(current.map((config) => config.symbol).filter(Boolean));
      const next = current.map((config) => {
        if (config.symbol || !pool.find((item) => item.enabled)) return config;
        const target = pool.find((item) => item.enabled && !used.has(item.symbol));
        if (!target) return config;
        changed = true;
        used.add(target.symbol);
        return { ...config, symbol: target.symbol };
      });
      return changed ? next : current;
    });
  }, [pool]);

  useEffect(() => {
    if (!configsHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  }, [configs, configsHydrated]);

  const refreshBoard = useCallback(async () => {
    if (!symbolKey || requestBusy.current) return;
    requestBusy.current = true;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/control/manual-board?symbols=${encodeURIComponent(symbolKey)}&accountId=${encodeURIComponent(selectedAccountId)}&includeCandles=0`,
        { cache: "no-store" },
      );
      const result = await readJsonResponse(response) as { rows?: MarketRow[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "合约行情加载失败");
      setRows((current) => Object.fromEntries((result.rows ?? []).map((row) => {
        const previous = current[row.symbol];
        return [row.symbol, {
          ...previous,
          ...row,
          candles: previous?.candles ?? row.candles,
          chartError: previous?.chartError ?? null,
        }];
      })));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "合约行情加载失败");
    } finally {
      requestBusy.current = false;
      setLoading(false);
    }
  }, [selectedAccountId, setToast, symbolKey]);

  const refreshCandles = useCallback(async () => {
    if (!symbolKey) return;
    try {
      const response = await fetch(`/api/control/manual-board/klines?symbols=${encodeURIComponent(symbolKey)}`, { cache: "no-store" });
      const result = await readJsonResponse(response) as { rows?: Array<{ symbol: string; candles: Candle[]; error?: string | null }> };
      if (!response.ok || !Array.isArray(result.rows)) return;
      setRows((current) => {
        const next = { ...current };
        for (const row of result.rows ?? []) {
          const previous = next[row.symbol];
          if (!previous) continue;
          next[row.symbol] = {
            ...previous,
            candles: row.candles.length ? row.candles : previous.candles,
            chartError: row.error ?? null,
          };
        }
        return next;
      });
    } catch {
      // Keep the last valid candles on a transient refresh failure.
    }
  }, [symbolKey]);

  const refreshQuotes = useCallback(async () => {
    if (!symbolKey || quoteBusy.current) return;
    quoteBusy.current = true;
    try {
      const response = await fetch(`/api/control/manual-board/quotes?symbols=${encodeURIComponent(symbolKey)}`, { cache: "no-store" });
      const result = await readJsonResponse(response) as { rows?: Array<{ symbol: string; markPrice: number; fundingRate?: number | null; receivedAt?: number | null; time?: number | null }>; };
      if (!response.ok || !Array.isArray(result.rows)) return;
      setRows((current) => {
        const next = { ...current };
        for (const quote of result.rows ?? []) {
          const row = next[quote.symbol];
          if (!row) continue;
          next[quote.symbol] = {
            ...row,
            markPrice: quote.markPrice,
            fundingRate: quote.fundingRate ?? null,
            receivedAt: quote.receivedAt ?? quote.time ?? null,
          };
        }
        return next;
      });
    } finally {
      quoteBusy.current = false;
    }
  }, [symbolKey]);

  useEffect(() => {
    void refreshBoard();
    void refreshCandles();
    const boardTimer = window.setInterval(() => void refreshBoard(), 30_000);
    const candleTimer = window.setInterval(() => void refreshCandles(), 30_000);
    // Mark prices come from the server-side WebSocket snapshot, so this is a
    // lightweight refresh and keeps intraminute movement visible.
    const quoteTimer = window.setInterval(() => void refreshQuotes(), 2_000);
    return () => {
      window.clearInterval(boardTimer);
      window.clearInterval(candleTimer);
      window.clearInterval(quoteTimer);
    };
  }, [refreshBoard, refreshCandles, refreshQuotes]);

  function updateConfig(index: number, patch: Partial<WindowConfig>) {
    setConfigs((current) => current.map((config, itemIndex) => itemIndex === index ? { ...config, ...patch } : config));
  }

  function openSettings(index: number) {
    setSettingsIndex(index);
    setSettingsDraft({ ...configs[index] });
  }

  function updateSettingsDraft(patch: Partial<WindowConfig>) {
    setSettingsDraft((current) => current ? { ...current, ...patch } : current);
  }

  function saveSettings() {
    if (settingsIndex === null || !settingsDraft) return;
    setConfigs((current) => current.map((config, index) => index === settingsIndex ? settingsDraft : config));
    setSettingsIndex(null);
    setSettingsDraft(null);
  }

  async function toggleFullScreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector<HTMLElement>(".manual-board-page")?.requestFullscreen();
    } catch {
      setFullScreen((current) => !current);
    }
  }

  function accountBlocker() {
    if (!selectedAccount) return "请选择可交易子账户";
    if (!credential) return "账户尚未绑定 Binance 密钥";
    if (!selectedAccount.tradeReadiness.liveReady) return selectedAccount.tradeReadiness.blockers.join("；") || "账户未达到实盘就绪条件";
    if (!credential.liveTradingEnabled) return "账户实盘开关未启用";
    return "";
  }

  async function submitCard(index: number, side: Side) {
    const config = configs[index];
    const symbol = config.symbol.trim().toUpperCase();
    const row = rows[symbol];
    const price = row?.markPrice || row?.rule?.price || 0;
    const step = row?.rule?.quantityStep ?? 0;
    const quantity = roundUpQuantity(config.notionalUsdt / Math.max(price, 1e-12), step);
    const leverage = Math.round(config.leverage);
    const blocker = accountBlocker();
    if (blocker) return setToast(blocker);
    if (!row?.rule || !price || !quantity) return setToast(`${symbol || "该合约"} 实时行情或交易规则尚未就绪`);
    if (!pool.some((item) => item.enabled && item.symbol === symbol)) return setToast(`${symbol} 尚未加入合约池，请先在合约池管理启用`);
    if (config.notionalUsdt <= 0) return setToast("下单金额必须大于 0 USDT");
    if (quantity * price < row.rule.minNotionalUsdt - 1e-8) return setToast(`${symbol} 名义价值低于交易所最小下单金额 ${row.rule.minNotionalUsdt} USDT`);
    if (!Number.isInteger(config.leverage) || leverage < 1) return setToast("杠杆必须为大于等于 1 的整数，由 Binance 按合约档位校验上限");
    const confirmation = `LIVE ${selectedAccountId} ${symbol} ${side === "LONG" ? "BUY" : "SELL"} ${quantity}`;
    const action = side === "LONG" ? "做多" : "做空";
    setSubmitting(index);
    try {
      const response = await fetch("/api/control/live-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId: credential!.id,
          symbol,
          positionSide: side,
          orderType: "MARKET",
          quantity,
          leverage,
          takeProfitPlan: [{ triggerPercent: config.takeProfitPercent, closePercent: 100, closeQuantity: quantity }],
          stopLossPlan: [{ triggerPercent: config.stopLossPercent, closePercent: 100, closeQuantity: quantity }],
          capitalPreservationStopRoePercent: config.stopLossPercent,
          trailingActivationPercent: config.trailingEnabled ? config.trailingActivationPercent : 0,
          trailingStopPercent: config.trailingEnabled ? config.trailingDrawdownPercent : 0,
          confirmation,
          idempotencyKey: createClientRequestId().replaceAll("-", ""),
        }),
      });
      const result = await readJsonResponse(response) as { error?: string; clientOrderId?: string; pending?: boolean };
      if (!response.ok) throw new Error(result.error ?? "订单提交失败");
      setToast(`${symbol} ${action}已提交统一执行链${result.clientOrderId ? `：${result.clientOrderId}` : ""}，请到订单与仓位列表确认`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "订单提交失败");
    } finally {
      setSubmitting(null);
    }
  }

  const boardBlocker = accountBlocker();
  return (
    <div className={`manual-board-page columns-${columns}${fullScreen ? " is-fullscreen" : ""}`}>
      <header className="manual-board-topbar">
        <div>
          <span className="manual-board-eyebrow">CONTRACT GRID</span>
          <h2>独立合约控制台</h2>
          <p>只负责人工下单；订单成交后自动进入平台统一持仓、结算与收益链路</p>
        </div>
        <div className="manual-board-topbar-right">
          <span className="manual-board-live-dot"><i /> Binance 实时行情</span>
          <label>交易子账户
            <select value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)}>
              <option value="">请选择子账户</option>
              {eligibleAccounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountId} · {account.name}</option>)}
            </select>
          </label>
        </div>
      </header>
      <section className="manual-board-toolbar">
        <div className="manual-board-window-count">
          <span>窗口</span>
          {[4, 5, 6].map((count) => <button key={count} type="button" className={windowCount === count ? "is-active" : ""} onClick={() => setWindowCount(count as 4 | 5 | 6)}>{count}</button>)}
        </div>
        <div className="manual-board-window-count">
          <span>每行</span>
          {[2, 3].map((count) => <button key={count} type="button" className={columns === count ? "is-active" : ""} onClick={() => setColumns(count as 2 | 3)}>{count}列</button>)}
        </div>
        <div className="manual-board-account-summary">
          <span>可用保证金 <b>{selectedAccount ? `${selectedAccount.stats.availableMargin.toFixed(2)} USDT` : "—"}</b></span>
          <span>开放仓位 <b>{selectedAccount?.stats.openPositions ?? 0}</b></span>
          <span className={boardBlocker ? "is-blocked" : "is-ready"}>{boardBlocker ? `未就绪：${boardBlocker}` : "账户可提交"}</span>
        </div>
        <div className="manual-board-toolbar-actions">
          <button type="button" className="secondary-btn" onClick={() => void refreshBoard()} disabled={loading}>{loading ? "刷新中…" : "↻ 刷新行情"}</button>
          <button type="button" className="secondary-btn" onClick={() => void toggleFullScreen()}>{fullScreen ? "退出全屏" : "⛶ 全屏"}</button>
        </div>
      </section>
      <div className="manual-board-grid">
        {configs.slice(0, windowCount).map((config, index) => {
          const symbol = config.symbol.trim().toUpperCase();
          const row = rows[symbol];
          const price = row?.markPrice || row?.rule?.price || 0;
          const quantity = row?.rule ? roundUpQuantity(config.notionalUsdt / Math.max(price, 1e-12), row.rule.quantityStep) : 0;
          const inPool = pool.some((item) => item.enabled && item.symbol === symbol);
          const disabled = Boolean(boardBlocker) || !symbol || !row?.rule || !quantity || !inPool || submitting !== null;
          const change = row?.rule?.change ?? null;
          return (
            <article className="manual-board-card" key={index}>
              <div className="manual-board-card-head">
                <div className="manual-board-symbol"><span>{symbol.slice(0, 1) || "?"}</span><div><strong>{symbol || "选择合约"}</strong><small>USDT 永续 · {row?.error ? "行情暂不可用" : row?.rule?.displayName || (row?.ruleError ? "合约规则同步中" : "等待行情")}</small></div></div>
                <span className="manual-board-card-live"><i /> LIVE</span>
              </div>
              <div className="manual-board-market-strip">
                <div><small>最新价格</small><b>{formatPrice(price)}</b></div>
                <div><small>标记价格</small><b className="is-mark">{formatPrice(row?.markPrice ?? 0)}</b></div>
                <div><small>资金费率</small><b>{formatPercent(row?.fundingRate == null ? null : row.fundingRate * 100)}</b></div>
                <div><small>24H 高 / 低</small><b>{formatPrice(row?.rule?.high ?? 0)} / {formatPrice(row?.rule?.low ?? 0)}</b></div>
                <div><small>24H 涨跌</small><b className={Number(change) >= 0 ? "is-up" : "is-down"}>{formatPercent(change)}</b></div>
              </div>
              <div className="manual-board-chart-wrap">
                <div className="manual-board-chart-tabs"><div>{(["1m", "5m", "15m", "1h"] as ChartInterval[]).map((interval) => <button type="button" key={interval} className={config.interval === interval ? "is-active" : ""} onClick={() => updateConfig(index, { interval })}>{interval}</button>)}</div><span>{row?.receivedAt && clockNow ? `${Math.max(0, clockNow - row.receivedAt)}ms` : "等待数据"}</span></div>
                <MiniCandleChart candles={row?.candles ?? []} interval={config.interval} markPrice={row?.markPrice ?? 0} />
                {!row?.candles?.length && <div className="manual-board-empty-chart">{row?.chartError ? `行情暂不可用：${row.chartError}` : row ? "正在异步同步 1m K 线" : "正在同步合约行情与持仓信息"}</div>}
              </div>
              <div className="manual-board-settings-row"><button type="button" className="manual-board-settings-btn" onClick={() => openSettings(index)}>⚙ 下单设置</button><span className="manual-board-settings-summary">金额 {config.notionalUsdt} USDT · 杠杆 {config.leverage}× · 止盈 {config.takeProfitPercent}% · 止损 {config.stopLossPercent}% · 移动止损 {config.trailingEnabled ? "开" : "关"} · 预计数量 <b>{quantity || "—"}</b> · 名义 {quantity && price ? `${(quantity * price).toFixed(2)} USDT` : "—"}</span><span className="manual-board-settings-validation">{!inPool && symbol ? "需先启用合约池" : row?.error || "统一执行链校验"}</span></div>
              <div className="manual-board-actions"><button type="button" className="manual-board-long" disabled={disabled} onClick={() => void submitCard(index, "LONG")}>↗ 做多</button><button type="button" className="manual-board-short" disabled={disabled} onClick={() => void submitCard(index, "SHORT")}>↘ 做空</button></div>
              <div className={`manual-board-position${!row || row.error ? " is-pending" : ""}`}>
                {row?.positions?.length
                  ? row.positions.map((position) => <span key={`${position.positionSide}-${position.quantity}`} className={position.positionSide === "LONG" ? "is-up" : "is-down"}>{position.positionSide === "LONG" ? "多" : "空"} {position.quantity} · 入场 {formatPrice(position.entryPrice)}</span>)
                  : !row
                    ? "正在同步持仓信息…"
                    : row.error
                      ? "行情未就绪，持仓信息等待同步"
                      : "当前无平台持仓"}
              </div>
            </article>
          );
        })}
      </div>
      <datalist id="manual-board-symbols">{pool.filter((item) => item.enabled).map((item) => <option value={item.symbol} key={item.symbol}>{item.name}</option>)}</datalist>
      <p className="manual-board-note">说明：点击做多或做空即按已保存设置提交统一执行链；图表为 Binance 公开 1 分钟 K 线聚合，标记价每 2 秒从服务端 WebSocket 快照刷新。窗口配置只保存在本浏览器草稿，不保存密钥。杠杆上限由 Binance 当前合约档位实时决定；服务端仍执行账户、权限、持仓互斥、最小数量、保证金和幂等校验。</p>
      {settingsDraft && settingsIndex !== null && <div className="manual-board-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSettingsIndex(null); setSettingsDraft(null); } }}>
        <section className="manual-board-modal" role="dialog" aria-modal="true" aria-labelledby="manual-board-settings-title">
          <div className="manual-board-modal-head"><div><span className="manual-board-eyebrow">ORDER SETTINGS</span><h3 id="manual-board-settings-title">窗口 {settingsIndex + 1} · 下单设置</h3></div><button type="button" aria-label="关闭设置" onClick={() => { setSettingsIndex(null); setSettingsDraft(null); }}>×</button></div>
          <div className="manual-board-modal-fields">
            <label><span>合约</span><input list="manual-board-symbols" value={settingsDraft.symbol} onChange={(event) => updateSettingsDraft({ symbol: event.target.value.toUpperCase() })} placeholder="BTCUSDT" /></label>
            <label><span>下单金额 USDT</span><input type="number" min="1" step="0.1" value={settingsDraft.notionalUsdt} onChange={(event) => updateSettingsDraft({ notionalUsdt: finiteNumber(event.target.value, settingsDraft.notionalUsdt) })} /></label>
            <label><span>杠杆</span><input type="number" min="1" step="1" value={settingsDraft.leverage} onChange={(event) => updateSettingsDraft({ leverage: finiteNumber(event.target.value, settingsDraft.leverage) })} /></label>
            <label><span>止盈 %</span><input type="number" min="0.1" step="0.1" value={settingsDraft.takeProfitPercent} onChange={(event) => updateSettingsDraft({ takeProfitPercent: finiteNumber(event.target.value, settingsDraft.takeProfitPercent) })} /></label>
            <label><span>止损 %</span><input type="number" min="0.1" step="0.1" value={settingsDraft.stopLossPercent} onChange={(event) => updateSettingsDraft({ stopLossPercent: finiteNumber(event.target.value, settingsDraft.stopLossPercent) })} /></label>
            <label className="manual-board-toggle"><span>移动止损</span><button type="button" aria-pressed={settingsDraft.trailingEnabled} onClick={() => updateSettingsDraft({ trailingEnabled: !settingsDraft.trailingEnabled })}>{settingsDraft.trailingEnabled ? "已开启" : "关闭"}</button></label>
          </div>
          {settingsDraft.trailingEnabled && <div className="manual-board-trailing modal-trailing"><label>激活 <input type="number" min="0.1" step="0.1" value={settingsDraft.trailingActivationPercent} onChange={(event) => updateSettingsDraft({ trailingActivationPercent: Math.max(0.1, finiteNumber(event.target.value, settingsDraft.trailingActivationPercent)) })} />%</label><label>回退 <input type="number" min="0.1" step="0.1" value={settingsDraft.trailingDrawdownPercent} onChange={(event) => updateSettingsDraft({ trailingDrawdownPercent: Math.max(0.1, finiteNumber(event.target.value, settingsDraft.trailingDrawdownPercent)) })} />%</label><span>按峰值回撤触发</span></div>}
          <div className="manual-board-modal-actions"><button type="button" className="secondary-btn" onClick={() => { setSettingsIndex(null); setSettingsDraft(null); }}>取消</button><button type="button" className="primary-btn" onClick={saveSettings}>保存设置</button></div>
        </section>
      </div>}
    </div>
  );
}
