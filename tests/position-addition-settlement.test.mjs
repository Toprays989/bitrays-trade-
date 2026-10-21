import test from "node:test";
import assert from "node:assert/strict";
import { settlePositionAdditionBasis } from "../lib/execution/position-addition-settlement.ts";

test("position addition settlement creates one new protection basis", () => {
  const result = settlePositionAdditionBasis({
    currentQuantity: 1,
    currentEntryPrice: 100,
    addedQuantity: 1,
    addedEntryPrice: 90,
    riskPlan: {
      takeProfits: [{ triggerPercent: 2, closePercent: 100, closeQuantity: 2 }],
      stopLosses: [{ triggerPercent: 1, closePercent: 100, closeQuantity: 2 }],
      dynamicProfitProtectionEnabled: false,
    },
    executedRiskProgress: { takeProfits: [], stopLosses: [] },
    minOrderQty: 0.01,
    quantityStep: 0.01,
    minNotionalUsdt: 5,
    trailingStopPercent: 0,
    positionVersion: 4,
    protectionVersion: 6,
    nowMs: 1000,
  });
  assert.equal(result.syncedQuantity, 2);
  assert.equal(result.syncedEntryPrice, 95);
  assert.equal(result.nextPositionVersion, 5);
  assert.equal(result.nextProtectionVersion, 7);
  assert.equal(result.riskPlan.protection.source, "MANUAL_ADD_ON");
  assert.equal(result.riskPlan.protection.basisPositionVersion, 5);
});

test("exchange basis is authoritative when it is available", () => {
  const result = settlePositionAdditionBasis({
    currentQuantity: 1,
    currentEntryPrice: 100,
    addedQuantity: 1,
    addedEntryPrice: 90,
    exchangeQuantity: 2.5,
    exchangeEntryPrice: 94,
    riskPlan: { takeProfits: [], stopLosses: [], dynamicProfitProtectionEnabled: true },
    executedRiskProgress: { takeProfits: [], stopLosses: [] },
    minOrderQty: 0.001,
    quantityStep: 0.001,
    minNotionalUsdt: 5,
    trailingStopPercent: 1,
    positionVersion: 1,
    protectionVersion: 1,
    nowMs: 1000,
  });
  assert.equal(result.syncedQuantity, 2.5);
  assert.equal(result.syncedEntryPrice, 94);
  assert.deepEqual(result.riskPlan.stopLosses, []);
});
