import test from "node:test";
import assert from "node:assert/strict";
import { createMarkPriceHistory } from "../deploy/mark-price-history.mjs";

test("websocket mark cache aggregates completed daily ranges without REST data", () => {
  const cache = createMarkPriceHistory({ watchTtlMs: 10 * 24 * 60 * 60_000 });
  const day = 86_400_000;
  const now = 8 * day + 12 * 60 * 60_000;
  cache.watch(["BTCUSDT"], now);
  for (const [offset, low, high] of [[0, 100, 110], [day, 90, 99], [2 * day, 80, 88]]) {
    cache.record({ symbol: "BTCUSDT", markPrice: low, eventAtMs: offset + 1_000, receivedAtMs: offset + 1_000 });
    cache.record({ symbol: "BTCUSDT", markPrice: high, eventAtMs: offset + 2_000, receivedAtMs: offset + 2_000 });
  }
  const profile = cache.volatility("BTCUSDT", now, 3);
  assert.equal(profile.days.length, 3);
  assert.deepEqual(profile.days.map((row) => row.rangePercent), [10, 10, 10]);
  assert.equal(profile.complete, true);
});
