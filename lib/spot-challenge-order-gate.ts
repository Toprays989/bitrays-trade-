import type { SpotOrderRequest } from "./binance-spot-live";

export type ChallengeOrderIntent = {
  challengeStatus: string;
  symbol: string;
  allowedSymbols: ReadonlySet<string>;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quantity?: number;
  quoteOrderQty?: number;
  price?: number;
  clientOrderId: string;
  referencePrice?: number;
  nowMs?: number;
  ttlMinutes?: number;
};

export type ChallengeOrderGateResult = {
  order: SpotOrderRequest;
  reservedNotionalUsdt: number;
  expiresAt: Date | null;
};

const OPEN_STATUSES = new Set(["RUNNING", "CAUTION"]);

export function gateSpotChallengeOrder(input: ChallengeOrderIntent): ChallengeOrderGateResult {
  if (!OPEN_STATUSES.has(input.challengeStatus)) throw new Error("挑战当前风险状态不允许新增订单");
  const symbol = input.symbol.trim().toUpperCase();
  const allowed = input.allowedSymbols.has(symbol) || Array.from(input.allowedSymbols).some((candidate) => candidate.toUpperCase() === symbol);
  if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol) || !allowed) throw new Error("交易对不在挑战赛已锁定白名单中");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.clientOrderId)) throw new Error("clientOrderId 格式无效");
  const quantity = input.quantity != null ? Number(input.quantity) : undefined;
  const quoteOrderQty = input.quoteOrderQty != null ? Number(input.quoteOrderQty) : undefined;
  const price = input.price != null ? Number(input.price) : undefined;
  if (!(quantity == null || Number.isFinite(quantity) && quantity > 0)) throw new Error("订单数量必须为正数");
  if (!(quoteOrderQty == null || Number.isFinite(quoteOrderQty) && quoteOrderQty > 0)) throw new Error("报价金额必须为正数");
  if (quantity == null && quoteOrderQty == null) throw new Error("订单必须提供 quantity 或 quoteOrderQty");
  if (quantity != null && quoteOrderQty != null) throw new Error("quantity 与 quoteOrderQty 不能同时提供");
  if (input.orderType === "LIMIT") {
    if (quantity == null || price == null || !Number.isFinite(price) || price <= 0) throw new Error("限价单必须提供有效数量和价格");
  }
  const referencePrice = price ?? input.referencePrice;
  const reservedNotionalUsdt = quoteOrderQty ?? (quantity != null && referencePrice != null ? quantity * referencePrice : 0);
  if (!Number.isFinite(reservedNotionalUsdt) || reservedNotionalUsdt <= 0) throw new Error("无法计算订单占用的 USDT 金额");
  const ttlMinutes = input.ttlMinutes ?? 180;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 180) throw new Error("限价单有效期必须在 1-180 分钟内");
  return {
    order: {
      symbol,
      side: input.side,
      type: input.orderType,
      ...(quantity != null ? { quantity } : {}),
      ...(quoteOrderQty != null ? { quoteOrderQty } : {}),
      ...(price != null ? { price, timeInForce: "GTC" as const } : {}),
      newClientOrderId: input.clientOrderId,
    },
    reservedNotionalUsdt,
    expiresAt: input.orderType === "LIMIT" ? new Date((input.nowMs ?? Date.now()) + ttlMinutes * 60_000) : null,
  };
}
