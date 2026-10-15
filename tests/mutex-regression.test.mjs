import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutomatedOrderConcurrency } from "../lib/automated-order-concurrency.ts";
import { mapWithConcurrency } from "../lib/bounded-concurrency.ts";
import {
  THREE_MINUTE_OPPORTUNITY_BOARD_CAPACITY,
  ThreeMinuteOpportunityBoard,
} from "../lib/three-minute-opportunity-board.ts";
import { advanceNexusPositionState } from "../lib/nexus-position-state-machine.ts";
import {
  THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH,
  THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY,
  planThreeMinuteCandidateQueueAdmission,
} from "../lib/three-minute-candidate-queue.ts";

const workingOrder = (overrides = {}) => ({
  id: 1,
  symbol: "BTCUSDT",
  positionSide: "LONG",
  status: "NEW",
  estimatedNotional: 20,
  ...overrides,
});

test("terminal order history does not reserve capacity or block re-entry", () => {
  const result = evaluateAutomatedOrderConcurrency({
    orders: [workingOrder({ status: "FILLED" }), workingOrder({ status: "CANCELED" })],
    targetSymbol: "BTCUSDT",
    targetPositionSide: "LONG",
    positionMode: "HEDGE",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reservedNotional, 0);
});

test("malformed order status is treated as non-working instead of aborting the batch", () => {
  const result = evaluateAutomatedOrderConcurrency({
    orders: [workingOrder({ status: null })],
    targetSymbol: "BTCUSDT",
    targetPositionSide: "LONG",
    positionMode: "HEDGE",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reservedNotional, 0);
});

test("unknown execution state remains an account-wide blocker", () => {
  const result = evaluateAutomatedOrderConcurrency({
    orders: [workingOrder({ status: "EXECUTION_UNKNOWN", symbol: "ETHUSDT" })],
    targetSymbol: "BTCUSDT",
    targetPositionSide: "SHORT",
    positionMode: "HEDGE",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "EXECUTION_UNKNOWN_ORDER");
  assert.equal(result.reservedNotional, 20);
});

test("hedge mode blocks only the same symbol and executable leg", () => {
  const opposite = evaluateAutomatedOrderConcurrency({
    orders: [workingOrder()],
    targetSymbol: "BTCUSDT",
    targetPositionSide: "SHORT",
    positionMode: "HEDGE",
  });
  assert.equal(opposite.allowed, true);

  const sameLeg = evaluateAutomatedOrderConcurrency({
    orders: [workingOrder()],
    targetSymbol: "btcusdt",
    targetPositionSide: "LONG",
    positionMode: "HEDGE",
  });
  assert.equal(sameLeg.allowed, false);
  assert.equal(sameLeg.code, "SAME_LEG_WORKING_ORDER");
});

test("one-way mode blocks an opposite-side order for the same symbol", () => {
  const result = evaluateAutomatedOrderConcurrency({
    orders: [workingOrder()],
    targetSymbol: "BTCUSDT",
    targetPositionSide: "SHORT",
    positionMode: "ONE_WAY",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "SAME_LEG_WORKING_ORDER");
});

test("analysis mapper never exceeds its configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
  assert.equal(maximum, 2);
});

function wake(symbol, priority, receivedAt, expiresAt = receivedAt + 45_000) {
  return {
    symbol,
    direction: "LONG",
    receivedAt,
    expiresAt,
    evidence: { pLongPercent: priority },
  };
}

test("opportunity board replaces same-symbol facts and expires them", () => {
  const board = new ThreeMinuteOpportunityBoard();
  board.refresh([wake("btcusdt", 60, 1_000)], 1_000);
  board.refresh([wake("BTCUSDT", 75, 2_000)], 2_000);
  assert.equal(board.size, 1);
  assert.equal(board.snapshot(2_000)[0].priority, 75);
  assert.equal(board.snapshot(2_000)[0].wake.symbol, "BTCUSDT");
  board.remove("btcusdt");
  assert.equal(board.size, 0);
  board.refresh([wake("BTCUSDT", 75, 2_000)], 2_000);
  assert.equal(board.snapshot(50_000).length, 0);
});

test("opportunity board is bounded under a burst", () => {
  const board = new ThreeMinuteOpportunityBoard();
  board.refresh(
    Array.from({ length: THREE_MINUTE_OPPORTUNITY_BOARD_CAPACITY + 20 }, (_, index) =>
      wake(`S${index}USDT`, index, 1_000 + index)
    ),
    1_000,
  );
  assert.equal(board.size, THREE_MINUTE_OPPORTUNITY_BOARD_CAPACITY);
});

test("three-minute candidate admission keeps twelve slots and admits at most five", () => {
  const available = planThreeMinuteCandidateQueueAdmission(9);
  assert.equal(available.queuedCount, 9);
  assert.equal(available.availableSlots, 3);
  assert.equal(available.admissionLimit, 3);
  assert.equal(available.full, false);

  const full = planThreeMinuteCandidateQueueAdmission(THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY);
  assert.equal(full.availableSlots, 0);
  assert.equal(full.admissionLimit, 0);
  assert.equal(full.full, true);
});

test("pending reduction keeps a position in EXITING and prevents a duplicate action", () => {
  const base = {
    positionKey: "admin:bitrays04:BTCUSDT:LONG:1",
    observedAtMs: 1_000,
    managementState: "PROFIT_CONTINUATION",
    managementAction: "HOLD_FOR_EXTENSION",
    dataFresh: true,
    evidenceComplete: true,
    currentRoePercent: 1,
  };
  const first = advanceNexusPositionState(base);
  const exiting = advanceNexusPositionState({
    ...base,
    previous: first,
    observedAtMs: 2_000,
    pendingReduction: true,
  });
  assert.equal(exiting.state, "EXITING");
  assert.equal(exiting.action, "WAIT_REDUCTION_FILL");

  const retry = advanceNexusPositionState({
    ...base,
    previous: exiting,
    observedAtMs: 3_000,
  });
  assert.equal(retry.state, "EXITING");
  assert.equal(retry.action, "WAIT_REDUCTION_FILL");
});
