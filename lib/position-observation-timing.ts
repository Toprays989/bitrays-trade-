import { duePostEntryObservationMinute } from "./post-entry-observation-schedule.ts";

const DEFAULT_MARK_FRESHNESS_MS = 5_000;
export const POSITION_OBSERVATION_CAUSAL_WINDOW_MS = 90_000;

export type PositionObservationTiming = {
  scheduledAt: string;
  sampledAt: string;
  marketEventAt: string | null;
  marketReceivedAt: string | null;
  sampleDelayMs: number;
  markEventAgeMs: number | null;
  markReceiveAgeMs: number | null;
  snapshotAgeMs: number | null;
  transportLatencyMs: number | null;
  marketDataFresh: boolean;
  withinCausalWindow: boolean;
  liveDecisionEligible: boolean;
  causalLearningEligible: boolean;
  historicalLearningEligible: boolean;
  quality:
    | "LIVE_CAUSAL_WINDOW"
    | "MARK_DATA_STALE"
    | "HISTORICAL_BACKFILL_REQUIRED";
};

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoTimestamp(value: number | null) {
  return value !== null && value > 0 ? new Date(value).toISOString() : null;
}

export function buildPositionObservationTiming(input: {
  scheduledAtMs: number;
  sampledAtMs: number;
  marketEventAtMs?: number | null;
  marketReceivedAtMs?: number | null;
  snapshotAgeMs?: number | null;
  transportLatencyMs?: number | null;
  markFreshnessMs?: number;
  causalWindowMs?: number;
}): PositionObservationTiming {
  const marketEventAtMs = finiteNumber(input.marketEventAtMs);
  const marketReceivedAtMs = finiteNumber(input.marketReceivedAtMs);
  const snapshotAgeMs = finiteNumber(input.snapshotAgeMs);
  const transportLatencyMs = finiteNumber(input.transportLatencyMs);
  const sampleDelayMs = input.sampledAtMs - input.scheduledAtMs;
  const markEventAgeMs = marketEventAtMs === null
    ? null
    : input.sampledAtMs - marketEventAtMs;
  const markReceiveAgeMs = marketReceivedAtMs === null
    ? null
    : input.sampledAtMs - marketReceivedAtMs;
  const freshnessMs = Math.max(
    0,
    input.markFreshnessMs ?? DEFAULT_MARK_FRESHNESS_MS,
  );
  const causalWindowMs = Math.max(
    0,
    input.causalWindowMs ?? POSITION_OBSERVATION_CAUSAL_WINDOW_MS,
  );
  const ageWithin = (age: number | null) =>
    age !== null && age >= -1_000 && age <= freshnessMs;
  const marketDataFresh =
    ageWithin(markEventAgeMs) &&
    ageWithin(markReceiveAgeMs) &&
    snapshotAgeMs !== null &&
    snapshotAgeMs >= 0 &&
    snapshotAgeMs <= freshnessMs;
  const withinCausalWindow =
    Number.isFinite(sampleDelayMs) &&
    sampleDelayMs >= 0 &&
    sampleDelayMs <= causalWindowMs;
  const liveDecisionEligible = marketDataFresh && withinCausalWindow;

  return {
    scheduledAt: new Date(input.scheduledAtMs).toISOString(),
    sampledAt: new Date(input.sampledAtMs).toISOString(),
    marketEventAt: isoTimestamp(marketEventAtMs),
    marketReceivedAt: isoTimestamp(marketReceivedAtMs),
    sampleDelayMs,
    markEventAgeMs,
    markReceiveAgeMs,
    snapshotAgeMs,
    transportLatencyMs,
    marketDataFresh,
    withinCausalWindow,
    liveDecisionEligible,
    causalLearningEligible: liveDecisionEligible,
    historicalLearningEligible: marketDataFresh,
    quality: !marketDataFresh
      ? "MARK_DATA_STALE"
      : withinCausalWindow
        ? "LIVE_CAUSAL_WINDOW"
        : "HISTORICAL_BACKFILL_REQUIRED",
  };
}

export function positionObservationStorageStatus(
  timing: PositionObservationTiming,
): "OPEN" | "DATA_STALE" {
  return timing.liveDecisionEligible ? "OPEN" : "DATA_STALE";
}

function timestampMs(value: Date | number | null | undefined) {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Lightweight proof used by read models that intentionally do not load every
 * historical evidence JSON blob. A row must still have a trustworthy schedule,
 * persisted sample time and matching delay before it can be presented as a
 * current causal observation. DATA_STALE and legacy rows stay history-only.
 */
export function positionObservationHasCausalSchedule(input: {
  status: string;
  scheduledAt: Date | number | null | undefined;
  sampledAt: Date | number | null | undefined;
  sampleDelayMs: number | null | undefined;
  causalWindowMs?: number;
}) {
  if (input.status !== "OPEN" && input.status !== "CLOSED") return false;
  const scheduledAtMs = timestampMs(input.scheduledAt);
  const sampledAtMs = timestampMs(input.sampledAt);
  if (scheduledAtMs === null || sampledAtMs === null) return false;
  const computedDelayMs = sampledAtMs - scheduledAtMs;
  const storedDelayMs = finiteNumber(input.sampleDelayMs);
  const causalWindowMs = Math.max(
    0,
    input.causalWindowMs ?? POSITION_OBSERVATION_CAUSAL_WINDOW_MS,
  );
  return (
    storedDelayMs !== null &&
    computedDelayMs >= 0 &&
    computedDelayMs <= causalWindowMs &&
    Math.abs(storedDelayMs - computedDelayMs) <= 1_000
  );
}

/**
 * Parameter learning has a stricter contract than historical reporting.
 * Legacy rows without the complete live timing proof remain visible for
 * retrospective diagnosis, but cannot vote on a future strategy version.
 */
export function positionObservationCausalLearningEligible(input: {
  status: string;
  scheduledAt: Date | number | null | undefined;
  sampledAt: Date | number | null | undefined;
  sampleDelayMs: number | null | undefined;
  timing: unknown;
  causalWindowMs?: number;
}) {
  if (!positionObservationHasCausalSchedule(input)) return false;
  if (!input.timing || typeof input.timing !== "object") return false;
  const timing = input.timing as Record<string, unknown>;
  if (
    timing.causalLearningEligible !== true ||
    timing.liveDecisionEligible !== true ||
    timing.marketDataFresh !== true ||
    timing.withinCausalWindow !== true
  )
    return false;
  const scheduledAtMs = timestampMs(input.scheduledAt)!;
  const sampledAtMs = timestampMs(input.sampledAt)!;
  const computedDelayMs = sampledAtMs - scheduledAtMs;
  const storedDelayMs = finiteNumber(input.sampleDelayMs);
  const timingDelayMs = finiteNumber(
    typeof timing.sampleDelayMs === "number" ? timing.sampleDelayMs : null,
  );
  const causalWindowMs = Math.max(
    0,
    input.causalWindowMs ?? POSITION_OBSERVATION_CAUSAL_WINDOW_MS,
  );
  if (
    storedDelayMs === null ||
    timingDelayMs === null ||
    computedDelayMs < 0 ||
    computedDelayMs > causalWindowMs ||
    Math.abs(storedDelayMs - computedDelayMs) > 1_000 ||
    Math.abs(timingDelayMs - computedDelayMs) > 1_000
  )
    return false;
  return true;
}

export function duePositionObservationCandidates(input: {
  nowMs: number;
  positions: Array<{
    id: number;
    openedAtMs: number;
    recordedMinuteOffsets?: readonly number[];
  }>;
}) {
  if (!Number.isFinite(input.nowMs)) return [];
  return input.positions
    .flatMap((position) => {
      if (!Number.isInteger(position.id) || !Number.isFinite(position.openedAtMs))
        return [];
      const minuteOffset = duePostEntryObservationMinute(
        input.nowMs - position.openedAtMs,
        position.recordedMinuteOffsets,
      );
      return minuteOffset === null
        ? []
        : [{
            id: position.id,
            minuteOffset,
            scheduledAtMs: position.openedAtMs + minuteOffset * 60_000,
          }];
    })
    .sort(
      (left, right) =>
        left.scheduledAtMs - right.scheduledAtMs || left.id - right.id,
    );
}

export function positionObservationSampleKey(
  traceId: string,
  minuteOffset: number,
) {
  return `${traceId}:${minuteOffset}`;
}

/**
 * Closing a position can share the same minute bucket as a valid live sample.
 * Preserve that sample's timing, price and ROE proof; terminal settlement is
 * additive lifecycle evidence, not a replacement observation.
 */
export function mergeTerminalPositionObservation(input: {
  existingEvidence: Record<string, unknown>;
  terminalSettlement: Record<string, unknown>;
  netPnlEstimate: number | null;
  mfeRoePercent: number;
  maeRoePercent: number;
}) {
  return {
    status: "CLOSED" as const,
    remainingQty: 0,
    unrealizedPnl: null,
    netPnlEstimate: input.netPnlEstimate,
    mfeRoePercent: input.mfeRoePercent,
    maeRoePercent: input.maeRoePercent,
    evidenceJson: JSON.stringify({
      ...input.existingEvidence,
      terminalSettlement: input.terminalSettlement,
    }),
  };
}
