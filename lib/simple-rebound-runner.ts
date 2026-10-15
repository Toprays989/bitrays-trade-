import { coordinateSimpleReboundCycle } from "./simple-rebound-coordinator.ts";
import type { SimpleReboundMarketRow } from "./simple-rebound-scanner.ts";
import type { SimpleReboundSlot } from "./simple-rebound-slots.ts";
import {
  simpleReboundTriggerAdapter,
  type SimpleReboundTriggerFact,
} from "./strategy-triggers/simple-rebound.ts";
import { SIMPLE_REBOUND_EVENT_TYPES } from "./simple-rebound-events.ts";
import { buildSimpleReboundOrderPlan, type SimpleReboundOrderPlan } from "./simple-rebound-order-plan.ts";
import { SIMPLE_REBOUND_MAX_SLOTS } from "./simple-rebound-slots.ts";

export function runSimpleReboundCycle(input: Readonly<{
  market: readonly SimpleReboundMarketRow[];
  slots: readonly (SimpleReboundSlot | null)[];
  nowMs: number;
}>) {
  const cycle = coordinateSimpleReboundCycle(input);
  const facts: SimpleReboundTriggerFact[] = cycle.entries.map((candidate) => ({
    candidate,
    eventAt: input.nowMs,
    receivedAt: input.nowMs,
  }));
  const signals = simpleReboundTriggerAdapter.evaluate({
    facts: { rows: facts, processedAt: input.nowMs },
    config: { maxFactAgeMs: 3_000, maximumCandidates: 5 },
  });
  const availableSlotIds = input.slots
    .map((slot, index) => (slot ? null : index + 1))
    .filter((slotId): slotId is number => slotId !== null)
    .slice(0, SIMPLE_REBOUND_MAX_SLOTS);
  const orderPlans: SimpleReboundOrderPlan[] = signals.flatMap((signal, index) => {
    const slotId = availableSlotIds[index];
    if (!slotId) return [];
    const plan = buildSimpleReboundOrderPlan({ candidate: signal, slotId, nowMs: input.nowMs });
    return plan ? [plan] : [];
  });
  const events = [
    ...signals.map((signal) => ({
      eventType: SIMPLE_REBOUND_EVENT_TYPES.SIGNAL,
      stage: "SIGNAL" as const,
      outcome: "PASSED" as const,
      symbol: signal.symbol,
      eventAt: signal.eventAt,
      message: `${signal.symbol} 满足 Simple Rebound 入场条件`,
      detail: signal,
    })),
    ...orderPlans.map((plan) => ({
      eventType: SIMPLE_REBOUND_EVENT_TYPES.ORDER,
      stage: "ORDER" as const,
      outcome: "PENDING" as const,
      symbol: plan.symbol,
      eventAt: input.nowMs,
      message: `${plan.symbol} 已生成 Simple Rebound 下单计划，等待独立执行入口`,
      detail: plan,
    })),
    ...cycle.exits.map((exit) => ({
      eventType: SIMPLE_REBOUND_EVENT_TYPES.EXIT,
      stage: "POSITION_MANAGEMENT" as const,
      outcome: "PASSED" as const,
      symbol: exit.symbol,
      eventAt: input.nowMs,
      message: `${exit.symbol} 触发 ${exit.action}`,
      detail: exit,
    })),
  ];
  return { signals, orderPlans, exits: cycle.exits, events };
}
