import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { contractSymbols } from "../../../../db/schema";
import { getNexusLiveOrderFlow } from "../../../../lib/nexus-order-flow-live";
import { deriveNexusBrainShadowState } from "../../../../lib/nexus-brain-shadow-state";
import { nexusMarketFactBuffer } from "../../../../lib/nexus-market-fact-buffer";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

const MAX_WATCH_SYMBOLS = 20;

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function distanceBps(price: number, wall: number) {
  return price > 0 && wall > 0 ? ((wall - price) / price) * 10_000 : null;
}

function wallState(row: Awaited<ReturnType<typeof getNexusLiveOrderFlow>>["rows"][number]) {
  if (!row.orderFlowReady) return "WARMING";
  if (row.proxyState === "BID_LIQUIDITY_PULLED") return "BID_PULLED";
  if (row.proxyState === "ASK_LIQUIDITY_PULLED") return "ASK_PULLED";
  if (row.absorption === "BID_ABSORPTION") return "BID_ABSORPTION";
  if (row.absorption === "ASK_ABSORPTION") return "ASK_ABSORPTION";
  if (row.flowDirection === "BUY") return "BUY_PRESSURE";
  if (row.flowDirection === "SELL") return "SELL_PRESSURE";
  return "BALANCED";
}

function directionForWall(row: Awaited<ReturnType<typeof getNexusLiveOrderFlow>>["rows"][number]) {
  if (row.flowDirection === "BUY" || row.absorption === "BID_ABSORPTION") return "LONG" as const;
  if (row.flowDirection === "SELL" || row.absorption === "ASK_ABSORPTION") return "SHORT" as const;
  return null;
}

function evaluatePhaseTwo(row: Awaited<ReturnType<typeof getNexusLiveOrderFlow>>["rows"][number]) {
  const now = Date.now();
  const facts = nexusMarketFactBuffer.query({
    symbol: row.symbol,
    freshOnly: true,
    now,
    preserveLatestByKindInterval: true,
    limit: 160,
  });
  const longBrain = deriveNexusBrainShadowState({ direction: "LONG", facts, now });
  const shortBrain = deriveNexusBrainShadowState({ direction: "SHORT", facts, now });
  const direction = directionForWall(row);
  const brain = direction === "LONG" ? longBrain : direction === "SHORT" ? shortBrain : null;
  const reliability = direction === "LONG" ? row.bidWallReliability : direction === "SHORT" ? row.askWallReliability : 0;
  const pulled = direction === "LONG" ? row.proxyState === "BID_LIQUIDITY_PULLED" : direction === "SHORT" ? row.proxyState === "ASK_LIQUIDITY_PULLED" : false;
  const eye = !row.orderFlowReady || !row.fresh
    ? "WAIT"
    : pulled || reliability < 0.35
      ? "INVALIDATED"
      : row.confidence >= 0.55 && reliability >= 0.55 && direction
        ? "READY"
        : "WAIT";
  const status = pulled || (brain?.state === "INVALIDATED") || eye === "INVALIDATED"
    ? "INVALIDATED"
    : brain?.state === "READY_SHADOW" && eye === "READY"
      ? "READY"
      : "WAIT";
  return {
    status,
    direction,
    waitReason: status === "WAIT" ? (brain?.reasons[0]?.message ?? "等待订单流方向、墙体可靠性和大脑事实闭合") : null,
    brain: {
      long: longBrain.state,
      short: shortBrain.state,
      selected: brain?.state ?? "OBSERVING",
      reason: brain?.reasons[0]?.message ?? "订单流方向尚未形成，等待大脑方向事实",
      factCount: facts.length,
    },
    marketEye: {
      status: eye,
      reason: !row.orderFlowReady || !row.fresh
        ? "订单流数据尚未新鲜完整"
        : pulled
          ? "方向墙体发生撤单"
          : reliability < 0.35
            ? "方向墙体可靠性不足"
            : row.confidence >= 0.55 && reliability >= 0.55 && direction
              ? "订单流、墙体可靠性和主动成交方向已满足时机门槛"
              : "等待主动成交方向、墙体可靠性和价格冲击进一步闭合",
    },
  };
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;

  const db = getDb();
  const universe = await db
    .select({
      symbol: contractSymbols.symbol,
      quoteVolume24h: contractSymbols.quoteVolume24h,
      isActive: contractSymbols.isActive,
    })
    .from(contractSymbols)
    .where(
      and(
        eq(contractSymbols.venue, "BINANCE"),
        eq(contractSymbols.market, "USDT_M"),
        eq(contractSymbols.environment, "LIVE"),
        eq(contractSymbols.listingGeneration, "CURRENT"),
        eq(contractSymbols.isActive, true),
      ),
    )
    .orderBy(desc(contractSymbols.quoteVolume24h))
    .limit(MAX_WATCH_SYMBOLS);

  const symbols = universe.map((row) => row.symbol);
  const flow = await getNexusLiveOrderFlow(symbols);
  const bySymbol = new Map(flow.rows.map((row) => [row.symbol, row]));
  const minVolume = Number(new URL(request.url).searchParams.get("minVolume"));
  const rows = universe
    .filter((row) => !Number.isFinite(minVolume) || finite(row.quoteVolume24h) >= minVolume)
    .map((market) => {
      const orderFlow = bySymbol.get(market.symbol);
      if (!orderFlow) {
        return {
          symbol: market.symbol,
          quoteVolume24h: finite(market.quoteVolume24h),
          status: flow.missing.includes(market.symbol) ? "WARMING" : "UNAVAILABLE",
          orderFlow: null,
        };
      }
      const price = (orderFlow.bestBidPrice + orderFlow.bestAskPrice) / 2;
      const bidDistanceBps = distanceBps(price, orderFlow.bidWallPrice);
      const askDistanceBps = distanceBps(price, orderFlow.askWallPrice);
      const score = Math.max(0, Math.min(100,
        orderFlow.confidence * 40 +
        Math.max(orderFlow.bidWallReliability, orderFlow.askWallReliability) * 30 +
        Math.min(1, orderFlow.tradeToDepthRatio10s * 10) * 20 +
        (orderFlow.fresh ? 10 : 0),
      ));
      const phaseTwo = evaluatePhaseTwo(orderFlow);
      return {
        symbol: market.symbol,
        quoteVolume24h: finite(market.quoteVolume24h),
        status: wallState(orderFlow),
        score,
        price,
        orderFlow,
        bidDistanceBps,
        askDistanceBps,
        businessState: phaseTwo.status,
        direction: phaseTwo.direction,
        brain: phaseTwo.brain,
        marketEye: phaseTwo.marketEye,
        waitReason: phaseTwo.waitReason,
      };
    });

  const phaseTwoRows = rows.filter((row) => row.orderFlow && row.businessState);
  return Response.json({
    business: "WALL_TREND",
    businessLabel: "买卖墙趋势",
    phase: 2,
    decisionVersion: "wall-trend-brain-eye-v1",
    readOnly: true,
    source: "BINANCE_WEBSOCKET_PUBLIC_ORDER_FLOW",
    watchedLimit: MAX_WATCH_SYMBOLS,
    watchedSymbols: symbols,
    ready: flow.ready,
    missing: flow.missing,
    summary: {
      ready: phaseTwoRows.filter((row) => row.businessState === "READY").length,
      waiting: phaseTwoRows.filter((row) => row.businessState === "WAIT").length,
      invalidated: phaseTwoRows.filter((row) => row.businessState === "INVALIDATED").length,
      brainReady: phaseTwoRows.filter((row) => row.brain?.selected === "READY_SHADOW").length,
      eyeReady: phaseTwoRows.filter((row) => row.marketEye?.status === "READY").length,
    },
    updatedAt: new Date().toISOString(),
    rows,
  });
}
