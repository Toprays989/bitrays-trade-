const DEFAULT_WINDOW_MS = 60 * 60_000;
const DEFAULT_MAX_EVENTS = 10_000;
const STRATEGY_TRIGGER_WINDOW_MS = 120_000;
const STRATEGY_TRIGGER_NOTIONAL_USDT = 6_000;
const STRATEGY_TRIGGER_MIN_ACCUMULATED_EVENTS = 3;
const STRATEGY_TRIGGER_MAX_EVENT_GAP_MS = 30_000;
const BUCKETS = [
  { label: "<1k", min: 0, max: 1_000 },
  { label: "1k–3k", min: 1_000, max: 3_000 },
  { label: "3k–6k", min: 3_000, max: 6_000 },
  { label: "6k–15k", min: 6_000, max: 15_000 },
  { label: "15k–50k", min: 15_000, max: 50_000 },
  { label: "≥50k", min: 50_000, max: Number.POSITIVE_INFINITY },
];

export function createLiquidationNotionalTracker(options = {}) {
  const windowMs = finitePositive(options.windowMs) ?? DEFAULT_WINDOW_MS;
  const maxEvents = Math.max(
    1,
    Math.floor(finitePositive(options.maxEvents) ?? DEFAULT_MAX_EVENTS),
  );
  const events = [];

  function prune(now = Date.now()) {
    const cutoff = now - windowMs;
    while (
      events.length &&
      (events[0].time < cutoff || events.length > maxEvents)
    )
      events.shift();
  }

  function record(event) {
    const notional = finitePositive(event?.notional);
    const time = finitePositive(event?.time);
    if (notional === null || time === null) return false;
    events.push({
      notional,
      time,
      symbol: typeof event.symbol === "string" ? event.symbol : "",
      side: event.side === "BUY" || event.side === "SELL" ? event.side : "",
      eventCount: Math.max(
        1,
        Math.trunc(finitePositive(event.eventCount) ?? 1),
      ),
    });
    prune(time);
    return true;
  }

  function snapshot(now = Date.now()) {
    prune(now);
    const sorted = events
      .map((event) => event.notional)
      .sort((left, right) => left - right);
    const totalNotional = sorted.reduce((sum, value) => sum + value, 0);
    const buyNotional = events
      .filter((event) => event.side === "BUY")
      .reduce((sum, event) => sum + event.notional, 0);
    const sellNotional = events
      .filter((event) => event.side === "SELL")
      .reduce((sum, event) => sum + event.notional, 0);
    const eventCount = sorted.length;
    const oldestEventAt = events.length ? events[0].time : null;
    const newestEventAt = events.length ? events.at(-1).time : null;
    const threshold6000Count = sorted.filter((value) => value >= 6_000).length;
    const threshold6000Notional = sorted
      .filter((value) => value >= 6_000)
      .reduce((sum, value) => sum + value, 0);
    return {
      windowMs,
      eventCount,
      uniqueSymbols: new Set(events.map((event) => event.symbol).filter(Boolean))
        .size,
      totalNotional,
      buyEventCount: events.filter((event) => event.side === "BUY").length,
      sellEventCount: events.filter((event) => event.side === "SELL").length,
      buyNotional,
      sellNotional,
      buyNotionalShare: totalNotional ? buyNotional / totalNotional : 0,
      sellNotionalShare: totalNotional ? sellNotional / totalNotional : 0,
      oldestEventAt,
      newestEventAt,
      coverageMs:
        oldestEventAt === null || newestEventAt === null
          ? 0
          : Math.max(0, newestEventAt - oldestEventAt),
      p50Notional: percentile(sorted, 0.5),
      p75Notional: percentile(sorted, 0.75),
      p90Notional: percentile(sorted, 0.9),
      p95Notional: percentile(sorted, 0.95),
      threshold6000: {
        eventCount: threshold6000Count,
        eventShare: eventCount ? threshold6000Count / eventCount : 0,
        notional: threshold6000Notional,
        notionalShare: totalNotional
          ? threshold6000Notional / totalNotional
          : 0,
      },
      marketWindow120s: {
        windowMs: STRATEGY_TRIGGER_WINDOW_MS,
        thresholdNotionalUsdt: STRATEGY_TRIGGER_NOTIONAL_USDT,
        minAccumulatedEvents: STRATEGY_TRIGGER_MIN_ACCUMULATED_EVENTS,
        maxInterEventGapMs: STRATEGY_TRIGGER_MAX_EVENT_GAP_MS,
        buy: rollingTriggerStats(
          events,
          "BUY",
          now,
          STRATEGY_TRIGGER_WINDOW_MS,
          STRATEGY_TRIGGER_NOTIONAL_USDT,
          STRATEGY_TRIGGER_MIN_ACCUMULATED_EVENTS,
          STRATEGY_TRIGGER_MAX_EVENT_GAP_MS,
        ),
        sell: rollingTriggerStats(
          events,
          "SELL",
          now,
          STRATEGY_TRIGGER_WINDOW_MS,
          STRATEGY_TRIGGER_NOTIONAL_USDT,
          STRATEGY_TRIGGER_MIN_ACCUMULATED_EVENTS,
          STRATEGY_TRIGGER_MAX_EVENT_GAP_MS,
        ),
      },
      buckets: BUCKETS.map((bucket) => {
        const values = sorted.filter(
          (value) => value >= bucket.min && value < bucket.max,
        );
        const notional = values.reduce((sum, value) => sum + value, 0);
        return {
          label: bucket.label,
          minInclusive: bucket.min,
          maxExclusive: Number.isFinite(bucket.max) ? bucket.max : null,
          eventCount: values.length,
          eventShare: eventCount ? values.length / eventCount : 0,
          notional,
          notionalShare: totalNotional ? notional / totalNotional : 0,
        };
      }),
    };
  }

  return { record, snapshot };
}

function rollingTriggerStats(
  events,
  side,
  now,
  windowMs,
  thresholdNotional,
  minAccumulatedEvents,
  maxInterEventGapMs,
) {
  const ordered = events
    .filter((event) => event.side === side)
    .sort((left, right) => left.time - right.time);
  let pending = [];
  let triggerCount = 0;
  let latestTriggerAt = null;
  let peakNotional = 0;
  let peakAt = null;
  for (const event of ordered) {
    const singleStrongSignal = event.notional >= thresholdNotional;
    if (singleStrongSignal) {
      pending = [event];
    } else {
      const previous = pending[pending.length - 1];
      if (
        previous &&
        event.time - previous.time > maxInterEventGapMs
      )
        pending = [];
      pending = pending.filter((item) => event.time - item.time <= windowMs);
      pending.push(event);
    }
    const pendingNotional = pending.reduce(
      (sum, item) => sum + item.notional,
      0,
    );
    const pendingEventCount = pending.reduce(
      (sum, item) => sum + item.eventCount,
      0,
    );
    if (pendingNotional > peakNotional) {
      peakNotional = pendingNotional;
      peakAt = event.time;
    }
    if (
      singleStrongSignal ||
      (
        pendingNotional >= thresholdNotional &&
        pendingEventCount >= minAccumulatedEvents
      )
    ) {
      triggerCount += 1;
      latestTriggerAt = event.time;
      pending = [];
    }
  }

  const lastPending = pending[pending.length - 1];
  if (
    lastPending &&
    (
      now - lastPending.time > maxInterEventGapMs ||
      now - pending[0].time > windowMs
    )
  )
    pending = [];
  return {
    currentNotional: pending.reduce((sum, event) => sum + event.notional, 0),
    currentEventCount: pending.reduce(
      (sum, event) => sum + event.eventCount,
      0,
    ),
    currentUniqueSymbols: new Set(
      pending.map((event) => event.symbol).filter(Boolean),
    ).size,
    peakNotional,
    peakAt,
    triggerCount,
    latestTriggerAt,
  };
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
