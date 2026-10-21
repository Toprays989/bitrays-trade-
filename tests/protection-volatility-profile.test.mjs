import test from "node:test";
import assert from "node:assert/strict";

const modulePath = new URL("../lib/protection-volatility-profile.ts", import.meta.url).href;
const { buildProtectionVolatilityProfile, pricePercentFromRoe } = await import(modulePath);

test("protection volatility profile ignores incomplete daily samples and uses completed days", () => {
  const profile = buildProtectionVolatilityProfile({
    days: [
      { dayStartMs: 1, low: 100, high: 110, first: 105, last: 100, sampleCount: 30 },
      { dayStartMs: 2, low: 200, high: 206, first: 201, last: 205, sampleCount: 30 },
      { dayStartMs: 3, low: 300, high: 315, first: 310, last: 305, sampleCount: 30 },
      { dayStartMs: 4, low: 400, high: 410, first: 400, last: 405, sampleCount: 2 },
    ],
    windowDays: 3,
  });
  assert.equal(profile.sampleDays, 3);
  assert.equal(profile.complete, true);
  assert.equal(profile.averageRangePercent, (10 + 3 + 5) / 3);
  assert.equal(profile.averageDownDayRangePercent, 7.5);
});

test("ROE conversion remains independent of long or short direction", () => {
  assert.equal(pricePercentFromRoe(6, 5), 1.2);
  assert.equal(pricePercentFromRoe(-3, 5), -0.6);
});
