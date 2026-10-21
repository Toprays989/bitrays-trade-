import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  exchangeCredentials,
  manualEntryGridLevels,
  manualEntryGridPlans,
  tradingAccounts,
} from "../../../../db/schema";
import { getBinanceLiveContractRule } from "../../../../lib/binance-usdm-live";
import { liveTradingAllowedByServer } from "../../../../lib/credential-vault";
import { getTradeReadiness } from "../../../../lib/trade-readiness";
import { allocateManualGridQuantity, buildManualGridLevels } from "../../../../lib/manual-entry-grid";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function tickAligned(value: number, tick: number) {
  return Math.abs(value / tick - Math.round(value / tick)) <= 1e-8;
}

function roundTick(value: number, tick: number) {
  return Number((Math.round(value / tick) * tick).toFixed(12));
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const db = getDb();
  const planId = Number(new URL(request.url).searchParams.get("id"));
  const plans = await db
    .select()
    .from(manualEntryGridPlans)
    .where(and(
      eq(manualEntryGridPlans.ownerEmail, user.email),
      Number.isInteger(planId) && planId > 0
        ? eq(manualEntryGridPlans.id, planId)
        : undefined,
    ))
    .orderBy(desc(manualEntryGridPlans.updatedAt))
    .limit(planId > 0 ? 1 : 50);
  const levels = plans.length
    ? await db.select().from(manualEntryGridLevels).where(inArray(manualEntryGridLevels.planId, plans.map((plan) => plan.id)))
    : [];
  return Response.json({ plans: plans.map((plan) => ({
    ...plan,
    levels: levels.filter((level) => level.planId === plan.id),
  })) });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const body = bodyObject(await request.json().catch(() => null));
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const credentialId = Number(body.credentialId);
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const positionSide = body.positionSide === "SHORT" ? "SHORT" : body.positionSide === "LONG" ? "LONG" : null;
  const lowerPrice = positive(body.lowerPrice);
  const upperPrice = positive(body.upperPrice);
  const totalQuantity = positive(body.totalQuantity);
  const leverage = Number(body.leverage ?? 1);
  const takeProfitPlan = Array.isArray(body.takeProfitPlan) ? body.takeProfitPlan : [];
  const stopLossPlan = Array.isArray(body.stopLossPlan) ? body.stopLossPlan : [];
  const trailingActivationPercent = Number(body.trailingActivationPercent ?? 0);
  const trailingStopPercent = Number(body.trailingStopPercent ?? 0);
  const capitalPreservationStopRoePercent = body.capitalPreservationStopRoePercent === undefined ? null : Number(body.capitalPreservationStopRoePercent);
  const gridCount = Number(body.gridCount);
  const hysteresisBps = body.hysteresisBps === undefined ? 5 : Number(body.hysteresisBps);
  const expiresAtMs = body.expiresAt === undefined ? null : Number(body.expiresAt);
  if (!accountId || !Number.isInteger(credentialId) || !symbol || !positionSide ||
    lowerPrice === null || upperPrice === null || totalQuantity === null ||
    !Number.isInteger(gridCount) || gridCount < 2 || gridCount > 100 ||
    !Number.isInteger(leverage) || leverage < 1 || leverage > 125 ||
    !Number.isFinite(trailingActivationPercent) || trailingActivationPercent < 0 || trailingActivationPercent > 100 ||
    !Number.isFinite(trailingStopPercent) || trailingStopPercent < 0 || trailingStopPercent > 50 ||
    (trailingStopPercent > 0 && (!Number.isFinite(capitalPreservationStopRoePercent) || Number(capitalPreservationStopRoePercent) <= 0)) ||
    !Number.isFinite(hysteresisBps) || hysteresisBps < 0 || hysteresisBps > 1_000 ||
    (expiresAtMs !== null && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()))) {
    return Response.json({ error: "网格参数无效" }, { status: 400 });
  }
  if (upperPrice <= lowerPrice) return Response.json({ error: "上限价格必须大于下限价格" }, { status: 400 });
  if (trailingStopPercent > 0 && stopLossPlan.length > 0) return Response.json({ error: "移动止损与固定止损网格不能同时启用" }, { status: 400 });

  const db = getDb();
  const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, accountId))).limit(1);
  const [credential] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.id, credentialId), eq(exchangeCredentials.accountId, accountId))).limit(1);
  if (!account || !credential) return Response.json({ error: "实盘账户或密钥不存在" }, { status: 404 });
  const readiness = getTradeReadiness(account, credential, await liveTradingAllowedByServer());
  if (!readiness.liveReady) return Response.json({ error: "账户尚未满足实盘执行条件", readiness }, { status: 409 });
  if (account.accountType === "MAIN" || account.executionMode !== "LIVE") return Response.json({ error: "网格计划只允许非 MAIN 实盘账户" }, { status: 409 });

  let contract;
  try { ({ contract } = await getBinanceLiveContractRule(symbol)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "合约规则读取失败" }, { status: 422 }); }
  if (!tickAligned(lowerPrice, contract.priceTickSize) || !tickAligned(upperPrice, contract.priceTickSize))
    return Response.json({ error: `区间边界必须按 ${contract.priceTickSize} 的价格步长设置` }, { status: 400 });
  if (totalQuantity < contract.minOrderQty || !tickAligned(totalQuantity, contract.quantityStep))
    return Response.json({ error: `总数量必须不小于 ${contract.minOrderQty} 且按 ${contract.quantityStep} 步长设置` }, { status: 400 });
  if (Number.isFinite(Number(contract.maxLeverage)) && leverage > Number(contract.maxLeverage)) return Response.json({ error: `杠杆不能超过合约上限 ${contract.maxLeverage}` }, { status: 400 });
  let rawLevels;
  let quantities;
  try {
    rawLevels = buildManualGridLevels({ lowerPrice, upperPrice, gridCount });
    quantities = allocateManualGridQuantity({ totalQuantity, levelCount: gridCount, quantityStep: contract.quantityStep });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "网格参数无法分配" }, { status: 422 });
  }
  const prices = rawLevels.map((level) => roundTick(level.price, contract.priceTickSize));
  if (new Set(prices).size !== prices.length || prices.some((price, index) => index > 0 && price <= prices[index - 1]))
    return Response.json({ error: "当前价格步长过大，无法生成互不重复的网格价位" }, { status: 422 });
  if (quantities.length !== prices.length) return Response.json({ error: "网格数量分配结果与价位数量不一致" }, { status: 422 });
  if (quantities.some((quantity) => quantity < contract.minOrderQty))
    return Response.json({ error: "平均分配后存在低于合约最小下单量的网格" }, { status: 422 });
  const existing = await db.select({ id: manualEntryGridPlans.id }).from(manualEntryGridPlans).where(and(
    eq(manualEntryGridPlans.ownerEmail, user.email), eq(manualEntryGridPlans.accountId, accountId), eq(manualEntryGridPlans.symbol, symbol), eq(manualEntryGridPlans.positionSide, positionSide), inArray(manualEntryGridPlans.status, ["DRAFT", "ARMED", "PAUSED"]),
  )).limit(1);
  if (existing.length) return Response.json({ error: "同账户、同交易对、同方向已有未结束网格计划" }, { status: 409 });

  const now = new Date();
  const [plan] = await db.insert(manualEntryGridPlans).values({
    ownerEmail: user.email, accountId, credentialId, symbol, positionSide,
    lowerPrice, upperPrice, gridCount, totalQuantity, quantityStep: contract.quantityStep,
    leverage, takeProfitPlanJson: JSON.stringify(takeProfitPlan), stopLossPlanJson: JSON.stringify(stopLossPlan),
    trailingActivationPercent, trailingStopPercent, capitalPreservationStopRoePercent,
    hysteresisBps, levelsJson: JSON.stringify(prices), status: "DRAFT",
    expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs), createdAt: now, updatedAt: now,
  }).returning();
  if (!plan) return Response.json({ error: "网格计划创建失败" }, { status: 500 });
  const levels = await db.insert(manualEntryGridLevels).values(prices.map((price, index) => ({
    planId: plan.id, levelIndex: index, levelPrice: price, quantity: quantities[index], state: "ARMED" as const, updatedAt: now,
  }))).returning();
  return Response.json({ plan: { ...plan, levels }, readiness, contract }, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const body = bodyObject(await request.json().catch(() => null));
  const id = Number(body?.id);
  const action = body?.action;
  if (!Number.isInteger(id) || id <= 0 || !["ARM", "PAUSE", "CANCEL"].includes(String(action))) return Response.json({ error: "计划状态操作无效" }, { status: 400 });
  const nextStatus = action === "ARM" ? "ARMED" : action === "PAUSE" ? "PAUSED" : "CANCELED";
  const [plan] = await getDb().update(manualEntryGridPlans).set({ status: nextStatus, updatedAt: new Date(), lastBlockReason: null }).where(and(eq(manualEntryGridPlans.id, id), eq(manualEntryGridPlans.ownerEmail, user.email), inArray(manualEntryGridPlans.status, ["DRAFT", "ARMED", "PAUSED"]))).returning();
  if (!plan) return Response.json({ error: "计划不存在或当前状态不可操作" }, { status: 409 });
  return Response.json({ plan });
}
