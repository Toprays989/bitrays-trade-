import {
  buildManualGridAdditionIntent,
  buildManualGridMarketOrderRequest,
  type ManualGridDirection,
  type ManualGridMarketOrderRequest,
  type ManualGridTrigger,
} from "./manual-entry-grid.ts";

export type ManualGridExecutionPlan =
  | {
      kind: "OPEN_NEW_POSITION";
      order: ManualGridMarketOrderRequest;
    }
  | {
      kind: "ADD_TO_EXISTING_POSITION";
      order: ManualGridMarketOrderRequest;
      addition: ReturnType<typeof buildManualGridAdditionIntent>;
    }
  | {
      kind: "BLOCK_RECONCILIATION";
      reason: "EXECUTION_UNKNOWN_POSITION_REQUIRES_RECONCILIATION";
    };

export function buildManualGridExecutionPlan(input: {
  planId: number;
  symbol: string;
  direction: ManualGridDirection;
  quantity: number;
  trigger: ManualGridTrigger;
  positionId?: number | null;
  positionVersion?: number | null;
  executionUnknownCount: number;
}): ManualGridExecutionPlan {
  if (!Number.isInteger(input.executionUnknownCount) || input.executionUnknownCount < 0) {
    throw new Error("executionUnknownCount must be a non-negative integer");
  }
  if (input.executionUnknownCount > 0) {
    return {
      kind: "BLOCK_RECONCILIATION",
      reason: "EXECUTION_UNKNOWN_POSITION_REQUIRES_RECONCILIATION",
    };
  }
  const order = buildManualGridMarketOrderRequest({
    planId: input.planId,
    symbol: input.symbol,
    direction: input.direction,
    quantity: input.quantity,
    trigger: input.trigger,
  });
  if (input.positionId === null || input.positionId === undefined) {
    if (input.positionVersion !== null && input.positionVersion !== undefined) {
      throw new Error("positionVersion cannot exist without positionId");
    }
    return { kind: "OPEN_NEW_POSITION", order };
  }
  if (!Number.isInteger(input.positionVersion) || Number(input.positionVersion) < 1) {
    throw new Error("existing position requires a valid positionVersion");
  }
  return {
    kind: "ADD_TO_EXISTING_POSITION",
    order,
    addition: buildManualGridAdditionIntent({
      positionId: input.positionId,
      positionVersion: input.positionVersion,
      order,
    }),
  };
}
