import { runSimpleReboundCycle } from "./simple-rebound-runner.ts";
import {
  buildSimpleReboundExitPlan,
  reconcileSimpleReboundFill,
  releaseSimpleReboundPosition,
} from "./simple-rebound-position-handoff.ts";
import type { SimpleReboundMarketRow } from "./simple-rebound-scanner.ts";
import { createSimpleReboundSlots, type SimpleReboundSlot } from "./simple-rebound-slots.ts";

export type SimpleReboundReplayStep = Readonly<{
  nowMs: number;
  market: readonly SimpleReboundMarketRow[];
  fills?: Readonly<Record<string, "FILLED" | "REJECTED" | "EXECUTION_UNKNOWN">>;
}>;

/**
 * Deterministic local replay. It deliberately has no DB, network, credential,
 * or exchange dependency, so it is safe for regression and failure testing.
 */
export function replaySimpleReboundExecution(steps: readonly SimpleReboundReplayStep[]) {
  let slots: (SimpleReboundSlot | null)[] = createSimpleReboundSlots();
  const history: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    const cycle = runSimpleReboundCycle({ market: step.market, slots, nowMs: step.nowMs });
    for (const plan of cycle.orderPlans) {
      const status = step.fills?.[plan.clientOrderId] ?? "EXECUTION_UNKNOWN";
      const handoff = reconcileSimpleReboundFill({
        slots,
        plan,
        status,
        filledAtMs: step.nowMs,
      });
      slots = handoff.slots;
      history.push({ type: "ORDER_RESULT", clientOrderId: plan.clientOrderId, status, outcome: handoff.outcome });
    }
    for (const exit of cycle.exits) {
      const slot = slots[exit.slotId - 1];
      if (!slot) continue;
      const plan = buildSimpleReboundExitPlan({ slot, reason: exit.action });
      slots = releaseSimpleReboundPosition(slots, plan);
      history.push({ type: "EXIT_RESULT", symbol: plan.symbol, reason: plan.reason, outcome: "RELEASED" });
    }
    history.push({
      type: "CYCLE",
      nowMs: step.nowMs,
      signals: cycle.signals.length,
      orderPlans: cycle.orderPlans.length,
      exits: cycle.exits.length,
      occupiedSlots: slots.filter(Boolean).length,
    });
  }
  return { slots, history };
}
