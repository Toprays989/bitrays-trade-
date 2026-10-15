import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_STRATEGY_TYPES,
  CREATABLE_CONTROL_STRATEGY_TYPES,
  isControlStrategyType,
  isCreatableControlStrategyType,
} from "../lib/control-strategy-types.ts";

test("restored strategy control API excludes unsupported plugin records", () => {
  assert.deepEqual(CONTROL_STRATEGY_TYPES, ["LIQ_CHASE", "SENTINEL", "SIMPLE_REBOUND"]);
  assert.deepEqual(CREATABLE_CONTROL_STRATEGY_TYPES, ["LIQ_CHASE", "SIMPLE_REBOUND"]);
  assert.equal(isControlStrategyType("SENTINEL"), true);
  assert.equal(isControlStrategyType("UNKNOWN"), false);
  assert.equal(isCreatableControlStrategyType("LIQ_CHASE"), true);
  assert.equal(isCreatableControlStrategyType("SIMPLE_REBOUND"), true);
  assert.equal(isCreatableControlStrategyType("SENTINEL"), false);
});
