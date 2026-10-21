import { env } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import {
  normalizeLiveAccountPositionSnapshots,
  normalizeLivePositionSnapshot,
  type LivePositionRiskRow,
} from "./live-position-snapshot";
import {
  buildNexusWsOrderPlaceShadow,
  compareRestAndWsOrderSemantics,
} from "./nexus-ws-execution-shadow";
import { parseJsonPreservingIntegerFields } from "../deploy/json-integer-fields.mjs";
import { exchangeWriteTimeoutIsExecutionUnknown } from
  "./execution/exchange-write-timeout.ts";

const LIVE_BASE_URL = "https://fapi.binance.com";
const REQUEST_TIMEOUT_MS = 7_000;
const RESPONSE_BODY_TIMEOUT_MS = 7_000;
const SERVER_TIME_CACHE_MS = 30_000;
const SERVER_TIME_STALE_FALLBACK_MS = 15 * 60_000;
export const LOCAL_POSITION_MISSING_CODE = -90_001;
let serverTimeCache: {
  offset: number;
  latencyMs: number;
  expiresAt: number;
  observedAt: number;
} | null = null;
const leverageBracketCache = new Map<
  string,
  { maximumLeverage: number; expiresAt: number }
>();
const leverageBracketUniverseCache = new Map<
  string,
  { maximums: Map<string, number>; expiresAt: number }
>();
const LEVERAGE_BRACKET_CACHE_MS = 60 * 60_000;
const accountLeverageMaximumCache = new Map<
  string,
  { maximumLeverage: number; expiresAt: number }
>();
const ACCOUNT_LEVERAGE_MAXIMUM_CACHE_MS = 10 * 60_000;
const orderTradeCache = new Map<string, {
  trades: BinanceOrderTrade[];
  expiresAt: number;
}>();
const ORDER_TRADE_CACHE_MS = 10 * 60_000;
const ORDER_TRADE_CACHE_MAXIMUM_ENTRIES = 2_000;

function pruneLeverageCaches(now = Date.now()) {
  for (const [key, value] of leverageBracketCache)
    if (value.expiresAt <= now) leverageBracketCache.delete(key);
  for (const [key, value] of leverageBracketUniverseCache)
    if (value.expiresAt <= now) leverageBracketUniverseCache.delete(key);
  for (const [key, value] of accountLeverageMaximumCache)
    if (value.expiresAt <= now) accountLeverageMaximumCache.delete(key);
}

function proxyBaseUrl() {
  return (
    env as unknown as { NQ_BINANCE_PROXY_URL?: string }
  ).NQ_BINANCE_PROXY_URL?.replace(/\/$/, "");
}
function liveBaseUrl() {
  const proxy = proxyBaseUrl();
  return proxy ? `${proxy}/live` : LIVE_BASE_URL;
}

function marketSnapshotBaseUrl() {
  const proxy = proxyBaseUrl();
  if (!proxy)
    throw new BinanceLiveError(
      "系统统一 WebSocket 行情服务未配置",
      503,
    );
  return `${proxy}/market`;
}

export type BinanceProtectionVolatilityProfile = {
  symbol: string;
  windowDays: number;
  sampleDays: number;
  complete: boolean;
  averageRangePercent: number | null;
  medianRangePercent: number | null;
  p75RangePercent: number | null;
  maximumRangePercent: number | null;
  averageDownDayRangePercent: number | null;
  averageCloseChangePercent: number | null;
};

const protectionVolatilityCache = new Map<string, {
  profile: BinanceProtectionVolatilityProfile;
  expiresAt: number;
}>();

export async function getBinanceProtectionVolatilityProfile(
  symbol: string,
  options?: { days?: number; timeoutMs?: number },
) {
  const normalized = symbol.trim().toUpperCase();
  const days = Math.min(7, Math.max(3, Math.floor(Number(options?.days) || 7)));
  const cacheKey = `${normalized}:${days}`;
  const cached = protectionVolatilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;
  const query = new URLSearchParams({ symbols: normalized, days: String(days) });
  const response = await timedFetch(
    `${marketSnapshotBaseUrl()}/volatility?${query}`,
    { headers: { accept: "application/json" } },
    options?.timeoutMs,
  );
  const payload = await responseJson<{ rows?: BinanceProtectionVolatilityProfile[]; error?: string }>(
    response,
    "系统 WebSocket 波动率基线不可用",
  );
  const profile = Array.isArray(payload.rows) ? payload.rows[0] : undefined;
  if (!response.ok || !profile)
    throw new BinanceLiveError(payload.error ?? "系统 WebSocket 波动率基线不可用", response.status);
  const normalizedProfile = { ...profile, symbol: normalized, windowDays: days };
  protectionVolatilityCache.set(cacheKey, { profile: normalizedProfile, expiresAt: Date.now() + 5 * 60_000 });
  return normalizedProfile;
}

export class BinanceLiveError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly executionUnknown = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

function binanceLiveErrorMessage(code: number | undefined, message: string | undefined) {
  if (code === -5021)
    return "限价 FOK 成交失败：未能立即全部成交，Binance 已拒绝该委托且不会保留挂单";
  if (code === -4061)
    return "持仓方向与 Binance 账户模式不一致；系统已停止本次委托，请刷新账户模式后重试";
  return message ?? "Binance 实盘请求失败";
}

export type BinanceOrderTrade = {
  id: number;
  orderId: string;
  symbol: string;
  price: number;
  quantity: number;
  quoteQuantity: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  maker: boolean;
  time: number;
};

async function timedFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = fetch(url, {
    ...init,
    cache: "no-store",
    signal: controller.signal,
  });
  const hardTimeout = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new BinanceLiveError("Binance 实盘请求超时", 504));
    }, timeoutMs);
  });
  try {
    // Every proxy endpoint served here is live exchange state. Next/Workers
    // must never reuse a stale GET response, otherwise freshness retries keep
    // receiving the same expired book snapshot until the request gives up.
    // Some Worker-compatible runtimes do not reject fetch immediately after
    // AbortController.abort(). The hard race guarantees that a stalled request
    // cannot poison the shared Binance time promise and block every later
    // signed account/order request indefinitely.
    return await Promise.race([request, hardTimeout]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function responseJson<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    response.text(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void response.body?.cancel().catch(() => undefined);
        reject(new BinanceLiveError(
          `${fallbackMessage}：上游响应读取超时`,
          504,
        ));
      }, RESPONSE_BODY_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  if (!text.trim())
    throw new BinanceLiveError(
      `${fallbackMessage}：上游返回空响应`,
      response.ok ? 502 : response.status,
    );
  try {
    return parseJsonPreservingIntegerFields(text, ["orderId"]) as T;
  } catch {
    throw new BinanceLiveError(
      `${fallbackMessage}：上游返回格式异常`,
      response.ok ? 502 : response.status,
    );
  }
}

function hmacSha256Hex(secret: string, payload: string) {
  // The production runtime is Node.  A synchronous HMAC takes microseconds
  // and cannot leave a WebCrypto job pending forever between server-time
  // synchronization and the actual signed Binance request.  That exact gap
  // previously left account funding refreshes locked without ever issuing
  // /fapi/v3/account.
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function serverTime(protectiveClose = false) {
  if (serverTimeCache && serverTimeCache.expiresAt > Date.now())
    return { offset: serverTimeCache.offset, latencyMs: serverTimeCache.latencyMs };
  try {
    // Cache only the resolved clock. An in-flight fetch Promise is bound to
    // the Worker request that created it and cannot be joined by another one.
    const clock = await fetchServerTime(protectiveClose);
    serverTimeCache = {
      ...clock,
      expiresAt: Date.now() + SERVER_TIME_CACHE_MS,
      observedAt: Date.now(),
    };
    return clock;
  } catch (error) {
    if (
      serverTimeCache &&
      Date.now() - serverTimeCache.observedAt <= SERVER_TIME_STALE_FALLBACK_MS
    ) {
      return {
        offset: serverTimeCache.offset,
        latencyMs: serverTimeCache.latencyMs,
      };
    }
    throw error;
  }
}

async function fetchServerTime(protectiveClose = false) {
  const startedAt = Date.now();
  const response = await timedFetch(`${liveBaseUrl()}/fapi/v1/time`, {
    headers: protectiveClose ? { "x-nq-protective-close": "1" } : undefined,
  });
  const payload = await responseJson<{
    serverTime: number;
    code?: number;
    msg?: string;
  }>(response, "Binance 实盘时间服务不可用");
  if (!response.ok || !Number.isFinite(Number(payload.serverTime)))
    throw new BinanceLiveError(
      payload.msg ?? "Binance 实盘时间服务不可用",
      response.status,
      payload.code,
    );
  return {
    offset: Number(payload.serverTime) - Date.now(),
    latencyMs: Date.now() - startedAt,
  };
}

export async function liveTickerPrice(symbol: string) {
  const response = await timedFetch(
    `${marketSnapshotBaseUrl()}/ticker?symbol=${encodeURIComponent(symbol)}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<{
    ticker?: { lastPrice?: number };
    error?: string;
    code?: number;
    msg?: string;
  }>(response, "无法取得系统 WebSocket 实盘价格");
  const price = Number(payload.ticker?.lastPrice);
  if (!response.ok || !Number.isFinite(price) || price <= 0)
    throw new BinanceLiveError(
      payload.error ?? payload.msg ?? "无法取得系统 WebSocket 实盘价格",
      response.status,
      payload.code,
    );
  return price;
}

export async function getBinanceLiveKlines(
  symbol: string,
  interval = "5m",
  limit = 21,
  options: { includeCurrent?: boolean } = {},
) {
  const intervalMs = {
    "1m": 60_000,
    "3m": 3 * 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
  }[interval];
  const query = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (!options.includeCurrent && intervalMs)
    query.set("endTime", String(Math.floor(Date.now() / intervalMs) * intervalMs - 1));
  const response = await timedFetch(
    `${liveBaseUrl()}/fapi/v1/klines?${query.toString()}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<
    | Array<
        [
          number,
          string,
          string,
          string,
          string,
          string,
          number,
          string,
        ]
      >
    | { code?: number; msg?: string }
  >(response, "Binance 实盘K线行情不可用");
  if (!response.ok || !Array.isArray(payload))
    throw new BinanceLiveError(
      !Array.isArray(payload) && payload.msg
        ? payload.msg
        : "Binance 实盘K线行情不可用",
      response.status,
      !Array.isArray(payload) ? payload.code : undefined,
    );
  return payload.map((row) => ({
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    quoteVolume: Number(row[7]),
  }));
}

export async function getBinanceLiveMarkPriceKlines(
  symbol: string,
  interval = "1h",
  limit = 25,
) {
  const intervalMs = {
    "1m": 60_000,
    "3m": 3 * 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
  }[interval];
  const query = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (intervalMs)
    query.set("endTime", String(Math.floor(Date.now() / intervalMs) * intervalMs - 1));
  const response = await timedFetch(
    `${liveBaseUrl()}/fapi/v1/markPriceKlines?${query.toString()}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<
    | Array<[number, string, string, string, string]>
    | { code?: number; msg?: string }
  >(response, "Binance 标记价格K线不可用");
  if (!response.ok || !Array.isArray(payload))
    throw new BinanceLiveError(
      !Array.isArray(payload) && payload.msg
        ? payload.msg
        : "Binance 标记价格K线不可用",
      response.status,
      !Array.isArray(payload) ? payload.code : undefined,
    );
  return payload.map((row) => ({
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: 0,
  }));
}

type BinanceRatioPoint = {
  timestamp: number;
  longShortRatio?: string;
  buySellRatio?: string;
  sumOpenInterestValue?: string;
};

export async function getBinanceLiveOpenInterestHistory(
  symbol: string,
  period = "1h",
  limit = 48,
) {
  const query = new URLSearchParams({
    symbol: symbol.trim().toUpperCase(),
    period,
    limit: String(Math.min(500, Math.max(1, Math.trunc(limit)))),
  });
  const response = await timedFetch(
    `${liveBaseUrl()}/futures/data/openInterestHist?${query.toString()}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<
    | BinanceRatioPoint[]
    | { code?: number; msg?: string }
  >(response, "Binance 合约持仓历史不可用");
  if (!response.ok || !Array.isArray(payload))
    throw new BinanceLiveError(
      !Array.isArray(payload) && payload.msg
        ? payload.msg
        : "Binance 合约持仓历史不可用",
      response.status,
      !Array.isArray(payload) ? payload.code : undefined,
    );
  return payload
    .map((point) => ({
      timestamp: Number(point.timestamp),
      value: Number(point.sumOpenInterestValue),
    }))
    .filter(
      (point) =>
        Number.isFinite(point.timestamp) &&
        Number.isFinite(point.value) &&
        point.value >= 0,
    );
}

export async function getBinanceLargeTraderPositioningSnapshot(
  apiKey: string,
  symbol: string,
) {
  const query = new URLSearchParams({
    symbol: symbol.trim().toUpperCase(),
    period: "5m",
    limit: "3",
  });
  const paths = {
    openInterestValue: "/futures/data/openInterestHist",
    topPositionLongShortRatio: "/futures/data/topLongShortPositionRatio",
    topAccountLongShortRatio: "/futures/data/topLongShortAccountRatio",
    takerBuySellRatio: "/futures/data/takerlongshortRatio",
  } as const;
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, path]) => {
      const response = await timedFetch(
        `${liveBaseUrl()}${path}?${query.toString()}`,
        {
          headers: {
            accept: "application/json",
            "X-MBX-APIKEY": apiKey,
          },
        },
      );
      const payload = await responseJson<
        | BinanceRatioPoint[]
        | { code?: number; msg?: string }
      >(response, "Binance 大户聚合持仓数据不可用");
      if (!response.ok || !Array.isArray(payload))
        throw new BinanceLiveError(
          !Array.isArray(payload) && payload.msg
            ? payload.msg
            : "Binance 大户聚合持仓数据不可用",
          response.status,
          !Array.isArray(payload) ? payload.code : undefined,
        );
      const valueField = key === "openInterestValue"
        ? "sumOpenInterestValue"
        : key === "takerBuySellRatio"
          ? "buySellRatio"
          : "longShortRatio";
      return [
        key,
        payload.map((point) => ({
          timestamp: Number(point.timestamp),
          value: Number(point[valueField]),
        })),
      ] as const;
    }),
  );
  return Object.fromEntries(entries) as {
    openInterestValue: Array<{ timestamp: number; value: number }>;
    topPositionLongShortRatio: Array<{ timestamp: number; value: number }>;
    topAccountLongShortRatio: Array<{ timestamp: number; value: number }>;
    takerBuySellRatio: Array<{ timestamp: number; value: number }>;
  };
}

export async function getBinanceLiveMarkPriceKlinesRange(
  symbol: string,
  interval: "1m" | "5m" | "30m" | "1h",
  startTime: number,
  endTime: number,
  limit = 20,
) {
  const query = new URLSearchParams({
    symbol,
    interval,
    startTime: String(Math.trunc(startTime)),
    endTime: String(Math.trunc(endTime)),
    limit: String(Math.min(100, Math.max(1, Math.trunc(limit)))),
  });
  const response = await timedFetch(
    `${liveBaseUrl()}/fapi/v1/markPriceKlines?${query.toString()}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<
    | Array<[number, string, string, string, string, string, number]>
    | { code?: number; msg?: string; retryAfterSeconds?: number }
  >(response, "Binance 历史标记价格K线不可用");
  if (!response.ok || !Array.isArray(payload))
    throw new BinanceLiveError(
      !Array.isArray(payload) && payload.msg
        ? payload.msg
        : "Binance 历史标记价格K线不可用",
      response.status,
      !Array.isArray(payload) ? payload.code : undefined,
      false,
      !Array.isArray(payload) ? payload.retryAfterSeconds : undefined,
    );
  return payload.map((row) => ({
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  }));
}

export async function getBinanceLiveKlinesRange(
  symbol: string,
  interval: "1m",
  startTime: number,
  endTime: number,
  limit = 40,
) {
  const query = new URLSearchParams({
    symbol,
    interval,
    startTime: String(Math.trunc(startTime)),
    endTime: String(Math.trunc(endTime)),
    limit: String(Math.min(100, Math.max(1, Math.trunc(limit)))),
  });
  const response = await timedFetch(
    `${liveBaseUrl()}/fapi/v1/klines?${query.toString()}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<
    | Array<[number, string, string, string, string, string, number]>
    | { code?: number; msg?: string; retryAfterSeconds?: number }
  >(response, "Binance 历史成交K线不可用");
  if (!response.ok || !Array.isArray(payload))
    throw new BinanceLiveError(
      !Array.isArray(payload) && payload.msg
        ? payload.msg
        : "Binance 历史成交K线不可用",
      response.status,
      !Array.isArray(payload) ? payload.code : undefined,
      false,
      !Array.isArray(payload) ? payload.retryAfterSeconds : undefined,
    );
  return payload.map((row) => ({
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  }));
}

export type BinanceLiveContractRule = {
  symbol: string;
  displayName: string;
  contractType: "PERPETUAL" | "TRADIFI_PERPETUAL";
  underlyingType: string | null;
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
  priceTickSize: number;
  price: number;
  change: number;
  high: number;
  low: number;
  quoteVolume: number;
};

export async function getBinanceLiveContractUniverse() {
  const response = await timedFetch(`${marketSnapshotBaseUrl()}/contracts`, {
    headers: { accept: "application/json" },
  });
  const payload = await responseJson<{
    rows?: BinanceLiveContractRule[];
    error?: string;
  }>(response, "系统 WebSocket 合约行情不可用");
  if (!response.ok || !Array.isArray(payload.rows))
    throw new BinanceLiveError(
      payload.error ?? "系统 WebSocket 合约行情不可用",
      response.status,
    );
  return payload.rows;
}

export async function getBinanceLiveContractRule(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  const query = new URLSearchParams({ symbol: normalized });
  const response = await timedFetch(
    `${marketSnapshotBaseUrl()}/contract?${query.toString()}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<{
    contract?: BinanceLiveContractRule;
    source?: string;
    updatedAt?: string;
    ageMs?: number;
    error?: string;
  }>(response, `${normalized} Binance 合约规则暂不可用`);
  if (!response.ok || !payload.contract)
    throw new BinanceLiveError(
      payload.error ?? `${normalized} Binance 合约规则暂不可用`,
      response.status,
    );
  return {
    ...payload,
    contract: payload.contract,
  };
}

export async function getBinanceLiveMarkPrices(
  symbols: string[],
  options?: { timeoutMs?: number; includeHistory?: boolean },
) {
  if (!symbols.length) return [];
  type RawMarkPrice = {
    symbol: string;
    markPrice: number;
    fundingRate?: number | null;
    nextFundingTime?: number | null;
    time: number;
    eventTime?: number;
    receivedAt?: number;
    snapshotAgeMs?: number;
    transportLatencyMs?: number;
    history?: Array<{
      markPrice: number;
      eventAtMs: number;
      receivedAtMs: number;
    }>;
  };
  const query = new URLSearchParams({ symbols: symbols.join(",") });
  if (options?.includeHistory) query.set("includeHistory", "1");
  const response = await timedFetch(
    `${marketSnapshotBaseUrl()}/mark-prices?${query}`,
    { headers: { accept: "application/json" } },
    options?.timeoutMs,
  );
  const payload = await responseJson<
    | { rows?: RawMarkPrice[]; error?: string; retryAfterSeconds?: number }
    | { code?: number; msg?: string; retryAfterSeconds?: number }
  >(response, "系统 WebSocket 标记价格不可用");
  if (!response.ok || !("rows" in payload) || !Array.isArray(payload.rows))
    throw new BinanceLiveError(
      ("error" in payload && payload.error) ||
        ("msg" in payload && payload.msg) ||
        "系统 WebSocket 标记价格不可用",
      response.status,
      "code" in payload ? payload.code : undefined,
      false,
      payload.retryAfterSeconds ??
        (Number(response.headers.get("retry-after")) || undefined),
    );
  return payload.rows
    .map((item) => ({
      symbol: item.symbol,
      markPrice: Number(item.markPrice),
      fundingRate:
        item.fundingRate === null || item.fundingRate === undefined
          ? null
          : Number(item.fundingRate),
      nextFundingTime:
        item.nextFundingTime === null || item.nextFundingTime === undefined
          ? null
          : Number(item.nextFundingTime),
      time: item.time,
      receivedAt: Number(item.receivedAt) || item.time,
      snapshotAgeMs: Number(item.snapshotAgeMs),
      transportLatencyMs: Number.isFinite(Number(item.transportLatencyMs))
        ? Number(item.transportLatencyMs)
        : Math.max(
            0,
            (Number(item.receivedAt) || item.time) -
              (Number(item.eventTime) || item.time),
          ),
      history: Array.isArray(item.history)
        ? item.history
            .map((sample) => ({
              markPrice: Number(sample.markPrice),
              eventAtMs: Number(sample.eventAtMs),
              receivedAtMs: Number(sample.receivedAtMs),
            }))
            .filter((sample) =>
              Number.isFinite(sample.markPrice) &&
              sample.markPrice > 0 &&
              Number.isFinite(sample.eventAtMs) &&
              sample.eventAtMs > 0
            )
        : [],
    }))
    .filter((item) => Number.isFinite(item.markPrice) && item.markPrice > 0)
    .map((item) => ({
      ...item,
      fundingRate:
        item.fundingRate !== null && Number.isFinite(item.fundingRate)
          ? item.fundingRate
          : null,
      nextFundingTime:
        item.nextFundingTime !== null &&
        Number.isFinite(item.nextFundingTime) &&
        item.nextFundingTime > 0
          ? item.nextFundingTime
          : null,
    }));
}

export type NexusLiveBookTicker = {
  symbol: string;
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
  midPrice: number;
  microPrice: number;
  spread: number;
  spreadBps: number;
  imbalance: number;
  updateId: number;
  eventTime: number;
  receivedAt: number;
  ageMs: number;
  transportLatencyMs: number;
  fresh: boolean;
};

export async function getNexusLiveBookTickers(symbols: string[]) {
  const normalized = Array.from(
    new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (!normalized.length)
    return {
      ready: false,
      staleAfterMs: 30_000,
      maxTransportLatencyMs: 500,
      missing: [] as string[],
      stale: [] as string[],
      rows: [] as NexusLiveBookTicker[],
    };
  const query = new URLSearchParams({ symbols: normalized.join(",") });
  const response = await timedFetch(
    `${marketSnapshotBaseUrl()}/book-tickers?${query}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<{
    ready?: boolean;
    staleAfterMs?: number;
    snapshotStaleAfterMs?: number;
    maxTransportLatencyMs?: number;
    missing?: string[];
    stale?: string[];
    rows?: NexusLiveBookTicker[];
    error?: string;
  }>(response, "系统100毫秒盘口不可用");
  const result = {
    ready: payload.ready === true,
    staleAfterMs: Number(payload.snapshotStaleAfterMs ?? payload.staleAfterMs) || 30_000,
    maxTransportLatencyMs: Number(payload.maxTransportLatencyMs) || 500,
    missing: Array.isArray(payload.missing) ? payload.missing : [],
    stale: Array.isArray(payload.stale) ? payload.stale : [],
    rows: (Array.isArray(payload.rows) ? payload.rows : []).map((row) => ({
      ...row,
      // The proxy exposes snapshot-level ready/stale information. Materialize
      // the row-level contract here so consumers never interpret an omitted
      // `fresh` property as a stale market.
      fresh:
        row.fresh !== false &&
        Number.isFinite(Number(row.ageMs)) &&
        Number(row.ageMs) <=
          (Number(payload.snapshotStaleAfterMs ?? payload.staleAfterMs) || 30_000) &&
        Number(row.transportLatencyMs) <=
          (Number(payload.maxTransportLatencyMs) || 500) &&
        !payload.stale?.includes(row.symbol),
    })),
  };
  if (!response.ok || !result.ready)
    throw new BinanceLiveError(
      payload.error ||
        (result.missing.length
          ? `盘口尚未就绪：${result.missing.join("、")}`
          : `盘口已过期：${result.stale.join("、")}`),
      response.status || 503,
    );
  return result;
}

export async function requireFreshNexusBookTicker(symbol: string) {
  const result = await getNexusLiveBookTickers([symbol]);
  const row = result.rows.find(
    (item) => item.symbol === symbol.trim().toUpperCase(),
  );
  if (!result.ready || !row || !row.fresh || row.ageMs > result.staleAfterMs)
    throw new BinanceLiveError(
      `${symbol.toUpperCase()} 盘口快照或传输延迟超过安全阈值，禁止使用旧行情开仓`,
      503,
    );
  return row;
}

/**
 * Register a candidate with the proxy's dynamic top-book and short-lived
 * order-flow streams before the expensive brain analysis starts. A first
 * request is expected to return 503 while Binance acknowledges the
 * subscription, so warming is deliberately best-effort; the final top-book
 * order gate still calls require/wait and fails closed.
 */
export async function warmNexusBookTicker(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  const query = new URLSearchParams({ symbols: normalized });
  const [book] = await Promise.allSettled([
    getNexusLiveBookTickers([normalized]),
    Promise.resolve().then(() => timedFetch(
      `${marketSnapshotBaseUrl()}/order-flow?${query}`,
      { headers: { accept: "application/json" } },
      250,
    )),
  ]);
  return book.status === "fulfilled";
}

export async function waitForFreshNexusBookTicker(
  symbol: string,
  maxWaitMs = 1_200,
  pollIntervalMs = 50,
) {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let lastError: unknown = null;
  do {
    try {
      return await requireFreshNexusBookTicker(symbol);
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(Math.max(10, pollIntervalMs), remaining)),
    );
  } while (Date.now() <= deadline);
  throw lastError instanceof Error
    ? lastError
    : new BinanceLiveError(
        `${symbol.toUpperCase()} 盘口在等待窗口内仍未就绪`,
        503,
      );
}

export type NexusPrivateOrderStreamEvent = {
  sequence: number;
  eventTime: number;
  transactionTime: number;
  receivedAt: number;
  symbol: string;
  clientOrderId: string;
  exchangeOrderId: string;
  side: "BUY" | "SELL";
  positionSide: "BOTH" | "LONG" | "SHORT";
  orderType: string;
  executionType: string;
  exchangeStatus: string;
  state: "NEW" | "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED";
  originalQuantity: number;
  cumulativeQuantity: number;
  averagePrice: number;
  realizedProfit: number;
  commission: number;
  commissionAsset: string | null;
};

export async function getNexusPrivateOrderEvents(
  credentials: { apiKey: string },
  afterSequence = 0,
) {
  const proxy = proxyBaseUrl();
  if (!proxy)
    throw new BinanceLiveError("Binance 私有订单流服务未配置", 503);
  const query = new URLSearchParams({
    afterSequence: String(Math.max(0, Math.trunc(afterSequence))),
  });
  const response = await timedFetch(
    `${proxy}/private/order-events?${query}`,
    {
      headers: {
        accept: "application/json",
        "X-MBX-APIKEY": credentials.apiKey,
      },
    },
  );
  const payload = await responseJson<{
    connected?: boolean;
    retained?: number;
    lastSequence?: number;
    oldestSequence?: number | null;
    rows?: NexusPrivateOrderStreamEvent[];
    error?: string;
  }>(response, "Binance 私有订单流不可用");
  if (!response.ok || !Array.isArray(payload.rows))
    throw new BinanceLiveError(
      payload.error ?? "Binance 私有订单流尚未就绪",
      response.status,
    );
  return {
    connected: payload.connected === true,
    retained: Number(payload.retained) || 0,
    lastSequence: Number(payload.lastSequence) || afterSequence,
    oldestSequence:
      payload.oldestSequence == null
        ? null
        : Number(payload.oldestSequence),
    rows: payload.rows,
  };
}

export type BinanceLiquidationAggregate = {
  sequence: number;
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  averagePrice: number;
  filledQuantity: number;
  notional: number;
  eventCount: number;
  bucketStart: number;
  bucketEnd: number;
  firstTradeTime: number;
  lastTradeTime: number;
  firstReceivedAt: number;
  lastReceivedAt: number;
};

export async function getBinanceLiveLiquidationEvents(
  afterSequence = 0,
  sinceMs = 15_000,
) {
  const query = new URLSearchParams({
    afterSequence: String(Math.max(0, Math.trunc(afterSequence))),
    sinceMs: String(Math.min(300_000, Math.max(1_000, Math.trunc(sinceMs)))),
  });
  const response = await timedFetch(
    `${marketSnapshotBaseUrl()}/liquidations?${query}`,
    { headers: { accept: "application/json" } },
  );
  const payload = await responseJson<{
    rows?: BinanceLiquidationAggregate[];
    lastSequence?: number;
    aggregationWindowMs?: number;
    error?: string;
  }>(response, "系统 WebSocket 爆仓数据暂不可用");
  if (!response.ok || !Array.isArray(payload.rows))
    throw new BinanceLiveError(
      payload.error ?? "系统 WebSocket 爆仓数据暂不可用",
      response.status,
    );
  return {
    rows: payload.rows
      .filter(
        (row) =>
          Number.isInteger(row.sequence) &&
          typeof row.symbol === "string" &&
          /^[A-Z0-9]{3,30}$/i.test(row.symbol.trim()) &&
          ["BUY", "SELL"].includes(row.side) &&
          Number.isFinite(row.averagePrice) &&
          row.averagePrice > 0 &&
          Number.isFinite(row.notional) &&
          row.notional > 0,
      )
      .map((row) => ({
        ...row,
        symbol: row.symbol.trim().toUpperCase(),
      })),
    lastSequence: Number(payload.lastSequence) || afterSequence,
    aggregationWindowMs: Number(payload.aggregationWindowMs) || 1_000,
  };
}

export async function getBinanceLiveSystemMetrics() {
  const proxy = proxyBaseUrl();
  if (!proxy)
    throw new BinanceLiveError("系统统一 WebSocket 行情服务未配置", 503);
  const response = await timedFetch(`${proxy}/metrics`, {
    headers: { accept: "application/json" },
  });
  const payload = await responseJson<{
    websocket?: {
      connected?: boolean;
      lastMessageAt?: string | null;
      ageMs?: number | null;
      markSymbols?: number;
      tickerSymbols?: number;
      liquidationEventsRetained?: number;
      liquidationLastEventAt?: string | null;
    };
    rest?: {
      hardLimitPerMinute?: number;
      admissionLimitPerMinute?: number;
      safetyReserve?: number;
      localEstimatedWeight?: number;
      projectRemainingWeight?: number;
      tradingEstimatedWeight?: number;
      tradingWeightLimitPerMinute?: number;
      tradingAdmissionLimitPerMinute?: number;
      tradingRemainingWeight?: number;
      observationEstimatedWeight?: number;
      observationWeightLimitPerMinute?: number;
      observationRemainingWeight?: number;
      binanceObservedWeight?: number;
      effectiveUsedWeight?: number;
      unattributedWeight?: number;
      remainingWeight?: number;
      globalIpWeightLimitPerMinute?: number;
      globalIpAdmissionLimitPerMinute?: number;
      globalObservationPauseWeight?: number;
      globalRemainingWeight?: number;
    };
    futuresData?: {
      windowMs?: number;
      requestLimit?: number;
      upstreamRequests?: number;
      remainingRequests?: number;
    };
    klineWeightAudit?: Record<string, unknown>;
    liquidationNotionalDistribution?: {
      windowMs?: number;
      eventCount?: number;
      uniqueSymbols?: number;
      totalNotional?: number;
      buyEventCount?: number;
      sellEventCount?: number;
      buyNotional?: number;
      sellNotional?: number;
      buyNotionalShare?: number;
      sellNotionalShare?: number;
      oldestEventAt?: number | null;
      newestEventAt?: number | null;
      coverageMs?: number;
      p50Notional?: number | null;
      p75Notional?: number | null;
      p90Notional?: number | null;
      p95Notional?: number | null;
      threshold6000?: {
        eventCount?: number;
        eventShare?: number;
        notional?: number;
        notionalShare?: number;
      };
      marketWindow120s?: {
        windowMs?: number;
        thresholdNotionalUsdt?: number;
        sell?: {
          currentNotional?: number;
          currentEventCount?: number;
          currentUniqueSymbols?: number;
          peakNotional?: number;
          peakAt?: number | null;
          triggerCount?: number;
          latestTriggerAt?: number | null;
        };
        buy?: {
          currentNotional?: number;
          currentEventCount?: number;
          currentUniqueSymbols?: number;
          peakNotional?: number;
          peakAt?: number | null;
          triggerCount?: number;
          latestTriggerAt?: number | null;
        };
      };
    };
    topByInternalRequestCount?: {
      method?: string;
      pathname?: string;
      internalRequests?: number;
      upstreamRequests?: number;
      cacheServed?: number;
      blocked?: number;
      estimatedWeight?: number;
    } | null;
    topByUpstreamRequestCount?: {
      method?: string;
      pathname?: string;
      internalRequests?: number;
      upstreamRequests?: number;
      cacheServed?: number;
      blocked?: number;
      estimatedWeight?: number;
    } | null;
    error?: string;
  }>(response, "系统行情与限流指标暂不可用");
  if (!response.ok || !payload.websocket || !payload.rest)
    throw new BinanceLiveError(
      payload.error ?? "系统行情与限流指标暂不可用",
      response.status,
    );
  return payload;
}

export async function signedLiveRequest<T>(
  credentials: { apiKey: string; secretKey: string },
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean> = {},
  options: {
    protectiveClose?: boolean;
    /** A timed-out exchange write may already have executed remotely. */
    executionUnknownOnTimeout?: boolean;
  } = {},
) {
  const requestStartedAt = Date.now();
  const clock = await serverTime(Boolean(options.protectiveClose));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    query.set(key, String(value));
  query.set("recvWindow", "5000");
  query.set("timestamp", String(Date.now() + clock.offset));
  query.set(
    "signature",
    await hmacSha256Hex(credentials.secretKey, query.toString()),
  );
  let response: Response;
  let payload: T & { code?: number; msg?: string };
  try {
    response = await timedFetch(
      `${liveBaseUrl()}${path}?${query.toString()}`,
      {
        method,
        headers: {
          "X-MBX-APIKEY": credentials.apiKey,
          accept: "application/json",
          ...(options.protectiveClose ? { "x-nq-protective-close": "1" } : {}),
        },
      },
    );
    payload = await responseJson<T & {
      code?: number;
      msg?: string;
    }>(response, "Binance 实盘请求失败");
  } catch (error) {
    if (exchangeWriteTimeoutIsExecutionUnknown(
      error,
      options.executionUnknownOnTimeout === true,
    ))
      throw new BinanceLiveError(
        (error as BinanceLiveError).message,
        (error as BinanceLiveError).status,
        (error as BinanceLiveError).code,
        true,
        (error as BinanceLiveError).retryAfterSeconds,
      );
    throw error;
  }
  if (!response.ok) {
    const executionUnknown =
      response.status === 503 && /unknown|timeout/i.test(payload.msg ?? "");
    throw new BinanceLiveError(
      binanceLiveErrorMessage(
        payload.code,
        payload.msg ?? `Binance 实盘请求失败 (${response.status})`,
      ),
      response.status,
      payload.code,
      executionUnknown,
    );
  }
  return {
    data: payload,
    latencyMs: Date.now() - requestStartedAt,
    clockLatencyMs: clock.latencyMs,
    usedWeight:
      Number(response.headers.get("x-mbx-used-weight-1m") ?? 0) || null,
  };
}

export async function getBinanceLiveOrderTrades(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  orderId: string | number,
) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedOrderId = String(orderId).trim();
  if (!/^[A-Z0-9]{1,24}$/.test(normalizedSymbol) || !/^\d{1,30}$/.test(normalizedOrderId))
    throw new BinanceLiveError("Binance 成交明细查询参数无效", 400);
  const cacheKey = `${credentials.apiKey}:${normalizedSymbol}:${normalizedOrderId}`;
  pruneOrderTradeCache(Date.now());
  const cached = orderTradeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.trades;
  const result = await signedLiveRequest<Array<{
    id: number;
    orderId: string | number;
    symbol: string;
    price: string;
    qty: string;
    quoteQty: string;
    realizedPnl: string;
    commission: string;
    commissionAsset: string;
    maker: boolean;
    time: number;
  }>>(credentials, "GET", "/fapi/v1/userTrades", {
    symbol: normalizedSymbol,
    orderId: normalizedOrderId,
    limit: 1000,
  });
  const trades = result.data.map((trade) => ({
    id: Number(trade.id),
    orderId: String(trade.orderId),
    symbol: trade.symbol,
    price: Number(trade.price),
    quantity: Number(trade.qty),
    quoteQuantity: Number(trade.quoteQty),
    realizedPnl: Number(trade.realizedPnl),
    commission: Number(trade.commission),
    commissionAsset: trade.commissionAsset,
    maker: Boolean(trade.maker),
    time: Number(trade.time),
  })).filter((trade) =>
    Number.isFinite(trade.id) &&
    /^\d{1,30}$/.test(trade.orderId) &&
    Number.isFinite(trade.realizedPnl) &&
    Number.isFinite(trade.commission) &&
    trade.commission >= 0,
  );
  // A FILLED order can become visible in userTrades a fraction later than the
  // order response. Never cache an empty consistency-window result for ten
  // minutes, otherwise exact fee settlement cannot recover on a bounded retry.
  if (trades.length)
    orderTradeCache.set(cacheKey, {
      trades,
      expiresAt: Date.now() + ORDER_TRADE_CACHE_MS,
    });
  pruneOrderTradeCache(Date.now());
  return trades;
}

function pruneOrderTradeCache(now: number) {
  for (const [key, value] of orderTradeCache)
    if (value.expiresAt <= now) orderTradeCache.delete(key);
  while (orderTradeCache.size > ORDER_TRADE_CACHE_MAXIMUM_ENTRIES) {
    const oldestKey = orderTradeCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    orderTradeCache.delete(oldestKey);
  }
}

export async function getBinanceLiveFundingIncome(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  startTime: number,
  endTime: number,
) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (
    !/^[A-Z0-9]{1,24}$/.test(normalizedSymbol) ||
    !Number.isInteger(startTime) ||
    !Number.isInteger(endTime) ||
    startTime <= 0 ||
    endTime < startTime
  ) throw new BinanceLiveError("Binance 资金费查询参数无效", 400);
  const result = await signedLiveRequest<Array<{
    symbol: string;
    incomeType: string;
    income: string;
    asset: string;
    time: number;
    tranId?: string | number;
  }>>(credentials, "GET", "/fapi/v1/income", {
    symbol: normalizedSymbol,
    incomeType: "FUNDING_FEE",
    startTime,
    endTime,
    limit: 1000,
  });
  return result.data.map((row) => ({
    symbol: row.symbol,
    incomeType: row.incomeType,
    income: Number(row.income),
    asset: row.asset,
    time: Number(row.time),
    transactionId: row.tranId === undefined ? null : String(row.tranId),
  })).filter((row) =>
    row.symbol === normalizedSymbol &&
    row.incomeType === "FUNDING_FEE" &&
    Number.isFinite(row.income) &&
    Number.isFinite(row.time) &&
    row.time >= startTime &&
    row.time <= endTime
  );
}

export async function getBinanceLiveFundingIncomeRange(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  startTime: number,
  endTime: number,
) {
  // Binance retains income history for only the latest three calendar months.
  // Refuse to label an older position exact instead of silently truncating it.
  const conservativeRetentionMs = 88 * 24 * 60 * 60_000;
  if (startTime < Date.now() - conservativeRetentionMs)
    throw new BinanceLiveError(
      "Binance 资金费历史已超出可精确查询周期",
      409,
    );
  // A symbol has at most a few funding events per day, so one 1000-row request
  // covers the entire retained interval and consumes one 30-weight request.
  const rows = await getBinanceLiveFundingIncome(
    credentials,
    symbol,
    startTime,
    endTime,
  );
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.transactionId
      ? `${row.transactionId}:${row.time}:${row.income}`
      : `${row.symbol}:${row.time}:${row.income}:${row.asset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function verifyLiveAccount(credentials: {
  apiKey: string;
  secretKey: string;
}) {
  const [account, positionMode] = await Promise.all([
    signedLiveRequest<{
      canTrade: boolean;
      totalWalletBalance: string;
      totalUnrealizedProfit: string;
      totalMarginBalance: string;
      totalPositionInitialMargin: string;
      totalOpenOrderInitialMargin: string;
      availableBalance: string;
    }>(credentials, "GET", "/fapi/v3/account"),
    signedLiveRequest<{ dualSidePosition: boolean }>(
      credentials,
      "GET",
      "/fapi/v1/positionSide/dual",
    ),
  ]);
  const hedgeMode = Boolean(positionMode.data.dualSidePosition);
  const testOrderParams: Record<string, string | number | boolean> = {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: 0.001,
  };
  if (hedgeMode) testOrderParams.positionSide = "LONG";
  const tradeTest = await signedLiveRequest<Record<string, never>>(
    credentials,
    "POST",
    "/fapi/v1/order/test",
    testOrderParams,
  );
  return {
    canTrade: true,
    accountCanTradeReported: Boolean(account.data.canTrade),
    tradeTestAccepted: true,
    totalWalletBalance: account.data.totalWalletBalance,
    totalUnrealizedProfit: account.data.totalUnrealizedProfit,
    totalMarginBalance: account.data.totalMarginBalance,
    totalPositionInitialMargin: account.data.totalPositionInitialMargin,
    totalOpenOrderInitialMargin: account.data.totalOpenOrderInitialMargin,
    availableBalance: account.data.availableBalance,
    hedgeMode,
    latencyMs: Math.max(
      account.latencyMs,
      positionMode.latencyMs,
      tradeTest.latencyMs,
    ),
    usedWeight: account.usedWeight,
  };
}

export async function getBinanceLiveAccountBalance(credentials: {
  apiKey: string;
  secretKey: string;
}) {
  const account = await signedLiveRequest<{
    canTrade: boolean;
    totalWalletBalance: string;
    totalUnrealizedProfit: string;
    totalMarginBalance: string;
    totalPositionInitialMargin: string;
    totalOpenOrderInitialMargin: string;
    availableBalance: string;
  }>(credentials, "GET", "/fapi/v3/account");
  return {
    canTrade: Boolean(account.data.canTrade),
    totalWalletBalance: Number(account.data.totalWalletBalance),
    totalUnrealizedProfit: Number(account.data.totalUnrealizedProfit),
    totalMarginBalance: Number(account.data.totalMarginBalance),
    totalPositionInitialMargin: Number(account.data.totalPositionInitialMargin),
    totalOpenOrderInitialMargin: Number(account.data.totalOpenOrderInitialMargin),
    availableBalance: Number(account.data.availableBalance),
    latencyMs: account.latencyMs,
    usedWeight: account.usedWeight,
  };
}

export async function getBinanceLiveMaximumLeverageUniverse(
  credentials: { apiKey: string; secretKey: string },
) {
  pruneLeverageCaches();
  const cached = leverageBracketUniverseCache.get(credentials.apiKey);
  if (cached && cached.expiresAt > Date.now())
    return new Map(cached.maximums);
  const result = await signedLiveRequest<
    Array<{
      symbol: string;
      brackets: Array<{ initialLeverage: number }>;
    }>
  >(credentials, "GET", "/fapi/v1/leverageBracket");
  const maximums = new Map<string, number>();
  const expiresAt = Date.now() + LEVERAGE_BRACKET_CACHE_MS;
  for (const row of result.data) {
    const maximumLeverage = Math.max(
      0,
      ...(row.brackets ?? []).map((bracket) =>
        Number(bracket.initialLeverage) || 0
      ),
    );
    if (!Number.isInteger(maximumLeverage) || maximumLeverage < 1) continue;
    maximums.set(row.symbol, maximumLeverage);
    leverageBracketCache.set(`${credentials.apiKey}:${row.symbol}`, {
      maximumLeverage,
      expiresAt,
    });
  }
  if (!maximums.size)
    throw new BinanceLiveError(
      "Binance 合约最大杠杆档位暂不可用",
      502,
    );
  leverageBracketUniverseCache.set(credentials.apiKey, {
    maximums,
    expiresAt,
  });
  return new Map(maximums);
}

async function getBinanceLiveMaximumLeverage(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
) {
  pruneLeverageCaches();
  const cacheKey = `${credentials.apiKey}:${symbol}`;
  const cached = leverageBracketCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now())
    return cached.maximumLeverage;
  const maximumLeverage = (
    await getBinanceLiveMaximumLeverageUniverse(credentials)
  ).get(symbol);
  if (!Number.isInteger(maximumLeverage) || maximumLeverage! < 1)
    throw new BinanceLiveError(
      `${symbol} 的 Binance 最大杠杆档位暂不可用`,
      502,
    );
  return maximumLeverage!;
}

export async function submitLiveEntryOrder(
  credentials: { apiKey: string; secretKey: string },
  order: {
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "LONG" | "SHORT";
    quantity: number;
    clientOrderId: string;
    leverage: number;
    orderType: "MARKET" | "LIMIT";
    price?: number | null;
    timeInForce?: "FOK" | "GTC";
    positionMode?: "ONE_WAY" | "HEDGE" | null;
    requireExactLeverage?: boolean;
  },
) {
  const startedAt = Date.now();
  const positionModeStartedAt = Date.now();
  // Position mode must come from Binance at order time. A locally cached mode
  // can drift after an external/account-page switch and causes Binance -4061.
  // positionRisk is already required for leverage verification, so use the
  // same response as the authoritative mode source without adding a REST call.
  const currentSymbolPositions = await signedLiveRequest<LivePositionRiskRow[]>(
    credentials,
    "GET",
    "/fapi/v3/positionRisk",
    {},
  );
  let hedgeMode = currentSymbolPositions.data.some(
    (position) => position.positionSide !== "BOTH",
  );
  if (currentSymbolPositions.data.length === 0) {
    hedgeMode = Boolean(
      (
        await signedLiveRequest<{ dualSidePosition: boolean }>(
          credentials,
          "GET",
          "/fapi/v1/positionSide/dual",
        )
      ).data.dualSidePosition,
    );
  }
  const positionModeMs = Date.now() - positionModeStartedAt;
  const params: Record<string, string | number | boolean> = {
    symbol: order.symbol,
    side: order.side,
    type: order.orderType,
    quantity: order.quantity,
    newClientOrderId: order.clientOrderId,
    newOrderRespType: "RESULT",
  };
  if (order.orderType === "LIMIT") {
    if (!Number.isFinite(order.price) || order.price! <= 0)
      throw new BinanceLiveError("限价单价格无效", 400);
    params.price = order.price!;
    params.timeInForce = "FOK";
    if (order.timeInForce === "GTC") {
      params.timeInForce = "GTC";
      params.newOrderRespType = "ACK";
    }
  }
  // Binance one-way mode defaults to BOTH. Hedge mode requires an explicit LONG/SHORT.
  if (hedgeMode)
    params.positionSide = order.positionSide;
  const executionShadow = buildNexusWsOrderPlaceShadow(
    {
      symbol: order.symbol,
      side: order.side,
      positionSide: hedgeMode ? order.positionSide : "BOTH",
      type: order.orderType,
      quantity: order.quantity,
      price: order.price,
      timeInForce:
        order.orderType === "LIMIT"
          ? (params.timeInForce as "FOK" | "GTC")
          : undefined,
      clientOrderId: order.clientOrderId,
    },
    Date.now(),
  );
  const executionParity = compareRestAndWsOrderSemantics(
    params,
    executionShadow,
  );
  // Leverage is an exchange-side, symbol-wide setting. It may be changed by
  // another order path (and applies to both LONG and SHORT in hedge mode), so a
  // process-local cache cannot prove the value is still correct. Set and verify
  // it immediately before every entry order.
  const binanceMaximumLeverage = await getBinanceLiveMaximumLeverage(
    credentials,
    order.symbol,
  );
  const leverageRestrictionCacheKey =
    `${credentials.apiKey}:${order.symbol}`;
  const cachedAccountMaximum = accountLeverageMaximumCache.get(
    leverageRestrictionCacheKey,
  );
  const accountMaximumLeverage =
    cachedAccountMaximum && cachedAccountMaximum.expiresAt > Date.now()
      ? cachedAccountMaximum.maximumLeverage
      : Number.POSITIVE_INFINITY;
  // Do not impose a second application-wide leverage ceiling. Binance's
  // symbol bracket is the hard exchange limit; an account-specific maximum
  // learned from Binance remains an additional restriction when available.
  let targetLeverage = Math.min(
    order.leverage,
    binanceMaximumLeverage,
    accountMaximumLeverage,
  );
  if (order.requireExactLeverage && targetLeverage !== order.leverage)
    throw new BinanceLiveError(
      `${order.symbol} 当前最多允许 ${targetLeverage}x 杠杆，未按请求的 ${order.leverage}x 下单`,
      409,
    );
  const leverageStartedAt = Date.now();
  let leverageResult;
  try {
    leverageResult = await signedLiveRequest<{
      leverage: number;
      maxNotionalValue: string;
      symbol: string;
    }>(credentials, "POST", "/fapi/v1/leverage", {
      symbol: order.symbol,
      leverage: targetLeverage,
    });
  } catch (error) {
    const restrictedMaximum =
      error instanceof BinanceLiveError
        ? Number(
            /restricted from using leverage greater than\s+(\d+)x/i.exec(
              error.message,
            )?.[1] ?? 0,
          )
        : 0;
    if (
      !Number.isInteger(restrictedMaximum) ||
      restrictedMaximum < 1 ||
      restrictedMaximum >= targetLeverage
    )
      throw error;
    if (order.requireExactLeverage)
      throw new BinanceLiveError(
        `${order.symbol} 当前最多允许 ${restrictedMaximum}x 杠杆，未按请求的 ${order.leverage}x 下单`,
        409,
        error instanceof BinanceLiveError ? error.code : undefined,
      );
    targetLeverage = restrictedMaximum;
    accountLeverageMaximumCache.set(leverageRestrictionCacheKey, {
      maximumLeverage: restrictedMaximum,
      expiresAt: Date.now() + ACCOUNT_LEVERAGE_MAXIMUM_CACHE_MS,
    });
    leverageResult = await signedLiveRequest<{
      leverage: number;
      maxNotionalValue: string;
      symbol: string;
    }>(credentials, "POST", "/fapi/v1/leverage", {
      symbol: order.symbol,
      leverage: targetLeverage,
    });
  }
  const leverageMs = Date.now() - leverageStartedAt;
  const confirmedLeverage = Number(leverageResult.data.leverage);
  if (confirmedLeverage !== targetLeverage) {
    throw new BinanceLiveError(
      `Binance 杠杆校验失败：要求 ${targetLeverage}x，实际 ${confirmedLeverage || "--"}x`,
      409,
      Number(leverageResult.data.code) || undefined,
    );
  }
  const orderStartedAt = Date.now();
  const result = await signedLiveRequest<{
    orderId: string;
    clientOrderId: string;
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote?: string;
    price?: string;
    time?: number;
    updateTime?: number;
  }>(credentials, "POST", "/fapi/v1/order", params, {
    executionUnknownOnTimeout: true,
  });
  const shadowEvidence = {
    mode: "SHADOW_ONLY" as const,
    method: executionShadow.method,
    matchesRestSemantics: executionParity.matches,
    mismatches: executionParity.mismatches,
  };
  return {
    ...result,
    data: { ...result.data, nexusExecutionShadow: shadowEvidence },
    executionShadow: shadowEvidence,
    timing: {
      totalMs: Date.now() - startedAt,
      positionModeMs,
      positionModeCached: false,
      cachedPositionMode: order.positionMode ?? null,
      confirmedPositionMode: hedgeMode ? "HEDGE" : "ONE_WAY",
      positionModeCorrected:
        Boolean(order.positionMode) &&
        order.positionMode !== (hedgeMode ? "HEDGE" : "ONE_WAY"),
      leverageMs,
      leverageUpdated: true,
      confirmedLeverage,
      requestedLeverage: order.leverage,
      binanceMaximumLeverage,
      systemMaximumLeverage: 20,
      leverageAdjusted: confirmedLeverage !== order.leverage,
      orderMs: Date.now() - orderStartedAt,
    },
  };
}

export async function changeLivePositionMode(
  credentials: { apiKey: string; secretKey: string },
  positionMode: "ONE_WAY" | "HEDGE",
) {
  const current = await signedLiveRequest<{ dualSidePosition: boolean }>(
    credentials,
    "GET",
    "/fapi/v1/positionSide/dual",
  );
  const currentMode = current.data.dualSidePosition ? "HEDGE" : "ONE_WAY";
  if (currentMode === positionMode)
    return { changed: false, positionMode, latencyMs: current.latencyMs };
  const changed = await signedLiveRequest<{ code: number; msg: string }>(
    credentials,
    "POST",
    "/fapi/v1/positionSide/dual",
    { dualSidePosition: positionMode === "HEDGE" },
  );
  return {
    changed: true,
    positionMode,
    latencyMs: current.latencyMs + changed.latencyMs,
  };
}

export async function getLivePositionSnapshot(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  positionSide: "LONG" | "SHORT",
) {
  let positions;
  try {
    positions = await signedLiveRequest<LivePositionRiskRow[]>(
      credentials,
      "GET",
      "/fapi/v3/positionRisk",
      {},
      { protectiveClose: true },
    );
  } catch (error) {
    if (!(error instanceof BinanceLiveError) || error.status < 500)
      throw error;
    positions = await signedLiveRequest<LivePositionRiskRow[]>(
      credentials,
      "GET",
      "/fapi/v3/positionRisk",
      {},
      { protectiveClose: true },
    );
  }
  if (!Array.isArray(positions.data))
    throw new BinanceLiveError("Binance 实盘仓位返回格式异常", 502);
  return {
    ...normalizeLivePositionSnapshot(positions.data, symbol, positionSide),
    liquidationPriceObservedAt: Date.now(),
  };
}

export async function getLivePositionSnapshots(
  credentials: { apiKey: string; secretKey: string },
  targets: Array<{
    symbol: string;
    positionSide: "LONG" | "SHORT";
  }>,
) {
  const positions = await signedLiveRequest<LivePositionRiskRow[]>(
    credentials,
    "GET",
    "/fapi/v3/positionRisk",
    {},
    { protectiveClose: true },
  );
  const liquidationPriceObservedAt = Date.now();
  return new Map(
    targets.map((target) => [
      `${target.symbol}:${target.positionSide}`,
      {
        ...normalizeLivePositionSnapshot(
          positions.data,
          target.symbol,
          target.positionSide,
        ),
        liquidationPriceObservedAt,
      },
    ]),
  );
}

export async function getLiveAccountPositionSnapshots(
  credentials: { apiKey: string; secretKey: string },
) {
  const positions = await signedLiveRequest<LivePositionRiskRow[]>(
    credentials,
    "GET",
    "/fapi/v3/positionRisk",
    {},
    { protectiveClose: true },
  );
  if (!Array.isArray(positions.data))
    throw new BinanceLiveError("Binance 实盘仓位返回格式异常", 502);
  return {
    hedgeMode: positions.data.some((row) => row.positionSide !== "BOTH"),
    positions: normalizeLiveAccountPositionSnapshots(positions.data).map(
      (position) => ({
        ...position,
        liquidationPriceObservedAt: Date.now(),
      }),
    ),
    latencyMs: positions.latencyMs,
    usedWeight: positions.usedWeight,
  };
}

export function alignReduceQuantityToStep(
  quantity: number,
  quantityStep: number,
) {
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(quantityStep) ||
    quantityStep <= 0
  ) return 0;
  return Number(
    (
      Math.floor((quantity + quantityStep * 1e-8) / quantityStep) *
      quantityStep
    ).toPrecision(15),
  );
}

async function normalizeLiveReduceQuantity(
  symbol: string,
  requestedQuantity: number,
  liveQuantity: number,
  knownQuantityStep?: number,
) {
  const cappedQuantity = Math.min(requestedQuantity, liveQuantity);
  let quantityStep =
    Number.isFinite(knownQuantityStep) && Number(knownQuantityStep) > 0
      ? Number(knownQuantityStep)
      : 0;
  if (!(quantityStep > 0)) {
    try {
      const contracts = await getBinanceLiveContractUniverse();
      quantityStep =
        contracts.find((contract) => contract.symbol === symbol)?.quantityStep ??
        0;
    } catch {
      // 合约池快照偶发不可用时仍允许保护性平仓，至少清除 JS 浮点尾数。
    }
  }
  const quantity = quantityStep > 0
    ? alignReduceQuantityToStep(cappedQuantity, quantityStep)
    : Number(cappedQuantity.toPrecision(12));
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new BinanceLiveError(
      "保护性减仓数量按 Binance 步长对齐后无效",
      400,
    );
  return quantity;
}

export async function submitLiveReduceMarketOrder(
  credentials: { apiKey: string; secretKey: string },
  order: {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    quantity: number;
    clientOrderId: string;
    quantityStep?: number;
  },
) {
  const reductionStartedAt = Date.now();
  const positionVerificationStartedAt = Date.now();
  const position = await getLivePositionSnapshot(credentials, order.symbol, order.positionSide);
  const positionVerificationCompletedAt = Date.now();
  if (!Number.isFinite(position.quantity) || position.quantity <= 0)
    throw new BinanceLiveError(
      "Binance 当前方向的实盘仓位为 0，本次未发送新的平仓指令",
      409,
      LOCAL_POSITION_MISSING_CODE,
    );
  const quantity = await normalizeLiveReduceQuantity(
    order.symbol,
    order.quantity,
    position.quantity,
    order.quantityStep,
  );
  const quantityNormalizationCompletedAt = Date.now();
  const params: Record<string, string | number | boolean> = {
    symbol: order.symbol,
    side: order.positionSide === "LONG" ? "SELL" : "BUY",
    type: "MARKET",
    quantity,
    newClientOrderId: order.clientOrderId,
    newOrderRespType: "RESULT",
  };
  if (position.hedgeMode) params.positionSide = order.positionSide;
  else params.reduceOnly = true;
  const executionShadow = buildNexusWsOrderPlaceShadow(
    {
      symbol: order.symbol,
      side: order.positionSide === "LONG" ? "SELL" : "BUY",
      positionSide: position.hedgeMode ? order.positionSide : "BOTH",
      type: "MARKET",
      quantity,
      clientOrderId: order.clientOrderId,
      reduceOnly: !position.hedgeMode,
    },
    Date.now(),
  );
  const executionParity = compareRestAndWsOrderSemantics(
    params,
    executionShadow,
  );
  const orderRequestStartedAt = Date.now();
  const result = await signedLiveRequest<{
    orderId: string;
    clientOrderId: string;
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote?: string;
    price?: string;
  }>(credentials, "POST", "/fapi/v1/order", params, {
    protectiveClose: true,
  });
  const orderRequestCompletedAt = Date.now();
  const shadowEvidence = {
    mode: "SHADOW_ONLY" as const,
    method: executionShadow.method,
    matchesRestSemantics: executionParity.matches,
    mismatches: executionParity.mismatches,
  };
  return {
    ...result,
    data: { ...result.data, nexusExecutionShadow: shadowEvidence },
    requestedQuantity: quantity,
    positionBefore: position,
    executionShadow: shadowEvidence,
    executionTiming: {
      version: "nexus-reduce-execution-timing-v1",
      totalMs: Math.max(0, orderRequestCompletedAt - reductionStartedAt),
      positionVerificationMs: Math.max(
        0,
        positionVerificationCompletedAt - positionVerificationStartedAt,
      ),
      quantityNormalizationMs: Math.max(
        0,
        quantityNormalizationCompletedAt - positionVerificationCompletedAt,
      ),
      orderRequestMs: Math.max(0, orderRequestCompletedAt - orderRequestStartedAt),
      signedRequestLatencyMs: result.latencyMs,
    },
  };
}

export async function submitLiveReduceLimitFokOrder(
  credentials: { apiKey: string; secretKey: string },
  order: {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    quantity: number;
    price: number;
    clientOrderId: string;
  },
) {
  const position = await getLivePositionSnapshot(credentials, order.symbol, order.positionSide);
  if (!Number.isFinite(position.quantity) || position.quantity <= 0)
    throw new BinanceLiveError(
      "Binance 当前方向的实盘仓位为 0，本次未发送新的平仓指令",
      409,
      LOCAL_POSITION_MISSING_CODE,
    );
  const quantity = await normalizeLiveReduceQuantity(
    order.symbol,
    order.quantity,
    position.quantity,
  );
  const params: Record<string, string | number | boolean> = {
    symbol: order.symbol,
    side: order.positionSide === "LONG" ? "SELL" : "BUY",
    type: "LIMIT",
    timeInForce: "FOK",
    price: order.price,
    quantity,
    newClientOrderId: order.clientOrderId,
    newOrderRespType: "RESULT",
  };
  if (position.hedgeMode) params.positionSide = order.positionSide;
  else params.reduceOnly = true;
  const executionShadow = buildNexusWsOrderPlaceShadow(
    {
      symbol: order.symbol,
      side: order.positionSide === "LONG" ? "SELL" : "BUY",
      positionSide: position.hedgeMode ? order.positionSide : "BOTH",
      type: "LIMIT",
      quantity,
      price: order.price,
      timeInForce: "FOK",
      clientOrderId: order.clientOrderId,
      reduceOnly: !position.hedgeMode,
    },
    Date.now(),
  );
  const executionParity = compareRestAndWsOrderSemantics(
    params,
    executionShadow,
  );
  const result = await signedLiveRequest<{
    orderId: string;
    clientOrderId: string;
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote?: string;
    price?: string;
  }>(credentials, "POST", "/fapi/v1/order", params, {
    protectiveClose: true,
  });
  const shadowEvidence = {
    mode: "SHADOW_ONLY" as const,
    method: executionShadow.method,
    matchesRestSemantics: executionParity.matches,
    mismatches: executionParity.mismatches,
  };
  return {
    ...result,
    data: { ...result.data, nexusExecutionShadow: shadowEvidence },
    requestedQuantity: quantity,
    positionBefore: position,
    executionShadow: shadowEvidence,
  };
}

export async function queryLiveOrder(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  clientOrderId: string,
) {
  return signedLiveRequest<{
    orderId: string;
    clientOrderId: string;
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote?: string;
    price?: string;
    time?: number;
    updateTime?: number;
  }>(credentials, "GET", "/fapi/v1/order", {
    symbol,
    origClientOrderId: clientOrderId,
  });
}

export async function cancelLiveOrder(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  clientOrderId: string,
) {
  return signedLiveRequest<{
    orderId: string;
    clientOrderId: string;
    status: string;
    executedQty: string;
    avgPrice: string;
    cumQuote?: string;
    price?: string;
    time?: number;
    updateTime?: number;
  }>(credentials, "DELETE", "/fapi/v1/order", {
    symbol,
    origClientOrderId: clientOrderId,
  });
}
