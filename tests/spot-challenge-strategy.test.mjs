import test from "node:test";
import assert from "node:assert/strict";
import { planSpotChallengeLongEntry } from "../lib/spot-challenge-strategy.ts";

test("spot challenge only buys low whitelist candidates with BTC support", () => {
  const signal = planSpotChallengeLongEntry({ capitalUsdt: 100, riskUsedPercent: 0, price: 9.2, dayHigh: 12, dayLow: 8, weekHigh: 14, weekLow: 7, btcChangePercent: 0.5 });
  assert.equal(signal.action, "BUY");
  assert.ok(signal.quoteOrderUsdt <= 15);
});

test("spot challenge holds when BTC is weak or price is high in range", () => {
  assert.equal(planSpotChallengeLongEntry({ capitalUsdt: 100, riskUsedPercent: 0, price: 11.8, dayHigh: 12, dayLow: 8, weekHigh: 14, weekLow: 7, btcChangePercent: 0 }).action, "HOLD");
  assert.equal(planSpotChallengeLongEntry({ capitalUsdt: 100, riskUsedPercent: 0, price: 9, dayHigh: 12, dayLow: 8, weekHigh: 14, weekLow: 7, btcChangePercent: -3 }).action, "HOLD");
});

test("spot challenge protects small capital from high priced spot entries", () => {
  const signal = planSpotChallengeLongEntry({ capitalUsdt: 100, riskUsedPercent: 0, price: 21, dayHigh: 22, dayLow: 18, threeDayHigh: 22, threeDayLow: 18, weekHigh: 24, weekLow: 16, btcChangePercent: 0 });
  assert.equal(signal.action, "HOLD");
  assert.match(signal.reason, /20/);
});
