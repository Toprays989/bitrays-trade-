import test from "node:test";
import assert from "node:assert/strict";
import { allocateManualGridQuantity, buildManualGridAdditionIntent, buildManualGridMarketOrderRequest, buildManualGridLevels, evaluateManualGridTick, shouldBlockManualGridTrigger } from "../lib/manual-entry-grid.ts";
import { buildManualGridExecutionPlan } from "../lib/manual-grid-execution-plan.ts";

test("manual grid chooses first entry, addition, or reconciliation block", () => {
  assert.deepEqual(shouldBlockManualGridTrigger({ existingPositionCount: 0 }), { blocked: false, mode: "OPEN_NEW_POSITION", reason: null });
  assert.deepEqual(shouldBlockManualGridTrigger({ existingPositionCount: 1 }), { blocked: false, mode: "ADD_TO_EXISTING_POSITION", reason: null });
  assert.deepEqual(shouldBlockManualGridTrigger({ existingPositionCount: 1, existingExecutionUnknownCount: 1 }), { blocked: true, mode: "BLOCK_RECONCILIATION", reason: "EXECUTION_UNKNOWN_POSITION_REQUIRES_RECONCILIATION" });
});

test("manual grid builds deterministic market order requests", () => {
  const request = buildManualGridMarketOrderRequest({
    planId: 42,
    symbol: "BTCUSDT",
    direction: "SHORT",
    quantity: 0.01,
    trigger: { index: 2, levelPrice: 100, triggerPrice: 99.9, direction: "SHORT", triggerCount: 3 },
  });
  assert.equal(request.side, "SELL");
  assert.equal(request.orderType, "MARKET");
  assert.equal(request.clientOrderId, "mgrid_42_2_3");
});

test("manual grid additions bind to the existing position version", () => {
  const order = buildManualGridMarketOrderRequest({
    planId: 42,
    symbol: "BTCUSDT",
    direction: "LONG",
    quantity: 0.01,
    trigger: { index: 1, levelPrice: 100, triggerPrice: 99.9, direction: "LONG", triggerCount: 2 },
  });
  assert.deepEqual(buildManualGridAdditionIntent({ positionId: 7, positionVersion: 3, order }), {
    positionId: 7,
    basePositionVersion: 3,
    clientOrderId: "mgrid_42_1_2",
    symbol: "BTCUSDT",
    positionSide: "LONG",
    quantity: 0.01,
    status: "PENDING",
    source: "MANUAL_GRID",
  });
});

test("manual grid routes first entry and additions without ambiguity", () => {
  const trigger = { index: 1, levelPrice: 100, triggerPrice: 99.9, direction: "LONG", triggerCount: 1 };
  assert.equal(buildManualGridExecutionPlan({ planId: 1, symbol: "BTCUSDT", direction: "LONG", quantity: 0.01, trigger, executionUnknownCount: 0 }).kind, "OPEN_NEW_POSITION");
  const addition = buildManualGridExecutionPlan({ planId: 1, symbol: "BTCUSDT", direction: "LONG", quantity: 0.01, trigger, positionId: 9, positionVersion: 2, executionUnknownCount: 0 });
  assert.equal(addition.kind, "ADD_TO_EXISTING_POSITION");
  assert.equal(addition.kind === "ADD_TO_EXISTING_POSITION" ? addition.addition.basePositionVersion : 0, 2);
  assert.equal(buildManualGridExecutionPlan({ planId: 1, symbol: "BTCUSDT", direction: "LONG", quantity: 0.01, trigger, positionId: 9, positionVersion: 2, executionUnknownCount: 1 }).kind, "BLOCK_RECONCILIATION");
});

test("manual grid splits total quantity by contract step without exceeding it", () => {
  const quantities = allocateManualGridQuantity({ totalQuantity: 1.01, levelCount: 3, quantityStep: 0.01 });
  assert.deepEqual(quantities, [0.33, 0.33, 0.35]);
  assert.ok(quantities.every((quantity) => quantity >= 0.01));
  assert.ok(quantities.reduce((sum, quantity) => sum + quantity, 0) <= 1.01 + 1e-9);
});

test("manual grid creates evenly spaced armed levels", () => {
  const levels = buildManualGridLevels({ lowerPrice: 90, upperPrice: 100, gridCount: 3 });
  assert.deepEqual(levels.map((level) => level.price), [90, 95, 100]);
  assert.ok(levels.every((level) => level.state === "ARMED"));
});

test("long grid triggers downward crossings in nearest-first order", () => {
  const levels = buildManualGridLevels({ lowerPrice: 90, upperPrice: 100, gridCount: 3 });
  const result = evaluateManualGridTick({
    direction: "LONG",
    previousPrice: 101,
    currentPrice: 89,
    levels,
    hysteresisBps: 5,
  });
  assert.deepEqual(result.triggers.map((trigger) => trigger.levelPrice), [100, 95, 90]);
  assert.ok(result.levels.every((level) => level.state === "WAIT_REARM"));
});

test("short grid triggers upward crossings in nearest-first order", () => {
  const levels = buildManualGridLevels({ lowerPrice: 90, upperPrice: 100, gridCount: 3 });
  const result = evaluateManualGridTick({
    direction: "SHORT",
    previousPrice: 89,
    currentPrice: 101,
    levels,
    hysteresisBps: 5,
  });
  assert.deepEqual(result.triggers.map((trigger) => trigger.levelPrice), [90, 95, 100]);
});

test("a level does not repeat while price remains near it, then rearms after hysteresis", () => {
  const levels = buildManualGridLevels({ lowerPrice: 90, upperPrice: 100, gridCount: 2 });
  const first = evaluateManualGridTick({ direction: "LONG", previousPrice: 101, currentPrice: 99, levels });
  assert.equal(first.triggers.length, 1);
  const held = evaluateManualGridTick({ direction: "LONG", previousPrice: 99, currentPrice: 98.9, levels: first.levels });
  assert.equal(held.triggers.length, 0);
  const rearmed = evaluateManualGridTick({ direction: "LONG", previousPrice: 98.9, currentPrice: 100.1, levels: held.levels });
  assert.equal(rearmed.triggers.length, 0);
  const second = evaluateManualGridTick({ direction: "LONG", previousPrice: 100.1, currentPrice: 99, levels: rearmed.levels });
  assert.equal(second.triggers.length, 1);
  assert.equal(second.triggers[0].triggerCount, 2);
});

test("first price sample only initializes the watcher", () => {
  const levels = buildManualGridLevels({ lowerPrice: 90, upperPrice: 100, gridCount: 3 });
  const result = evaluateManualGridTick({ direction: "LONG", previousPrice: null, currentPrice: 89, levels });
  assert.equal(result.triggers.length, 0);
});
