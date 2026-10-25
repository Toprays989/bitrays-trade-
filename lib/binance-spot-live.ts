import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";

const SPOT_DIRECT_BASE_URL = "https://api.binance.com";
const REQUEST_TIMEOUT_MS = 7_000;

export class BinanceSpotError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: number, public readonly executionUnknown = false) {
    super(message);
  }
}

type SpotCredentials = { apiKey: string; secretKey: string };

type PublicCacheEntry<T> = { expiresAt: number; value?: T; pending?: Promise<T> };
const publicCache = new Map<string, PublicCacheEntry<unknown>>();

async function cachedPublic<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = publicCache.get(key) as PublicCacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    if (existing.pending) return existing.pending;
    if (existing.value !== undefined) return existing.value;
  }
  const pending = loader();
  publicCache.set(key, { expiresAt: now + ttlMs, pending });
  try {
    const value = await pending;
    publicCache.set(key, { expiresAt: Date.now() + ttlMs, value });
    return value;
  } catch (error) {
    if (publicCache.get(key)?.pending === pending) publicCache.delete(key);
    throw error;
  }
}

function spotBaseUrl() {
  const proxy = (env as unknown as { NQ_BINANCE_PROXY_URL?: string }).NQ_BINANCE_PROXY_URL?.replace(/\/$/, "");
  return proxy ? `${proxy}/spot` : SPOT_DIRECT_BASE_URL;
}

function spotProxyUrl() {
  return (env as unknown as { NQ_BINANCE_PROXY_URL?: string }).NQ_BINANCE_PROXY_URL?.replace(/\/$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new BinanceSpotError("Binance Spot 请求超时", 504, undefined, true);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function json<T>(response: Response): Promise<T & { code?: number; msg?: string }> {
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") throw new BinanceSpotError("Binance Spot 返回格式异常", response.status || 502);
  return payload as T & { code?: number; msg?: string };
}

let serverTimeOffset = 0;
let serverTimeExpiresAt = 0;
async function getServerTime() {
  if (serverTimeExpiresAt > Date.now()) return Date.now() + serverTimeOffset;
  const response = await fetchWithTimeout(`${spotBaseUrl()}/api/v3/time`);
  const payload = await json<{ serverTime?: number }>(response);
  if (!response.ok || !Number.isFinite(Number(payload.serverTime))) throw new BinanceSpotError(payload.msg || "Binance Spot 时间服务不可用", response.status);
  serverTimeOffset = Number(payload.serverTime) - Date.now();
  serverTimeExpiresAt = Date.now() + 30_000;
  return Number(payload.serverTime);
}

async function signedSpotRequest<T>(credentials: SpotCredentials, method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | boolean> = {}, executionUnknownOnTimeout = false) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  query.set("recvWindow", "5000");
  query.set("timestamp", String(await getServerTime()));
  query.set("signature", createHmac("sha256", credentials.secretKey).update(query.toString()).digest("hex"));
  let response: Response;
  try {
    response = await fetchWithTimeout(`${spotBaseUrl()}${path}?${query.toString()}`, { method, headers: { "X-MBX-APIKEY": credentials.apiKey, accept: "application/json" } });
  } catch (error) {
    if (executionUnknownOnTimeout && error instanceof BinanceSpotError) throw new BinanceSpotError(error.message, error.status, error.code, true);
    throw error;
  }
  const payload = await json<T>(response);
  if (!response.ok) throw new BinanceSpotError(payload.msg || "Binance Spot 请求失败", response.status, payload.code);
  return payload;
}

export async function getBinanceSpotAccount(credentials: SpotCredentials) {
  return signedSpotRequest<{ accountType?: string; balances?: Array<{ asset: string; free: string; locked: string }>; permissions?: string[] }>(credentials, "GET", "/api/v3/account");
}

export async function getBinanceSpotTickerPrice(symbol: string) {
  const normalized = symbol.toUpperCase();
  return cachedPublic(`price:${normalized}`, 1_000, async () => {
    const proxy = spotProxyUrl();
    const response = await fetchWithTimeout(proxy
      ? `${proxy}/market/spot-ticker?symbol=${encodeURIComponent(normalized)}`
      : `${spotBaseUrl()}/api/v3/ticker/price?symbol=${encodeURIComponent(normalized)}`);
    const payload = await json<{ symbol?: string; price?: string; lastPrice?: number }>(response);
    const price = Number(payload.price ?? payload.lastPrice);
    if (!response.ok || !Number.isFinite(price) || price <= 0) throw new BinanceSpotError(payload.msg || `无法取得 ${symbol} 现货价格`, response.status || 502);
    return price;
  });
}

export async function getBinanceSpotTicker24h(symbol: string) {
  const normalized = symbol.toUpperCase();
  return cachedPublic(`ticker24h:${normalized}`, 5_000, async () => {
    const proxy = spotProxyUrl();
    const response = await fetchWithTimeout(proxy
      ? `${proxy}/market/spot-ticker?symbol=${encodeURIComponent(normalized)}`
      : `${spotBaseUrl()}/api/v3/ticker/24hr?symbol=${encodeURIComponent(normalized)}`);
    const payload = await json<{ symbol?: string; lastPrice?: string; highPrice?: string; lowPrice?: string; priceChangePercent?: string; quoteVolume?: string }>(response);
    if (!response.ok) throw new BinanceSpotError(payload.msg || `无法取得 ${symbol} 24小时行情`, response.status || 502);
    return {
      symbol: String(payload.symbol || symbol).toUpperCase(),
      lastPrice: Number(payload.lastPrice),
      highPrice: Number(payload.highPrice),
      lowPrice: Number(payload.lowPrice),
      priceChangePercent: Number(payload.priceChangePercent),
      quoteVolume: Number(payload.quoteVolume),
    };
  });
}

export async function getBinanceSpotKlines(symbol: string, interval: "3d" | "1w", limit = 52) {
  const cappedLimit = Math.max(2, Math.min(52, Math.trunc(limit)));
  const proxy = spotProxyUrl();
  const normalized = symbol.toUpperCase();
  const ttlMs = interval === "1w" ? 10 * 60_000 : 60_000;
  return cachedPublic(`klines:${normalized}:${interval}:${cappedLimit}`, ttlMs, async () => {
    const response = await fetchWithTimeout(proxy
      ? `${proxy}/market/spot-klines?symbol=${encodeURIComponent(normalized)}&interval=${interval}&limit=${cappedLimit}`
      : `${spotBaseUrl()}/api/v3/klines?symbol=${encodeURIComponent(normalized)}&interval=${interval}&limit=${cappedLimit}`);
    const payload = await json<unknown>(response);
    if (!response.ok || !Array.isArray(payload)) throw new BinanceSpotError(`无法取得现货${interval}行情`, response.status || 502);
    return payload.map((row) => Array.isArray(row) ? { high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) } : null).filter((row): row is { high: number; low: number; close: number } => !!row && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
  });
}

export type SpotOrderRequest = {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity?: number;
  quoteOrderQty?: number;
  price?: number;
  timeInForce?: "GTC" | "IOC" | "FOK";
  newClientOrderId: string;
};

export async function placeBinanceSpotOrder(credentials: SpotCredentials, order: SpotOrderRequest) {
  if (!order.quantity && !order.quoteOrderQty) throw new BinanceSpotError("现货订单必须提供数量或报价金额", 400);
  if (order.type === "LIMIT" && (!order.quantity || !order.price || !order.timeInForce)) throw new BinanceSpotError("限价单缺少数量、价格或有效期", 400);
  return signedSpotRequest<{
    symbol: string;
    orderId: string | number;
    clientOrderId: string;
    status: string;
    executedQty: string;
    cummulativeQuoteQty: string;
    fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
  }>(credentials, "POST", "/api/v3/order", {
    symbol: order.symbol.toUpperCase(), side: order.side, type: order.type,
    ...(order.quantity ? { quantity: order.quantity } : {}),
    ...(order.quoteOrderQty ? { quoteOrderQty: order.quoteOrderQty } : {}),
    ...(order.price ? { price: order.price } : {}),
    ...(order.timeInForce ? { timeInForce: order.timeInForce } : {}),
    newClientOrderId: order.newClientOrderId,
  }, true);
}

export async function queryBinanceSpotOrder(credentials: SpotCredentials, symbol: string, clientOrderId: string) {
  return signedSpotRequest<{ symbol: string; orderId: string | number; clientOrderId: string; status: string; executedQty: string; cummulativeQuoteQty: string; price: string }>(credentials, "GET", "/api/v3/order", { symbol: symbol.toUpperCase(), origClientOrderId: clientOrderId });
}

export async function cancelBinanceSpotOrder(credentials: SpotCredentials, symbol: string, clientOrderId: string) {
  return signedSpotRequest<{ symbol: string; orderId: string | number; clientOrderId: string; status: string }>(credentials, "DELETE", "/api/v3/order", { symbol: symbol.toUpperCase(), origClientOrderId: clientOrderId }, true);
}

export async function getBinanceSpotOpenOrders(credentials: SpotCredentials, symbol?: string) {
  return signedSpotRequest<Array<{ symbol: string; orderId: string | number; clientOrderId: string; status: string; price: string; origQty: string; executedQty: string }>>(credentials, "GET", "/api/v3/openOrders", symbol ? { symbol: symbol.toUpperCase() } : {});
}
