import { occupySimpleReboundSlotAt, releaseSimpleReboundSlot, type SimpleReboundSlot } from "./simple-rebound-slots.ts";
import type { SimpleReboundOrderPlan } from "./simple-rebound-order-plan.ts";

export type SimpleReboundFillStatus = "FILLED" | "REJECTED" | "EXECUTION_UNKNOWN";

export function reconcileSimpleReboundFill(input: Readonly<{
  slots: readonly (SimpleReboundSlot | null)[];
  plan: SimpleReboundOrderPlan;
  status: SimpleReboundFillStatus;
  fillPrice?: number;
  filledAtMs: number;
}>) {
  if (input.status !== "FILLED")
    return { slots: input.slots, outcome: input.status === "EXECUTION_UNKNOWN" ? "WAIT_RECONCILIATION" as const : "NOT_OCCUPIED" as const };
  const entryPrice = input.fillPrice ?? input.plan.referencePrice;
  if (!(entryPrice > 0)) return { slots: input.slots, outcome: "REJECTED" as const };
  const existing = input.slots[input.plan.slotId - 1];
  if (existing?.symbol === input.plan.symbol)
    return { slots: input.slots, outcome: "ALREADY_OCCUPIED" as const };
  const result = occupySimpleReboundSlotAt(input.slots, {
    slotId: input.plan.slotId,
    symbol: input.plan.symbol,
    entryPrice,
    openedAtMs: input.filledAtMs,
  });
  return { slots: result.slots, outcome: result.occupied ? "OCCUPIED" as const : "REJECTED" as const };
}

export type SimpleReboundExitPlan = Readonly<{
  source: "SIMPLE_REBOUND";
  symbol: string;
  slotId: number;
  side: "SELL";
  positionSide: "LONG";
  reduceOnly: true;
  reason: "EXIT_PROFIT" | "EXIT_TIME" | "EXIT_ADVERSE";
}>;

export function buildSimpleReboundExitPlan(input: Readonly<{
  slot: SimpleReboundSlot;
  reason: SimpleReboundExitPlan["reason"];
}>): SimpleReboundExitPlan {
  return {
    source: "SIMPLE_REBOUND",
    symbol: input.slot.symbol,
    slotId: input.slot.slotId,
    side: "SELL",
    positionSide: "LONG",
    reduceOnly: true,
    reason: input.reason,
  };
}

export function releaseSimpleReboundPosition(
  slots: readonly (SimpleReboundSlot | null)[],
  exit: Pick<SimpleReboundExitPlan, "slotId">,
) {
  return releaseSimpleReboundSlot(slots, exit.slotId);
}
