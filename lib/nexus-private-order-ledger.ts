import {
  applyNexusOrderTransition,
  type NexusOrderLifecycle,
} from "./nexus-order-state-machine.ts";
import type { NexusPrivateOrderEvent } from "./nexus-private-order-event";

export class NexusPrivateOrderLedger {
  private readonly orders = new Map<string, NexusOrderLifecycle>();

  register(input: {
    clientOrderId: string;
    originalQuantity: number;
    state?: NexusOrderLifecycle["state"];
    now: number;
  }) {
    if (
      !input.clientOrderId ||
      !Number.isFinite(input.originalQuantity) ||
      input.originalQuantity <= 0
    )
      throw new Error("订单登记参数无效");
    const existing = this.orders.get(input.clientOrderId);
    if (existing) return existing;
    const lifecycle: NexusOrderLifecycle = {
      clientOrderId: input.clientOrderId,
      exchangeOrderId: null,
      state: input.state || "CREATED",
      originalQuantity: input.originalQuantity,
      cumulativeQuantity: 0,
      averagePrice: 0,
      updatedAt: input.now,
      terminalAt: null,
    };
    this.orders.set(input.clientOrderId, lifecycle);
    return lifecycle;
  }

  apply(event: NexusPrivateOrderEvent) {
    const current = this.orders.get(event.clientOrderId);
    if (!current)
      return { applied: false, reason: "UNREGISTERED_ORDER" } as const;
    if (event.eventTime < current.updatedAt)
      return { applied: false, reason: "STALE_EVENT" } as const;
    const next = applyNexusOrderTransition(current, {
      state: event.state,
      exchangeOrderId: event.exchangeOrderId,
      cumulativeQuantity: event.cumulativeQuantity,
      averagePrice: event.averagePrice,
      eventTime: event.eventTime,
    });
    this.orders.set(event.clientOrderId, next);
    return { applied: true, order: next } as const;
  }

  get(clientOrderId: string) {
    return this.orders.get(clientOrderId) || null;
  }
}
