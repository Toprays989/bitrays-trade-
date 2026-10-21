import test from "node:test";
import assert from "node:assert/strict";
import { gateSpotChallengeOrder } from "../lib/spot-challenge-order-gate.ts";

const allowedSymbols = new Set(["BTCUSDT"]);

test("challenge order gate reserves limit notional and expires in three hours", () => {
  const result = gateSpotChallengeOrder({
    challengeStatus: "RUNNING",
    symbol: "btcusdt",
    allowedSymbols,
    side: "BUY",
    orderType: "LIMIT",
    quantity: 0.01,
    price: 60000,
    clientOrderId: "challenge-1-buy-1",
    nowMs: 1_000,
  });
  assert.equal(result.order.symbol, "BTCUSDT");
  assert.equal(result.reservedNotionalUsdt, 600);
  assert.equal(result.expiresAt?.getTime(), 1_000 + 180 * 60_000);
  assert.equal(result.order.timeInForce, "GTC");
});

test("challenge order gate blocks stale risk states and symbols outside locked whitelist", () => {
  assert.throws(() => gateSpotChallengeOrder({ challengeStatus: "PROTECT", symbol: "BTCUSDT", allowedSymbols, side: "BUY", orderType: "MARKET", quoteOrderQty: 100, clientOrderId: "challenge-1-buy-2" }), /风险状态/);
  assert.throws(() => gateSpotChallengeOrder({ challengeStatus: "RUNNING", symbol: "ETHUSDT", allowedSymbols, side: "BUY", orderType: "MARKET", quoteOrderQty: 100, clientOrderId: "challenge-1-buy-3" }), /白名单/);
});

test("market order with quote amount does not invent a price", () => {
  const result = gateSpotChallengeOrder({ challengeStatus: "CAUTION", symbol: "BTCUSDT", allowedSymbols, side: "SELL", orderType: "MARKET", quoteOrderQty: 25, clientOrderId: "challenge-1-sell-1" });
  assert.equal(result.reservedNotionalUsdt, 25);
  assert.equal(result.expiresAt, null);
});
