export const NEXUS_ORDER_FLOW_VERSION = "nexus-order-flow-eye-v4";

const DEFAULT_RETENTION_MS = 30_000;
const DEFAULT_BUCKET_MS = 250;
const MINIMUM_TRADE_COUNT = 3;

/**
 * Public order-flow proxy, not an institution identity detector.
 *
 * Binance does not expose the owner of a public order. This tracker therefore
 * records only observable facts: multi-level displayed depth, aggressive
 * taker flow and whether large displayed levels persist while trades arrive.
 */
export function createOrderFlowTracker(options = {}) {
  const retentionMs = Math.max(
    10_000,
    Number(options.retentionMs) || DEFAULT_RETENTION_MS,
  );
  const bucketMs = Math.max(100, Number(options.bucketMs) || DEFAULT_BUCKET_MS);
  const maxDepthAgeMs = Math.max(500, Number(options.maxDepthAgeMs) || 2_000);
  const symbols = new Map();

  function stateFor(symbol) {
    let state = symbols.get(symbol);
    if (!state) {
      state = { latestDepth: null, depthHistory: [], tradeBuckets: new Map() };
      symbols.set(symbol, state);
    }
    return state;
  }

  function recordDepth(payload, receivedAt = Date.now()) {
    const depth = normalizePartialDepth(payload, receivedAt);
    if (!depth) return { accepted: false, reason: "INVALID" };
    const state = stateFor(depth.symbol);
    if (
      state.latestDepth &&
      depth.finalUpdateId <= state.latestDepth.finalUpdateId
    ) return { accepted: false, reason: "NON_MONOTONIC" };
    state.latestDepth = depth;
    const bucketStart = Math.floor(receivedAt / bucketMs) * bucketMs;
    const previous = state.depthHistory.at(-1);
    if (!previous || previous.bucketStart !== bucketStart) {
      state.depthHistory.push(depthSummary(depth, bucketStart));
    } else {
      state.depthHistory[state.depthHistory.length - 1] = depthSummary(
        depth,
        bucketStart,
      );
    }
    pruneState(state, receivedAt, retentionMs);
    return { accepted: true, reason: "UPDATED", value: depth };
  }

  function recordTrade(payload, receivedAt = Date.now()) {
    const trade = normalizeAggregateTrade(payload, receivedAt);
    if (!trade) return { accepted: false, reason: "INVALID" };
    const state = stateFor(trade.symbol);
    const bucketStart = Math.floor(receivedAt / bucketMs) * bucketMs;
    const bucket = state.tradeBuckets.get(bucketStart) || {
      bucketStart,
      firstPrice: trade.price,
      lastPrice: trade.price,
      buyNotional: 0,
      sellNotional: 0,
      tradeCount: 0,
      firstTradeTime: trade.tradeTime,
      lastTradeTime: trade.tradeTime,
    };
    bucket.lastPrice = trade.price;
    bucket.lastTradeTime = trade.tradeTime;
    bucket.tradeCount += 1;
    if (trade.takerSide === "BUY") bucket.buyNotional += trade.notional;
    else bucket.sellNotional += trade.notional;
    state.tradeBuckets.set(bucketStart, bucket);
    pruneState(state, receivedAt, retentionMs);
    return { accepted: true, reason: "UPDATED", value: trade };
  }

  function remove(symbol) {
    symbols.delete(normalizeSymbol(symbol));
  }

  function snapshot(requestedSymbols, now = Date.now()) {
    const rows = [];
    const missing = [];
    const stale = [];
    for (const rawSymbol of requestedSymbols) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) continue;
      const state = symbols.get(symbol);
      if (!state?.latestDepth) {
        missing.push(symbol);
        continue;
      }
      pruneState(state, now, retentionMs);
      const row = buildOrderFlowSnapshot(symbol, state, now, maxDepthAgeMs);
      rows.push(row);
      if (row.ageMs > maxDepthAgeMs) stale.push(symbol);
    }
    return {
      version: NEXUS_ORDER_FLOW_VERSION,
      ready: missing.length === 0 && stale.length === 0 && rows.length > 0,
      maxDepthAgeMs,
      missing,
      stale,
      rows,
    };
  }

  return { recordDepth, recordTrade, remove, snapshot };
}

export function normalizePartialDepth(payload, receivedAt = Date.now()) {
  if (!payload || (payload.st !== undefined && Number(payload.st) !== 1))
    return null;
  const symbol = normalizeSymbol(payload.s);
  const bids = normalizeLevels(payload.b || payload.bids);
  const asks = normalizeLevels(payload.a || payload.asks);
  const finalUpdateId = Number(payload.u ?? payload.lastUpdateId);
  const firstUpdateId = Number(payload.U ?? finalUpdateId);
  const eventTime = Number(payload.E) || receivedAt;
  if (
    !symbol || !bids.length || !asks.length ||
    !Number.isFinite(finalUpdateId) || !Number.isFinite(firstUpdateId) ||
    asks[0].price <= bids[0].price
  ) return null;
  return {
    symbol,
    bids,
    asks,
    firstUpdateId,
    finalUpdateId,
    eventTime,
    transactionTime: Number(payload.T) || eventTime,
    receivedAt,
    transportLatencyMs: Math.max(0, receivedAt - eventTime),
  };
}

export function normalizeAggregateTrade(payload, receivedAt = Date.now()) {
  if (
    !payload || !["aggTrade", "trade"].includes(payload.e) ||
    (payload.st !== undefined && Number(payload.st) !== 1)
  ) return null;
  const symbol = normalizeSymbol(payload.s);
  const price = Number(payload.p);
  const quantity = Number(payload.q);
  const aggregateTradeId = Number(payload.a ?? payload.t);
  const eventTime = Number(payload.E) || receivedAt;
  const tradeTime = Number(payload.T) || eventTime;
  if (
    !symbol || !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(quantity) || quantity <= 0 ||
    !Number.isFinite(aggregateTradeId)
  ) return null;
  return {
    symbol,
    aggregateTradeId,
    price,
    quantity,
    notional: price * quantity,
    // m=true means the buyer was maker, therefore the taker sold.
    takerSide: payload.m === true ? "SELL" : "BUY",
    eventTime,
    tradeTime,
    receivedAt,
    transportLatencyMs: Math.max(0, receivedAt - eventTime),
  };
}

function buildOrderFlowSnapshot(symbol, state, now, maxDepthAgeMs) {
  const depth = state.latestDepth;
  const ageMs = Math.max(0, now - depth.receivedAt);
  const weightedBidNotional = weightedNotional(depth.bids);
  const weightedAskNotional = weightedNotional(depth.asks);
  const depthTotal = weightedBidNotional + weightedAskNotional;
  const depthImbalance = depthTotal > 0
    ? (weightedBidNotional - weightedAskNotional) / depthTotal
    : 0;
  const bidWall = largestWall(depth.bids);
  const askWall = largestWall(depth.asks);
  const recentDepth = state.depthHistory.filter(
    (item) => now - item.receivedAt <= 10_000,
  );
  const bidWallPersistence = wallPersistence(recentDepth, "bid", bidWall);
  const askWallPersistence = wallPersistence(recentDepth, "ask", askWall);
  const flow1s = aggregateFlow(state, now, 1_000);
  const flow3s = aggregateFlow(state, now, 3_000);
  const flow10s = aggregateFlow(state, now, 10_000);
  const liquidityDynamics = depthLiquidityDynamics(recentDepth, flow10s);
  const bidWallReliability = wallReliability(
    bidWallPersistence,
    liquidityDynamics.bidLiquidityPullRatio10s,
    liquidityDynamics.bidReplenishmentRatio10s,
  );
  const askWallReliability = wallReliability(
    askWallPersistence,
    liquidityDynamics.askLiquidityPullRatio10s,
    liquidityDynamics.askReplenishmentRatio10s,
  );
  const visibleDepthNotional = depth.bids.concat(depth.asks)
    .reduce((sum, level) => sum + level.price * level.quantity, 0);
  const tradeToDepthRatio10s = visibleDepthNotional > 0
    ? flow10s.totalNotional / visibleDepthNotional
    : 0;
  const midPrice = (depth.bids[0].price + depth.asks[0].price) / 2;
  const priceImpactBps10s = flow10s.firstPrice && flow10s.lastPrice
    ? (flow10s.lastPrice - flow10s.firstPrice) / midPrice * 10_000
    : 0;
  const flowDirection = classifyDirection(flow3s.imbalance, flow10s.imbalance);
  const absorption = classifyAbsorption({
    flow10s,
    priceImpactBps10s,
    bidWallPersistence,
    askWallPersistence,
    bidReplenishmentRatio10s: liquidityDynamics.bidReplenishmentRatio10s,
    askReplenishmentRatio10s: liquidityDynamics.askReplenishmentRatio10s,
  });
  const matureDepthWindow =
    liquidityDynamics.depthCoverageMs10s >= 2_500 &&
    liquidityDynamics.depthSampleCount10s >= 8;
  const explicitLiquidityPull = [
    "BID_LIQUIDITY_PULL",
    "ASK_LIQUIDITY_PULL",
  ].includes(liquidityDynamics.liquidityEvent);
  const orderFlowReady = matureDepthWindow && (
    flow10s.tradeCount >= MINIMUM_TRADE_COUNT || explicitLiquidityPull
  );
  const confidence = flowConfidence({
    flow3s,
    flow10s,
    tradeToDepthRatio10s,
    flowDirection,
    depthSampleCount10s: liquidityDynamics.depthSampleCount10s,
    liquidityEvent: liquidityDynamics.liquidityEvent,
    evidenceWindowReady: orderFlowReady,
  });
  const proxyState = !orderFlowReady
    ? "INSUFFICIENT"
    : liquidityDynamics.liquidityEvent === "BID_LIQUIDITY_PULL"
    ? "BID_LIQUIDITY_PULLED"
    : liquidityDynamics.liquidityEvent === "ASK_LIQUIDITY_PULL"
      ? "ASK_LIQUIDITY_PULLED"
      : absorption !== "NONE"
    ? absorption === "BID_ABSORPTION"
      ? "PASSIVE_BID_ABSORPTION"
      : "PASSIVE_ASK_ABSORPTION"
    : flowDirection === "BUY"
      ? "PERSISTENT_BUY_EXECUTION"
      : flowDirection === "SELL"
        ? "PERSISTENT_SELL_EXECUTION"
        : flow10s.tradeCount < MINIMUM_TRADE_COUNT
          ? "INSUFFICIENT"
          : "MIXED";
  return {
    version: NEXUS_ORDER_FLOW_VERSION,
    evidenceKind: "PUBLIC_ORDER_FLOW_PROXY",
    symbol,
    eventTime: depth.eventTime,
    receivedAt: depth.receivedAt,
    ageMs,
    fresh: ageMs <= maxDepthAgeMs,
    transportLatencyMs: depth.transportLatencyMs,
    orderFlowReady,
    bestBidPrice: depth.bids[0].price,
    bestAskPrice: depth.asks[0].price,
    weightedBidNotional,
    weightedAskNotional,
    depthImbalance,
    bidWallPrice: bidWall.price,
    bidWallNotional: bidWall.notional,
    bidWallPersistence,
    bidWallReliability,
    askWallPrice: askWall.price,
    askWallNotional: askWall.notional,
    askWallPersistence,
    askWallReliability,
    ...liquidityDynamics,
    aggressorBuyNotional1s: flow1s.buyNotional,
    aggressorSellNotional1s: flow1s.sellNotional,
    aggressorImbalance1s: flow1s.imbalance,
    aggressorBuyNotional3s: flow3s.buyNotional,
    aggressorSellNotional3s: flow3s.sellNotional,
    aggressorImbalance3s: flow3s.imbalance,
    aggressorBuyNotional10s: flow10s.buyNotional,
    aggressorSellNotional10s: flow10s.sellNotional,
    aggressorImbalance10s: flow10s.imbalance,
    tradeCount10s: flow10s.tradeCount,
    tradeToDepthRatio10s,
    priceImpactBps10s,
    flowDirection,
    absorption,
    proxyState,
    confidence,
    limitations: [
      "公开盘口不包含账户身份，不能断言订单属于机构或某个量化系统",
      "挂单可以撤销，只有持续盘口与主动成交共同出现才提高可信度",
      "流动性撤回与补单仅由多档盘口变化和实际成交近似，不能还原单个订单队列",
      "该事实当前只进入影子报价，不替代现有方向大脑与真实委托",
    ],
  };
}

function aggregateFlow(state, now, windowMs) {
  const buckets = [...state.tradeBuckets.values()]
    .filter((bucket) => now - bucket.bucketStart <= windowMs)
    .sort((left, right) => left.bucketStart - right.bucketStart);
  const buyNotional = buckets.reduce((sum, item) => sum + item.buyNotional, 0);
  const sellNotional = buckets.reduce((sum, item) => sum + item.sellNotional, 0);
  const totalNotional = buyNotional + sellNotional;
  return {
    buyNotional,
    sellNotional,
    totalNotional,
    imbalance: totalNotional > 0
      ? (buyNotional - sellNotional) / totalNotional
      : 0,
    tradeCount: buckets.reduce((sum, item) => sum + item.tradeCount, 0),
    firstPrice: buckets[0]?.firstPrice ?? null,
    lastPrice: buckets.at(-1)?.lastPrice ?? null,
  };
}

function classifyDirection(shortImbalance, longImbalance) {
  if (shortImbalance >= 0.18 && longImbalance >= 0.12) return "BUY";
  if (shortImbalance <= -0.18 && longImbalance <= -0.12) return "SELL";
  return "MIXED";
}

function classifyAbsorption(input) {
  if (input.flow10s.tradeCount < MINIMUM_TRADE_COUNT) return "NONE";
  if (
    input.flow10s.imbalance <= -0.25 &&
    input.bidWallPersistence >= 0.6 &&
    input.bidReplenishmentRatio10s >= 0.12 &&
    input.priceImpactBps10s > -2
  ) return "BID_ABSORPTION";
  if (
    input.flow10s.imbalance >= 0.25 &&
    input.askWallPersistence >= 0.6 &&
    input.askReplenishmentRatio10s >= 0.12 &&
    input.priceImpactBps10s < 2
  ) return "ASK_ABSORPTION";
  return "NONE";
}

function flowConfidence(input) {
  const explicitLiquidityPull = [
    "BID_LIQUIDITY_PULL",
    "ASK_LIQUIDITY_PULL",
  ].includes(input.liquidityEvent);
  if (
    input.flow10s.tradeCount < MINIMUM_TRADE_COUNT &&
    !explicitLiquidityPull
  ) return 0;
  const agreement = input.flowDirection === "MIXED" ? 0 : 0.4;
  const activity = Math.min(0.35, input.flow10s.tradeCount / 50 * 0.35);
  const turnover = Math.min(0.25, input.tradeToDepthRatio10s * 0.25);
  const depthCoverage = Math.min(0.15, input.depthSampleCount10s / 20 * 0.15);
  const liquiditySignal = explicitLiquidityPull
    ? 0.45
    : input.liquidityEvent === "STABLE" ||
        input.liquidityEvent === "INSUFFICIENT"
      ? 0
      : 0.1;
  const confidence = Math.min(
    1,
    agreement + activity + turnover + depthCoverage + liquiditySignal,
  );
  return round(input.evidenceWindowReady ? confidence : Math.min(0.35, confidence));
}

function depthSummary(depth, bucketStart) {
  const bidWall = largestWall(depth.bids);
  const askWall = largestWall(depth.asks);
  return {
    bucketStart,
    receivedAt: depth.receivedAt,
    bidWallPrice: bidWall.price,
    bidWallNotional: bidWall.notional,
    askWallPrice: askWall.price,
    askWallNotional: askWall.notional,
    weightedBidNotional: weightedNotional(depth.bids),
    weightedAskNotional: weightedNotional(depth.asks),
  };
}

function depthLiquidityDynamics(history, flow10s) {
  if (history.length < 2) return {
    depthSampleCount10s: history.length,
    depthCoverageMs10s: 0,
    bidLiquidityPullRatio10s: 0,
    askLiquidityPullRatio10s: 0,
    bidReplenishmentRatio10s: 0,
    askReplenishmentRatio10s: 0,
    liquidityEvent: "INSUFFICIENT",
  };
  const first = history[0];
  const latest = history.at(-1);
  const bidBase = Math.max(first.weightedBidNotional, 1e-9);
  const askBase = Math.max(first.weightedAskNotional, 1e-9);
  const bidDepthReduction = Math.max(
    0,
    first.weightedBidNotional - latest.weightedBidNotional,
  );
  const askDepthReduction = Math.max(
    0,
    first.weightedAskNotional - latest.weightedAskNotional,
  );
  const bidLiquidityPullRatio10s = clamp01(
    (bidDepthReduction - flow10s.sellNotional) / bidBase,
  );
  const askLiquidityPullRatio10s = clamp01(
    (askDepthReduction - flow10s.buyNotional) / askBase,
  );
  const bidReplenishmentRatio10s = clamp01(
    flow10s.sellNotional / bidBase *
      Math.min(1, latest.weightedBidNotional / bidBase),
  );
  const askReplenishmentRatio10s = clamp01(
    flow10s.buyNotional / askBase *
      Math.min(1, latest.weightedAskNotional / askBase),
  );
  const depthCoverageMs10s = Math.max(0, latest.receivedAt - first.receivedAt);
  const ready = history.length >= 4 && depthCoverageMs10s >= 750;
  const liquidityEvent = !ready
    ? "INSUFFICIENT"
    : bidLiquidityPullRatio10s >= 0.35 &&
        bidLiquidityPullRatio10s >= askLiquidityPullRatio10s + 0.1
      ? "BID_LIQUIDITY_PULL"
      : askLiquidityPullRatio10s >= 0.35 &&
          askLiquidityPullRatio10s >= bidLiquidityPullRatio10s + 0.1
        ? "ASK_LIQUIDITY_PULL"
        : bidReplenishmentRatio10s >= 0.2 && flow10s.imbalance <= -0.18
          ? "BID_REPLENISHMENT"
          : askReplenishmentRatio10s >= 0.2 && flow10s.imbalance >= 0.18
            ? "ASK_REPLENISHMENT"
            : "STABLE";
  return {
    depthSampleCount10s: history.length,
    depthCoverageMs10s,
    bidLiquidityPullRatio10s: round(bidLiquidityPullRatio10s),
    askLiquidityPullRatio10s: round(askLiquidityPullRatio10s),
    bidReplenishmentRatio10s: round(bidReplenishmentRatio10s),
    askReplenishmentRatio10s: round(askReplenishmentRatio10s),
    liquidityEvent,
  };
}

function wallReliability(persistence, pullRatio, replenishmentRatio) {
  return round(clamp01(
    (persistence * 0.75 + replenishmentRatio * 0.25) * (1 - pullRatio),
  ));
}

function wallPersistence(history, side, wall) {
  if (!history.length || !(wall.notional > 0)) return 0;
  const priceKey = `${side}WallPrice`;
  const notionalKey = `${side}WallNotional`;
  const matching = history.filter((item) =>
    relativeDifference(item[priceKey], wall.price) <= 0.00005 &&
    item[notionalKey] >= wall.notional * 0.5
  ).length;
  return round(matching / history.length);
}

function largestWall(levels) {
  return levels.reduce((largest, level) => {
    const notional = level.price * level.quantity;
    return notional > largest.notional
      ? { price: level.price, notional }
      : largest;
  }, { price: levels[0]?.price ?? 0, notional: 0 });
}

function weightedNotional(levels) {
  return levels.reduce(
    (sum, level, index) =>
      sum + level.price * level.quantity * Math.exp(-index * 0.22),
    0,
  );
}

function normalizeLevels(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((level) => ({
    price: Number(level?.[0]),
    quantity: Number(level?.[1]),
  })).filter((level) =>
    Number.isFinite(level.price) && level.price > 0 &&
    Number.isFinite(level.quantity) && level.quantity >= 0
  );
}

function pruneState(state, now, retentionMs) {
  const cutoff = now - retentionMs;
  state.depthHistory = state.depthHistory.filter(
    (item) => item.receivedAt >= cutoff,
  );
  for (const bucketStart of state.tradeBuckets.keys())
    if (bucketStart < cutoff) state.tradeBuckets.delete(bucketStart);
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{2,24}$/.test(symbol) ? symbol : "";
}

function relativeDifference(left, right) {
  return right > 0 ? Math.abs(left - right) / right : 1;
}

function round(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}
