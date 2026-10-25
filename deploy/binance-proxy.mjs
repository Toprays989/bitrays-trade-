import http from "node:http";
import { createHash } from "node:crypto";
import {
  evaluatePartitionedRestWeightReservation,
  isProtectiveCloseRequest,
} from "./binance-rest-priority.mjs";
import {
  pruneFuturesDataRequestEvents,
  reserveFuturesDataRequest as reserveFuturesDataRequestWindow,
} from "./binance-futures-data-priority.mjs";
import { createLiquidationNotionalTracker } from "./liquidation-notional-distribution.mjs";
import {
  pruneLiquidationFingerprints,
  rememberLiquidationFingerprint,
} from "./liquidation-fingerprint-cache.mjs";
import {
  NEXUS_BOOK_STALE_MS,
  NEXUS_BOOK_SNAPSHOT_STALE_MS,
  bookTickerSnapshot,
  normalizeBookTicker,
  recordBookTicker,
} from "./nexus-market-eye.mjs";
import { createOrderFlowTracker } from "./nexus-order-flow-eye.mjs";
import { createPrivateOrderEventStore } from "./nexus-private-order-eye.mjs";
import { parseJsonPreservingIntegerFields } from "./json-integer-fields.mjs";
import { liquidationFilledQuantity } from "./binance-liquidation-order.mjs";
import { isSupportedBinanceUsdtPerpetual } from "./binance-contract-kind.mjs";
import {
  mutatesPrivateAccountState,
  privateStateCacheKey,
  privateStateCacheTtl,
} from "./binance-private-state-cache.mjs";
import {
  summarizeBinanceKlineWeightAudit,
} from "./binance-kline-weight-audit.mjs";
import {
  BoundedResponseCache,
  projectSharedKlinePayload,
  sharedKlineRequestPlan,
} from "./binance-shared-kline-cache.mjs";
import { createMarkPriceHistory } from "./mark-price-history.mjs";

const TARGETS = {
  live: "https://fapi.binance.com",
  spot: "https://api.binance.com",
};
const MARKET_STREAM_URL =
  "wss://fstream.binance.com/market/stream?streams=!markPrice@arr@1s/!ticker@arr/!forceOrder@arr";
const SPOT_KLINE_STREAM_URL = "wss://stream.binance.com:9443/stream";
const BOOK_STREAM_URL = "wss://fstream.binance.com/public/stream";
const BOOK_WATCH_TTL_MS = 2 * 60_000;
const BOOK_WATCH_LIMIT = 100;
const ORDER_FLOW_WATCH_TTL_MS = 30_000;
const ORDER_FLOW_WATCH_LIMIT = 20;
const TRADING_WEIGHT_LIMIT = Math.min(
  Math.max(
    1,
    Number(process.env.NQ_BINANCE_REST_WEIGHT_LIMIT || 800) || 800,
  ),
  800,
);
const TRADING_SAFETY_RESERVE = 40;
const TRADING_ADMISSION_LIMIT = Math.max(
  1,
  TRADING_WEIGHT_LIMIT - TRADING_SAFETY_RESERVE,
);
const PROJECT_WEIGHT_LIMIT = TRADING_WEIGHT_LIMIT;
const PROJECT_TRADING_ADMISSION_LIMIT = Math.max(
  1,
  PROJECT_WEIGHT_LIMIT - TRADING_SAFETY_RESERVE,
);
const PROJECT_OBSERVATION_ADMISSION_LIMIT = Math.max(
  1,
  PROJECT_WEIGHT_LIMIT - 100,
);
const OBSERVATION_WEIGHT_LIMIT = Math.min(
  Math.max(
    1,
    Number(process.env.NQ_BINANCE_OBSERVATION_WEIGHT_LIMIT || 500) || 500,
  ),
  500,
);
const GLOBAL_IP_WEIGHT_LIMIT = Math.min(
  Math.max(
    TRADING_WEIGHT_LIMIT + OBSERVATION_WEIGHT_LIMIT,
    Number(process.env.NQ_BINANCE_GLOBAL_IP_WEIGHT_LIMIT || 2_200) || 2_200,
  ),
  2_200,
);
const GLOBAL_IP_SAFETY_RESERVE = 100;
const GLOBAL_IP_ADMISSION_LIMIT = Math.max(
  TRADING_WEIGHT_LIMIT + OBSERVATION_WEIGHT_LIMIT,
  GLOBAL_IP_WEIGHT_LIMIT - GLOBAL_IP_SAFETY_RESERVE,
);
const GLOBAL_OBSERVATION_PAUSE_WEIGHT = Math.min(
  GLOBAL_IP_ADMISSION_LIMIT,
  1_800,
);
const WEIGHT_WINDOW_MS = 60_000;
const FUTURES_DATA_WINDOW_MS = 5 * 60_000;
const FUTURES_DATA_REQUEST_LIMIT = Math.min(
  Math.max(1, Number(process.env.NQ_BINANCE_FUTURES_DATA_LIMIT_5M || 800) || 800),
  800,
);
const MARKET_STALE_MS = 5_000;
const LIQUIDATION_WINDOW_MS = 1_000;
const LIQUIDATION_RETENTION_MS = 300_000;
const LIQUIDATION_MAX_EVENTS = 5_000;
const LIQUIDATION_MAX_FINGERPRINTS = LIQUIDATION_MAX_EVENTS * 5;
const PRIVATE_ORDER_EVENT_LIMIT = 1_000;
const PRIVATE_STREAM_KEEPALIVE_MS = 45 * 60_000;
const UPSTREAM_REQUEST_TIMEOUT_MS = 8_000;
const UPSTREAM_BODY_TIMEOUT_MS = 8_000;
const EXCHANGE_INFO_TTL_MS = 10 * 60_000;
const GLOBAL_LIQUIDATION_READER_URL =
  "https://r.jina.ai/http://www.coinglass.com/zh/liquidations";
const GLOBAL_LIQUIDATION_CACHE_MS = 60_000;
const GLOBAL_LIQUIDATION_STALE_MS = 10 * 60_000;
const RESPONSE_CACHE_MAXIMUM_ENTRIES = 1_200;
const RESPONSE_CACHE_MAXIMUM_BYTES = 64 * 1024 * 1024;
const port = Number(process.env.PORT || 3100);

const responseCache = new BoundedResponseCache({
  maximumEntries: RESPONSE_CACHE_MAXIMUM_ENTRIES,
  maximumBytes: RESPONSE_CACHE_MAXIMUM_BYTES,
});
const inFlight = new Map();
const privateStateCacheEpochs = new Map();
const SERVER_TIME_FRESH_MS = 30_000;
const SERVER_TIME_STALE_MS = 6 * 60 * 60_000;
let serverClock = null;
const blocked = new Map();
const privateOrderStreams = new Map();
const requestStats = new Map();
const restWeightEvents = [];
const restWeightAuditEvents = [];
const restRateLimitEvents = [];
const proxyStartedAt = Date.now();
const futuresDataRequestEvents = [];
const markPrices = new Map();
const markPriceHistory = createMarkPriceHistory();
const tickers = new Map();
const bookTickers = new Map();
const orderFlowTracker = createOrderFlowTracker();
const bookWatch = new Map();
const bookSubscriptions = new Set();
const orderFlowWatch = new Map();
const orderFlowSubscriptions = new Set();
const spotKlineSubscriptions = new Set();
const spotKlineCache = new Map();
const spotTickerCache = new Map();
let spotKlineSocket = null;
let spotKlineConnectedAt = 0;
let spotKlineLastMessageAt = 0;
let spotKlineReconnectAttempt = 0;
let spotKlineReconnectTimer = null;
let spotKlineRequestSequence = 0;
let spotKlineStaleRecoveryAt = 0;
const liquidationBuckets = new Map();
const liquidationFingerprints = new Map();
const liquidationEvents = [];
const liquidationNotionalTracker = createLiquidationNotionalTracker();
let liquidationSequence = 0;
let liquidationLastEventAt = 0;
let exchangeSymbols = new Map();
let exchangeInfoUpdatedAt = 0;
let exchangeInfoPromise = null;
let globalLiquidationPage = null;
let globalLiquidationPagePromise = null;
let observedUsedWeight = 0;
let observedWeightAt = 0;
let observedOrderCount10s = 0;
let observedOrderCount1m = 0;
let observedOrderCountAt = 0;
let marketSocket = null;
let marketConnectedAt = 0;
let marketLastMessageAt = 0;
let reconnectAttempt = 0;
let reconnectTimer = null;
let marketStaleRecoveryAt = 0;
let bookSocket = null;
let bookConnectedAt = 0;
let bookLastMessageAt = 0;
let bookReconnectAttempt = 0;
let bookReconnectTimer = null;
let bookStaleRecoveryAt = 0;
let bookRequestSequence = 0;

function apiKeyScope(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function privateStateCacheEpoch(scope) {
  return privateStateCacheEpochs.get(scope) || 0;
}

function invalidatePrivateStateCache(scope) {
  privateStateCacheEpochs.set(scope, privateStateCacheEpoch(scope) + 1);
}

function retirePrivateOrderStream(scope, generation) {
  const current = privateOrderStreams.get(scope);
  if (!current || current.generation !== generation) return;
  current.connected = false;
  current.socket = null;
  current.reconnectAttempt += 1;
  if (current.reconnectTimer) return;
  const delay = Math.min(
    30_000,
    1_000 * 2 ** Math.min(current.reconnectAttempt, 5),
  );
  current.reconnectTimer = setTimeout(() => {
    current.reconnectTimer = null;
    ensurePrivateOrderStream(current.apiKey).catch(() => undefined);
  }, delay);
}

async function createPrivateListenKey(apiKey) {
  const reservation = reserveWeight(
    "POST",
    "/fapi/v1/listenKey",
    new URLSearchParams(),
  );
  if (!reservation.allowed)
    throw new Error("Binance 私有订单流创建等待交易权重恢复");
  const response = await fetch(`${TARGETS.live}/fapi/v1/listenKey`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
    signal: AbortSignal.timeout(8_000),
  });
  updateObservedWeight(response);
  const payload = await response.json();
  if (!response.ok || !payload.listenKey)
    throw new Error("Binance 私有订单流创建失败");
  return String(payload.listenKey);
}

async function keepPrivateListenKey(stream) {
  if (!stream.listenKey) return;
  const reservation = reserveWeight(
    "PUT",
    "/fapi/v1/listenKey",
    new URLSearchParams(),
  );
  if (!reservation.allowed)
    throw new Error("Binance 私有订单流保活等待交易权重恢复");
  const response = await fetch(
    `${TARGETS.live}/fapi/v1/listenKey?listenKey=${encodeURIComponent(stream.listenKey)}`,
    {
      method: "PUT",
      headers: { "X-MBX-APIKEY": stream.apiKey },
      signal: AbortSignal.timeout(8_000),
    },
  );
  updateObservedWeight(response);
  if (!response.ok) throw new Error("Binance 私有订单流保活失败");
  stream.lastKeepaliveAt = Date.now();
}

async function ensurePrivateOrderStream(apiKey) {
  const scope = apiKeyScope(apiKey);
  const existing = privateOrderStreams.get(scope);
  if (
    existing?.socket &&
    [WebSocket.CONNECTING, WebSocket.OPEN].includes(existing.socket.readyState)
  )
    return existing;
  if (existing?.connecting) return existing.connecting;
  const stream = existing || {
    scope,
    apiKey,
    store: createPrivateOrderEventStore(PRIVATE_ORDER_EVENT_LIMIT),
    socket: null,
    listenKey: null,
    connected: false,
    connectedAt: 0,
    lastMessageAt: 0,
    lastKeepaliveAt: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,
    generation: 0,
    connecting: null,
  };
  privateOrderStreams.set(scope, stream);
  stream.generation += 1;
  const generation = stream.generation;
  stream.connecting = (async () => {
    const listenKey = await createPrivateListenKey(apiKey);
    if (stream.generation !== generation) return stream;
    stream.listenKey = listenKey;
    const socket = new WebSocket(
      `wss://fstream.binance.com/ws/${encodeURIComponent(listenKey)}`,
    );
    stream.socket = socket;
    socket.addEventListener("open", () => {
      if (stream.generation !== generation) return;
      stream.connected = true;
      stream.connectedAt = Date.now();
      stream.reconnectAttempt = 0;
    });
    socket.addEventListener("message", (event) => {
      if (stream.generation !== generation) return;
      try {
        const payload = parseJsonPreservingIntegerFields(
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data).toString("utf8"),
          ["i"],
        );
        stream.lastMessageAt = Date.now();
        if (payload.e === "listenKeyExpired") {
          retirePrivateOrderStream(scope, generation);
          return;
        }
        stream.store.append(payload, stream.lastMessageAt);
      } catch {
        // A malformed private event is ignored; it never mutates order state.
      }
    });
    socket.addEventListener("close", () =>
      retirePrivateOrderStream(scope, generation)
    );
    socket.addEventListener("error", () =>
      retirePrivateOrderStream(scope, generation)
    );
    return stream;
  })().finally(() => {
    if (stream.generation === generation) stream.connecting = null;
  });
  return stream.connecting;
}

async function maintainPrivateOrderStreams(now = Date.now()) {
  for (const stream of privateOrderStreams.values()) {
    if (
      stream.connected &&
      stream.lastKeepaliveAt < now - PRIVATE_STREAM_KEEPALIVE_MS
    )
      keepPrivateListenKey(stream).catch(() =>
        retirePrivateOrderStream(stream.scope, stream.generation)
      );
  }
}

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function statKey(method, pathname) {
  return `${method} ${pathname}`;
}

function recordStat(method, pathname, field, amount = 1) {
  const key = statKey(method, pathname);
  const current = requestStats.get(key) || {
    method,
    pathname,
    internalRequests: 0,
    upstreamRequests: 0,
    estimatedWeight: 0,
    websocketServed: 0,
    cacheServed: 0,
    blocked: 0,
  };
  current[field] = (current[field] || 0) + amount;
  requestStats.set(key, current);
}

function pruneWeightWindow(now = Date.now()) {
  while (restWeightEvents.length && restWeightEvents[0].at <= now - WEIGHT_WINDOW_MS)
    restWeightEvents.shift();
  while (
    restWeightAuditEvents.length &&
    restWeightAuditEvents[0].at <= now - 6 * WEIGHT_WINDOW_MS
  ) restWeightAuditEvents.shift();
  while (
    restRateLimitEvents.length &&
    restRateLimitEvents[0].at <= now - 6 * WEIGHT_WINDOW_MS
  ) restRateLimitEvents.shift();
  if (observedWeightAt <= now - WEIGHT_WINDOW_MS) {
    observedUsedWeight = 0;
    observedWeightAt = 0;
  }
  if (observedOrderCountAt <= now - WEIGHT_WINDOW_MS) {
    observedOrderCount10s = 0;
    observedOrderCount1m = 0;
    observedOrderCountAt = 0;
  }
}

function recordRestRateLimit(status, source, pathname) {
  restRateLimitEvents.push({
    at: Date.now(),
    status: Number(status),
    source,
    pathname,
  });
  pruneWeightWindow();
}

function localUsedWeight(now = Date.now(), bucket = null) {
  pruneWeightWindow(now);
  return restWeightEvents.reduce(
    (sum, item) => sum + (bucket && item.bucket !== bucket ? 0 : item.weight),
    0,
  );
}

function klineWeight(limit) {
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

function estimatedWeight(pathname, searchParams) {
  const hasSymbol = Boolean(searchParams.get("symbol"));
  if ([
    "/futures/data/openInterestHist",
    "/futures/data/topLongShortPositionRatio",
    "/futures/data/topLongShortAccountRatio",
    "/futures/data/takerlongshortRatio",
  ].includes(pathname)) return 0;
  if (pathname === "/fapi/v1/ticker/24hr") return hasSymbol ? 1 : 40;
  if (pathname === "/fapi/v1/premiumIndex") return hasSymbol ? 1 : 10;
  if (pathname === "/fapi/v1/ticker/price") return hasSymbol ? 1 : 2;
  if (pathname === "/fapi/v1/klines")
    return klineWeight(Number(searchParams.get("limit") || 500));
  if (pathname === "/fapi/v1/markPriceKlines")
    return klineWeight(Number(searchParams.get("limit") || 500));
  if (pathname === "/api/v3/klines")
    return klineWeight(Number(searchParams.get("limit") || 500));
  if (pathname === "/fapi/v1/exchangeInfo" || pathname === "/fapi/v1/time") return 1;
  if (pathname === "/fapi/v1/listenKey") return 1;
  if (pathname === "/fapi/v3/account" || pathname === "/fapi/v3/positionRisk") return 5;
  if (pathname === "/fapi/v1/userTrades") return 5;
  if (pathname === "/fapi/v1/income") return 30;
  if (pathname === "/fapi/v1/positionSide/dual") return 30;
  if (["/fapi/v1/order", "/fapi/v1/order/test", "/fapi/v1/leverage"].includes(pathname)) return 5;
  return 20;
}

function reserveWeight(method, pathname, searchParams, criticalOverride = false) {
  const now = Date.now();
  const weight = estimatedWeight(pathname, searchParams);
  const totalLocalUsedWeight = localUsedWeight(now);
  const tradingUsedWeight = localUsedWeight(now, "TRADING");
  const observationUsedWeight = localUsedWeight(now, "OBSERVATION");
  const reservation = evaluatePartitionedRestWeightReservation({
    method,
    pathname,
    tradingUsedWeight,
    observationUsedWeight,
    totalLocalUsedWeight,
    observedUsedWeight,
    requestWeight: weight,
    tradingAdmissionLimit: TRADING_ADMISSION_LIMIT,
    tradingHardLimit: TRADING_WEIGHT_LIMIT,
    observationLimit: OBSERVATION_WEIGHT_LIMIT,
    globalObservationLimit: GLOBAL_OBSERVATION_PAUSE_WEIGHT,
    globalAdmissionLimit: GLOBAL_IP_ADMISSION_LIMIT,
    globalHardLimit: GLOBAL_IP_WEIGHT_LIMIT,
    projectObservationLimit: PROJECT_OBSERVATION_ADMISSION_LIMIT,
    projectAdmissionLimit: PROJECT_TRADING_ADMISSION_LIMIT,
    projectHardLimit: PROJECT_WEIGHT_LIMIT,
    criticalOverride,
  });
  if (weight === 0) {
    recordStat(method, pathname, "upstreamRequests");
    return {
      allowed: true,
      weight: 0,
      used: reservation.partitionUsed,
      limit: reservation.partitionLimit,
      bucket: reservation.bucket,
      globalUsed: reservation.globalUsed,
      globalLimit: reservation.globalLimit,
      projectUsed: reservation.projectUsed,
      projectLimit: reservation.projectLimit,
    };
  }
  if (!reservation.allowed) {
    recordStat(method, pathname, "blocked");
    return {
      allowed: false,
      weight,
      used: reservation.partitionUsed,
      limit: reservation.partitionLimit,
      bucket: reservation.bucket,
      reason: reservation.reason,
      globalUsed: reservation.globalUsed,
      globalLimit: reservation.globalLimit,
    };
  }
  const weightEvent = {
    at: now,
    weight,
    bucket: reservation.bucket,
    method,
    pathname,
    symbol: searchParams.get("symbol") || null,
    interval: searchParams.get("interval") || null,
    requestKey: `${pathname}?${searchParams.toString()}`,
  };
  restWeightEvents.push(weightEvent);
  restWeightAuditEvents.push(weightEvent);
  recordStat(method, pathname, "upstreamRequests");
  recordStat(method, pathname, "estimatedWeight", weight);
  return {
    allowed: true,
    weight,
    used: reservation.partitionProjected,
    limit: reservation.partitionLimit,
    bucket: reservation.bucket,
    globalUsed: reservation.globalProjected,
    globalLimit: reservation.globalLimit,
    projectUsed: reservation.projectUsed,
    projectLimit: reservation.projectLimit,
  };
}

function reserveFuturesDataRequest(method, pathname, now = Date.now()) {
  if (!sharedMarketDataPath(pathname)) return { allowed: true, used: 0, retryAfterSeconds: 0 };
  const reservation = reserveFuturesDataRequestWindow(futuresDataRequestEvents, {
    now,
    windowMs: FUTURES_DATA_WINDOW_MS,
    limit: FUTURES_DATA_REQUEST_LIMIT,
  });
  if (!reservation.allowed) recordStat(method, pathname, "blocked");
  return reservation;
}

function updateObservedWeight(upstream) {
  const used = Number(upstream.headers.get("x-mbx-used-weight-1m"));
  if (Number.isFinite(used) && used >= 0) {
    observedUsedWeight = used;
    observedWeightAt = Date.now();
  }
  const orderCount10s = Number(
    upstream.headers.get("x-mbx-order-count-10s"),
  );
  const orderCount1m = Number(
    upstream.headers.get("x-mbx-order-count-1m"),
  );
  if (
    (Number.isFinite(orderCount10s) && orderCount10s >= 0) ||
    (Number.isFinite(orderCount1m) && orderCount1m >= 0)
  ) {
    if (Number.isFinite(orderCount10s) && orderCount10s >= 0)
      observedOrderCount10s = orderCount10s;
    if (Number.isFinite(orderCount1m) && orderCount1m >= 0)
      observedOrderCount1m = orderCount1m;
    observedOrderCountAt = Date.now();
  }
}

function apiKeyBlockKey(headers) {
  const apiKey = headers["X-MBX-APIKEY"];
  return typeof apiKey === "string" && apiKey
    ? `ORDER_UID:${apiKeyScope(apiKey)}`
    : null;
}

function klineCacheTtl(searchParams, now = Date.now()) {
  const intervalMs = {
    "1m": 60_000,
    "3m": 3 * 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "3d": 3 * 24 * 60 * 60_000,
    "1w": 7 * 24 * 60 * 60_000,
  }[searchParams.get("interval") || searchParams.get("period")];
  if (!intervalMs) return 0;
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs;
  return Math.max(5_000, nextBoundary - now + 2_000);
}

function cacheTtl(environment, pathname, searchParams) {
  if (environment !== "live") return 0;
  if (pathname === "/fapi/v1/exchangeInfo") return EXCHANGE_INFO_TTL_MS;
  if (pathname === "/fapi/v1/klines")
    return klineCacheTtl(searchParams);
  if (pathname === "/fapi/v1/markPriceKlines")
    return klineCacheTtl(searchParams);
  if (pathname === "/api/v3/klines")
    return klineCacheTtl(searchParams);
  if ([
    "/futures/data/openInterestHist",
    "/futures/data/topLongShortPositionRatio",
    "/futures/data/topLongShortAccountRatio",
    "/futures/data/takerlongshortRatio",
  ].includes(pathname)) return klineCacheTtl(searchParams);
  return 0;
}

function sharedMarketDataPath(pathname) {
  return pathname.startsWith("/futures/data/");
}

function retryAfterSeconds(upstream, body) {
  const header = Number(upstream.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  try {
    const message = JSON.parse(body.toString("utf8")).msg || "";
    const bannedUntil = Number(message.match(/banned until (\d{13})/i)?.[1]);
    if (Number.isFinite(bannedUntil))
      return Math.max(1, Math.ceil((bannedUntil - Date.now()) / 1_000));
  } catch { /* upstream body is not JSON */ }
  return 60;
}

function send(response, payload) {
  response.writeHead(payload.status, payload.headers);
  response.end(payload.body);
}

function cachedServerTimePayload(now = Date.now(), allowStale = false) {
  if (!serverClock) return null;
  const ageMs = now - serverClock.observedAt;
  if (ageMs > (allowStale ? SERVER_TIME_STALE_MS : SERVER_TIME_FRESH_MS))
    return null;
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-nq-time-source": allowStale ? "cached-stale" : "cached",
    },
    body: Buffer.from(JSON.stringify({
      serverTime: serverClock.serverTime + ageMs,
    })),
  };
}

async function readUpstreamBody(upstream) {
  let timeout;
  try {
    return Buffer.from(await Promise.race([
      upstream.arrayBuffer(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          Promise.resolve(upstream.body?.cancel()).catch(() => undefined);
          reject(new Error(
            `Binance upstream response body timed out after ${UPSTREAM_BODY_TIMEOUT_MS}ms`,
          ));
        }, UPSTREAM_BODY_TIMEOUT_MS);
      }),
    ]));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchPayload(environment, path, method, headers, pathname, searchParams, criticalOverride = false) {
  if (environment === "live" && method === "GET" && pathname === "/fapi/v1/time") {
    const cachedTime = cachedServerTimePayload();
    if (cachedTime) return cachedTime;
  }
  const futuresDataReservation = reserveFuturesDataRequest(method, pathname);
  if (!futuresDataReservation.allowed) {
    recordRestRateLimit(429, "LOCAL_FUTURES_DATA", pathname);
    return {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": String(futuresDataReservation.retryAfterSeconds),
      },
      body: Buffer.from(JSON.stringify({
        code: -1003,
        msg: `系统已达到 Binance 大户聚合接口每5分钟 ${FUTURES_DATA_REQUEST_LIMIT} 次保护线`,
        retryAfterSeconds: futuresDataReservation.retryAfterSeconds,
        localRateLimit: true,
        futuresDataRequests: futuresDataReservation.used,
      })),
    };
  }
  const reservation = reserveWeight(method, pathname, searchParams, criticalOverride);
  if (!reservation.allowed) {
    recordRestRateLimit(429, "LOCAL_REST_WEIGHT", pathname);
    if (environment === "live" && method === "GET" && pathname === "/fapi/v1/time") {
      const cachedTime = cachedServerTimePayload(Date.now(), true);
      if (cachedTime) return cachedTime;
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-nq-time-source": "host-fallback",
        },
        body: Buffer.from(JSON.stringify({ serverTime: Date.now() })),
      };
    }
    return {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "60",
      },
      body: Buffer.from(JSON.stringify({
        code: -1003,
        msg: reservation.reason === "GLOBAL_IP_WEIGHT_LIMIT"
          ? `系统已达到 Binance/IP 每分钟 ${reservation.globalLimit} 权重保护线`
          : reservation.reason === "PROJECT_WEIGHT_RESERVE"
            ? `Nexus 每分钟权重已达到 ${reservation.projectLimit} 保护线，正在保留下单、撤单与仓位对账容量`
          : `系统已达到 Binance ${reservation.bucket === "OBSERVATION" ? "观测" : "交易"} 每分钟 ${reservation.limit} 权重保护线`,
        retryAfterSeconds: 60,
        localRateLimit: true,
        usedWeight: reservation.used,
        weightBucket: reservation.bucket,
        globalUsedWeight: reservation.globalUsed,
        globalWeightLimit: reservation.globalLimit,
        projectUsedWeight: reservation.projectUsed,
        projectWeightLimit: reservation.projectLimit,
      })),
    };
  }
  let upstream = await fetch(`${TARGETS[environment]}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
  });
  updateObservedWeight(upstream);
  const body = await readUpstreamBody(upstream);
  if (
    environment === "live" &&
    method === "GET" &&
    pathname === "/fapi/v1/time" &&
    upstream.ok
  ) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      const observedServerTime = Number(payload.serverTime);
      if (Number.isFinite(observedServerTime) && observedServerTime > 0)
        serverClock = { serverTime: observedServerTime, observedAt: Date.now() };
    } catch { /* invalid upstream time response is returned unchanged */ }
  }
  const outgoingHeaders = {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
  };
  for (const name of ["x-mbx-used-weight-1m", "x-mbx-order-count-10s", "x-mbx-order-count-1m", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) outgoingHeaders[name] = value;
  }
  if ([418, 429].includes(upstream.status)) {
    recordRestRateLimit(upstream.status, "BINANCE_UPSTREAM", pathname);
    const seconds = retryAfterSeconds(upstream, body);
    const orderLimited =
      upstream.headers.has("x-mbx-order-count-10s") ||
      upstream.headers.has("x-mbx-order-count-1m");
    const scope =
      orderLimited && apiKeyBlockKey(headers)
        ? apiKeyBlockKey(headers)
        : `REST_IP:${environment}`;
    blocked.set(scope, {
      until: Date.now() + seconds * 1_000,
      status: upstream.status,
      domain: orderLimited ? "ORDER_UID" : "REST_IP",
    });
    outgoingHeaders["retry-after"] = String(seconds);
    try {
      const payload = JSON.parse(body.toString("utf8"));
      payload.retryAfterSeconds = seconds;
      return { status: upstream.status, headers: outgoingHeaders, body: Buffer.from(JSON.stringify(payload)) };
    } catch { /* keep original response body */ }
  }
  return { status: upstream.status, headers: outgoingHeaders, body };
}

function parseMarketMessage(event) {
  try {
    const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    const rows = Array.isArray(message.data) ? message.data : [];
    const receivedAt = Date.now();
    if (message.stream === "!markPrice@arr@1s") {
      // The weekly protection baseline must warm up while the account is
      // empty as well. Keep the existing short history semantics, but mark
      // the full WebSocket universe as watched before recording daily ranges.
      markPriceHistory.watch(
        rows
          .filter((row) => typeof row.s === "string")
          .map((row) => row.s),
        receivedAt,
      );
      for (const row of rows) {
        if (row.st !== undefined && row.st !== 1) continue;
        const markPrice = Number(row.p);
        const fundingRate = Number(row.r);
        const nextFundingTime = Number(row.T);
        if (typeof row.s === "string" && Number.isFinite(markPrice) && markPrice > 0) {
          const eventAtMs = Number(row.E) || receivedAt;
          markPrices.set(row.s, {
            symbol: row.s,
            markPrice,
            fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
            nextFundingTime:
              Number.isFinite(nextFundingTime) && nextFundingTime > 0
                ? nextFundingTime
                : null,
            time: eventAtMs,
            receivedAt,
          });
          markPriceHistory.record({
            symbol: row.s,
            markPrice,
            eventAtMs,
            receivedAtMs: receivedAt,
          });
        }
      }
    } else if (message.stream === "!ticker@arr") {
      for (const row of rows) {
        if (row.st !== undefined && row.st !== 1) continue;
        const ticker = {
          symbol: row.s,
          lastPrice: Number(row.c),
          priceChangePercent: Number(row.P),
          highPrice: Number(row.h),
          lowPrice: Number(row.l),
          quoteVolume: Number(row.q),
          time: Number(row.E) || receivedAt,
          receivedAt,
        };
        if (typeof row.s === "string" && [ticker.lastPrice, ticker.priceChangePercent, ticker.highPrice, ticker.lowPrice, ticker.quoteVolume].every(Number.isFinite))
          {
            tickers.set(row.s, ticker);
          }
      }
    } else if (message.stream === "!forceOrder@arr") {
      recordLiquidation(message.data, receivedAt);
    }
    marketLastMessageAt = receivedAt;
  } catch { /* malformed upstream frame is ignored; freshness guard remains active */ }
}

function spotKlineKey(symbol, interval) {
  return `${symbol.toUpperCase()}:${interval}`;
}

function parseSpotKlineMessage(event) {
  try {
    const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    if (message?.stream === "!ticker@arr" && Array.isArray(message.data)) {
      const receivedAt = Date.now();
      for (const row of message.data) {
        const symbol = String(row?.s || "").toUpperCase();
        const values = [row?.c, row?.h, row?.l, row?.P, row?.q].map(Number);
        if (!/^[A-Z0-9]{2,24}$/.test(symbol) || values.some((value) => !Number.isFinite(value))) continue;
        spotTickerCache.set(symbol, { symbol, lastPrice: values[0], highPrice: values[1], lowPrice: values[2], priceChangePercent: values[3], quoteVolume: values[4], receivedAt });
      }
      spotKlineLastMessageAt = receivedAt;
      return;
    }
    const kline = message?.data?.k;
    if (message?.data?.e !== "kline" || !kline) return;
    const symbol = String(kline.s || "").toUpperCase();
    const interval = String(kline.i || "");
    const openTime = Number(kline.t);
    if (!/^[A-Z0-9]{2,24}$/.test(symbol) || !["3d", "1w"].includes(interval) || !Number.isSafeInteger(openTime)) return;
    const row = [
      openTime, String(kline.o), String(kline.h), String(kline.l), String(kline.c),
      String(kline.v), Number(kline.T), String(kline.q), Number(kline.n),
      String(kline.V), String(kline.Q), Number(kline.B),
    ];
    const key = spotKlineKey(symbol, interval);
    const current = spotKlineCache.get(key) || { rows: new Map(), lastMessageAt: 0, lastWsMessageAt: 0 };
    current.rows.set(openTime, row);
    while (current.rows.size > 120) current.rows.delete(current.rows.keys().next().value);
    current.lastMessageAt = Date.now();
    current.lastWsMessageAt = current.lastMessageAt;
    spotKlineCache.set(key, current);
    spotKlineLastMessageAt = current.lastMessageAt;
  } catch { /* malformed public frame is ignored; freshness guard remains active */ }
}

function sendSpotKlineSubscription(method, keys) {
  if (!keys.length || !spotKlineSocket || spotKlineSocket.readyState !== WebSocket.OPEN) return;
  spotKlineRequestSequence += 1;
  spotKlineSocket.send(JSON.stringify({
    method,
    params: keys.map((key) => {
      const [symbol, interval] = key.split(":");
      return `${symbol.toLowerCase()}@kline_${interval}`;
    }),
    id: `nq-spot-kline-${spotKlineRequestSequence}`,
  }));
}

function syncSpotKlineSubscriptions() {
  const desired = [...spotKlineSubscriptions];
  if (spotKlineSocket?.readyState !== WebSocket.OPEN) return;
  const additions = desired.filter((key) => !spotKlineSocket.subscribed?.has(key));
  if (!spotKlineSocket.subscribed?.has("!ticker@arr")) {
    spotKlineSocket.send(JSON.stringify({ method: "SUBSCRIBE", params: ["!ticker@arr"], id: "nq-spot-ticker" }));
  }
  sendSpotKlineSubscription("SUBSCRIBE", additions);
  if (!spotKlineSocket.subscribed) spotKlineSocket.subscribed = new Set();
  spotKlineSocket.subscribed.add("!ticker@arr");
  for (const key of desired) spotKlineSocket.subscribed.add(key);
}

function scheduleSpotKlineReconnect() {
  if (spotKlineReconnectTimer) return;
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(spotKlineReconnectAttempt, 5));
  spotKlineReconnectAttempt += 1;
  spotKlineReconnectTimer = setTimeout(() => {
    spotKlineReconnectTimer = null;
    connectSpotKlineStream();
  }, delay);
}

function retireSpotKlineSocket(socket) {
  if (spotKlineSocket !== socket) return;
  spotKlineSocket = null;
  scheduleSpotKlineReconnect();
}

function connectSpotKlineStream() {
  if (spotKlineSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(spotKlineSocket.readyState)) return;
  const socket = new WebSocket(SPOT_KLINE_STREAM_URL);
  socket.subscribed = new Set();
  spotKlineSocket = socket;
  socket.addEventListener("open", () => {
    if (spotKlineSocket !== socket) return;
    spotKlineReconnectAttempt = 0;
    spotKlineConnectedAt = Date.now();
    syncSpotKlineSubscriptions();
  });
  socket.addEventListener("message", (event) => {
    if (spotKlineSocket === socket) parseSpotKlineMessage(event);
  });
  socket.addEventListener("close", () => retireSpotKlineSocket(socket));
  socket.addEventListener("error", () => retireSpotKlineSocket(socket));
}

function watchSpotKline(symbol, interval) {
  const key = spotKlineKey(symbol, interval);
  spotKlineSubscriptions.add(key);
  syncSpotKlineSubscriptions();
  return key;
}

function spotKlineRows(key, limit) {
  const entry = spotKlineCache.get(key);
  if (!entry) return null;
  const rows = [...entry.rows.values()].sort((a, b) => Number(a[0]) - Number(b[0]));
  return { rows: rows.slice(-limit), lastMessageAt: entry.lastMessageAt, lastWsMessageAt: entry.lastWsMessageAt || 0 };
}

async function handleSpotKlines(incoming, response) {
  const symbol = String(incoming.searchParams.get("symbol") || "").trim().toUpperCase();
  const interval = String(incoming.searchParams.get("interval") || "");
  const limit = Math.max(2, Math.min(52, Math.trunc(Number(incoming.searchParams.get("limit") || 52))));
  if (!/^[A-Z0-9]{2,24}$/.test(symbol) || !["3d", "1w"].includes(interval))
    return json(response, 400, { error: "现货 K 线参数无效" });
  const key = watchSpotKline(symbol, interval);
  const cached = spotKlineRows(key, limit);
  if (cached && cached.rows.length >= limit && cached.lastWsMessageAt > Date.now() - 10 * 60_000) {
    recordStat("GET", "/market/spot-klines", "websocketServed");
    return json(response, 200, cached.rows, { "x-nq-kline-source": "spot-websocket" });
  }
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const payload = await fetchPayload("spot", `/api/v3/klines?${params.toString()}`, "GET", { accept: "application/json" }, "/api/v3/klines", params);
  if (payload.status >= 200 && payload.status < 300) {
    try {
      const rows = JSON.parse(payload.body.toString("utf8"));
      if (Array.isArray(rows)) {
        const entry = spotKlineCache.get(key) || { rows: new Map(), lastMessageAt: 0, lastWsMessageAt: 0 };
        for (const row of rows) if (Array.isArray(row) && Number.isSafeInteger(Number(row[0]))) entry.rows.set(Number(row[0]), row);
        entry.lastMessageAt = Date.now();
        spotKlineCache.set(key, entry);
      }
    } catch { /* keep the REST payload as the response */ }
  }
  send(response, payload);
}

function handleSpotTicker(incoming, response) {
  const symbol = String(incoming.searchParams.get("symbol") || "").trim().toUpperCase();
  const ticker = spotTickerCache.get(symbol);
  if (!/^[A-Z0-9]{2,24}$/.test(symbol) || !ticker)
    return json(response, 503, { error: "现货 WebSocket 行情尚未就绪", source: "SPOT_WEBSOCKET" }, { "retry-after": "2" });
  if (Date.now() - ticker.receivedAt > 15_000)
    return json(response, 503, { error: "现货 WebSocket 行情已过期", source: "SPOT_WEBSOCKET" }, { "retry-after": "2" });
  recordStat("GET", "/market/spot-ticker", "websocketServed");
  return json(response, 200, ticker, { "x-nq-kline-source": "spot-websocket" });
}

function activeBookSymbols(now = Date.now()) {
  for (const [symbol, expiresAt] of bookWatch)
    if (expiresAt <= now) bookWatch.delete(symbol);
  return [...bookWatch.keys()].sort();
}

function sendBookSubscription(method, symbols, includeOrderFlow = false) {
  if (
    !symbols.length ||
    !bookSocket ||
    bookSocket.readyState !== WebSocket.OPEN
  )
    return;
  bookRequestSequence += 1;
  bookSocket.send(
    JSON.stringify({
      method,
      params: includeOrderFlow
        ? symbols.flatMap((symbol) => [
            `${symbol.toLowerCase()}@depth10@100ms`,
            `${symbol.toLowerCase()}@trade`,
          ])
        : symbols.map((symbol) => `${symbol.toLowerCase()}@bookTicker`),
      id: `nq-book-${bookRequestSequence}`,
    }),
  );
}

function syncBookSubscriptions(now = Date.now()) {
  const desired = new Set(activeBookSymbols(now));
  const additions = [...desired].filter(
    (symbol) => !bookSubscriptions.has(symbol),
  );
  const removals = [...bookSubscriptions].filter(
    (symbol) => !desired.has(symbol),
  );
  sendBookSubscription("SUBSCRIBE", additions);
  sendBookSubscription("UNSUBSCRIBE", removals);
  for (const symbol of additions) bookSubscriptions.add(symbol);
  for (const symbol of removals) {
    bookSubscriptions.delete(symbol);
    bookTickers.delete(symbol);
  }
  const desiredOrderFlow = new Set(activeOrderFlowSymbols(now));
  const orderFlowAdditions = [...desiredOrderFlow].filter(
    (symbol) => !orderFlowSubscriptions.has(symbol),
  );
  const orderFlowRemovals = [...orderFlowSubscriptions].filter(
    (symbol) => !desiredOrderFlow.has(symbol),
  );
  sendBookSubscription("SUBSCRIBE", orderFlowAdditions, true);
  sendBookSubscription("UNSUBSCRIBE", orderFlowRemovals, true);
  for (const symbol of orderFlowAdditions) orderFlowSubscriptions.add(symbol);
  for (const symbol of orderFlowRemovals) {
    orderFlowSubscriptions.delete(symbol);
    orderFlowTracker.remove(symbol);
  }
}

function activeOrderFlowSymbols(now = Date.now()) {
  for (const [symbol, expiresAt] of orderFlowWatch) {
    if (expiresAt > now) continue;
    orderFlowWatch.delete(symbol);
    if (!orderFlowSubscriptions.has(symbol)) orderFlowTracker.remove(symbol);
  }
  return [...orderFlowWatch.keys()].sort();
}

function watchBookSymbols(symbols, now = Date.now()) {
  const normalized = [
    ...new Set(
      symbols
        .map((symbol) => String(symbol || "").trim().toUpperCase())
        .filter((symbol) => /^[A-Z0-9]{2,24}$/.test(symbol)),
    ),
  ];
  const existing = activeBookSymbols(now);
  const combined = [...new Set([...existing, ...normalized])];
  if (combined.length > BOOK_WATCH_LIMIT)
    return {
      accepted: false,
      error: `盘口眼睛最多同时监听 ${BOOK_WATCH_LIMIT} 个候选合约`,
    };
  for (const symbol of normalized)
    bookWatch.set(symbol, now + BOOK_WATCH_TTL_MS);
  syncBookSubscriptions(now);
  return { accepted: true, symbols: normalized };
}

function watchOrderFlowSymbols(symbols, now = Date.now()) {
  const normalized = [...new Set(symbols
    .map((symbol) => String(symbol || "").trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9]{2,24}$/.test(symbol)))];
  const combined = [...new Set([...activeOrderFlowSymbols(now), ...normalized])];
  if (combined.length > ORDER_FLOW_WATCH_LIMIT)
    return {
      accepted: false,
      error: `实时订单流最多同时监听 ${ORDER_FLOW_WATCH_LIMIT} 个临近委托合约`,
    };
  for (const symbol of normalized)
    orderFlowWatch.set(symbol, now + ORDER_FLOW_WATCH_TTL_MS);
  syncBookSubscriptions(now);
  return { accepted: true, symbols: normalized };
}

function parseBookMessage(event) {
  try {
    const message = JSON.parse(
      typeof event.data === "string"
        ? event.data
        : Buffer.from(event.data).toString("utf8"),
    );
    if (!message?.data) return;
    const receivedAt = Date.now();
    let recorded = { accepted: false };
    if (message.data.e === "bookTicker") {
      const ticker = normalizeBookTicker(message.data, receivedAt);
      recorded = recordBookTicker(bookTickers, ticker);
    } else if (message.data.e === "depthUpdate") {
      recorded = orderFlowTracker.recordDepth(message.data, receivedAt);
    } else if (["aggTrade", "trade"].includes(message.data.e)) {
      recorded = orderFlowTracker.recordTrade(message.data, receivedAt);
    }
    if (recorded.accepted) bookLastMessageAt = receivedAt;
  } catch {
    // Malformed frames never replace the last valid top-of-book fact.
  }
}

function recordLiquidation(payload, receivedAt) {
  const order = payload?.o;
  if (!order || (payload.st !== undefined && payload.st !== 1)) return;
  const symbol = typeof order.s === "string" ? order.s.toUpperCase() : "";
  const side = order.S === "BUY" || order.S === "SELL" ? order.S : "";
  const averagePrice = Number(order.ap) > 0 ? Number(order.ap) : Number(order.p);
  const filledQuantity = liquidationFilledQuantity(order);
  const tradeTime = Number(order.T) || Number(payload.E) || receivedAt;
  if (!symbol || !side || !Number.isFinite(averagePrice) || averagePrice <= 0 || filledQuantity <= 0) return;
  const fingerprint = `${symbol}:${side}:${tradeTime}:${averagePrice}:${filledQuantity}:${order.X || ""}`;
  if (!rememberLiquidationFingerprint(
    liquidationFingerprints,
    fingerprint,
    receivedAt,
    {
      retentionMs: LIQUIDATION_RETENTION_MS,
      maximumEntries: LIQUIDATION_MAX_FINGERPRINTS,
    },
  )) return;
  const bucketStart = Math.floor(receivedAt / LIQUIDATION_WINDOW_MS) * LIQUIDATION_WINDOW_MS;
  const key = `${bucketStart}:${symbol}:${side}`;
  const current = liquidationBuckets.get(key) || {
    id: key,
    symbol,
    side,
    bucketStart,
    bucketEnd: bucketStart + LIQUIDATION_WINDOW_MS,
    eventCount: 0,
    filledQuantity: 0,
    notional: 0,
    weightedPriceTotal: 0,
    firstTradeTime: tradeTime,
    lastTradeTime: tradeTime,
    firstReceivedAt: receivedAt,
    lastReceivedAt: receivedAt,
  };
  const notional = averagePrice * filledQuantity;
  current.eventCount += 1;
  current.filledQuantity += filledQuantity;
  current.notional += notional;
  current.weightedPriceTotal += averagePrice * filledQuantity;
  current.firstTradeTime = Math.min(current.firstTradeTime, tradeTime);
  current.lastTradeTime = Math.max(current.lastTradeTime, tradeTime);
  current.lastReceivedAt = receivedAt;
  liquidationBuckets.set(key, current);
  liquidationLastEventAt = receivedAt;
}

function flushLiquidations(now = Date.now()) {
  for (const [key, bucket] of liquidationBuckets) {
    if (bucket.bucketEnd > now) continue;
    liquidationBuckets.delete(key);
    liquidationSequence += 1;
    const aggregate = {
      sequence: liquidationSequence,
      id: bucket.id,
      symbol: bucket.symbol,
      side: bucket.side,
      averagePrice: bucket.filledQuantity > 0
        ? bucket.weightedPriceTotal / bucket.filledQuantity
        : 0,
      filledQuantity: bucket.filledQuantity,
      notional: bucket.notional,
      eventCount: bucket.eventCount,
      bucketStart: bucket.bucketStart,
      bucketEnd: bucket.bucketEnd,
      firstTradeTime: bucket.firstTradeTime,
      lastTradeTime: bucket.lastTradeTime,
      firstReceivedAt: bucket.firstReceivedAt,
      lastReceivedAt: bucket.lastReceivedAt,
    };
    liquidationEvents.push(aggregate);
    liquidationNotionalTracker.record({
      notional: aggregate.notional,
      time: aggregate.bucketEnd,
      symbol: aggregate.symbol,
      side: aggregate.side,
      eventCount: aggregate.eventCount,
    });
  }
  while (
    liquidationEvents.length > LIQUIDATION_MAX_EVENTS ||
    (liquidationEvents.length && liquidationEvents[0].bucketEnd < now - LIQUIDATION_RETENTION_MS)
  )
    liquidationEvents.shift();
  // Fingerprints are also pruned at insertion so a liquidation storm cannot
  // retain an unbounded five-minute raw-event set before the next reader runs.
  // The periodic pass keeps quiet-market expiry deterministic.
  pruneLiquidationFingerprints(
    liquidationFingerprints,
    now,
    LIQUIDATION_RETENTION_MS,
    LIQUIDATION_MAX_FINGERPRINTS,
  );
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMarketStream();
  }, delay);
}

function retireMarketSocket(socket) {
  if (marketSocket !== socket) return;
  marketSocket = null;
  scheduleReconnect();
}

function connectMarketStream() {
  if (marketSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(marketSocket.readyState)) return;
  const socket = new WebSocket(MARKET_STREAM_URL);
  marketSocket = socket;
  socket.addEventListener("open", () => {
    if (marketSocket !== socket) return;
    reconnectAttempt = 0;
    marketConnectedAt = Date.now();
  });
  socket.addEventListener("message", (event) => {
    if (marketSocket === socket) parseMarketMessage(event);
  });
  socket.addEventListener("close", () => retireMarketSocket(socket));
  // Undici may synchronously emit another error from WebSocket.close(). Never
  // call close() inside the error handler; retire the failed generation and let
  // the single reconnect timer replace it.
  socket.addEventListener("error", () => retireMarketSocket(socket));
}

function scheduleBookReconnect() {
  if (bookReconnectTimer) return;
  const delay = Math.min(
    30_000,
    1_000 * 2 ** Math.min(bookReconnectAttempt, 5),
  );
  bookReconnectAttempt += 1;
  bookReconnectTimer = setTimeout(() => {
    bookReconnectTimer = null;
    connectBookStream();
  }, delay);
}

function retireBookSocket(socket) {
  if (bookSocket !== socket) return;
  bookSocket = null;
  bookSubscriptions.clear();
  orderFlowSubscriptions.clear();
  scheduleBookReconnect();
}

function connectBookStream() {
  if (
    bookSocket &&
    [WebSocket.CONNECTING, WebSocket.OPEN].includes(bookSocket.readyState)
  )
    return;
  const socket = new WebSocket(BOOK_STREAM_URL);
  bookSocket = socket;
  socket.addEventListener("open", () => {
    if (bookSocket !== socket) return;
    bookReconnectAttempt = 0;
    bookConnectedAt = Date.now();
    bookSubscriptions.clear();
    orderFlowSubscriptions.clear();
    syncBookSubscriptions();
  });
  socket.addEventListener("message", (event) => {
    if (bookSocket === socket) parseBookMessage(event);
  });
  socket.addEventListener("close", () => retireBookSocket(socket));
  socket.addEventListener("error", () => retireBookSocket(socket));
}

function monitorWebSocketFreshness(now = Date.now()) {
  if (
    marketSocket?.readyState === WebSocket.OPEN &&
    marketConnectedAt > 0 &&
    now - Math.max(marketLastMessageAt, marketConnectedAt) > MARKET_STALE_MS
  ) {
    marketStaleRecoveryAt = now;
    // A socket can remain OPEN while its upstream stream is silently dead.
    // Recycle it so the existing single-flight reconnect path can recover the
    // complete mark/ticker/liquidation feed instead of serving stale data.
    const staleSocket = marketSocket;
    try { staleSocket.close(4000, "stale-market-stream"); } catch { /* reconnect below */ }
    retireMarketSocket(staleSocket);
  }
  if (
    spotKlineSubscriptions.size > 0 &&
    spotKlineSocket?.readyState === WebSocket.OPEN &&
    spotKlineConnectedAt > 0 &&
    now - Math.max(spotKlineLastMessageAt, spotKlineConnectedAt) > 15 * 60_000
  ) {
    spotKlineStaleRecoveryAt = now;
    const staleSocket = spotKlineSocket;
    try { staleSocket.close(4000, "stale-spot-kline-stream"); } catch { /* reconnect below */ }
    retireSpotKlineSocket(staleSocket);
  }
  const watchedBooks = activeBookSymbols(now).length || activeOrderFlowSymbols(now).length;
  if (
    watchedBooks > 0 &&
    bookSocket?.readyState === WebSocket.OPEN &&
    bookConnectedAt > 0 &&
    now - Math.max(bookLastMessageAt, bookConnectedAt) > NEXUS_BOOK_STALE_MS
  ) {
    bookStaleRecoveryAt = now;
    const staleSocket = bookSocket;
    try { staleSocket.close(4000, "stale-book-stream"); } catch { /* reconnect below */ }
    retireBookSocket(staleSocket);
  }
}

async function ensureExchangeInfo() {
  if (exchangeSymbols.size && exchangeInfoUpdatedAt > Date.now() - EXCHANGE_INFO_TTL_MS)
    return exchangeSymbols;
  if (exchangeInfoPromise) return exchangeInfoPromise;
  exchangeInfoPromise = (async () => {
    const searchParams = new URLSearchParams();
    const payload = await fetchPayload(
      "live",
      "/fapi/v1/exchangeInfo",
      "GET",
      { accept: "application/json" },
      "/fapi/v1/exchangeInfo",
      searchParams,
    );
    if (payload.status < 200 || payload.status >= 300)
      throw new Error("Binance 合约规则同步失败");
    const parsed = JSON.parse(payload.body.toString("utf8"));
    exchangeSymbols = new Map((parsed.symbols || []).map((item) => [item.symbol, item]));
    exchangeInfoUpdatedAt = Date.now();
    return exchangeSymbols;
  })().finally(() => { exchangeInfoPromise = null; });
  return exchangeInfoPromise;
}

function marketFreshness(rows) {
  const now = Date.now();
  const oldest = rows.length ? Math.min(...rows.map((row) => row.receivedAt)) : 0;
  return { now, oldest, ageMs: oldest ? now - oldest : Number.POSITIVE_INFINITY };
}

function handleMarkPrices(incoming, response) {
  const symbols = (incoming.searchParams.get("symbols") || "")
    .split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return json(response, 400, { error: "缺少合约代码" });
  const includeHistory = incoming.searchParams.get("includeHistory") === "1";
  if (includeHistory) markPriceHistory.watch(symbols);
  const rows = symbols.map((symbol) => markPrices.get(symbol)).filter(Boolean);
  const freshness = marketFreshness(rows);
  if (rows.length !== symbols.length || freshness.ageMs > MARKET_STALE_MS)
    return json(response, 503, {
      error: "系统 WebSocket 标记价格尚未就绪或已过期",
      source: "BINANCE_WEBSOCKET",
      ageMs: Number.isFinite(freshness.ageMs) ? freshness.ageMs : null,
    }, { "retry-after": "2" });
  if (includeHistory) {
    for (const row of rows)
      markPriceHistory.record({
        symbol: row.symbol,
        markPrice: row.markPrice,
        eventAtMs: row.time,
        receivedAtMs: row.receivedAt,
      });
  }
  recordStat("GET", "/market/mark-prices", "websocketServed");
  return json(response, 200, {
    source: "BINANCE_WEBSOCKET",
    updatedAt: new Date(freshness.oldest).toISOString(),
    ageMs: freshness.ageMs,
    rows: rows.map((row) => ({
      symbol: row.symbol,
      markPrice: row.markPrice,
      fundingRate: row.fundingRate,
      nextFundingTime: row.nextFundingTime,
      time: row.time,
      receivedAt: row.receivedAt,
      snapshotAgeMs: Math.max(0, freshness.now - row.receivedAt),
      transportLatencyMs: Math.max(0, row.receivedAt - row.time),
      ...(includeHistory
        ? { history: markPriceHistory.snapshot(row.symbol, freshness.now) }
        : {}),
    })),
  });
}

function handleMarketVolatility(incoming, response) {
  const symbols = (incoming.searchParams.get("symbols") || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) return json(response, 400, { error: "缺少合约代码" });
  const windowDays = Math.min(7, Math.max(3, Number(incoming.searchParams.get("days") || 7)));
  const rows = symbols.map((symbol) => markPriceHistory.volatility(symbol, Date.now(), windowDays));
  recordStat("GET", "/market/volatility", "cacheServed");
  return json(response, 200, {
    source: "BINANCE_WEBSOCKET_CACHE",
    windowDays,
    updatedAt: new Date().toISOString(),
    rows,
  });
}

async function handleGlobalLiquidations(response) {
  const now = Date.now();
  if (
    globalLiquidationPage &&
    now - globalLiquidationPage.fetchedAt <= GLOBAL_LIQUIDATION_CACHE_MS
  )
    return json(response, 200, {
      source: "COINGLASS_WEB_VIA_READER",
      updatedAt: new Date(globalLiquidationPage.fetchedAt).toISOString(),
      stale: false,
      markdown: globalLiquidationPage.markdown,
    });
  if (!globalLiquidationPagePromise)
    globalLiquidationPagePromise = fetch(GLOBAL_LIQUIDATION_READER_URL, {
      headers: {
        accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": "NexusQuant/1.0 CoinGlass public-page reader",
      },
      signal: AbortSignal.timeout(8_000),
    })
      .then(async (upstream) => {
        if (!upstream.ok)
          throw new Error(`CoinGlass 网页读取返回 ${upstream.status}`);
        const markdown = await upstream.text();
        if (!markdown.trim()) throw new Error("CoinGlass 网页返回空内容");
        globalLiquidationPage = {
          fetchedAt: Date.now(),
          markdown,
        };
        recordStat("GET", "/market/global-liquidations", "upstreamRequests");
        return globalLiquidationPage;
      })
      .finally(() => {
        globalLiquidationPagePromise = null;
      });
  try {
    const current = await globalLiquidationPagePromise;
    return json(response, 200, {
      source: "COINGLASS_WEB_VIA_READER",
      updatedAt: new Date(current.fetchedAt).toISOString(),
      stale: false,
      markdown: current.markdown,
    });
  } catch (error) {
    if (
      globalLiquidationPage &&
      now - globalLiquidationPage.fetchedAt <= GLOBAL_LIQUIDATION_STALE_MS
    )
      return json(response, 200, {
        source: "COINGLASS_WEB_VIA_READER",
        updatedAt: new Date(globalLiquidationPage.fetchedAt).toISOString(),
        stale: true,
        markdown: globalLiquidationPage.markdown,
        error: error instanceof Error ? error.message : "CoinGlass 网页读取失败",
      });
    return json(
      response,
      503,
      {
        error:
          error instanceof Error ? error.message : "CoinGlass 网页读取失败",
      },
      { "retry-after": "60" },
    );
  }
}

function handleTicker(incoming, response) {
  const symbol = (incoming.searchParams.get("symbol") || "").trim().toUpperCase();
  const row = tickers.get(symbol);
  const freshness = marketFreshness(row ? [row] : []);
  if (!row || freshness.ageMs > MARKET_STALE_MS)
    return json(response, 503, { error: "系统 WebSocket 最新价尚未就绪或已过期", source: "BINANCE_WEBSOCKET" }, { "retry-after": "2" });
  recordStat("GET", "/market/ticker", "websocketServed");
  const { receivedAt, ...ticker } = row;
  return json(response, 200, { source: "BINANCE_WEBSOCKET", updatedAt: new Date(receivedAt).toISOString(), ageMs: freshness.ageMs, ticker });
}

function handleBookTickers(incoming, response) {
  const symbols = (incoming.searchParams.get("symbols") || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length)
    return json(response, 400, { error: "缺少盘口监听合约代码" });
  const watch = watchBookSymbols(symbols);
  if (!watch.accepted) return json(response, 409, { error: watch.error });
  const snapshot = bookTickerSnapshot(
    bookTickers,
    symbols,
    Date.now(),
    NEXUS_BOOK_STALE_MS,
    NEXUS_BOOK_SNAPSHOT_STALE_MS,
  );
  const connected = bookSocket?.readyState === WebSocket.OPEN;
  const ready = connected && snapshot.ready;
  recordStat("GET", "/market/book-tickers", "websocketServed");
  return json(response, ready ? 200 : 503, {
    source: "BINANCE_WEBSOCKET_BOOK_TICKER",
    ...snapshot,
    connected,
    ready,
    error: connected ? undefined : "Binance 盘口 WebSocket 当前未连接",
  }, ready ? {} : { "retry-after": "1" });
}

function handleOrderFlow(incoming, response) {
  const symbols = (incoming.searchParams.get("symbols") || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length)
    return json(response, 400, { error: "缺少订单流监听合约代码" });
  const watch = watchBookSymbols(symbols);
  if (!watch.accepted) return json(response, 409, { error: watch.error });
  const orderFlowWatchResult = watchOrderFlowSymbols(symbols);
  if (!orderFlowWatchResult.accepted)
    return json(response, 409, { error: orderFlowWatchResult.error });
  const snapshot = orderFlowTracker.snapshot(symbols, Date.now());
  const connected = bookSocket?.readyState === WebSocket.OPEN;
  const ready = connected && snapshot.ready;
  recordStat("GET", "/market/order-flow", "websocketServed");
  return json(response, ready ? 200 : 503, {
    source: "BINANCE_WEBSOCKET_PUBLIC_ORDER_FLOW",
    ...snapshot,
    connected,
    ready,
    error: connected
      ? snapshot.missing.length
        ? `订单流尚未就绪：${snapshot.missing.join("、")}`
        : snapshot.stale.length
          ? `订单流已经过期：${snapshot.stale.join("、")}`
          : undefined
      : "Binance 订单流 WebSocket 当前未连接",
  }, ready ? {} : { "retry-after": "1" });
}

function handleLiquidations(incoming, response) {
  flushLiquidations();
  const requestedSinceMs = Number(incoming.searchParams.get("sinceMs") || 15_000);
  const sinceMs = Number.isFinite(requestedSinceMs)
    ? Math.min(LIQUIDATION_RETENTION_MS, Math.max(1_000, requestedSinceMs))
    : 15_000;
  const afterSequence = Number(incoming.searchParams.get("afterSequence") || 0);
  const cutoff = Date.now() - sinceMs;
  const rows = liquidationEvents.filter((item) =>
    item.bucketEnd >= cutoff &&
    (!Number.isFinite(afterSequence) || item.sequence > afterSequence),
  );
  recordStat("GET", "/market/liquidations", "websocketServed");
  return json(response, 200, {
    source: "BINANCE_WEBSOCKET",
    aggregationWindowMs: LIQUIDATION_WINDOW_MS,
    lastSequence: liquidationSequence,
    lastEventAt: liquidationLastEventAt
      ? new Date(liquidationLastEventAt).toISOString()
      : null,
    rows,
  });
}

async function handlePrivateOrderEvents(request, incoming, response) {
  const apiKey = request.headers["x-mbx-apikey"];
  if (typeof apiKey !== "string" || !apiKey)
    return json(response, 401, { error: "缺少账户订单流身份" });
  const stream = await ensurePrivateOrderStream(apiKey);
  const afterSequence = Math.max(
    0,
    Number(incoming.searchParams.get("afterSequence")) || 0,
  );
  recordStat("GET", "/private/order-events", "websocketServed");
  return json(response, stream.connected ? 200 : 202, {
    source: "BINANCE_PRIVATE_WEBSOCKET",
    connected: stream.connected,
    connectedAt: stream.connectedAt
      ? new Date(stream.connectedAt).toISOString()
      : null,
    lastMessageAt: stream.lastMessageAt
      ? new Date(stream.lastMessageAt).toISOString()
      : null,
    ...stream.store.snapshot(),
    rows: stream.store.after(afterSequence),
  });
}

async function handleContracts(response) {
  const symbols = await ensureExchangeInfo();
  const marketAgeMs = marketLastMessageAt ? Date.now() - marketLastMessageAt : Number.POSITIVE_INFINITY;
  if (marketAgeMs > MARKET_STALE_MS)
    return json(response, 503, { error: "系统 WebSocket 合约行情尚未就绪", source: "BINANCE_WEBSOCKET" }, { "retry-after": "2" });
  const rows = [];
  let quotedCount = 0;
  for (const item of symbols.values()) {
    if (!isSupportedBinanceUsdtPerpetual(item)) continue;
    const ticker = tickers.get(item.symbol);
    if (ticker) quotedCount += 1;
    const quantityFilters = (item.filters || []).filter((filter) => ["LOT_SIZE", "MARKET_LOT_SIZE"].includes(filter.filterType));
    const minimums = quantityFilters.map((filter) => Number(filter.minQty)).filter((value) => Number.isFinite(value) && value > 0);
    const steps = quantityFilters.map((filter) => Number(filter.stepSize)).filter((value) => Number.isFinite(value) && value > 0);
    const minNotionalFilter = (item.filters || []).find((filter) => filter.filterType === "MIN_NOTIONAL");
    const minNotionalUsdt = Number(minNotionalFilter?.notional);
    const priceFilter = (item.filters || []).find((filter) => filter.filterType === "PRICE_FILTER");
    const priceTickSize = Number(priceFilter?.tickSize);
    rows.push({
      symbol: item.symbol,
      displayName: item.baseAsset,
      contractType: item.contractType,
      underlyingType: item.underlyingType ?? null,
      minOrderQty: minimums.length ? Math.max(...minimums) : 0.00000001,
      quantityStep: steps.length ? Math.max(...steps) : 0.00000001,
      minNotionalUsdt: Number.isFinite(minNotionalUsdt) && minNotionalUsdt > 0 ? minNotionalUsdt : 5,
      priceTickSize: Number.isFinite(priceTickSize) && priceTickSize > 0 ? priceTickSize : 0.00000001,
      price: markPrices.get(item.symbol)?.markPrice ?? ticker?.lastPrice ?? 0,
      change: ticker?.priceChangePercent ?? 0,
      high: ticker?.highPrice ?? 0,
      low: ticker?.lowPrice ?? 0,
      quoteVolume: ticker?.quoteVolume ?? 0,
    });
  }
  if (!rows.length)
    return json(response, 503, { error: "系统 WebSocket 合约行情尚未就绪", source: "BINANCE_WEBSOCKET" }, { "retry-after": "2" });
  recordStat("GET", "/market/contracts", "websocketServed");
  return json(response, 200, { source: "BINANCE_WEBSOCKET", updatedAt: new Date(marketLastMessageAt).toISOString(), ageMs: marketAgeMs, eligibleCount: rows.length, quotedCount, rows });
}

async function handleContract(incoming, response) {
  const symbol = (incoming.searchParams.get("symbol") || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol))
    return json(response, 400, { error: "合约代码无效" });
  const symbols = await ensureExchangeInfo();
  const item = symbols.get(symbol);
  if (
    !isSupportedBinanceUsdtPerpetual(item)
  )
    return json(response, 404, { error: `${symbol} 不是 Binance 当前可交易的 USDT 永续或 TradFi 永续合约` });
  const mark = markPrices.get(symbol);
  const freshness = marketFreshness(mark ? [mark] : []);
  if (!mark || freshness.ageMs > MARKET_STALE_MS)
    return json(response, 503, {
      error: `${symbol} Binance WebSocket 标记价格尚未就绪或已过期`,
      source: "BINANCE_WEBSOCKET",
    }, { "retry-after": "2" });
  const ticker = tickers.get(symbol);
  const quantityFilters = (item.filters || []).filter((filter) =>
    ["LOT_SIZE", "MARKET_LOT_SIZE"].includes(filter.filterType),
  );
  const minimums = quantityFilters
    .map((filter) => Number(filter.minQty))
    .filter((value) => Number.isFinite(value) && value > 0);
  const steps = quantityFilters
    .map((filter) => Number(filter.stepSize))
    .filter((value) => Number.isFinite(value) && value > 0);
  const minNotionalFilter = (item.filters || []).find(
    (filter) => filter.filterType === "MIN_NOTIONAL",
  );
  const minNotionalUsdt = Number(minNotionalFilter?.notional);
  const priceFilter = (item.filters || []).find(
    (filter) => filter.filterType === "PRICE_FILTER",
  );
  const priceTickSize = Number(priceFilter?.tickSize);
  recordStat("GET", "/market/contract", "websocketServed");
  return json(response, 200, {
    source: "BINANCE_EXCHANGE_INFO_AND_WEBSOCKET_MARK",
    updatedAt: new Date(mark.receivedAt).toISOString(),
    ageMs: freshness.ageMs,
    contract: {
      symbol,
      displayName: item.baseAsset,
      contractType: item.contractType,
      underlyingType: item.underlyingType ?? null,
      minOrderQty: minimums.length ? Math.max(...minimums) : 0.00000001,
      quantityStep: steps.length ? Math.max(...steps) : 0.00000001,
      minNotionalUsdt:
        Number.isFinite(minNotionalUsdt) && minNotionalUsdt > 0
          ? minNotionalUsdt
          : 5,
      priceTickSize:
        Number.isFinite(priceTickSize) && priceTickSize > 0
          ? priceTickSize
          : 0.00000001,
      price: mark.markPrice,
      change: ticker?.priceChangePercent ?? 0,
      high: ticker?.highPrice ?? 0,
      low: ticker?.lowPrice ?? 0,
      quoteVolume: ticker?.quoteVolume ?? 0,
    },
  });
}

function metricsPayload() {
  const now = Date.now();
  const localWeight = localUsedWeight(now);
  const tradingWeight = localUsedWeight(now, "TRADING");
  const observationWeight = localUsedWeight(now, "OBSERVATION");
  pruneFuturesDataRequestEvents(futuresDataRequestEvents, now, FUTURES_DATA_WINDOW_MS);
  const routes = [...requestStats.values()].sort((a, b) =>
    b.internalRequests - a.internalRequests || b.estimatedWeight - a.estimatedWeight,
  );
  const upstreamRoutes = routes.filter((item) => item.upstreamRequests > 0);
  const klineWeightAudit = summarizeBinanceKlineWeightAudit({
    events: restWeightAuditEvents,
    rateLimitEvents: restRateLimitEvents,
    observationWeight,
    observationLimit: OBSERVATION_WEIGHT_LIMIT,
    now,
    startedAt: proxyStartedAt,
  });
  return {
    websocket: {
      connected: marketSocket?.readyState === WebSocket.OPEN,
      connectedAt: marketConnectedAt ? new Date(marketConnectedAt).toISOString() : null,
      lastMessageAt: marketLastMessageAt ? new Date(marketLastMessageAt).toISOString() : null,
      ageMs: marketLastMessageAt ? now - marketLastMessageAt : null,
      reconnectAttempt,
      staleRecoveryAt: marketStaleRecoveryAt
        ? new Date(marketStaleRecoveryAt).toISOString()
        : null,
      markSymbols: markPrices.size,
      tickerSymbols: tickers.size,
      liquidationEventsRetained: liquidationEvents.length,
      liquidationFingerprintEntries: liquidationFingerprints.size,
      liquidationFingerprintLimit: LIQUIDATION_MAX_FINGERPRINTS,
      liquidationLastEventAt: liquidationLastEventAt
        ? new Date(liquidationLastEventAt).toISOString()
        : null,
    },
    spotKlineWebsocket: {
      connected: spotKlineSocket?.readyState === WebSocket.OPEN,
      connectedAt: spotKlineConnectedAt ? new Date(spotKlineConnectedAt).toISOString() : null,
      lastMessageAt: spotKlineLastMessageAt ? new Date(spotKlineLastMessageAt).toISOString() : null,
      ageMs: spotKlineLastMessageAt ? now - spotKlineLastMessageAt : null,
      reconnectAttempt: spotKlineReconnectAttempt,
      staleRecoveryAt: spotKlineStaleRecoveryAt ? new Date(spotKlineStaleRecoveryAt).toISOString() : null,
      subscriptions: spotKlineSubscriptions.size,
      cachedSeries: spotKlineCache.size,
      intervals: ["3d", "1w"],
      source: "Binance Spot WebSocket with REST bootstrap fallback",
    },
    spotTickerWebsocket: {
      connected: spotKlineSocket?.readyState === WebSocket.OPEN,
      symbols: spotTickerCache.size,
      ageMs: spotKlineLastMessageAt ? now - spotKlineLastMessageAt : null,
      source: "Binance Spot !ticker@arr WebSocket",
    },
    bookEye: {
      connected: bookSocket?.readyState === WebSocket.OPEN,
      connectedAt: bookConnectedAt
        ? new Date(bookConnectedAt).toISOString()
        : null,
      lastMessageAt: bookLastMessageAt
        ? new Date(bookLastMessageAt).toISOString()
        : null,
      ageMs: bookLastMessageAt ? now - bookLastMessageAt : null,
      reconnectAttempt: bookReconnectAttempt,
      staleRecoveryAt: bookStaleRecoveryAt
        ? new Date(bookStaleRecoveryAt).toISOString()
        : null,
      watchedSymbols: activeBookSymbols(now).length,
      readySymbols: bookTickers.size,
      maxTransportLatencyMs: NEXUS_BOOK_STALE_MS,
      snapshotStaleAfterMs: NEXUS_BOOK_SNAPSHOT_STALE_MS,
      orderFlowWatchedSymbols: activeOrderFlowSymbols(now).length,
      orderFlowWatchLimit: ORDER_FLOW_WATCH_LIMIT,
      subscribedStreamsPerOrderFlowSymbol: 2,
      orderFlowSource: "DEPTH10_100MS_AND_TRADE",
    },
    privateOrderEye: {
      accounts: privateOrderStreams.size,
      connectedAccounts: [...privateOrderStreams.values()].filter(
        (stream) => stream.connected,
      ).length,
      retainedEvents: [...privateOrderStreams.values()].reduce(
        (total, stream) => total + stream.store.snapshot().retained,
        0,
      ),
      eventLimitPerAccount: PRIVATE_ORDER_EVENT_LIMIT,
    },
    liquidationNotionalDistribution:
      liquidationNotionalTracker.snapshot(now),
    rest: {
      hardLimitPerMinute: TRADING_WEIGHT_LIMIT,
      admissionLimitPerMinute: TRADING_ADMISSION_LIMIT,
      safetyReserve: TRADING_WEIGHT_LIMIT - TRADING_ADMISSION_LIMIT,
      localEstimatedWeight: localWeight,
      projectHardLimitPerMinute: PROJECT_WEIGHT_LIMIT,
      projectTradingAdmissionLimitPerMinute:
        PROJECT_TRADING_ADMISSION_LIMIT,
      projectObservationAdmissionLimitPerMinute:
        PROJECT_OBSERVATION_ADMISSION_LIMIT,
      projectRemainingWeight: Math.max(
        0,
        PROJECT_WEIGHT_LIMIT - localWeight,
      ),
      tradingEstimatedWeight: tradingWeight,
      tradingWeightLimitPerMinute: TRADING_WEIGHT_LIMIT,
      tradingAdmissionLimitPerMinute: TRADING_ADMISSION_LIMIT,
      tradingRemainingWeight: Math.max(0, TRADING_WEIGHT_LIMIT - tradingWeight),
      observationEstimatedWeight: observationWeight,
      observationWeightLimitPerMinute: OBSERVATION_WEIGHT_LIMIT,
      observationRemainingWeight: Math.max(0, OBSERVATION_WEIGHT_LIMIT - observationWeight),
      binanceObservedWeight: observedUsedWeight,
      effectiveUsedWeight: Math.max(localWeight, observedUsedWeight),
      unattributedWeight: Math.max(0, observedUsedWeight - localWeight),
      remainingWeight: Math.max(0, TRADING_WEIGHT_LIMIT - tradingWeight),
      globalIpWeightLimitPerMinute: GLOBAL_IP_WEIGHT_LIMIT,
      globalIpAdmissionLimitPerMinute: GLOBAL_IP_ADMISSION_LIMIT,
      globalObservationPauseWeight: GLOBAL_OBSERVATION_PAUSE_WEIGHT,
      globalRemainingWeight: Math.max(
        0,
        GLOBAL_IP_WEIGHT_LIMIT - Math.max(localWeight, observedUsedWeight),
      ),
    },
    orderRate: {
      domain: "ORDER_UID",
      observedOrderCount10s,
      observedOrderCount1m,
      observedAt: observedOrderCountAt
        ? new Date(observedOrderCountAt).toISOString()
        : null,
    },
    rateLimitDomains: {
      restIp: "ACTIVE",
      orderUid: "OBSERVED_AND_SCOPED_BACKOFF",
      websocketIp: "SHADOW_READY",
    },
    futuresData: {
      windowMs: FUTURES_DATA_WINDOW_MS,
      requestLimit: FUTURES_DATA_REQUEST_LIMIT,
      upstreamRequests: futuresDataRequestEvents.length,
      remainingRequests: Math.max(0, FUTURES_DATA_REQUEST_LIMIT - futuresDataRequestEvents.length),
    },
    klineWeightAudit,
    sharedResponseCache: {
      ...responseCache.metrics(),
      inFlightLoads: inFlight.size,
    },
    topByInternalRequestCount: routes[0] || null,
    topByUpstreamRequestCount: [...upstreamRoutes].sort((a, b) => b.upstreamRequests - a.upstreamRequests)[0] || null,
    topByEstimatedWeight: [...upstreamRoutes].sort((a, b) => b.estimatedWeight - a.estimatedWeight)[0] || null,
    routes,
  };
}

async function forward(request, response) {
  try {
    const incoming = new URL(request.url || "/", "http://binance-proxy");
    recordStat(request.method || "GET", incoming.pathname, "internalRequests");
    if (incoming.pathname === "/health")
      return json(response, 200, { ok: true, websocketConnected: marketSocket?.readyState === WebSocket.OPEN, marketAgeMs: marketLastMessageAt ? Date.now() - marketLastMessageAt : null });
    if (incoming.pathname === "/metrics") return json(response, 200, metricsPayload());
    if (incoming.pathname === "/market/mark-prices") return handleMarkPrices(incoming, response);
    if (incoming.pathname === "/market/volatility") return handleMarketVolatility(incoming, response);
    if (incoming.pathname === "/market/global-liquidations")
      return await handleGlobalLiquidations(response);
    if (incoming.pathname === "/market/ticker") return handleTicker(incoming, response);
    if (incoming.pathname === "/market/spot-klines") return await handleSpotKlines(incoming, response);
    if (incoming.pathname === "/market/spot-ticker") return handleSpotTicker(incoming, response);
    if (incoming.pathname === "/market/book-tickers") return handleBookTickers(incoming, response);
    if (incoming.pathname === "/market/order-flow") return handleOrderFlow(incoming, response);
    if (incoming.pathname === "/private/order-events")
      return await handlePrivateOrderEvents(request, incoming, response);
    if (incoming.pathname === "/market/liquidations") return handleLiquidations(incoming, response);
    if (incoming.pathname === "/market/contract") return await handleContract(incoming, response);
    if (incoming.pathname === "/market/contracts") return await handleContracts(response);

    const match = incoming.pathname.match(
      /^\/(live|spot)(\/(?:fapi\/v\d+\/[A-Za-z0-9/_-]+|api\/v\d+\/[A-Za-z0-9/_-]+|futures\/data\/(?:openInterestHist|topLongShortPositionRatio|topLongShortAccountRatio|takerlongshortRatio)))$/,
    );
    if (!match || !["GET", "POST", "DELETE"].includes(request.method || "")) {
      response.writeHead(404); return response.end();
    }
    if ((request.url || "").length > 8192) { response.writeHead(414); return response.end(); }
    const environment = match[1];
    const pathname = match[2];
    const protectiveClose = request.headers["x-nq-protective-close"] === "1" &&
      isProtectiveCloseRequest(request.method, pathname);
    const path = `${pathname}${incoming.search}`;
    const sharedKline = sharedKlineRequestPlan({
      environment,
      method: request.method || "GET",
      pathname,
      searchParams: incoming.searchParams,
    });
    const upstreamPath = sharedKline?.canonicalPath ?? path;
    const upstreamSearchParams = sharedKline?.upstreamSearchParams ??
      incoming.searchParams;
    const headers = { accept: "application/json" };
    const apiKey = request.headers["x-mbx-apikey"];
    if (typeof apiKey === "string") headers["X-MBX-APIKEY"] = apiKey;
    const privateScope =
      typeof apiKey === "string" ? apiKeyScope(apiKey) : null;
    if (typeof apiKey === "string")
      ensurePrivateOrderStream(apiKey).catch(() => undefined);
    const uidBlock =
      typeof apiKey === "string"
        ? blocked.get(`ORDER_UID:${apiKeyScope(apiKey)}`)
        : null;
    const ipBlock = blocked.get(`REST_IP:${environment}`);
    const block = [uidBlock, ipBlock]
      .filter((item) => item && item.until > Date.now())
      .sort((left, right) => right.until - left.until)[0];
    if (block && block.until > Date.now()) {
      const seconds = Math.max(1, Math.ceil((block.until - Date.now()) / 1_000));
      recordStat(request.method, pathname, "blocked");
      return json(response, block.status, { code: -1003, msg: "Binance rate-limit backoff active", retryAfterSeconds: seconds }, { "retry-after": String(seconds) });
    }
    if (uidBlock && uidBlock.until <= Date.now())
      blocked.delete(`ORDER_UID:${apiKeyScope(apiKey)}`);
    if (ipBlock && ipBlock.until <= Date.now())
      blocked.delete(`REST_IP:${environment}`);

    const mutatesPrivateState = Boolean(
      privateScope &&
      mutatesPrivateAccountState(request.method || "", pathname),
    );
    if (privateScope && mutatesPrivateState)
      invalidatePrivateStateCache(privateScope);

    const publicTtl = request.method === "GET" &&
      (typeof apiKey !== "string" || sharedMarketDataPath(pathname))
      ? cacheTtl(environment, pathname, upstreamSearchParams)
      : 0;
    const privateTtl = privateStateCacheTtl(
      request.method || "",
      pathname,
      Boolean(privateScope),
    );
    const ttl = Math.max(publicTtl, privateTtl);
    const cacheKey =
      privateTtl > 0 && privateScope
        ? privateStateCacheKey({
            environment,
            pathname,
            apiKeyScope: privateScope,
            epoch: privateStateCacheEpoch(privateScope),
            searchParams: incoming.searchParams,
          })
        : sharedKline?.cacheKey ?? `${environment}:${path}`;
    const cached = ttl > 0 ? responseCache.get(cacheKey) : null;
    if (cached) {
      recordStat(request.method, pathname, "cacheServed");
      return send(
        response,
        sharedKline
          ? projectSharedKlinePayload(cached, sharedKline.requestedLimit)
          : cached,
      );
    }

    let requestPromise = ttl > 0 ? inFlight.get(cacheKey) : null;
    if (!requestPromise) {
      requestPromise = fetchPayload(
        environment,
        upstreamPath,
        request.method,
        headers,
        pathname,
        upstreamSearchParams,
        protectiveClose,
      );
      if (ttl > 0) inFlight.set(cacheKey, requestPromise);
    }
    let payload;
    try { payload = await requestPromise; }
    finally { if (ttl > 0 && inFlight.get(cacheKey) === requestPromise) inFlight.delete(cacheKey); }
    if (
      privateScope &&
      mutatesPrivateState &&
      payload.status >= 200 &&
      payload.status < 300
    )
      invalidatePrivateStateCache(privateScope);
    if (ttl > 0 && payload.status >= 200 && payload.status < 300) {
      responseCache.set(cacheKey, payload, Date.now() + ttl);
    }
    send(
      response,
      sharedKline
        ? projectSharedKlinePayload(payload, sharedKline.requestedLimit)
        : payload,
    );
  } catch (error) {
    json(response, 502, { code: -1, msg: error instanceof Error ? error.message : "Binance upstream unavailable" });
  }
}

connectMarketStream();
connectBookStream();
connectSpotKlineStream();
setInterval(() => monitorWebSocketFreshness(), 1_000);
ensureExchangeInfo().catch(() => {});
setInterval(() => flushLiquidations(), 250).unref();
setInterval(() => syncBookSubscriptions(), 5_000).unref();
setInterval(() => maintainPrivateOrderStreams(), 60_000).unref();
http.createServer(forward).listen(port, "0.0.0.0");
