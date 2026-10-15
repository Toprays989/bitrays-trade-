import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { simpleReboundSlots } from "../db/schema.ts";
import {
  SIMPLE_REBOUND_MAX_SLOTS,
} from "./simple-rebound-slots.ts";
import { hydrateSimpleReboundSlots } from "./simple-rebound-slot-recovery.ts";

export async function loadSimpleReboundSlots(strategyId: number) {
  const rows = await getDb()
    .select()
    .from(simpleReboundSlots)
    .where(eq(simpleReboundSlots.strategyId, strategyId))
    .orderBy(asc(simpleReboundSlots.slotId));
  return hydrateSimpleReboundSlots(rows);
}

export async function occupyPersistedSimpleReboundSlot(input: Readonly<{
  strategyId: number;
  slotId: number;
  ownerEmail: string;
  accountId: string;
  symbol: string;
  entryPrice: number;
  openedAtMs: number;
  traceId?: string;
}>) {
  if (
    input.slotId < 1 ||
    input.slotId > SIMPLE_REBOUND_MAX_SLOTS ||
    !Number.isFinite(input.entryPrice) ||
    input.entryPrice <= 0
  )
    return null;

  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol) return null;
  const [row] = await getDb()
    .insert(simpleReboundSlots)
    .values({
      strategyId: input.strategyId,
      slotId: input.slotId,
      ownerEmail: input.ownerEmail,
      accountId: input.accountId,
      symbol,
      entryPrice: input.entryPrice,
      openedAt: new Date(input.openedAtMs),
      traceId: input.traceId,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function releasePersistedSimpleReboundSlot(
  strategyId: number,
  slotId: number,
) {
  await getDb()
    .delete(simpleReboundSlots)
    .where(
      and(
        eq(simpleReboundSlots.strategyId, strategyId),
        eq(simpleReboundSlots.slotId, slotId),
      ),
    );
}
