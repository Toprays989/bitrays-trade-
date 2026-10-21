import test from "node:test";
import assert from "node:assert/strict";
import { buildManualGridAdditionLedger, buildManualGridLiveOrderLedger } from "../lib/execution/manual-grid-execution-adapter.ts";

const order = {
  symbol: "BTCUSDT",
  side: "BUY",
  positionSide: "LONG",
  orderType: "MARKET",
  quantity: 0.01,
  clientOrderId: "mgrid_7_1_1",
  triggerLevelPrice: 100,
  triggerPrice: 99.8,
  triggerCount: 1,
};

test("manual grid adapter writes the existing order ledger shape", () => {
  const row = buildManualGridLiveOrderLedger({ ownerEmail: "owner@example.com", accountId: "sub-1", credentialId: 3, order, referencePrice: 99.8, now: new Date(1000) });
  assert.equal(row.status, "PENDING");
  assert.equal(row.testOnly, false);
  assert.equal(row.estimatedNotional, 0.998);
  assert.equal(JSON.parse(row.responseJson).source, "MANUAL_GRID");
});

test("manual grid addition adapter binds the current position version", () => {
  const row = buildManualGridAdditionLedger({ positionId: 12, basePositionVersion: 4, ownerEmail: "owner@example.com", accountId: "sub-1", order, referencePrice: 99.8, now: new Date(1000) });
  assert.equal(row.positionId, 12);
  assert.equal(row.basePositionVersion, 4);
  assert.equal(row.status, "PENDING");
  assert.equal(JSON.parse(row.decisionJson).source, "MANUAL_GRID");
});
