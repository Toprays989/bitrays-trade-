import { SIMPLE_REBOUND_CONFIG } from "./simple-rebound-config.ts";
import type { SimpleReboundTriggerCandidate } from "./strategy-triggers/simple-rebound.ts";

export type SimpleReboundOrderPlan = Readonly<{
  source: "SIMPLE_REBOUND";
  clientOrderId: string;
  symbol: string;
  side: "LONG";
  notionalUsdt: 20;
  leverage: 5;
  referencePrice: number;
  slotId: number;
  openedAtMs: number;
}>;

export function buildSimpleReboundOrderPlan(input: Readonly<{
  candidate: SimpleReboundTriggerCandidate;
  slotId: number;
  nowMs: number;
}>) {
  if (input.candidate.direction !== "LONG") return null;
  if (!(input.candidate.referencePrice > 0)) return null;
  return {
    source: "SIMPLE_REBOUND" as const,
    clientOrderId: `srb_${input.candidate.symbol}_${input.candidate.eventAt}_${input.slotId}`,
    symbol: input.candidate.symbol,
    side: "LONG" as const,
    notionalUsdt: SIMPLE_REBOUND_CONFIG.orderNotionalUsdt,
    leverage: SIMPLE_REBOUND_CONFIG.leverage,
    referencePrice: input.candidate.referencePrice,
    slotId: input.slotId,
    openedAtMs: input.nowMs,
  } satisfies SimpleReboundOrderPlan;
}

export function buildSimpleReboundExchangeOrder(plan: SimpleReboundOrderPlan) {
  return {
    symbol: plan.symbol,
    side: "BUY" as const,
    positionSide: "LONG" as const,
    orderType: "MARKET" as const,
    quantity: plan.notionalUsdt / plan.referencePrice,
    leverage: plan.leverage,
    requireExactLeverage: true,
    clientOrderId: plan.clientOrderId,
    source: plan.source,
  };
}
