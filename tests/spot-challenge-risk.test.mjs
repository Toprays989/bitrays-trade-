import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSpotChallengeRisk } from "../lib/spot-challenge-risk.ts";

test("challenge risk uses net equity thresholds", () => {
  const result = evaluateSpotChallengeRisk({ capitalUsdt: 1000, equityUsdt: 1120, positions: [], pendingOrders: [] });
  assert.equal(result.status, "SUCCESS_PENDING_CLEAR");
  assert.equal(result.distanceToSuccessUsdt, 0);
});

test("pending limit orders consume pressure risk", () => {
  const result = evaluateSpotChallengeRisk({
    capitalUsdt: 1000,
    equityUsdt: 1000,
    positions: [{ symbol: "BTCUSDT", notionalUsdt: 200, pressureLossPercent: 10, correlationGroup: "majors" }],
    pendingOrders: [{ symbol: "ETHUSDT", reservedNotionalUsdt: 200, pressureLossPercent: 10, correlationGroup: "majors" }],
  });
  assert.equal(result.pressureLossUsdt, 40);
  assert.equal(result.reservedNotionalUsdt, 400);
  assert.match(result.reasons.join(" "), /高相关/);
});

test("stale market data forces reduce only", () => {
  const result = evaluateSpotChallengeRisk({ capitalUsdt: 1000, equityUsdt: 1000, positions: [], pendingOrders: [], websocketAgeMs: 3001 });
  assert.equal(result.status, "REDUCE_ONLY");
});

test("challenge risk returns dynamic settlement probabilities", () => {
  const result = evaluateSpotChallengeRisk({ capitalUsdt: 100, equityUsdt: 100, positions: [], pendingOrders: [], websocketAgeMs: 0 });
  assert.ok(result.successProbability !== null && result.successProbability > 0);
  assert.ok(result.failureProbability !== null && result.failureProbability > 0);
});
