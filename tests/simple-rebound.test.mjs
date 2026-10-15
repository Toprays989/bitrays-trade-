import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSimpleThreeMinuteEntry, shouldExitSimpleThreeMinutePosition } from "../lib/simple-three-minute-entry.ts";
import { buildSimpleReboundMarketRows } from "../lib/simple-rebound-scanner.ts";
import { createSimpleReboundSlots, occupySimpleReboundSlot, availableSimpleReboundSlots, findSimpleReboundSlot } from "../lib/simple-rebound-slots.ts";
import { buildSimpleReboundOrderPlan } from "../lib/simple-rebound-order-plan.ts";
import { buildSimpleReboundExecutionRequest } from "../lib/simple-rebound-execution-adapter.ts";
import { SIMPLE_REBOUND_EVENT_TYPES, isSimpleReboundEventType } from "../lib/simple-rebound-events.ts";
import { runSimpleReboundCycle } from "../lib/simple-rebound-runner.ts";
import { hydrateSimpleReboundSlots } from "../lib/simple-rebound-slot-recovery.ts";
import { createSimpleReboundScheduler } from "../lib/simple-rebound-scheduler.ts";
import { mapSimpleReboundVolumeRows } from "../lib/simple-rebound-market-mapping.ts";
import { resolveSimpleReboundOrderStatus, simpleReboundOrderCanAdvance, simpleReboundOrderTerminal } from "../lib/simple-rebound-execution-lifecycle.ts";
import { buildSimpleReboundExitPlan, reconcileSimpleReboundFill, releaseSimpleReboundPosition } from "../lib/simple-rebound-position-handoff.ts";
import { replaySimpleReboundExecution } from "../lib/simple-rebound-simulation.ts";
import { SimpleReboundSimulatedLedger } from "../lib/simple-rebound-simulated-ledger.ts";
import { assertSimpleReboundLiveConfirmation, SIMPLE_REBOUND_LIVE_CONFIRMATION } from "../lib/simple-rebound-live-gate.ts";

test("simple rebound requires ten 2s declines and two bearish minutes", () => {
  const result = evaluateSimpleThreeMinuteEntry({
    markPrices: Array.from({ length: 11 }, (_, index) => 100 - index),
    oneMinuteCandles: [{ open: 10, close: 9 }, { open: 9, close: 8 }, { open: 8, close: 8.2 }],
    currentMarkPrice: 8.2,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.phase, "READY");
});

test("simple rebound scanner owns a bounded top-volume universe", () => {
  const rows = buildSimpleReboundMarketRows(Array.from({ length: 35 }, (_, index) => ({
    symbol: `S${index}USDT`,
    quoteVolume24h: 35 - index,
    markPrices: [],
    oneMinuteCandles: [],
    currentMarkPrice: 1,
  })));
  assert.equal(rows.length, 30);
  assert.equal(rows[0]?.dailyVolumeRank, 1);
  assert.equal(rows[0]?.symbol, "S0USDT");
  assert.equal(rows.at(-1)?.dailyVolumeRank, 30);
});

test("simple rebound expires after the fourth candle fails", () => {
  const result = evaluateSimpleThreeMinuteEntry({
    markPrices: Array.from({ length: 11 }, (_, index) => 100 - index),
    oneMinuteCandles: [{ open: 10, close: 9 }, { open: 9, close: 8 }, { open: 8, close: 7 }, { open: 7, close: 6 }],
    currentMarkPrice: 6,
  });
  assert.equal(result.phase, "EXPIRED");
});

test("simple rebound exits adverse before three minutes and exits at three minutes", () => {
  assert.equal(shouldExitSimpleThreeMinutePosition({ openedAtMs: 0, nowMs: 1_000, entryPrice: 100, markPrice: 99 }), "EXIT_ADVERSE");
  assert.equal(shouldExitSimpleThreeMinutePosition({ openedAtMs: 0, nowMs: 180_000, entryPrice: 100, markPrice: 100 }), "EXIT_TIME");
  assert.equal(shouldExitSimpleThreeMinutePosition({ openedAtMs: 0, nowMs: 180_000, entryPrice: 100, markPrice: 101 }), "EXIT_PROFIT");
});

test("simple rebound has five independent slots", () => {
  let slots = createSimpleReboundSlots();
  for (let index = 0; index < 5; index += 1) {
    slots = occupySimpleReboundSlot(slots, { symbol: `S${index}USDT`, entryPrice: 1, openedAtMs: 0 }).slots;
  }
  assert.equal(availableSimpleReboundSlots(slots), 0);
  assert.equal(findSimpleReboundSlot(slots, "S2USDT")?.slotId, 3);
  assert.equal(occupySimpleReboundSlot(slots, { symbol: "S2USDT", entryPrice: 1, openedAtMs: 0 }).occupied, null);
});

test("simple rebound slot rows recover into the fixed five-seat shape", () => {
  const slots = hydrateSimpleReboundSlots([
    { slotId: 3, symbol: "ethusdt", entryPrice: 2_000, openedAt: new Date(123) },
    { slotId: 7, symbol: "INVALID", entryPrice: 1, openedAt: new Date(456) },
  ]);
  assert.equal(slots.length, 5);
  assert.equal(slots[2]?.symbol, "ethusdt");
  assert.equal(slots[2]?.openedAtMs, 123);
  assert.equal(slots.filter(Boolean).length, 1);
});

test("simple rebound order plan is long-only and fixed-size", () => {
  const plan = buildSimpleReboundOrderPlan({
    candidate: {
      kind: "SIMPLE_REBOUND",
      symbol: "BTCUSDT",
      direction: "LONG",
      eventAt: 123,
      receivedAt: 123,
      referencePrice: 100,
      phase: "READY",
    },
    slotId: 2,
    nowMs: 456,
  });
  assert.equal(plan?.source, "SIMPLE_REBOUND");
  assert.equal(plan?.notionalUsdt, 20);
  assert.equal(plan?.leverage, 5);
  assert.equal(plan?.slotId, 2);
  assert.match(plan?.clientOrderId ?? "", /^srb_BTCUSDT_123_2$/);
});

test("simple rebound execution request preserves account context", () => {
  const plan = buildSimpleReboundOrderPlan({
    candidate: { kind: "SIMPLE_REBOUND", symbol: "ETHUSDT", direction: "LONG", eventAt: 1, receivedAt: 1, referencePrice: 2_000, phase: "READY" },
    slotId: 1,
    nowMs: 2,
  });
  const request = buildSimpleReboundExecutionRequest(plan, { accountId: "bys04", credentialId: 7, ownerEmail: "owner@example.com" }, { minOrderQty: 0.001, quantityStep: 0.001, minNotionalUsdt: 5 });
  assert.equal(request.source, "SIMPLE_REBOUND");
  assert.equal(request.accountId, "bys04");
  assert.equal(request.order.side, "BUY");
  assert.equal(request.order.quantity, 0.01);
  assert.equal(request.order.requireExactLeverage, true);
});

test("simple rebound execution request rejects exchange-incompatible quantity", () => {
  const plan = buildSimpleReboundOrderPlan({
    candidate: { kind: "SIMPLE_REBOUND", symbol: "BTCUSDT", direction: "LONG", eventAt: 1, receivedAt: 1, referencePrice: 20_000, phase: "READY" },
    slotId: 1,
    nowMs: 2,
  });
  assert.throws(() => buildSimpleReboundExecutionRequest(plan, { accountId: "bys04", credentialId: 7, ownerEmail: "owner@example.com" }, { minOrderQty: 0.01, quantityStep: 0.01, minNotionalUsdt: 5 }), /最小下单量/);
});

test("simple rebound owns independent event types", () => {
  assert.deepEqual(Object.values(SIMPLE_REBOUND_EVENT_TYPES), [
    "SIMPLE_REBOUND_SCAN",
    "SIMPLE_REBOUND_SIGNAL",
    "SIMPLE_REBOUND_ORDER",
    "SIMPLE_REBOUND_EXIT",
  ]);
  assert.equal(isSimpleReboundEventType("THREE_MINUTE_PROBABILITY_WAKE_RECEIVED"), false);
});

test("simple rebound runner emits isolated signal and pending order events", () => {
  const result = runSimpleReboundCycle({
    market: [{
      symbol: "BTCUSDT",
      dailyVolumeRank: 1,
      markPrices: Array.from({ length: 11 }, (_, index) => 100 - index),
      oneMinuteCandles: [{ open: 10, close: 9 }, { open: 9, close: 8 }, { open: 8, close: 8.2 }],
      currentMarkPrice: 8.2,
    }],
    slots: [null, null, null, null, null],
    nowMs: 123,
  });
  assert.equal(result.signals.length, 1);
  assert.equal(result.orderPlans.length, 1);
  assert.deepEqual(result.events.map((event) => event.eventType), [
    "SIMPLE_REBOUND_SIGNAL",
    "SIMPLE_REBOUND_ORDER",
  ]);
  assert.equal(result.events[1]?.outcome, "PENDING");
});

test("simple rebound scheduler skips an overlapping cycle", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const scheduler = createSimpleReboundScheduler({
    runCycle: async () => {
      calls += 1;
      await gate;
      return "ok";
    },
    intervalMs: 2_000,
    now: () => 99,
  });
  const first = scheduler.tick();
  const second = await scheduler.tick();
  assert.equal(second.skipped, true);
  release();
  assert.deepEqual(await first, { skipped: false, value: "ok" });
  assert.equal(calls, 1);
  assert.equal(scheduler.lastRunAt(), 99);
});

test("simple rebound market adapter maps one bounded mark batch to volume rows", () => {
  const rows = mapSimpleReboundVolumeRows(
    [
      { symbol: "btcusdt", quoteVolume: 100, price: 101 },
      { symbol: "ETHUSDT", quoteVolume: 90, price: 2_000 },
    ],
    [{ symbol: "BTCUSDT", markPrice: 100.5, history: [{ markPrice: 100, eventAtMs: 1 }] }],
    new Map([["BTCUSDT", [{ open: 99, close: 100 }]]]),
  );
  assert.equal(rows[0]?.symbol, "BTCUSDT");
  assert.deepEqual(rows[0]?.markPrices, [100]);
  assert.equal(rows[0]?.oneMinuteCandles[0]?.close, 100);
  assert.equal(rows[1]?.currentMarkPrice, 2_000);
});

test("simple rebound execution lifecycle never skips reconciliation states", () => {
  assert.equal(resolveSimpleReboundOrderStatus({ acknowledged: true, filled: false }), "SUBMITTED");
  assert.equal(resolveSimpleReboundOrderStatus({ acknowledged: true, filled: true }), "FILLED");
  assert.equal(resolveSimpleReboundOrderStatus({ acknowledged: false, filled: false }), "REJECTED");
  assert.equal(resolveSimpleReboundOrderStatus({ acknowledged: true, filled: false, executionUnknown: true }), "EXECUTION_UNKNOWN");
  assert.equal(simpleReboundOrderCanAdvance("PENDING", "FILLED"), false);
  assert.equal(simpleReboundOrderCanAdvance("SUBMITTED", "FILLED"), true);
  assert.equal(simpleReboundOrderTerminal("EXECUTION_UNKNOWN"), true);
});

test("simple rebound fill occupies its planned slot and exit releases it", () => {
  const plan = { source: "SIMPLE_REBOUND", clientOrderId: "srb_1", symbol: "BTCUSDT", side: "LONG", notionalUsdt: 20, leverage: 5, referencePrice: 100, slotId: 2, openedAtMs: 1 };
  const filled = reconcileSimpleReboundFill({ slots: [null, null, null, null, null], plan, status: "FILLED", fillPrice: 101, filledAtMs: 2 });
  assert.equal(filled.outcome, "OCCUPIED");
  assert.equal(filled.slots[1]?.entryPrice, 101);
  const exit = buildSimpleReboundExitPlan({ slot: filled.slots[1], reason: "EXIT_TIME" });
  assert.equal(exit.reduceOnly, true);
  assert.equal(releaseSimpleReboundPosition(filled.slots, exit)[1], null);
});

test("simple rebound unknown execution never occupies a slot", () => {
  const plan = { source: "SIMPLE_REBOUND", clientOrderId: "srb_1", symbol: "BTCUSDT", side: "LONG", notionalUsdt: 20, leverage: 5, referencePrice: 100, slotId: 1, openedAtMs: 1 };
  const result = reconcileSimpleReboundFill({ slots: [null, null, null, null, null], plan, status: "EXECUTION_UNKNOWN", filledAtMs: 2 });
  assert.equal(result.outcome, "WAIT_RECONCILIATION");
  assert.equal(result.slots.filter(Boolean).length, 0);
});

test("simple rebound duplicate fill callback is idempotent", () => {
  const plan = { source: "SIMPLE_REBOUND", clientOrderId: "srb_1", symbol: "BTCUSDT", side: "LONG", notionalUsdt: 20, leverage: 5, referencePrice: 100, slotId: 1, openedAtMs: 1 };
  const first = reconcileSimpleReboundFill({ slots: [null, null, null, null, null], plan, status: "FILLED", fillPrice: 101, filledAtMs: 2 });
  const duplicate = reconcileSimpleReboundFill({ slots: first.slots, plan, status: "FILLED", fillPrice: 101, filledAtMs: 3 });
  assert.equal(duplicate.outcome, "ALREADY_OCCUPIED");
  assert.equal(duplicate.slots.filter(Boolean).length, 1);
});

test("simple rebound replay never exceeds five occupied slots", () => {
  const market = Array.from({ length: 30 }, (_, index) => ({
    symbol: `S${index}USDT`,
    dailyVolumeRank: index + 1,
    markPrices: Array.from({ length: 11 }, (_, tick) => 100 - tick),
    oneMinuteCandles: [{ open: 10, close: 9 }, { open: 9, close: 8 }, { open: 8, close: 8.2 }],
    currentMarkPrice: 8.2,
  }));
  const probe = replaySimpleReboundExecution([{ nowMs: 1_000, market }]);
  assert.equal(probe.slots.filter(Boolean).length, 0);
  const fillIds = Object.fromEntries(probe.history
    .filter((item) => item.type === "ORDER_RESULT")
    .map((item) => [String(item.clientOrderId), "FILLED"]));
  const result = replaySimpleReboundExecution([{ nowMs: 1_000, market, fills: fillIds }]);
  assert.equal(result.slots.filter(Boolean).length, 5);
});

test("simple rebound simulated ledger is idempotent across ack and exit replay", () => {
  const plan = { source: "SIMPLE_REBOUND", clientOrderId: "srb_ledger_1", symbol: "BTCUSDT", side: "LONG", notionalUsdt: 20, leverage: 5, referencePrice: 100, slotId: 1, openedAtMs: 1 };
  const ledger = new SimpleReboundSimulatedLedger();
  assert.equal(ledger.submit(plan, 1).status, "PENDING");
  assert.equal(ledger.acknowledge(plan, { acknowledged: true, filled: true, fillPrice: 101, nowMs: 2 }).status, "FILLED");
  assert.equal(ledger.acknowledge(plan, { acknowledged: true, filled: true, fillPrice: 101, nowMs: 3 }).status, "FILLED");
  const exit = ledger.requestExit(1, "EXIT_TIME");
  assert.equal(exit?.reduceOnly, true);
  assert.equal(ledger.acknowledgeExit(exit, 4, true), true);
  assert.equal(ledger.acknowledgeExit(exit, 5, true), true);
  assert.equal(ledger.snapshot().slots.filter(Boolean).length, 0);
});

test("simple rebound live boundary requires its own explicit confirmation", () => {
  assert.throws(() => assertSimpleReboundLiveConfirmation("ENABLE SERVER LIVE"), /SIMPLE REBOUND LIVE/);
  assert.doesNotThrow(() => assertSimpleReboundLiveConfirmation(SIMPLE_REBOUND_LIVE_CONFIRMATION));
});

test("simple rebound replay covers signal, fill, and three-minute exit", () => {
  const market = [{
    symbol: "BTCUSDT",
    dailyVolumeRank: 1,
    markPrices: Array.from({ length: 11 }, (_, index) => 100 - index),
    oneMinuteCandles: [{ open: 10, close: 9 }, { open: 9, close: 8 }, { open: 8, close: 8.2 }],
    currentMarkPrice: 8.2,
  }];
  const first = replaySimpleReboundExecution([{ nowMs: 1_000, market, fills: { srb_BTCUSDT_1000_1: "FILLED" } }]);
  assert.equal(first.slots.filter(Boolean).length, 1);
  const second = replaySimpleReboundExecution([
    { nowMs: 1_000, market, fills: { srb_BTCUSDT_1000_1: "FILLED" } },
    { nowMs: 181_000, market: [{ ...market[0], currentMarkPrice: 8.3 }] },
  ]);
  assert.equal(second.slots.filter(Boolean).length, 0);
  assert.equal(second.history.some((item) => item.type === "EXIT_RESULT"), true);
});
