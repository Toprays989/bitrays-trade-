import {
  submitLiveEntryOrder,
  submitLiveReduceMarketOrder,
} from "./execution/exchange-order-gateway.ts";
import {
  buildSimpleReboundExecutionRequest,
  type SimpleReboundContractRule,
} from "./simple-rebound-execution-adapter.ts";
import {
  buildSimpleReboundExitPlan,
  type SimpleReboundExitPlan,
} from "./simple-rebound-position-handoff.ts";
import type { SimpleReboundOrderPlan } from "./simple-rebound-order-plan.ts";
import type { SimpleReboundSlot } from "./simple-rebound-slots.ts";
import {
  assertSimpleReboundLiveConfirmation,
} from "./simple-rebound-live-gate.ts";

export async function submitSimpleReboundLiveEntry(input: Readonly<{
  confirmation: unknown;
  credentials: { apiKey: string; secretKey: string };
  plan: SimpleReboundOrderPlan;
  account: { accountId: string; credentialId: number; ownerEmail: string };
  contractRule: SimpleReboundContractRule;
}>) {
  assertSimpleReboundLiveConfirmation(input.confirmation);
  const request = buildSimpleReboundExecutionRequest(
    input.plan,
    input.account,
    input.contractRule,
  );
  const result = await submitLiveEntryOrder(input.credentials, {
    ...request.order,
    positionMode: "HEDGE",
  });
  return { source: "SIMPLE_REBOUND" as const, request, result };
}

export async function submitSimpleReboundLiveExit(input: Readonly<{
  confirmation: unknown;
  credentials: { apiKey: string; secretKey: string };
  slot: SimpleReboundSlot;
  reason: SimpleReboundExitPlan["reason"];
  quantity: number;
  quantityStep?: number;
}>) {
  assertSimpleReboundLiveConfirmation(input.confirmation);
  const exit = buildSimpleReboundExitPlan({ slot: input.slot, reason: input.reason });
  const result = await submitLiveReduceMarketOrder(input.credentials, {
    symbol: exit.symbol,
    positionSide: exit.positionSide,
    quantity: input.quantity,
    clientOrderId: `srb_exit_${exit.symbol}_${exit.slotId}_${Date.now()}`.slice(0, 36),
    quantityStep: input.quantityStep,
  });
  return { source: "SIMPLE_REBOUND" as const, exit, result };
}
