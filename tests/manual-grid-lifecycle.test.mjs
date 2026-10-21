import test from "node:test";
import assert from "node:assert/strict";
import { applyManualGridExecutionResult, createManualGridLifecycleState } from "../lib/manual-grid-lifecycle.ts";

test("manual grid replay binds first fill then advances additions on one position", () => {
  let state = createManualGridLifecycleState();
  state = applyManualGridExecutionResult({ state, levelIndex: 2, clientOrderId: "mgrid_1_2_1", result: "FILLED", positionId: 7, nextPositionVersion: 1 });
  state = applyManualGridExecutionResult({ state, levelIndex: 1, clientOrderId: "mgrid_1_1_1", result: "FILLED", positionId: 7, nextPositionVersion: 2 });
  assert.deepEqual(state, { planStatus: "ARMED", positionId: 7, positionVersion: 2, pendingClientOrderIds: [], filledLevelIndexes: [2, 1] });
});

test("unknown grid execution blocks future replay until reconciliation", () => {
  const state = applyManualGridExecutionResult({ state: createManualGridLifecycleState(), levelIndex: 1, clientOrderId: "mgrid_1_1_1", result: "EXECUTION_UNKNOWN" });
  assert.equal(state.planStatus, "BLOCKED");
  assert.deepEqual(state.pendingClientOrderIds, ["mgrid_1_1_1"]);
});

test("same order replay does not advance the position twice", () => {
  let state = applyManualGridExecutionResult({ state: createManualGridLifecycleState(), levelIndex: 1, clientOrderId: "mgrid_1_1_1", result: "FILLED", positionId: 7, nextPositionVersion: 1 });
  state = applyManualGridExecutionResult({ state, levelIndex: 1, clientOrderId: "mgrid_1_1_1", result: "FILLED", positionId: 7, nextPositionVersion: 1 });
  assert.equal(state.positionVersion, 1);
  assert.deepEqual(state.filledLevelIndexes, [1]);
});
