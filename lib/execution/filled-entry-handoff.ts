import { canonicalTradeLifecycleId } from "../trade-lifecycle-contract.ts";

export const FILLED_ENTRY_HANDOFF_CONTRACT_VERSION =
  "filled-entry-handoff-v1" as const;

export function resolveFilledPositionLifecycleLink(input: {
  traceId: string;
  orderLifecycleId?: string | null;
  orderEntryDecisionHandoffJson?: string | null;
  existingPositionLifecycleId?: string | null;
  existingPositionEntryDecisionHandoffJson?: string | null;
}) {
  const orderHandoff =
    typeof input.orderEntryDecisionHandoffJson === "string" &&
      input.orderEntryDecisionHandoffJson.trim().length > 0
      ? input.orderEntryDecisionHandoffJson
      : null;
  const existingHandoff =
    typeof input.existingPositionEntryDecisionHandoffJson === "string" &&
      input.existingPositionEntryDecisionHandoffJson.trim().length > 0
      ? input.existingPositionEntryDecisionHandoffJson
      : null;
  return {
    contractVersion: FILLED_ENTRY_HANDOFF_CONTRACT_VERSION,
    lifecycleId:
      canonicalTradeLifecycleId(input.orderLifecycleId) ??
      canonicalTradeLifecycleId(input.existingPositionLifecycleId) ??
      canonicalTradeLifecycleId(input.traceId),
    entryDecisionHandoffJson: orderHandoff ?? existingHandoff ?? "{}",
  };
}

export function buildFilledExecutionIntentDetail(input: {
  clientOrderId: string;
  exchangeOrderId: string | number | null | undefined;
  executedQuantity: number;
  positionId: string | number;
}) {
  return {
    clientOrderId: input.clientOrderId,
    exchangeOrderId: input.exchangeOrderId ?? null,
    executedQuantity: input.executedQuantity,
    positionId: input.positionId,
  };
}
