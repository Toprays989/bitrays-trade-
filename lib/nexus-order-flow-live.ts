import { env } from "cloudflare:workers";

export type NexusLiveOrderFlow = {
  version: "nexus-order-flow-eye-v4";
  evidenceKind: "PUBLIC_ORDER_FLOW_PROXY";
  symbol: string;
  eventTime: number;
  receivedAt: number;
  ageMs: number;
  fresh: boolean;
  transportLatencyMs: number;
  orderFlowReady: boolean;
  bestBidPrice: number;
  bestAskPrice: number;
  weightedBidNotional: number;
  weightedAskNotional: number;
  depthImbalance: number;
  bidWallPrice: number;
  bidWallNotional: number;
  bidWallPersistence: number;
  bidWallReliability: number;
  askWallPrice: number;
  askWallNotional: number;
  askWallPersistence: number;
  askWallReliability: number;
  depthSampleCount10s: number;
  depthCoverageMs10s: number;
  bidLiquidityPullRatio10s: number;
  askLiquidityPullRatio10s: number;
  bidReplenishmentRatio10s: number;
  askReplenishmentRatio10s: number;
  liquidityEvent:
    | "BID_LIQUIDITY_PULL"
    | "ASK_LIQUIDITY_PULL"
    | "BID_REPLENISHMENT"
    | "ASK_REPLENISHMENT"
    | "STABLE"
    | "INSUFFICIENT";
  aggressorBuyNotional1s: number;
  aggressorSellNotional1s: number;
  aggressorImbalance1s: number;
  aggressorBuyNotional3s: number;
  aggressorSellNotional3s: number;
  aggressorImbalance3s: number;
  aggressorBuyNotional10s: number;
  aggressorSellNotional10s: number;
  aggressorImbalance10s: number;
  tradeCount10s: number;
  tradeToDepthRatio10s: number;
  priceImpactBps10s: number;
  flowDirection: "BUY" | "SELL" | "MIXED";
  absorption: "BID_ABSORPTION" | "ASK_ABSORPTION" | "NONE";
  proxyState:
    | "PERSISTENT_BUY_EXECUTION"
    | "PERSISTENT_SELL_EXECUTION"
    | "PASSIVE_BID_ABSORPTION"
    | "PASSIVE_ASK_ABSORPTION"
    | "BID_LIQUIDITY_PULLED"
    | "ASK_LIQUIDITY_PULLED"
    | "MIXED"
    | "INSUFFICIENT";
  confidence: number;
  limitations: string[];
};

/**
 * Read-only local proxy client. It cannot sign or submit an exchange order.
 * A warming or unavailable stream is reported to the caller as missing shadow
 * evidence and must never block the existing real execution path.
 */
export async function getNexusLiveOrderFlow(symbols: string[]) {
  const normalized = [...new Set(symbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean))];
  if (!normalized.length)
    return { ready: false, missing: [] as string[], rows: [] as NexusLiveOrderFlow[] };
  const proxy = (env as unknown as { NQ_BINANCE_PROXY_URL?: string })
    .NQ_BINANCE_PROXY_URL?.replace(/\/$/, "");
  if (!proxy) throw new Error("系统统一 WebSocket 行情服务未配置");
  const controller = new AbortController();
  // This is a local proxy lookup on the shadow path. Keep the deadline short so
  // unavailable order-flow evidence cannot add material latency to a real order.
  const timeout = setTimeout(() => controller.abort(), 100);
  try {
    const query = new URLSearchParams({ symbols: normalized.join(",") });
    const response = await fetch(`${proxy}/market/order-flow?${query}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json() as {
      ready?: boolean;
      missing?: string[];
      rows?: NexusLiveOrderFlow[];
      error?: string;
    };
    if (!response.ok && response.status !== 503)
      throw new Error(payload.error || "系统实时订单流尚未就绪");
    return {
      ready: payload.ready === true,
      missing: Array.isArray(payload.missing) ? payload.missing : [],
      rows: Array.isArray(payload.rows) ? payload.rows : [],
    };
  } finally {
    clearTimeout(timeout);
  }
}
