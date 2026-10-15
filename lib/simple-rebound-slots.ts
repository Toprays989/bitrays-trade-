export const SIMPLE_REBOUND_MAX_SLOTS = 5;

export type SimpleReboundSlot = Readonly<{
  slotId: number;
  symbol: string;
  entryPrice: number;
  openedAtMs: number;
}>;

export function createSimpleReboundSlots(
  slots: readonly (SimpleReboundSlot | null)[] = [],
) {
  return Array.from({ length: SIMPLE_REBOUND_MAX_SLOTS }, (_, index) => slots[index] ?? null);
}

export function availableSimpleReboundSlots(
  slots: readonly (SimpleReboundSlot | null)[],
) {
  return Math.max(0, SIMPLE_REBOUND_MAX_SLOTS - slots.filter(Boolean).length);
}

export function occupySimpleReboundSlot(
  slots: readonly (SimpleReboundSlot | null)[],
  input: Omit<SimpleReboundSlot, "slotId">,
) {
  const next = createSimpleReboundSlots(slots);
  if (next.some((slot) => slot?.symbol === input.symbol))
    return { slots: next, occupied: null };
  const index = next.findIndex((slot) => slot === null);
  if (index < 0) return { slots: next, occupied: null };
  const occupied = { ...input, slotId: index + 1 };
  next[index] = occupied;
  return { slots: next, occupied };
}

export function occupySimpleReboundSlotAt(
  slots: readonly (SimpleReboundSlot | null)[],
  input: SimpleReboundSlot,
) {
  const next = createSimpleReboundSlots(slots);
  if (input.slotId < 1 || input.slotId > SIMPLE_REBOUND_MAX_SLOTS) return { slots: next, occupied: null };
  if (next[input.slotId - 1] || next.some((slot, index) => index !== input.slotId - 1 && slot?.symbol === input.symbol))
    return { slots: next, occupied: null };
  next[input.slotId - 1] = input;
  return { slots: next, occupied: input };
}

export function findSimpleReboundSlot(
  slots: readonly (SimpleReboundSlot | null)[],
  symbol: string,
) {
  return slots.find((slot) => slot?.symbol === symbol.trim().toUpperCase()) ?? null;
}

export function releaseSimpleReboundSlot(
  slots: readonly (SimpleReboundSlot | null)[],
  slotId: number,
) {
  const next = createSimpleReboundSlots(slots);
  if (slotId >= 1 && slotId <= SIMPLE_REBOUND_MAX_SLOTS) next[slotId - 1] = null;
  return next;
}
