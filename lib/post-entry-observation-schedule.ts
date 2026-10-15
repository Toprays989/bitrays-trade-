// 学习闭环的正式检查点统一为 1/3/5/15/30/60 分钟。
// 1–10 分钟执行路径仍单独保留，二者共享节点但不重复写入。
export const POST_ENTRY_MODEL_MINUTES = [1, 3, 5, 15, 30, 60] as const;

export const POST_ENTRY_EXECUTION_PATH_MINUTES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
] as const;

// 正式学习节点完成后再稀疏观察长持仓，用于识别后段恢复、趋势延续和
// 利润回撤，同时不提高风控循环的稳定行情请求频率。
export const POST_ENTRY_LONG_HOLD_MINUTES = [
  120,
  180,
  240,
  480,
  720,
  1_440,
] as const;

// The first-day checkpoints describe the entry lifecycle. Positions that stay
// open longer need fresh evidence as the market regime changes, but replaying
// every missed historical day would invent causal context and create a REST
// burst. After 24 hours, take one current-time observation only when at least
// another full day has elapsed since the latest stored long-hold observation.
export const POST_ENTRY_RECURRING_HOLD_INTERVAL_MINUTES = 1_440;

export function isRecurringPostEntryHoldObservationMinute(
  minuteOffset: number,
) {
  return Number.isInteger(minuteOffset) &&
    minuteOffset > POST_ENTRY_RECURRING_HOLD_INTERVAL_MINUTES;
}

export const POST_ENTRY_STORED_MINUTES = [
  ...POST_ENTRY_EXECUTION_PATH_MINUTES,
  15,
  30,
  60,
  ...POST_ENTRY_LONG_HOLD_MINUTES,
] as const;

// A risk-loop tick or a brief process handover can land just after a model
// checkpoint. Preserve the enriched observation when it is at most 90 seconds
// late, while recording the real sample delay. Longer gaps remain price-only
// backfills because the missing historical context must not be reconstructed.
export const POST_ENTRY_CAUSAL_CHECKPOINT_MAX_DELAY_MS = 90_000;

export function duePostEntryObservationMinute(
  elapsedMs: number,
  recordedMinuteOffsets: readonly number[] = [],
) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const recordedMinutes = new Set(
    recordedMinuteOffsets.filter((minute) => Number.isInteger(minute)),
  );
  const delayedCheckpoint = [...POST_ENTRY_MODEL_MINUTES]
    .reverse()
    .find((minute) => {
      const delayMs = elapsedMs - minute * 60_000;
      return !recordedMinutes.has(minute) &&
        delayMs >= 0 &&
        delayMs <= POST_ENTRY_CAUSAL_CHECKPOINT_MAX_DELAY_MS;
    });
  if (delayedCheckpoint !== undefined) return delayedCheckpoint;
  const elapsedMinute = Math.floor(elapsedMs / 60_000);
  const storedMinute = POST_ENTRY_STORED_MINUTES.includes(
      elapsedMinute as (typeof POST_ENTRY_STORED_MINUTES)[number],
    ) && !recordedMinutes.has(elapsedMinute)
    ? elapsedMinute
    : null;
  if (storedMinute !== null) return storedMinute;

  const latestLongHoldMinute = Math.max(
    POST_ENTRY_RECURRING_HOLD_INTERVAL_MINUTES,
    ...[...recordedMinutes].filter(
      (minute) => minute >= POST_ENTRY_RECURRING_HOLD_INTERVAL_MINUTES,
    ),
  );
  return elapsedMinute - latestLongHoldMinute >=
      POST_ENTRY_RECURRING_HOLD_INTERVAL_MINUTES &&
      !recordedMinutes.has(elapsedMinute)
    ? elapsedMinute
    : null;
}

/**
 * A legacy exploration position can receive its missing entry structure long
 * after the normal 1/3/5/15/30/60-minute checkpoints. Reassess it in the current
 * elapsed-minute bucket once, without treating it as an original checkpoint.
 */
export function entryStructureReassessmentMinute(
  elapsedMs: number,
  structureBackfilled: boolean,
) {
  if (!structureBackfilled || !Number.isFinite(elapsedMs) || elapsedMs < 60_000)
    return null;
  return Math.floor(elapsedMs / 60_000);
}

export type PostEntryObservationType =
  | "ENTRY_EXECUTION_PATH"
  | "POST_ENTRY_MODEL_CHECKPOINT"
  | "POST_ENTRY_LONG_HOLD_OBSERVATION"
  | "POST_ENTRY_RECURRING_HOLD_OBSERVATION"
  | "ENTRY_STRUCTURE_BACKFILL_REASSESSMENT";

export function postEntryObservationType(
  minuteOffset: number,
): PostEntryObservationType | null {
  if (
    POST_ENTRY_MODEL_MINUTES.includes(
      minuteOffset as (typeof POST_ENTRY_MODEL_MINUTES)[number],
    )
  )
    return "POST_ENTRY_MODEL_CHECKPOINT";
  if (
    POST_ENTRY_LONG_HOLD_MINUTES.includes(
      minuteOffset as (typeof POST_ENTRY_LONG_HOLD_MINUTES)[number],
    )
  )
    return "POST_ENTRY_LONG_HOLD_OBSERVATION";
  if (isRecurringPostEntryHoldObservationMinute(minuteOffset))
    return "POST_ENTRY_RECURRING_HOLD_OBSERVATION";
  if (
    POST_ENTRY_EXECUTION_PATH_MINUTES.includes(
      minuteOffset as (typeof POST_ENTRY_EXECUTION_PATH_MINUTES)[number],
    )
  )
    return "ENTRY_EXECUTION_PATH";
  return null;
}

export function postEntryBackfillKlinePlan(
  finalMinuteOffset: number,
): {
  interval: "1m" | "30m";
  intervalMs: number;
  limit: number;
} {
  if (!Number.isFinite(finalMinuteOffset) || finalMinuteOffset <= 60)
    return {
      interval: "1m",
      intervalMs: 60_000,
      limit: Math.max(
        10,
        Math.min(100, Math.ceil(finalMinuteOffset || 0) + 2),
      ),
    };
  return {
    interval: "30m",
    intervalMs: 30 * 60_000,
    limit: Math.min(100, Math.ceil(finalMinuteOffset / 30) + 2),
  };
}
