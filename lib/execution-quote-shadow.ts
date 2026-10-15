export const EXECUTION_QUOTE_SHADOW_VERSION =
  "as-execution-quote-shadow-v4" as const;

export type ExecutionQuoteRole = "ENTRY" | "ADD" | "EXIT";
export type ExecutionQuoteOrigin =
  | "MANUAL"
  | "SEMI_AUTO"
  | "STRATEGY_LONG"
  | "STRATEGY_SHORT";

export type ExecutionQuoteShadow = {
  modelVersion: typeof EXECUTION_QUOTE_SHADOW_VERSION;
  observationOnly: true;
  quoteRole: ExecutionQuoteRole;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  actualOrderType: "MARKET" | "LIMIT";
  actualRequestedPrice: number;
  decisionMarkPrice: number;
  executableReferencePrice: number;
  reservationPrice: number;
  shadowQuotePrice: number;
  actualDistanceBps: number;
  shadowDistanceBps: number;
  theoreticalImprovementBps: number;
  immediatelyMarketable: boolean;
  recommendedOrderType: "MARKET" | "LIMIT";
  wallAnchorApplied: boolean;
  wallAnchorSide: "BID" | "ASK" | "NONE";
  wallAnchorPrice: number;
  wallAnchorReliability: number;
  wallAnchorDistanceBps: number;
  wallAnchorReason: string;
  dynamicOffsetBps: number;
  volatilityPricePerSqrtSecond: number;
  effectiveHorizonSeconds: number;
  inventorySkewRatio: number;
  inventoryShiftPrice: number;
  tradeIntensityRatio: number;
  orderBookImbalance: number;
  orderFlowEvidenceKind: "PUBLIC_ORDER_FLOW_PROXY" | "UNAVAILABLE";
  orderFlowProxyState: string;
  orderFlowEvidenceReady: boolean;
  orderFlowDepthSampleCount10s: number;
  orderFlowDepthCoverageMs10s: number;
  orderFlowTradeCount10s: number;
  orderFlowConfidence: number;
  orderFlowPressure: number;
  directionalOrderFlowPressure: number;
  aggressorImbalance3s: number;
  aggressorImbalance10s: number;
  priceImpactBps10s: number;
  bidWallPrice: number;
  bidWallPersistence: number;
  askWallPrice: number;
  askWallPersistence: number;
  bidWallReliability: number;
  askWallReliability: number;
  bidLiquidityPullRatio10s: number;
  askLiquidityPullRatio10s: number;
  bidReplenishmentRatio10s: number;
  askReplenishmentRatio10s: number;
  directionalLiquidityPressure: number;
  orderFlowShiftPrice: number;
  executableDepthRatio: number;
  microstructureShiftPrice: number;
  observedHalfSpreadPrice: number;
  expectedWaitCostPrice: number;
  reason: string;
  assumptions: string[];
};

/**
 * Avellaneda–Stoikov inspired execution shadow.
 *
 * It never decides direction or quantity and never submits an order. ATR is
 * converted to a per-second price-volatility proxy; the current directional
 * inventory shifts the reservation price; observed spread and recent trade
 * intensity approximate order-arrival speed. The resulting one-sided quote is
 * compared with the real order selected by the existing execution logic.
 */
export function buildExecutionQuoteShadow(input: {
  quoteRole: ExecutionQuoteRole;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  actualOrderType: "MARKET" | "LIMIT";
  actualRequestedPrice: number;
  decisionMarkPrice: number;
  executableReferencePrice: number;
  priceTickSize: number;
  atr5m?: number | null;
  orderHorizonSeconds?: number | null;
  inventorySkewRatio?: number | null;
  tradeIntensityRatio?: number | null;
  bestBidQuantity?: number | null;
  bestAskQuantity?: number | null;
  orderFlow?: {
    evidenceKind?: "PUBLIC_ORDER_FLOW_PROXY" | null;
    proxyState?: string | null;
    orderFlowReady?: boolean | null;
    depthSampleCount10s?: number | null;
    depthCoverageMs10s?: number | null;
    tradeCount10s?: number | null;
    confidence?: number | null;
    depthImbalance?: number | null;
    aggressorImbalance3s?: number | null;
    aggressorImbalance10s?: number | null;
    priceImpactBps10s?: number | null;
    bidWallPrice?: number | null;
    bidWallPersistence?: number | null;
    askWallPrice?: number | null;
    askWallPersistence?: number | null;
    bidWallReliability?: number | null;
    askWallReliability?: number | null;
    bidLiquidityPullRatio10s?: number | null;
    askLiquidityPullRatio10s?: number | null;
    bidReplenishmentRatio10s?: number | null;
    askReplenishmentRatio10s?: number | null;
  } | null;
  urgency?: number | null;
  riskAversion?: number | null;
}): ExecutionQuoteShadow | null {
  const mark = positive(input.decisionMarkPrice);
  const executable = positive(input.executableReferencePrice);
  const actualRequested = positive(input.actualRequestedPrice);
  const tick = positive(input.priceTickSize);
  if (
    mark === null || executable === null || actualRequested === null ||
    tick === null
  ) return null;

  const atr5m = positive(input.atr5m);
  const fallbackAtr = Math.max(tick * 4, Math.abs(executable - mark) * 2);
  const volatilityAtr = atr5m ?? fallbackAtr;
  const sigma = volatilityAtr / Math.sqrt(300);
  const horizon = clamp(
    finiteOr(input.orderHorizonSeconds, roleHorizon(input.quoteRole)),
    5,
    120,
  );
  const inventorySkew = clamp(finiteOr(input.inventorySkewRatio, 0), -1, 1);
  const riskAversion = clamp(finiteOr(input.riskAversion, 0.15), 0.01, 1);
  const tradeIntensity = clamp(finiteOr(input.tradeIntensityRatio, 1), 0.25, 4);
  const bidQuantity = positive(input.bestBidQuantity);
  const askQuantity = positive(input.bestAskQuantity);
  const orderBookImbalance = bidQuantity !== null && askQuantity !== null
    ? clamp((bidQuantity - askQuantity) / (bidQuantity + askQuantity), -1, 1)
    : 0;
  const orderFlowEvidenceReady = input.orderFlow?.orderFlowReady === true;
  const orderFlowConfidence = clamp(
    orderFlowEvidenceReady ? finiteOr(input.orderFlow?.confidence, 0) : 0,
    0,
    1,
  );
  const depthImbalance = clamp(
    finiteOr(input.orderFlow?.depthImbalance, orderBookImbalance),
    -1,
    1,
  );
  const aggressorImbalance3s = clamp(
    finiteOr(input.orderFlow?.aggressorImbalance3s, 0),
    -1,
    1,
  );
  const aggressorImbalance10s = clamp(
    finiteOr(input.orderFlow?.aggressorImbalance10s, 0),
    -1,
    1,
  );
  const priceImpactBps10s = clamp(
    finiteOr(input.orderFlow?.priceImpactBps10s, 0),
    -50,
    50,
  );
  const bidLiquidityPullRatio10s = clamp(
    finiteOr(input.orderFlow?.bidLiquidityPullRatio10s, 0), 0, 1,
  );
  const askLiquidityPullRatio10s = clamp(
    finiteOr(input.orderFlow?.askLiquidityPullRatio10s, 0), 0, 1,
  );
  const bidReplenishmentRatio10s = clamp(
    finiteOr(input.orderFlow?.bidReplenishmentRatio10s, 0), 0, 1,
  );
  const askReplenishmentRatio10s = clamp(
    finiteOr(input.orderFlow?.askReplenishmentRatio10s, 0), 0, 1,
  );
  const bidWallPrice = positive(input.orderFlow?.bidWallPrice);
  const askWallPrice = positive(input.orderFlow?.askWallPrice);
  const bidWallPersistence = clamp(
    finiteOr(input.orderFlow?.bidWallPersistence, 0), 0, 1,
  );
  const askWallPersistence = clamp(
    finiteOr(input.orderFlow?.askWallPersistence, 0), 0, 1,
  );
  const bidWallReliability = clamp(
    finiteOr(input.orderFlow?.bidWallReliability, 0), 0, 1,
  );
  const askWallReliability = clamp(
    finiteOr(input.orderFlow?.askWallReliability, 0), 0, 1,
  );
  const liquidityPressure = clamp(
    (askLiquidityPullRatio10s - bidLiquidityPullRatio10s) * 0.55 +
      (bidReplenishmentRatio10s - askReplenishmentRatio10s) * 0.45,
    -1,
    1,
  );
  const orderFlowPressure = clamp(
    depthImbalance * 0.15 +
      aggressorImbalance3s * 0.3 +
      aggressorImbalance10s * 0.2 +
      clamp(priceImpactBps10s / 10, -1, 1) * 0.15 +
      liquidityPressure * 0.2,
    -1,
    1,
  );
  const directionalOrderFlowPressure = input.side === "BUY"
    ? orderFlowPressure
    : -orderFlowPressure;
  const directionalLiquidityPressure = input.side === "BUY"
    ? liquidityPressure
    : -liquidityPressure;
  const executableDepth = input.side === "BUY" ? askQuantity : bidQuantity;
  const oppositeDepth = input.side === "BUY" ? bidQuantity : askQuantity;
  const executableDepthRatio = executableDepth !== null && oppositeDepth !== null
    ? clamp(executableDepth / oppositeDepth, 0.25, 4)
    : 1;
  const effectiveArrivalIntensity = clamp(
    tradeIntensity * Math.sqrt(executableDepthRatio),
    0.25,
    4,
  );
  const urgency = clamp(finiteOr(input.urgency, roleUrgency(input.quoteRole)), 0, 1);
  const orderFlowEscapeRisk = (
    directionalOrderFlowPressure >= 0.35 ||
    directionalLiquidityPressure >= 0.35
  ) && orderFlowConfidence >= 0.55;
  const varianceOverHorizon = sigma * sigma * horizon;
  const inventoryShift = inventorySkew * riskAversion * varianceOverHorizon;
  const microstructureShift = orderBookImbalance * sigma * Math.sqrt(horizon) * 0.25;
  // Public flow may move the reservation price by at most three basis points.
  // It refines execution only; it never decides the trading direction.
  const orderFlowShift = mark * orderFlowPressure * orderFlowConfidence * 3 /
    10_000;
  const reservationPrice = mark - inventoryShift + microstructureShift +
    orderFlowShift;
  const observedHalfSpread = Math.max(tick / 2, Math.abs(executable - mark));
  const arrivalDecay = effectiveArrivalIntensity / observedHalfSpread;
  const liquidityHalfSpread =
    Math.log1p(riskAversion / arrivalDecay) / riskAversion;
  const riskHalfSpread = riskAversion * varianceOverHorizon / 2;
  const halfSpread = Math.max(tick / 2, liquidityHalfSpread + riskHalfSpread);
  const rawQuote = input.side === "BUY"
    ? reservationPrice - halfSpread
    : reservationPrice + halfSpread;
  const baseShadowQuote = alignPrice(rawQuote, tick, input.side);
  const wallAnchor = selectReliableWallAnchor({
    role: input.quoteRole,
    side: input.side,
    mark,
    executable,
    tick,
    volatilityAtr,
    urgency,
    orderFlowEvidenceReady,
    orderFlowEscapeRisk,
    bidWallPrice,
    bidWallPersistence,
    bidWallReliability,
    bidLiquidityPullRatio10s,
    bidReplenishmentRatio10s,
    askWallPrice,
    askWallPersistence,
    askWallReliability,
    askLiquidityPullRatio10s,
    askReplenishmentRatio10s,
  });
  const shadowQuote = wallAnchor.applied
    ? wallAnchor.price
    : baseShadowQuote;
  if (!(shadowQuote > 0)) return null;

  const actualDistanceBps = directionalDistanceBps(
    actualRequested,
    mark,
    input.side,
  );
  const shadowDistanceBps = directionalDistanceBps(
    shadowQuote,
    mark,
    input.side,
  );
  const theoreticalImprovementBps = favorableDifferenceBps(
    actualRequested,
    shadowQuote,
    input.side,
  );
  const immediatelyMarketable = input.side === "BUY"
    ? shadowQuote >= executable
    : shadowQuote <= executable;
  const effectiveWaitSeconds = horizon / effectiveArrivalIntensity;
  const expectedWaitCostPrice =
    sigma * Math.sqrt(effectiveWaitSeconds) * (0.25 + urgency * 0.75);
  const theoreticalImprovementPrice = input.side === "BUY"
    ? actualRequested - shadowQuote
    : shadowQuote - actualRequested;
  const recommendMarket = !wallAnchor.applied && (
    urgency >= 0.85 || orderFlowEscapeRisk ||
    theoreticalImprovementPrice <= expectedWaitCostPrice
  );
  const recommendedOrderType = recommendMarket ? "MARKET" : "LIMIT";
  const atrSource = atr5m === null ? "盘口/步长保守替代" : "闭合5分钟ATR";

  return {
    modelVersion: EXECUTION_QUOTE_SHADOW_VERSION,
    observationOnly: true,
    quoteRole: input.quoteRole,
    side: input.side,
    positionSide: input.positionSide,
    actualOrderType: input.actualOrderType,
    actualRequestedPrice: round(actualRequested),
    decisionMarkPrice: round(mark),
    executableReferencePrice: round(executable),
    reservationPrice: round(reservationPrice),
    shadowQuotePrice: round(shadowQuote),
    actualDistanceBps: round(actualDistanceBps),
    shadowDistanceBps: round(shadowDistanceBps),
    theoreticalImprovementBps: round(theoreticalImprovementBps),
    immediatelyMarketable,
    recommendedOrderType,
    wallAnchorApplied: wallAnchor.applied,
    wallAnchorSide: wallAnchor.side,
    wallAnchorPrice: round(wallAnchor.price),
    wallAnchorReliability: round(wallAnchor.reliability),
    wallAnchorDistanceBps: round(wallAnchor.distanceBps),
    wallAnchorReason: wallAnchor.reason,
    dynamicOffsetBps: round(Math.abs(shadowQuote - mark) / mark * 10_000),
    volatilityPricePerSqrtSecond: round(sigma),
    effectiveHorizonSeconds: round(horizon),
    inventorySkewRatio: round(inventorySkew),
    inventoryShiftPrice: round(inventoryShift),
    tradeIntensityRatio: round(tradeIntensity),
    orderBookImbalance: round(orderBookImbalance),
    orderFlowEvidenceKind:
      input.orderFlow?.evidenceKind === "PUBLIC_ORDER_FLOW_PROXY"
        ? "PUBLIC_ORDER_FLOW_PROXY"
        : "UNAVAILABLE",
    orderFlowProxyState: String(input.orderFlow?.proxyState || "INSUFFICIENT"),
    orderFlowEvidenceReady,
    orderFlowDepthSampleCount10s: Math.max(
      0,
      Math.trunc(finiteOr(input.orderFlow?.depthSampleCount10s, 0)),
    ),
    orderFlowDepthCoverageMs10s: Math.max(
      0,
      Math.trunc(finiteOr(input.orderFlow?.depthCoverageMs10s, 0)),
    ),
    orderFlowTradeCount10s: Math.max(
      0,
      Math.trunc(finiteOr(input.orderFlow?.tradeCount10s, 0)),
    ),
    orderFlowConfidence: round(orderFlowConfidence),
    orderFlowPressure: round(orderFlowPressure),
    directionalOrderFlowPressure: round(directionalOrderFlowPressure),
    aggressorImbalance3s: round(aggressorImbalance3s),
    aggressorImbalance10s: round(aggressorImbalance10s),
    priceImpactBps10s: round(priceImpactBps10s),
    bidWallPrice: round(bidWallPrice ?? 0),
    bidWallPersistence: round(bidWallPersistence),
    askWallPrice: round(askWallPrice ?? 0),
    askWallPersistence: round(askWallPersistence),
    bidWallReliability: round(bidWallReliability),
    askWallReliability: round(askWallReliability),
    bidLiquidityPullRatio10s: round(bidLiquidityPullRatio10s),
    askLiquidityPullRatio10s: round(askLiquidityPullRatio10s),
    bidReplenishmentRatio10s: round(bidReplenishmentRatio10s),
    askReplenishmentRatio10s: round(askReplenishmentRatio10s),
    directionalLiquidityPressure: round(directionalLiquidityPressure),
    orderFlowShiftPrice: round(orderFlowShift),
    executableDepthRatio: round(executableDepthRatio),
    microstructureShiftPrice: round(microstructureShift),
    observedHalfSpreadPrice: round(observedHalfSpread),
    expectedWaitCostPrice: round(expectedWaitCostPrice),
    reason: recommendedOrderType === "MARKET"
      ? `按${atrSource}、实时盘口深度和主动成交估算，等待期间的价格逃逸成本不低于影子限价的理论改善，影子建议市价；仅用于对比。`
      : `按${atrSource}、方向库存、实时盘口深度和主动成交估算，影子限价的理论改善高于等待成本，影子建议限价；仅用于对比。`,
    assumptions: [
      "方向、数量、杠杆和风险参数完全继承现有系统",
      "ATR只作为当前波动率代理，不预测未来价格",
      "最优买卖盘深度、价差和短周期成交强度只近似订单到达速度",
      "公开盘口不含账户身份，订单流只能作为机构/量化行为代理，不能识别具体机构",
      "挂单可能撤销，盘口墙必须与持续主动成交共同解释",
      "流动性撤回和承接补单只按多档盘口变化近似，不还原账户或订单队列",
      "只有成熟订单流中持续、低撤回且出现补单的可靠墙价才可成为影子限价锚点",
      "影子报价没有下单权限，未成交机会成本必须由真实结果验证",
    ],
  };
}

function selectReliableWallAnchor(input: {
  role: ExecutionQuoteRole;
  side: "BUY" | "SELL";
  mark: number;
  executable: number;
  tick: number;
  volatilityAtr: number;
  urgency: number;
  orderFlowEvidenceReady: boolean;
  orderFlowEscapeRisk: boolean;
  bidWallPrice: number | null;
  bidWallPersistence: number;
  bidWallReliability: number;
  bidLiquidityPullRatio10s: number;
  bidReplenishmentRatio10s: number;
  askWallPrice: number | null;
  askWallPersistence: number;
  askWallReliability: number;
  askLiquidityPullRatio10s: number;
  askReplenishmentRatio10s: number;
}) {
  const unavailable = (reason: string) => ({
    applied: false,
    side: "NONE" as const,
    price: 0,
    reliability: 0,
    distanceBps: 0,
    reason,
  });
  if (!input.orderFlowEvidenceReady)
    return unavailable("订单流采集尚未成熟，不使用墙价锚点。");
  if (input.role === "EXIT")
    return unavailable("退出委托不等待盘口墙，墙价锚点不适用。");
  if (input.urgency >= 0.85 || input.orderFlowEscapeRisk)
    return unavailable("价格逃逸或紧急度较高，不使用被动墙价锚点。");

  const isBuy = input.side === "BUY";
  const wallPrice = isBuy ? input.bidWallPrice : input.askWallPrice;
  const persistence = isBuy
    ? input.bidWallPersistence
    : input.askWallPersistence;
  const reliability = isBuy
    ? input.bidWallReliability
    : input.askWallReliability;
  const pullRatio = isBuy
    ? input.bidLiquidityPullRatio10s
    : input.askLiquidityPullRatio10s;
  const replenishmentRatio = isBuy
    ? input.bidReplenishmentRatio10s
    : input.askReplenishmentRatio10s;
  if (wallPrice === null)
    return unavailable("当前方向没有可用墙价。");
  if (
    persistence < 0.65 || reliability < 0.65 || pullRatio > 0.15 ||
    replenishmentRatio < 0.08
  ) return unavailable("墙价未同时通过持续性、低撤回和补单验证。");

  const maximumDistance = Math.max(input.tick * 4, input.volatilityAtr * 0.25);
  if (Math.abs(wallPrice - input.mark) > maximumDistance)
    return unavailable("可靠墙价距离当前标记价过远，不用于当前报价。");
  if (
    (isBuy && wallPrice >= input.executable) ||
    (!isBuy && wallPrice <= input.executable)
  ) return unavailable("墙价不在当前委托的被动成交一侧。");

  const candidate = alignPrice(
    isBuy ? wallPrice + input.tick : wallPrice - input.tick,
    input.tick,
    input.side,
  );
  if (
    !(candidate > 0) ||
    (isBuy && candidate >= input.executable) ||
    (!isBuy && candidate <= input.executable)
  ) return unavailable("墙价前置一档后会立即成交，不作为被动锚点。");

  return {
    applied: true,
    side: isBuy ? "BID" as const : "ASK" as const,
    price: candidate,
    reliability,
    distanceBps: Math.abs(candidate - input.mark) / input.mark * 10_000,
    reason: `${isBuy ? "买墙" : "卖墙"}已通过持续、撤回和补单验证，影子价前置一档跟随；仅用于对比。`,
  };
}

export function directionalInventorySkew(input: {
  positions: Array<{
    positionSide: "LONG" | "SHORT";
    quantity: number;
    markPrice: number;
  }>;
  accountEquityUsdt: number | null | undefined;
  prospectiveSide?: "BUY" | "SELL";
  prospectiveNotionalUsdt?: number | null;
}) {
  const equity = positive(input.accountEquityUsdt);
  if (equity === null) return 0;
  const current = input.positions.reduce((sum, position) => {
    const notional = Math.max(0, finiteOr(position.quantity, 0)) *
      Math.max(0, finiteOr(position.markPrice, 0));
    return sum + (position.positionSide === "LONG" ? notional : -notional);
  }, 0);
  const prospective = Math.max(0, finiteOr(input.prospectiveNotionalUsdt, 0)) *
    (input.prospectiveSide === "BUY"
      ? 1
      : input.prospectiveSide === "SELL"
        ? -1
        : 0);
  return round(clamp((current + prospective) / equity, -1, 1));
}

export function shadowFillEvidence(input: {
  side: "BUY" | "SELL";
  shadowQuotePrice: number;
  actualFillPrice: number | null;
}) {
  const shadow = positive(input.shadowQuotePrice);
  const fill = positive(input.actualFillPrice);
  if (shadow === null || fill === null)
    return { status: "NOT_CONFIRMED" as const, reason: "真实成交价尚未取得，不能判断影子报价是否可成交。" };
  const confirmed = input.side === "BUY" ? fill <= shadow : fill >= shadow;
  return confirmed
    ? { status: "CONFIRMED_AT_ACTUAL_FILL" as const, reason: "真实成交价格已穿过影子报价，可确认该报价在本次成交路径中具备成交条件。" }
    : { status: "NOT_CONFIRMED" as const, reason: "真实平均成交价没有穿过影子报价，不能声称影子限价能够成交。" };
}

function roleHorizon(role: ExecutionQuoteRole) {
  return role === "EXIT" ? 15 : role === "ADD" ? 45 : 30;
}

function roleUrgency(role: ExecutionQuoteRole) {
  return role === "EXIT" ? 0.9 : role === "ADD" ? 0.35 : 0.5;
}

function alignPrice(price: number, tick: number, side: "BUY" | "SELL") {
  const ticks = side === "BUY"
    ? Math.floor((price + tick * 1e-8) / tick)
    : Math.ceil((price - tick * 1e-8) / tick);
  return Number((ticks * tick).toPrecision(15));
}

function directionalDistanceBps(
  price: number,
  mark: number,
  side: "BUY" | "SELL",
) {
  return (side === "BUY" ? mark - price : price - mark) / mark * 10_000;
}

function favorableDifferenceBps(
  actual: number,
  shadow: number,
  side: "BUY" | "SELL",
) {
  return (side === "BUY" ? actual - shadow : shadow - actual) /
    actual * 10_000;
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finiteOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
