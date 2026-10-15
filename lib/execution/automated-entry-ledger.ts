import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import { liveOrderEvents, livePositions } from "../../db/schema.ts";

export const AUTOMATED_ENTRY_LEDGER_VERSION =
  "automated-entry-ledger-v1" as const;

type LiveOrderInsert = typeof liveOrderEvents.$inferInsert;
type LivePositionInsert = typeof livePositions.$inferInsert;

export async function createAutomatedEntryOrder(input: {
  ownerEmail: string;
  accountId: string;
  credentialId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  orderType: "MARKET" | "LIMIT";
  quantity: number;
  referencePrice: number;
  responseJson: string;
  lifecycleId: string;
  entryDecisionHandoffJson: string;
  createdAt: Date;
}) {
  const db = getDb();
  const values: LiveOrderInsert = {
    ownerEmail: input.ownerEmail,
    accountId: input.accountId,
    credentialId: input.credentialId,
    clientOrderId: input.clientOrderId,
    symbol: input.symbol,
    side: input.side,
    positionSide: input.positionSide,
    orderType: input.orderType,
    quantity: input.quantity,
    referencePrice: input.referencePrice,
    estimatedNotional: input.quantity * input.referencePrice,
    testOnly: false,
    status: "PENDING",
    responseJson: input.responseJson,
    lifecycleId: input.lifecycleId,
    entryDecisionHandoffJson: input.entryDecisionHandoffJson,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  const [inserted] = await db
    .insert(liveOrderEvents)
    .values(values)
    .onConflictDoNothing({ target: liveOrderEvents.clientOrderId })
    .returning();
  if (inserted) return { order: inserted, reused: false } as const;

  const [existing] = await db
    .select()
    .from(liveOrderEvents)
    .where(eq(liveOrderEvents.clientOrderId, input.clientOrderId))
    .limit(1);
  if (
    !existing ||
    existing.ownerEmail !== input.ownerEmail ||
    existing.accountId !== input.accountId ||
    existing.symbol !== input.symbol ||
    existing.side !== input.side ||
    existing.positionSide !== input.positionSide
  )
    throw new Error("客户端订单号已被其他交易身份占用");
  return { order: existing, reused: true } as const;
}

export async function persistFilledAutomatedPosition(input: {
  insertValues: LivePositionInsert;
  recoveryValues: Partial<LivePositionInsert>;
}) {
  const sourceEventId = Number(input.insertValues.sourceEventId);
  if (!Number.isInteger(sourceEventId) || sourceEventId <= 0)
    throw new Error("成交仓位缺少有效来源订单编号");
  const db = getDb();
  const [inserted] = await db
    .insert(livePositions)
    .values(input.insertValues)
    .onConflictDoNothing({ target: livePositions.sourceEventId })
    .returning();
  if (inserted) return { position: inserted, recovered: false } as const;

  const [existing] = await db
    .select()
    .from(livePositions)
    .where(eq(livePositions.sourceEventId, sourceEventId))
    .limit(1);
  if (
    !existing ||
    existing.ownerEmail !== input.insertValues.ownerEmail ||
    existing.accountId !== input.insertValues.accountId ||
    existing.symbol !== input.insertValues.symbol ||
    existing.positionSide !== input.insertValues.positionSide
  )
    throw new Error("来源订单已绑定到其他真实仓位");
  const [recovered] = await db
    .update(livePositions)
    .set(input.recoveryValues)
    .where(eq(livePositions.id, existing.id))
    .returning();
  if (!recovered) throw new Error("成交仓位恢复失败");
  return { position: recovered, recovered: true } as const;
}
