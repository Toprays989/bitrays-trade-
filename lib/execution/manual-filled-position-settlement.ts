import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "../../db/index.ts";
import {
  liveOrderEvents,
  livePositions,
} from "../../db/schema.ts";
import type {
  buildFilledPositionInsertValues,
  buildFilledPositionRecoveryValues,
} from "./filled-position-persistence.ts";

export const MANUAL_FILLED_POSITION_SETTLEMENT_VERSION =
  "manual-filled-position-settlement-v1" as const;

type NexusDb = ReturnType<typeof getDb>;
type PositionInsertValues = ReturnType<
  typeof buildFilledPositionInsertValues
>;
type PositionRecoveryValues = ReturnType<
  typeof buildFilledPositionRecoveryValues
>;

async function positionBySourceEventId(db: NexusDb, sourceEventId: number) {
  return db
    .select()
    .from(livePositions)
    .where(eq(livePositions.sourceEventId, sourceEventId))
    .limit(1)
    .then((rows) => rows[0]);
}

export async function settleFilledManualPosition(input: {
  db: NexusDb;
  orderEventId: number;
  exchangeOrderId: string | null;
  orderResponseJson: string;
  positionValues: PositionInsertValues;
  positionRecoveryValues: PositionRecoveryValues;
  settledAt: Date;
}) {
  if (input.positionValues.sourceEventId !== input.orderEventId)
    throw new Error("人工成交仓位来源订单号不一致，禁止结算");

  let position = await positionBySourceEventId(input.db, input.orderEventId);
  let created = false;
  if (!position) {
    try {
      [position] = await input.db
        .insert(livePositions)
        .values(input.positionValues)
        .returning();
      created = true;
    } catch (error) {
      position = await positionBySourceEventId(input.db, input.orderEventId);
      if (!position) throw error;
    }
  }

  const [order] = await input.db
    .select()
    .from(liveOrderEvents)
    .where(eq(liveOrderEvents.id, input.orderEventId))
    .limit(1);
  if (!order || !position)
    throw new Error("人工成交订单或仓位不存在，禁止结算");
  if (
    position.sourceEventId !== order.id ||
    position.ownerEmail !== order.ownerEmail ||
    position.accountId !== order.accountId ||
    position.credentialId !== order.credentialId ||
    position.symbol !== order.symbol ||
    position.positionSide !== order.positionSide
  )
    throw new Error("人工成交订单与仓位所有权不一致，禁止结算");

  if (order.status === "FILLED")
    return { position, created, alreadySettled: true };

  const [orderRows, positionRows] = await input.db.batch([
    input.db
      .update(liveOrderEvents)
      .set({
        exchangeOrderId: input.exchangeOrderId,
        status: "FILLED",
        responseJson: input.orderResponseJson,
        updatedAt: input.settledAt,
      })
      .where(and(
        eq(liveOrderEvents.id, input.orderEventId),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
        ]),
      ))
      .returning({ id: liveOrderEvents.id }),
    input.db
      .update(livePositions)
      .set(input.positionRecoveryValues)
      .where(and(
        eq(livePositions.id, position.id),
        eq(livePositions.sourceEventId, input.orderEventId),
      ))
      .returning({ id: livePositions.id }),
  ]);
  if (!positionRows[0])
    throw new Error("人工成交仓位保护校准失败，等待下轮巡检重试");
  if (!orderRows[0]) {
    const [latestOrder] = await input.db
      .select({ status: liveOrderEvents.status })
      .from(liveOrderEvents)
      .where(eq(liveOrderEvents.id, input.orderEventId))
      .limit(1);
    if (latestOrder?.status !== "FILLED")
      throw new Error("人工成交订单终态未完成，等待下轮巡检重试");
    return { position, created, alreadySettled: true };
  }

  return { position, created, alreadySettled: false };
}
