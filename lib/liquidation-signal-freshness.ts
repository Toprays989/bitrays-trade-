export type LiquidationSignalTiming = {
  transportLatencyMs: number;
  processingLagMs: number;
  totalSignalAgeMs: number;
  fresh: boolean;
};

export type ScheduledLiquidationSignalTiming = LiquidationSignalTiming & {
  freshnessBasis: "TOTAL_SIGNAL_AGE" | "TRANSPORT_LATENCY";
};

export function liquidationSignalTiming(input: {
  tradeTimeMs: number;
  receivedAtMs: number;
  processedAtMs: number;
  maxSignalDelayMs: number;
}): LiquidationSignalTiming {
  const valid =
    Number.isFinite(input.tradeTimeMs) &&
    Number.isFinite(input.receivedAtMs) &&
    Number.isFinite(input.processedAtMs) &&
    Number.isFinite(input.maxSignalDelayMs) &&
    input.tradeTimeMs > 0 &&
    input.receivedAtMs > 0 &&
    input.processedAtMs > 0 &&
    input.maxSignalDelayMs >= 0;

  const transportLatencyMs = valid
    ? Math.max(0, input.receivedAtMs - input.tradeTimeMs)
    : Number.POSITIVE_INFINITY;
  const processingLagMs = valid
    ? Math.max(0, input.processedAtMs - input.receivedAtMs)
    : Number.POSITIVE_INFINITY;
  const totalSignalAgeMs = valid
    ? Math.max(0, input.processedAtMs - input.tradeTimeMs)
    : Number.POSITIVE_INFINITY;

  return {
    transportLatencyMs,
    processingLagMs,
    totalSignalAgeMs,
    fresh: valid && totalSignalAgeMs <= input.maxSignalDelayMs,
  };
}

/**
 * A direction worker may consume an event several scheduler ticks after the
 * proxy received it. Once the worker has an initialized sequence cursor, the
 * event is known to be new and the configured delay continues to protect the
 * exchange-to-proxy transport path rather than accidentally measuring the
 * scheduler queue. On bootstrap/recovery we retain the original total-age
 * check so retained proxy history cannot be replayed as a new opportunity.
 */
export function scheduledLiquidationSignalTiming(input: {
  tradeTimeMs: number;
  receivedAtMs: number;
  processedAtMs: number;
  maxSignalDelayMs: number;
  sequenceCursorInitialized: boolean;
}): ScheduledLiquidationSignalTiming {
  const timing = liquidationSignalTiming(input);
  const transportFresh =
    Number.isFinite(timing.transportLatencyMs) &&
    timing.transportLatencyMs <= input.maxSignalDelayMs;
  const freshnessBasis = input.sequenceCursorInitialized
    ? "TRANSPORT_LATENCY"
    : "TOTAL_SIGNAL_AGE";

  return {
    ...timing,
    freshnessBasis,
    fresh:
      transportFresh &&
      (input.sequenceCursorInitialized || timing.fresh),
  };
}
