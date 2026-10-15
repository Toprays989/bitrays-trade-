import {
  buildSimpleReboundExchangeOrder,
  type SimpleReboundOrderPlan,
} from "./simple-rebound-order-plan.ts";

export type SimpleReboundExecutionContext = Readonly<{
  accountId: string;
  credentialId: number;
  ownerEmail: string;
}>;

export type SimpleReboundContractRule = Readonly<{
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
}>;

function floorToStep(value: number, step: number) {
  if (!(step > 0)) return value;
  return Math.floor((value + step * 1e-9) / step) * step;
}

export function buildSimpleReboundExecutionRequest(
  plan: SimpleReboundOrderPlan,
  context: SimpleReboundExecutionContext,
  rule?: SimpleReboundContractRule,
) {
  const rawQuantity = plan.notionalUsdt / plan.referencePrice;
  const quantity = floorToStep(rawQuantity, rule?.quantityStep ?? 0.00000001);
  if (!(quantity > 0) || quantity < (rule?.minOrderQty ?? 0))
    throw new Error(`${plan.symbol} 数量低于 Binance 最小下单量`);
  if (quantity * plan.referencePrice < (rule?.minNotionalUsdt ?? 0))
    throw new Error(`${plan.symbol} 名义价值低于 Binance 最小名义金额`);
  const order = { ...buildSimpleReboundExchangeOrder(plan), quantity };
  return {
    ...context,
    source: "SIMPLE_REBOUND" as const,
    executionMode: "PENDING_CONFIRMATION" as const,
    clientOrderId: plan.clientOrderId,
    order,
  };
}
