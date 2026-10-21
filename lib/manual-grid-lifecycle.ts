export type ManualGridLifecycleState = {
  planStatus: "ARMED" | "PAUSED" | "BLOCKED" | "COMPLETED";
  positionId: number | null;
  positionVersion: number | null;
  pendingClientOrderIds: string[];
  filledLevelIndexes: number[];
};

export function createManualGridLifecycleState(): ManualGridLifecycleState {
  return { planStatus: "ARMED", positionId: null, positionVersion: null, pendingClientOrderIds: [], filledLevelIndexes: [] };
}

export function applyManualGridExecutionResult(input: {
  state: ManualGridLifecycleState;
  levelIndex: number;
  clientOrderId: string;
  result: "FILLED" | "EXECUTION_UNKNOWN" | "REJECTED";
  positionId?: number;
  nextPositionVersion?: number;
}) {
  const state = {
    ...input.state,
    pendingClientOrderIds: [...input.state.pendingClientOrderIds],
    filledLevelIndexes: [...input.state.filledLevelIndexes],
  };
  if (state.filledLevelIndexes.includes(input.levelIndex)) return state;
  if (state.pendingClientOrderIds.includes(input.clientOrderId) && input.result !== "FILLED") return state;
  if (input.result === "EXECUTION_UNKNOWN") {
    state.planStatus = "BLOCKED";
    if (!state.pendingClientOrderIds.includes(input.clientOrderId)) state.pendingClientOrderIds.push(input.clientOrderId);
    return state;
  }
  if (input.result === "REJECTED") return state;
  if (!Number.isInteger(input.positionId) || input.positionId <= 0) throw new Error("filled grid order requires positionId");
  if (state.positionId === null) {
    if (!Number.isInteger(input.nextPositionVersion) || input.nextPositionVersion! < 1) throw new Error("first fill requires positionVersion");
    state.positionId = input.positionId;
    state.positionVersion = input.nextPositionVersion!;
  } else {
    if (state.positionId !== input.positionId) throw new Error("grid fill positionId mismatch");
    if (input.nextPositionVersion !== state.positionVersion! + 1) throw new Error("grid fill positionVersion mismatch");
    state.positionVersion = input.nextPositionVersion!;
  }
  state.pendingClientOrderIds = state.pendingClientOrderIds.filter((id) => id !== input.clientOrderId);
  if (!state.filledLevelIndexes.includes(input.levelIndex)) state.filledLevelIndexes.push(input.levelIndex);
  return state;
}
