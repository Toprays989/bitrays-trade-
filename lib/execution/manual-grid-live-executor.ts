import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  contractSymbols,
  exchangeCredentials,
  liveOrderEvents,
  livePositionAdditions,
  livePositions,
  manualEntryGridPlans,
} from "../../db/schema.ts";
import {
  getLivePositionSnapshot,
  queryLiveOrder,
  submitLiveEntryOrder,
} from "./exchange-order-gateway.ts";
import { credentialContext, decryptCredential } from "../credential-vault.ts";
import { buildFilledPositionProtection } from "./filled-position-protection.ts";
import {
  buildFilledPositionInsertValues,
} from "./filled-position-persistence.ts";
import { settleFilledManualPosition } from "./manual-filled-position-settlement.ts";
import { settlePositionAdditionBasis } from "./position-addition-settlement.ts";
import { normalizeExecutedRiskProgress } from "../risk-execution-progress.ts";
import { rebalanceRiskPlan } from "../risk-plan-rebalance.ts";
import type { ManualGridMarketOrderRequest } from "../manual-entry-grid.ts";

type Db = ReturnType<typeof getDb>;
type Plan = typeof manualEntryGridPlans.$inferSelect;
type Position = typeof livePositions.$inferSelect;

function jsonRecord(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function jsonArray(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fillFrom(value: unknown) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const quantity = Number(row.executedQty) || 0;
  const average = Number(row.avgPrice) || 0;
  return {
    status: String(row.status ?? "UNKNOWN").toUpperCase(),
    quantity,
    price: average > 0 ? average : quantity > 0 ? Number(row.cumQuote ?? 0) / quantity : 0,
    orderId: String(row.orderId ?? "") || null,
  };
}

async function keysFor(credential: typeof exchangeCredentials.$inferSelect, ownerEmail: string, accountId: string) {
  return {
    apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(ownerEmail, accountId, "api-key")),
    secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(ownerEmail, accountId, "secret-key")),
  };
}

async function findOrCreateOrder(input: {
  db: Db;
  ownerEmail: string;
  accountId: string;
  credentialId: number;
  order: ManualGridMarketOrderRequest;
  referencePrice: number;
  now: Date;
}) {
  const [created] = await input.db.insert(liveOrderEvents).values({
    ownerEmail: input.ownerEmail,
    accountId: input.accountId,
    credentialId: input.credentialId,
    clientOrderId: input.order.clientOrderId,
    symbol: input.order.symbol,
    side: input.order.side,
    positionSide: input.order.positionSide,
    orderType: "MARKET",
    quantity: input.order.quantity,
    referencePrice: input.referencePrice,
    estimatedNotional: input.referencePrice * input.order.quantity,
    testOnly: false,
    status: "PENDING",
    responseJson: JSON.stringify({ source: "MANUAL_GRID", triggerLevelPrice: input.order.triggerLevelPrice, triggerPrice: input.order.triggerPrice, triggerCount: input.order.triggerCount }),
    lifecycleId: `manual-grid-${input.order.clientOrderId}`,
    entryDecisionHandoffJson: JSON.stringify({ source: "MANUAL_GRID", triggerLevelPrice: input.order.triggerLevelPrice, triggerPrice: input.order.triggerPrice, triggerCount: input.order.triggerCount }),
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await input.db.select().from(liveOrderEvents).where(and(
    eq(liveOrderEvents.ownerEmail, input.ownerEmail),
    eq(liveOrderEvents.accountId, input.accountId),
    eq(liveOrderEvents.credentialId, input.credentialId),
    eq(liveOrderEvents.clientOrderId, input.order.clientOrderId),
  )).limit(1);
  if (!existing) throw new Error("网格订单幂等记录创建失败");
  return existing;
}

async function exchangeFill(input: {
  credential: typeof exchangeCredentials.$inferSelect;
  ownerEmail: string;
  accountId: string;
  order: ManualGridMarketOrderRequest;
  leverage: number;
}) {
  const keys = await keysFor(input.credential, input.ownerEmail, input.accountId);
  const submitted = await submitLiveEntryOrder(keys, {
    symbol: input.order.symbol,
    side: input.order.side,
    positionSide: input.order.positionSide,
    quantity: input.order.quantity,
    clientOrderId: input.order.clientOrderId,
    leverage: input.leverage,
    positionMode: input.credential.positionMode ?? "ONE_WAY",
    orderType: "MARKET",
  });
  let execution = submitted.data;
  let fill = fillFrom(execution);
  if (fill.status !== "FILLED" || fill.quantity <= 0 || fill.price <= 0) {
    try {
      execution = (await queryLiveOrder(keys, input.order.symbol, input.order.clientOrderId)).data;
      fill = fillFrom(execution);
    } catch {
      // Keep the submit response as the only exchange evidence available.
    }
  }
  return { keys, submitted, execution, fill };
}

export async function executeManualGridFirstEntry(input: {
  db?: Db;
  plan: Plan;
  order: ManualGridMarketOrderRequest;
  referencePrice: number;
  credential: typeof exchangeCredentials.$inferSelect;
  symbol: typeof contractSymbols.$inferSelect;
}) {
  const db = input.db ?? getDb();
  const now = new Date();
  const event = await findOrCreateOrder({ db, ownerEmail: input.plan.ownerEmail, accountId: input.plan.accountId, credentialId: input.plan.credentialId, order: input.order, referencePrice: input.referencePrice, now });
  if (event.status === "FILLED") return { status: "FILLED" as const, orderEventId: event.id, positionId: null, duplicate: true };
  let result: Awaited<ReturnType<typeof exchangeFill>>;
  try {
    result = await exchangeFill({ credential: input.credential, ownerEmail: input.plan.ownerEmail, accountId: input.plan.accountId, order: input.order, leverage: input.plan.leverage });
  } catch (error) {
    await db.update(liveOrderEvents).set({ status: "REJECTED", responseJson: JSON.stringify({ source: "MANUAL_GRID", error: error instanceof Error ? error.message : String(error) }), updatedAt: new Date() }).where(eq(liveOrderEvents.id, event.id));
    return { status: "REJECTED" as const, orderEventId: event.id, positionId: null, duplicate: false };
  }
  if (result.fill.quantity <= 0 || result.fill.price <= 0) {
    await db.update(liveOrderEvents).set({ exchangeOrderId: result.fill.orderId, status: "EXECUTION_UNKNOWN", responseJson: JSON.stringify(result.execution), updatedAt: new Date() }).where(eq(liveOrderEvents.id, event.id));
    return { status: "EXECUTION_UNKNOWN" as const, orderEventId: event.id, positionId: null, duplicate: false };
  }
  const dynamic = input.plan.trailingStopPercent > 0;
  const rebalanced = rebalanceRiskPlan({
    calculationMode: "ROE",
    orderOrigin: "MANUAL",
    dynamicProfitProtectionEnabled: dynamic,
    takeProfits: jsonArray(input.plan.takeProfitPlanJson),
    stopLosses: dynamic ? [] : jsonArray(input.plan.stopLossPlanJson),
  }, result.fill.quantity, input.symbol.minOrderQty, input.symbol.quantityStep);
  const protection = buildFilledPositionProtection({ plan: rebalanced.plan, activatedAt: now, trailingActivationPercent: input.plan.trailingActivationPercent, trailingStopPercent: input.plan.trailingStopPercent });
  const positionValues = buildFilledPositionInsertValues({
    ownerEmail: input.plan.ownerEmail,
    accountId: input.plan.accountId,
    credentialId: input.plan.credentialId,
    sourceEventId: event.id,
    handoffOrigin: "MANUAL",
    lifecycleId: event.lifecycleId,
    entryDecisionHandoffJson: event.entryDecisionHandoffJson,
    symbol: input.plan.symbol,
    instrumentId: input.symbol.instrumentId,
    instrumentRuleVersion: input.symbol.ruleVersion,
    positionSide: input.plan.positionSide,
    quantity: result.fill.quantity,
    entryPrice: result.fill.price,
    leverage: input.plan.leverage,
    protection,
    openedAt: now,
    updatedAt: now,
  });
  const settled = await settleFilledManualPosition({
    db,
    orderEventId: event.id,
    exchangeOrderId: result.fill.orderId,
    orderResponseJson: JSON.stringify({ ...result.execution, source: "MANUAL_GRID" }),
    positionValues,
    positionRecoveryValues: { ...protection, updatedAt: now },
    settledAt: now,
  });
  return { status: "FILLED" as const, orderEventId: event.id, positionId: settled.position.id, duplicate: settled.alreadySettled };
}

export async function executeManualGridAddition(input: {
  db?: Db;
  plan: Plan;
  position: Position;
  order: ManualGridMarketOrderRequest;
  referencePrice: number;
  credential: typeof exchangeCredentials.$inferSelect;
  symbol: typeof contractSymbols.$inferSelect;
}) {
  const db = input.db ?? getDb();
  const now = new Date();
  const [addition] = await db.insert(livePositionAdditions).values({
    positionId: input.position.id,
    basePositionVersion: input.position.positionVersion,
    ownerEmail: input.plan.ownerEmail,
    accountId: input.plan.accountId,
    clientOrderId: input.order.clientOrderId,
    symbol: input.plan.symbol,
    positionSide: input.plan.positionSide,
    quantity: input.order.quantity,
    notionalUsdt: input.order.quantity * input.referencePrice,
    status: "PENDING",
    decisionJson: JSON.stringify({ source: "MANUAL_GRID", triggerLevelPrice: input.order.triggerLevelPrice, triggerPrice: input.order.triggerPrice, triggerCount: input.order.triggerCount, previousQuantity: input.position.quantity, previousEntryPrice: input.position.entryPrice }),
    responseJson: JSON.stringify({ source: "MANUAL_GRID" }),
    lifecycleId: input.position.lifecycleId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning();
  if (!addition) return { status: "DUPLICATE" as const, positionId: input.position.id };
  let event;
  try {
    event = await findOrCreateOrder({ db, ownerEmail: input.plan.ownerEmail, accountId: input.plan.accountId, credentialId: input.plan.credentialId, order: input.order, referencePrice: input.referencePrice, now });
  } catch (error) {
    await db.update(livePositionAdditions).set({ status: "REJECTED", lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date() }).where(eq(livePositionAdditions.id, addition.id));
    return { status: "REJECTED" as const, positionId: input.position.id };
  }
  let result: Awaited<ReturnType<typeof exchangeFill>>;
  try {
    result = await exchangeFill({ credential: input.credential, ownerEmail: input.plan.ownerEmail, accountId: input.plan.accountId, order: input.order, leverage: input.position.leverage });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.batch([
      db.update(liveOrderEvents).set({ status: "REJECTED", responseJson: JSON.stringify({ source: "MANUAL_GRID", error: message }), updatedAt: new Date() }).where(eq(liveOrderEvents.id, event.id)),
      db.update(livePositionAdditions).set({ status: "REJECTED", lastError: message, updatedAt: new Date() }).where(eq(livePositionAdditions.id, addition.id)),
    ]);
    return { status: "REJECTED" as const, positionId: input.position.id };
  }
  if (result.fill.quantity <= 0 || result.fill.price <= 0) {
    await db.batch([
      db.update(liveOrderEvents).set({ exchangeOrderId: result.fill.orderId, status: "EXECUTION_UNKNOWN", responseJson: JSON.stringify(result.execution), updatedAt: new Date() }).where(eq(liveOrderEvents.id, event.id)),
      db.update(livePositionAdditions).set({ exchangeOrderId: result.fill.orderId, status: "EXECUTION_UNKNOWN", responseJson: JSON.stringify(result.execution), updatedAt: new Date() }).where(eq(livePositionAdditions.id, addition.id)),
    ]);
    return { status: "EXECUTION_UNKNOWN" as const, positionId: input.position.id };
  }
  let exchangeQuantity = result.fill.quantity + input.position.quantity;
  let exchangeEntryPrice = result.fill.price;
  let markPrice = result.fill.price;
  try {
    const snapshot = await getLivePositionSnapshot(await keysFor(input.credential, input.plan.ownerEmail, input.plan.accountId), input.plan.symbol, input.plan.positionSide);
    if (snapshot.quantity > 0) {
      exchangeQuantity = snapshot.quantity;
      exchangeEntryPrice = snapshot.entryPrice > 0 ? snapshot.entryPrice : exchangeEntryPrice;
      markPrice = snapshot.markPrice > 0 ? snapshot.markPrice : markPrice;
    }
  } catch {
    // The local combined basis remains valid; the next live-risk cycle retries the exchange snapshot.
  }
  const settled = settlePositionAdditionBasis({
    currentQuantity: input.position.quantity,
    currentEntryPrice: input.position.entryPrice,
    addedQuantity: result.fill.quantity,
    addedEntryPrice: result.fill.price,
    exchangeQuantity,
    exchangeEntryPrice,
    riskPlan: jsonRecord(input.position.riskPlanJson),
    executedRiskProgress: normalizeExecutedRiskProgress(jsonRecord(input.position.executedRiskPlanJson)),
    minOrderQty: input.symbol.minOrderQty,
    quantityStep: input.symbol.quantityStep,
    minNotionalUsdt: input.symbol.minNotionalUsdt,
    trailingStopPercent: input.position.trailingStopPercent,
    positionVersion: input.position.positionVersion,
    protectionVersion: input.position.protectionVersion,
    nowMs: now.getTime(),
    source: "MANUAL_ADD_ON",
  });
  const [applied] = await db.update(livePositions).set({
    quantity: settled.syncedQuantity,
    entryPrice: settled.syncedEntryPrice,
    markPrice,
    positionVersion: settled.nextPositionVersion,
    protectionVersion: settled.nextProtectionVersion,
    protectionState: "ACTIVE",
    protectionUpdatedAt: now,
    riskPlanJson: JSON.stringify(settled.riskPlan),
    executedRiskPlanJson: JSON.stringify(settled.executedRiskProgress),
    favorablePrice: markPrice,
    additionCount: input.position.additionCount + 1,
    lastAdditionClientOrderId: input.order.clientOrderId,
    lastError: null,
    updatedAt: now,
  }).where(and(eq(livePositions.id, input.position.id), eq(livePositions.status, "OPEN"), eq(livePositions.positionVersion, input.position.positionVersion), eq(livePositions.protectionVersion, input.position.protectionVersion))).returning({ id: livePositions.id });
  if (!applied) {
    await db.batch([
      db.update(liveOrderEvents).set({ exchangeOrderId: result.fill.orderId, status: "EXECUTION_UNKNOWN", responseJson: JSON.stringify(result.execution), updatedAt: now }).where(eq(liveOrderEvents.id, event.id)),
      db.update(livePositionAdditions).set({ exchangeOrderId: result.fill.orderId, status: "EXECUTION_UNKNOWN", responseJson: JSON.stringify(result.execution), updatedAt: now }).where(eq(livePositionAdditions.id, addition.id)),
    ]);
    return { status: "EXECUTION_UNKNOWN" as const, positionId: input.position.id };
  }
  await db.batch([
    db.update(liveOrderEvents).set({ exchangeOrderId: result.fill.orderId, status: "FILLED", responseJson: JSON.stringify({ ...result.execution, source: "MANUAL_GRID", positionVersion: settled.nextPositionVersion }), updatedAt: now }).where(eq(liveOrderEvents.id, event.id)),
    db.update(livePositionAdditions).set({ exchangeOrderId: result.fill.orderId, quantity: result.fill.quantity, entryPrice: result.fill.price, notionalUsdt: result.fill.quantity * result.fill.price, status: "SUBMITTED", appliedPositionVersion: settled.nextPositionVersion, protectionVersion: settled.nextProtectionVersion, responseJson: JSON.stringify({ ...result.execution, source: "MANUAL_GRID" }), updatedAt: now }).where(eq(livePositionAdditions.id, addition.id)),
  ]);
  return { status: "FILLED" as const, positionId: input.position.id, positionVersion: settled.nextPositionVersion };
}
