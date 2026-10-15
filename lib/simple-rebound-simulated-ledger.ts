import type { SimpleReboundOrderPlan } from "./simple-rebound-order-plan.ts";
import {
  buildSimpleReboundExitPlan,
  reconcileSimpleReboundFill,
  releaseSimpleReboundPosition,
  type SimpleReboundExitPlan,
} from "./simple-rebound-position-handoff.ts";
import {
  resolveSimpleReboundOrderStatus,
  type SimpleReboundOrderStatus,
} from "./simple-rebound-execution-lifecycle.ts";
import { createSimpleReboundSlots, type SimpleReboundSlot } from "./simple-rebound-slots.ts";

export type SimpleReboundSimulatedOrder = Readonly<{
  clientOrderId: string;
  symbol: string;
  slotId: number;
  status: SimpleReboundOrderStatus;
  updatedAtMs: number;
}>;

export type SimpleReboundLedgerSnapshot = Readonly<{
  orders: readonly SimpleReboundSimulatedOrder[];
  slots: readonly (SimpleReboundSlot | null)[];
}>;

/** Local-only order ledger used by replay tests; it has no exchange side effects. */
export class SimpleReboundSimulatedLedger {
  private readonly orders = new Map<string, SimpleReboundSimulatedOrder>();
  private slots: (SimpleReboundSlot | null)[] = createSimpleReboundSlots();

  submit(plan: SimpleReboundOrderPlan, nowMs: number) {
    const existing = this.orders.get(plan.clientOrderId);
    if (existing) return existing;
    const order: SimpleReboundSimulatedOrder = {
      clientOrderId: plan.clientOrderId,
      symbol: plan.symbol,
      slotId: plan.slotId,
      status: "PENDING",
      updatedAtMs: nowMs,
    };
    this.orders.set(plan.clientOrderId, order);
    return order;
  }

  acknowledge(
    plan: SimpleReboundOrderPlan,
    input: Readonly<{
      acknowledged: boolean;
      filled: boolean;
      executionUnknown?: boolean;
      fillPrice?: number;
      nowMs: number;
    }>,
  ) {
    const previous = this.submit(plan, input.nowMs);
    const status = resolveSimpleReboundOrderStatus(input);
    if (previous.status !== "PENDING" && previous.status !== "SUBMITTED") return previous;
    const next = { ...previous, status, updatedAtMs: input.nowMs };
    this.orders.set(plan.clientOrderId, next);
    if (status === "FILLED") {
      this.slots = reconcileSimpleReboundFill({
        slots: this.slots,
        plan,
        status,
        fillPrice: input.fillPrice,
        filledAtMs: input.nowMs,
      }).slots;
    }
    return next;
  }

  requestExit(slotId: number, reason: SimpleReboundExitPlan["reason"]) {
    const slot = this.slots[slotId - 1];
    return slot ? buildSimpleReboundExitPlan({ slot, reason }) : null;
  }

  acknowledgeExit(exit: SimpleReboundExitPlan, nowMs: number, filled: boolean) {
    if (!filled) return false;
    this.slots = releaseSimpleReboundPosition(this.slots, exit);
    for (const [key, order] of this.orders) {
      if (order.slotId === exit.slotId && order.status === "FILLED")
        this.orders.set(key, { ...order, updatedAtMs: nowMs });
    }
    return true;
  }

  snapshot(): SimpleReboundLedgerSnapshot {
    return {
      orders: [...this.orders.values()],
      slots: this.slots.map((slot) => slot ? { ...slot } : null),
    };
  }
}
