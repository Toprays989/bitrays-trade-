import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  paperAccounts,
  paperFills,
  paperOrders,
  paperPositions,
} from "../../../../db/schema";
import { getBinanceLiveMarkPrices } from "../../../../lib/binance-usdm-live";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

function objectBody(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const db = getDb();
  const accountId = new URL(request.url).searchParams.get("accountId") ?? undefined;
  const accounts = await db.select().from(paperAccounts).where(
    accountId
      ? and(eq(paperAccounts.ownerEmail, user.email), eq(paperAccounts.accountId, accountId))
      : eq(paperAccounts.ownerEmail, user.email),
  ).orderBy(desc(paperAccounts.updatedAt));
  const ids = accounts.map((account) => account.id);
  if (!ids.length) return Response.json({ accounts: [], orders: [], positions: [] });
  const orders = await db.select().from(paperOrders)
    .where(eq(paperOrders.ownerEmail, user.email))
    .orderBy(desc(paperOrders.createdAt)).limit(200);
  const positions = await db.select().from(paperPositions)
    .where(eq(paperPositions.ownerEmail, user.email))
    .orderBy(desc(paperPositions.updatedAt)).limit(200);
  return Response.json({
    environment: "PAPER",
    readOnlyMarketSource: "BINANCE_PUBLIC_LIVE_MARK_PRICE",
    accounts,
    orders: orders.filter((order) => ids.includes(order.paperAccountId)),
    positions: positions.filter((position) => ids.includes(position.paperAccountId)),
  });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const body = objectBody(await request.json().catch(() => null));
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const action = typeof body.action === "string" ? body.action : "";
  const db = getDb();
  const now = new Date();

  if (action === "CREATE_ACCOUNT") {
    const accountId = typeof body.accountId === "string" ? body.accountId.trim().toUpperCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const balance = positive(body.initialBalanceUsdt);
    if (!/^PAPER-[A-Z0-9_-]{1,20}$/.test(accountId) || !name || !balance)
      return Response.json({ error: "虚拟账户编号必须以 PAPER- 开头，且本金必须大于 0" }, { status: 400 });
    const existing = await db.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.ownerEmail, user.email), eq(paperAccounts.accountId, accountId))).limit(1);
    if (existing.length) return Response.json({ error: "虚拟账户编号已存在" }, { status: 409 });
    const [account] = await db.insert(paperAccounts).values({
      ownerEmail: user.email,
      accountId,
      name,
      initialBalanceUsdt: balance,
      balanceUsdt: balance,
      availableBalanceUsdt: balance,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return Response.json({ environment: "PAPER", account }, { status: 201 });
  }

  if (action !== "PLACE_ORDER") return Response.json({ error: "不支持的虚拟盘操作" }, { status: 400 });
  const accountId = typeof body.accountId === "string" ? body.accountId.trim().toUpperCase() : "";
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const direction = body.direction === "LONG" || body.direction === "SHORT" ? body.direction : null;
  const orderType = body.orderType === "LIMIT" ? "LIMIT" : body.orderType === "MARKET" ? "MARKET" : null;
  const quantity = positive(body.quantity);
  const limitPrice = positive(body.limitPrice);
  if (!/^PAPER-[A-Z0-9_-]{1,20}$/.test(accountId) || !/^[A-Z0-9]{3,20}USDT$/.test(symbol) || !direction || !orderType || !quantity || (orderType === "LIMIT" && !limitPrice))
    return Response.json({ error: "虚拟订单参数无效" }, { status: 400 });
  const [account] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.ownerEmail, user.email), eq(paperAccounts.accountId, accountId))).limit(1);
  if (!account) return Response.json({ error: "虚拟账户不存在" }, { status: 404 });
  if (account.status !== "ACTIVE") return Response.json({ error: "虚拟账户当前不可交易" }, { status: 409 });
  let fillPrice: number | null = null;
  if (orderType === "MARKET") {
    const [mark] = await getBinanceLiveMarkPrices([symbol]);
    fillPrice = Number(mark?.markPrice);
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return Response.json({ error: "实时标记价格暂不可用，虚拟订单未创建" }, { status: 503 });
  }
  const clientOrderId = `PAPER-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  const [order] = await db.insert(paperOrders).values({
    ownerEmail: user.email,
    paperAccountId: account.id,
    symbol,
    direction,
    orderType,
    quantity,
    limitPrice: orderType === "LIMIT" ? limitPrice : null,
    filledQuantity: fillPrice ? quantity : 0,
    averagePrice: fillPrice,
    status: fillPrice ? "FILLED" : "NEW",
    sourceBusiness: typeof body.sourceBusiness === "string" ? body.sourceBusiness.slice(0, 80) : "PAPER_TRADING",
    strategyId: Number.isInteger(body.strategyId) ? Number(body.strategyId) : null,
    brainKey: typeof body.brainKey === "string" ? body.brainKey.slice(0, 120) : null,
    configVersion: Number.isInteger(body.configVersion) ? Number(body.configVersion) : null,
    analysisRecordId: Number.isInteger(body.analysisRecordId) ? Number(body.analysisRecordId) : null,
    clientOrderId,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!fillPrice) return Response.json({ environment: "PAPER", order }, { status: 201 });
  const notional = quantity * fillPrice;
  const fee = notional * account.feeRateBps / 10_000;
  await db.insert(paperFills).values({ ownerEmail: user.email, paperAccountId: account.id, paperOrderId: order.id, symbol, direction, quantity, price: fillPrice, feeUsdt: fee, createdAt: now });
  const [position] = await db.select().from(paperPositions).where(and(eq(paperPositions.paperAccountId, account.id), eq(paperPositions.symbol, symbol), eq(paperPositions.status, "OPEN"))).limit(1);
  if (!position) {
    await db.insert(paperPositions).values({ ownerEmail: user.email, paperAccountId: account.id, symbol, direction, quantity, entryPrice: fillPrice, openedAt: now, updatedAt: now });
  } else if (position.direction === direction) {
    const nextQuantity = position.quantity + quantity;
    const nextEntry = (position.entryPrice * position.quantity + fillPrice * quantity) / nextQuantity;
    await db.update(paperPositions).set({ quantity: nextQuantity, entryPrice: nextEntry, updatedAt: now }).where(eq(paperPositions.id, position.id));
  } else {
    const closingQuantity = Math.min(position.quantity, quantity);
    const pnl = position.direction === "LONG" ? (fillPrice - position.entryPrice) * closingQuantity : (position.entryPrice - fillPrice) * closingQuantity;
    const remaining = position.quantity - closingQuantity;
    await db.update(paperPositions).set({ quantity: remaining, realizedPnlUsdt: position.realizedPnlUsdt + pnl, status: remaining > 0 ? "OPEN" : "CLOSED", updatedAt: now }).where(eq(paperPositions.id, position.id));
    if (quantity > closingQuantity) await db.insert(paperPositions).values({ ownerEmail: user.email, paperAccountId: account.id, symbol, direction, quantity: quantity - closingQuantity, entryPrice: fillPrice, openedAt: now, updatedAt: now });
  }
  await db.update(paperAccounts).set({ balanceUsdt: account.balanceUsdt - fee, availableBalanceUsdt: account.availableBalanceUsdt - fee, updatedAt: now }).where(eq(paperAccounts.id, account.id));
  return Response.json({ environment: "PAPER", order: { ...order, feeUsdt: fee, fillPrice }, fill: { quantity, price: fillPrice, feeUsdt: fee } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const body = objectBody(await request.json().catch(() => null));
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const action = typeof body.action === "string" ? body.action : "";
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "虚拟对象编号无效" }, { status: 400 });
  const db = getDb();
  const now = new Date();
  if (action === "CANCEL_ORDER") {
    const [order] = await db.select().from(paperOrders).where(and(eq(paperOrders.id, id), eq(paperOrders.ownerEmail, user.email))).limit(1);
    if (!order) return Response.json({ error: "虚拟订单不存在" }, { status: 404 });
    if (order.status !== "NEW") return Response.json({ error: "只有未成交的虚拟限价单可以撤销" }, { status: 409 });
    const [updated] = await db.update(paperOrders).set({ status: "CANCELED", updatedAt: now }).where(eq(paperOrders.id, id)).returning();
    return Response.json({ environment: "PAPER", order: updated });
  }
  if (action !== "CLOSE_POSITION") return Response.json({ error: "不支持的虚拟盘操作" }, { status: 400 });
  const [position] = await db.select().from(paperPositions).where(and(eq(paperPositions.id, id), eq(paperPositions.ownerEmail, user.email), eq(paperPositions.status, "OPEN"))).limit(1);
  if (!position) return Response.json({ error: "可平仓的虚拟持仓不存在" }, { status: 404 });
  const [mark] = await getBinanceLiveMarkPrices([position.symbol]);
  const exitPrice = Number(mark?.markPrice);
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return Response.json({ error: "实时标记价格暂不可用，虚拟持仓未平仓" }, { status: 503 });
  const pnl = position.direction === "LONG" ? (exitPrice - position.entryPrice) * position.quantity : (position.entryPrice - exitPrice) * position.quantity;
  const [account] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.id, position.paperAccountId), eq(paperAccounts.ownerEmail, user.email))).limit(1);
  if (!account) return Response.json({ error: "虚拟账户不存在" }, { status: 404 });
  const [updated] = await db.update(paperPositions).set({ quantity: 0, realizedPnlUsdt: position.realizedPnlUsdt + pnl, status: "CLOSED", updatedAt: now }).where(eq(paperPositions.id, position.id)).returning();
  const fee = position.quantity * exitPrice * account.feeRateBps / 10_000;
  await db.update(paperAccounts).set({ balanceUsdt: account.balanceUsdt + pnl - fee, availableBalanceUsdt: account.availableBalanceUsdt + pnl - fee, updatedAt: now }).where(eq(paperAccounts.id, account.id));
  return Response.json({ environment: "PAPER", position: updated, exitPrice, pnl, feeUsdt: fee });
}
