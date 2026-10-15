import { SIMPLE_REBOUND_MAX_SLOTS, type SimpleReboundSlot } from "./simple-rebound-slots.ts";

export type SimpleReboundSlotRow = Readonly<{
  slotId: number;
  symbol: string;
  entryPrice: number;
  openedAt: Date;
}>;

/** Convert persisted rows into the fixed five-seat runtime shape after restart. */
export function hydrateSimpleReboundSlots(
  rows: readonly SimpleReboundSlotRow[],
) {
  const slots: (SimpleReboundSlot | null)[] = Array.from(
    { length: SIMPLE_REBOUND_MAX_SLOTS },
    () => null,
  );
  for (const row of rows) {
    if (row.slotId < 1 || row.slotId > SIMPLE_REBOUND_MAX_SLOTS) continue;
    slots[row.slotId - 1] = {
      slotId: row.slotId,
      symbol: row.symbol,
      entryPrice: row.entryPrice,
      openedAtMs: row.openedAt.getTime(),
    };
  }
  return slots;
}
