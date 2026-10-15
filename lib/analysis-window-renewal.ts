export function renewAnalysisWindow(input: {
  createdAtMs: number;
  currentExpiresAtMs: number;
  latestSignalTimeMs: number;
  validityMs: number;
  /** Renewal is opt-in. Repeated evaluation of the same WAIT must not extend it. */
  allowRenewal?: boolean;
  maximumLifetimeMultiplier?: number;
}) {
  const maximumLifetimeMultiplier = Math.max(
    1,
    Number(input.maximumLifetimeMultiplier ?? 2),
  );
  const valid =
    input.allowRenewal === true &&
    Number.isFinite(input.createdAtMs) &&
    Number.isFinite(input.currentExpiresAtMs) &&
    Number.isFinite(input.latestSignalTimeMs) &&
    Number.isFinite(input.validityMs) &&
    input.validityMs > 0 &&
    input.latestSignalTimeMs >= input.createdAtMs;
  if (!valid)
    return {
      renewed: false,
      nextExpiresAtMs: input.currentExpiresAtMs,
      hardExpiresAtMs: input.currentExpiresAtMs,
    };

  const hardExpiresAtMs =
    input.createdAtMs + input.validityMs * maximumLifetimeMultiplier;
  const nextExpiresAtMs = Math.min(
    input.latestSignalTimeMs + input.validityMs,
    hardExpiresAtMs,
  );
  return {
    renewed: nextExpiresAtMs > input.currentExpiresAtMs,
    nextExpiresAtMs: Math.max(
      input.currentExpiresAtMs,
      nextExpiresAtMs,
    ),
    hardExpiresAtMs,
  };
}

export function pauseAnalysisWindow(input: {
  createdAtMs: number;
  currentExpiresAtMs: number;
  lastProgressAtMs: number;
  nowMs: number;
  validityMs: number;
  /** Pausing is opt-in; an infrastructure wait cannot silently extend analysis. */
  allowPause?: boolean;
  alreadyPausedMs?: number;
  maximumPauseMs?: number;
  maximumPauseStepMs?: number;
  maximumLifetimeMultiplier?: number;
}) {
  const maximumLifetimeMultiplier = Math.max(
    1,
    Number(input.maximumLifetimeMultiplier ?? 3),
  );
  const maximumPauseMs = Math.max(
    0,
    Number(
      input.maximumPauseMs ??
        Math.min(input.validityMs / 4, 60_000),
    ),
  );
  const maximumPauseStepMs = Math.max(
    0,
    Number(input.maximumPauseStepMs ?? 30_000),
  );
  const alreadyPausedMs = Math.max(
    0,
    Number(input.alreadyPausedMs ?? 0),
  );
  const valid =
    input.allowPause === true &&
    Number.isFinite(input.createdAtMs) &&
    Number.isFinite(input.currentExpiresAtMs) &&
    Number.isFinite(input.lastProgressAtMs) &&
    Number.isFinite(input.nowMs) &&
    Number.isFinite(input.validityMs) &&
    Number.isFinite(maximumPauseMs) &&
    Number.isFinite(maximumPauseStepMs) &&
    Number.isFinite(alreadyPausedMs) &&
    input.validityMs > 0 &&
    input.nowMs >= input.lastProgressAtMs;
  if (!valid)
    return {
      paused: false,
      pauseAppliedMs: 0,
      totalPausedMs: alreadyPausedMs,
      nextExpiresAtMs: input.currentExpiresAtMs,
      hardExpiresAtMs: input.currentExpiresAtMs,
      maximumPauseMs,
    };

  // The strategy may consume at most the configured number of active analysis
  // windows. A bounded market-data allowance is added outside that active-time
  // budget so a brief feed gap does not silently burn the decision window.
  const hardExpiresAtMs =
    input.createdAtMs +
    input.validityMs * maximumLifetimeMultiplier +
    maximumPauseMs;
  const availablePauseMs = Math.max(
    0,
    maximumPauseMs - alreadyPausedMs,
  );
  const elapsedSinceProgressMs = Math.max(
    0,
    input.nowMs - input.lastProgressAtMs,
  );
  const pauseAppliedMs = Math.max(
    0,
    Math.min(
      elapsedSinceProgressMs,
      maximumPauseStepMs,
      availablePauseMs,
      Math.max(0, hardExpiresAtMs - input.currentExpiresAtMs),
    ),
  );
  return {
    paused: pauseAppliedMs > 0,
    pauseAppliedMs,
    totalPausedMs: alreadyPausedMs + pauseAppliedMs,
    nextExpiresAtMs: input.currentExpiresAtMs + pauseAppliedMs,
    hardExpiresAtMs,
    maximumPauseMs,
  };
}
