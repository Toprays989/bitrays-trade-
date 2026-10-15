import { scanSimpleReboundCandidates, type SimpleReboundMarketRow } from "./simple-rebound-scanner.ts";
import { shouldExitSimpleThreeMinutePosition } from "./simple-three-minute-entry.ts";
import { availableSimpleReboundSlots, type SimpleReboundSlot } from "./simple-rebound-slots.ts";

export function coordinateSimpleReboundCycle(input: Readonly<{
  market: readonly SimpleReboundMarketRow[];
  slots: readonly (SimpleReboundSlot | null)[];
  nowMs: number;
}>) {
  const activeSymbols = new Set(input.slots.filter(Boolean).map((slot) => slot!.symbol));
  const exits = input.slots
    .filter((slot): slot is SimpleReboundSlot => Boolean(slot))
    .map((slot) => ({
      slotId: slot.slotId,
      symbol: slot.symbol,
      action: shouldExitSimpleThreeMinutePosition({
        openedAtMs: slot.openedAtMs,
        nowMs: input.nowMs,
        entryPrice: slot.entryPrice,
        markPrice: input.market.find((row) => row.symbol === slot.symbol)?.currentMarkPrice ?? 0,
      }),
    }))
    .filter((item) => item.action !== "HOLD");
  const freeSlots = availableSimpleReboundSlots(input.slots);
  const entries = freeSlots > 0
    ? scanSimpleReboundCandidates(input.market)
      .filter((candidate) => !activeSymbols.has(candidate.symbol))
      .slice(0, freeSlots)
    : [];
  return { entries, exits };
}
