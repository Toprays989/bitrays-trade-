import test from "node:test";
import assert from "node:assert/strict";
import { readSpotAvailableUsdt } from "../lib/spot-account-capital.ts";

test("spot capital accepts permissions-only Spot account and matches asset case-insensitively", () => {
  assert.deepEqual(readSpotAvailableUsdt({
    permissions: ["SPOT"],
    balances: [{ asset: "usdt", free: "150", locked: "0" }],
  }), { isSpot: true, availableUsdt: 150 });
});

test("spot capital excludes locked USDT from available challenge capital", () => {
  assert.deepEqual(readSpotAvailableUsdt({
    accountType: "SPOT",
    balances: [{ asset: "USDT", free: "90", locked: "60" }],
  }), { isSpot: true, availableUsdt: 90 });
});

test("unknown account type is not accepted as Spot", () => {
  assert.deepEqual(readSpotAvailableUsdt({
    balances: [{ asset: "USDT", free: "150" }],
  }), { isSpot: false, availableUsdt: 150 });
});
