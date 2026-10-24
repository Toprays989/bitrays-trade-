import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { challengeInstances, challengeOrders, exchangeCredentials, paperAccounts, spotWhitelistSymbols } from "../../../../../db/schema";
import { credentialContext, decryptCredential } from "../../../../../lib/credential-vault";
import { BinanceSpotError, getBinanceSpotTickerPrice, placeBinanceSpotOrder } from "../../../../../lib/binance-spot-live";
import { gateSpotChallengeOrder } from "../../../../../lib/spot-challenge-order-gate";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = (env as unknown as { NQ_INTERNAL_RISK_TOKEN?: string }).NQ_INTERNAL_RISK_TOKEN ?? "";
  return expected.length >= 32 && request.headers.get("authorization") === `Bearer ${expected}`;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exchangeStatus(status: string) {
  if (status === "FILLED") return "FILLED" as const;
  if (status === "PARTIALLY_FILLED") return "PARTIALLY_FILLED" as const;
  if (status === "CANCELED" || status === "EXPIRED") return "CANCELED" as const;
  if (status === "REJECTED") return "REJECTED" as const;
  return "NEW" as const;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "内部挑战下单接口未授权" }, { status: 401 });
  const body = bodyObject(await request.json().catch(() => null));
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const challengeId = Number(body.challengeId);
  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "";
  const clientOrderId = typeof body.clientOrderId === "string" ? body.clientOrderId : "";
  if (!Number.isInteger(challengeId) || !symbol || !clientOrderId) return Response.json({ error: "challengeId、symbol、clientOrderId 必填" }, { status: 400 });
  const db = getDb();
  const [challenge] = await db.select().from(challengeInstances).where(eq(challengeInstances.id, challengeId)).limit(1);
  if (!challenge) return Response.json({ error: "挑战不存在" }, { status: 404 });
  const [existing] = await db.select().from(challengeOrders).where(eq(challengeOrders.clientOrderId, clientOrderId)).limit(1);
  if (existing) return Response.json({ ok: true, idempotent: true, order: existing });
  if (challenge.accountId.startsWith("PAPER-")) {
    const [paper] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.ownerEmail, challenge.ownerEmail), eq(paperAccounts.accountId, challenge.accountId))).limit(1);
    if (!paper || paper.status !== "ACTIVE") return Response.json({ error: "PAPER 虚拟账户不可用" }, { status: 409 });
    const requestedQuantity = Number(body.quantity);
    const requestedQuoteOrderQty = Number(body.quoteOrderQty);
    if (!(Number.isFinite(requestedQuantity) && requestedQuantity > 0) && !(Number.isFinite(requestedQuoteOrderQty) && requestedQuoteOrderQty > 0)) return Response.json({ error: "PAPER 挑战订单数量或报价金额无效" }, { status: 400 });
    const price = await getBinanceSpotTickerPrice(symbol);
    if (!Number.isFinite(price) || price <= 0) return Response.json({ error: "公共行情暂不可用" }, { status: 503 });
    let gate;
    try {
      const whitelist = await db.select({ symbol: spotWhitelistSymbols.symbol }).from(spotWhitelistSymbols).where(and(eq(spotWhitelistSymbols.versionId, challenge.whitelistVersionId), eq(spotWhitelistSymbols.eligible, true), eq(spotWhitelistSymbols.operatorSelected, true)));
      gate = gateSpotChallengeOrder({ challengeStatus: challenge.status, symbol, allowedSymbols: new Set(whitelist.map((row) => row.symbol)), side: body.side === "SELL" ? "SELL" : "BUY", orderType: "MARKET", quantity: Number.isFinite(requestedQuantity) && requestedQuantity > 0 ? requestedQuantity : undefined, quoteOrderQty: Number.isFinite(requestedQuoteOrderQty) && requestedQuoteOrderQty > 0 ? requestedQuoteOrderQty : undefined, referencePrice: price, clientOrderId });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
    }
    const now = new Date();
    const fee = gate.reservedNotionalUsdt * paper.feeRateBps / 10_000;
    const filledQuantity = gate.order.quantity ?? gate.reservedNotionalUsdt / price;
    const [filled] = await db.insert(challengeOrders).values({ challengeId, ownerEmail: challenge.ownerEmail, accountId: challenge.accountId, credentialId: 0, symbol, side: gate.order.side, orderType: "MARKET", quantity: filledQuantity, quoteOrderQty: null, limitPrice: null, reservedNotionalUsdt: gate.reservedNotionalUsdt, clientOrderId, status: "FILLED", executedQuantity: filledQuantity, averagePrice: price, feeUsdt: fee, responseJson: JSON.stringify({ environment: "PAPER", price, whitelist: true, riskGate: true }), createdAt: now, updatedAt: now }).returning();
    return Response.json({ ok: true, environment: "PAPER", order: filled });
  }
  const [credential] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, challenge.credentialId), eq(exchangeCredentials.ownerEmail, challenge.ownerEmail), eq(exchangeCredentials.accountId, challenge.accountId))).limit(1);
  if (!credential || credential.exchange !== "BINANCE_SPOT") return Response.json({ error: "挑战凭据不是 Binance Spot" }, { status: 409 });
  const whitelist = await db.select({ symbol: spotWhitelistSymbols.symbol }).from(spotWhitelistSymbols).where(and(eq(spotWhitelistSymbols.versionId, challenge.whitelistVersionId), eq(spotWhitelistSymbols.eligible, true), eq(spotWhitelistSymbols.operatorSelected, true)));
  let gate;
  try {
    gate = gateSpotChallengeOrder({ challengeStatus: challenge.status, symbol, allowedSymbols: new Set(whitelist.map((row) => row.symbol)), side: body.side === "SELL" ? "SELL" : "BUY", orderType: body.orderType === "LIMIT" ? "LIMIT" : "MARKET", quantity: body.quantity == null ? undefined : Number(body.quantity), quoteOrderQty: body.quoteOrderQty == null ? undefined : Number(body.quoteOrderQty), price: body.price == null ? undefined : Number(body.price), referencePrice: body.referencePrice == null ? undefined : Number(body.referencePrice), clientOrderId });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
  const now = new Date();
  const [pending] = await db.insert(challengeOrders).values({ challengeId, ownerEmail: challenge.ownerEmail, accountId: challenge.accountId, credentialId: challenge.credentialId, symbol, side: gate.order.side, orderType: gate.order.type, quantity: gate.order.quantity ?? null, quoteOrderQty: gate.order.quoteOrderQty ?? null, limitPrice: gate.order.price ?? null, reservedNotionalUsdt: gate.reservedNotionalUsdt, clientOrderId, status: "PENDING", expiresAt: gate.expiresAt, createdAt: now, updatedAt: now }).returning();
  try {
    const keys = { apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(challenge.ownerEmail, challenge.accountId, "api-key")), secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(challenge.ownerEmail, challenge.accountId, "secret-key")) };
    const response = await placeBinanceSpotOrder(keys, gate.order);
    const status = exchangeStatus(response.status);
    const executedQuantity = Number(response.executedQty || 0);
    const averagePrice = executedQuantity > 0 ? Number(response.cummulativeQuoteQty || 0) / executedQuantity : null;
    const feeUsdt = (response.fills || []).reduce((sum, fill) => sum + (fill.commissionAsset === "USDT" ? Number(fill.commission || 0) : 0), 0);
    const [updated] = await db.update(challengeOrders).set({ exchangeOrderId: String(response.orderId), status, executedQuantity, averagePrice: Number.isFinite(averagePrice || NaN) ? averagePrice : null, feeUsdt, responseJson: JSON.stringify(response), updatedAt: new Date() }).where(eq(challengeOrders.id, pending.id)).returning();
    return Response.json({ ok: true, order: updated });
  } catch (error) {
    const unknown = error instanceof BinanceSpotError && error.executionUnknown;
    const [updated] = await db.update(challengeOrders).set({ status: unknown ? "EXECUTION_UNKNOWN" : "REJECTED", responseJson: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), updatedAt: new Date() }).where(eq(challengeOrders.id, pending.id)).returning();
    return Response.json({ ok: false, executionUnknown: unknown, order: updated, error: error instanceof Error ? error.message : String(error) }, { status: unknown ? 503 : 502 });
  }
}
