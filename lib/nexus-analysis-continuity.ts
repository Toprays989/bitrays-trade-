type UnknownRecord = Record<string, unknown>;

export const NEXUS_EYE_RECOVERY_SLICE_MS = 30_000;
export const NEXUS_EYE_RECOVERY_MAX_EXTENSION_MS = 120_000;

export type NexusAnalysisContinuityDecision = {
  extend: boolean;
  code:
    | "EYE_DATA_RECOVERY_EXTENDED"
    | "SNAPSHOT_COMPLETE"
    | "SNAPSHOT_NOT_RECORDED"
    | "EYE_BLOCKED"
    | "ALL_PATHS_INVALIDATED"
    | "RECOVERY_BUDGET_EXHAUSTED";
  nextExpiresAtMs: number | null;
  recovery: UnknownRecord | null;
  missing: string[];
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * A transient eye-data gap may outlive the original signal timer by at most
 * two minutes. This is data recovery only: a complete-but-unconfirmed eye,
 * a blocked eye, or two invalidated entry paths never receives extra time.
 */
export function decideNexusAnalysisContinuity(input: {
  entryEvidence: unknown;
  currentExpiresAtMs: number;
  nowMs: number;
  sliceMs?: number;
  maximumExtensionMs?: number;
}): NexusAnalysisContinuityDecision {
  const evidence = record(input.entryEvidence);
  const snapshot = record(evidence.nexusDecisionSnapshot);
  if (!Object.keys(snapshot).length)
    return {
      extend: false,
      code: "SNAPSHOT_NOT_RECORDED",
      nextExpiresAtMs: null,
      recovery: null,
      missing: [],
    };
  if (snapshot.complete === true)
    return {
      extend: false,
      code: "SNAPSHOT_COMPLETE",
      nextExpiresAtMs: null,
      recovery: null,
      missing: [],
    };

  const eye = record(evidence.nexusMarketEyeDecision);
  const missing = [...new Set([
    ...strings(snapshot.missing),
    ...strings(eye.missing),
  ])];
  if (eye.verdict === "BLOCKED")
    return {
      extend: false,
      code: "EYE_BLOCKED",
      nextExpiresAtMs: null,
      recovery: null,
      missing,
    };

  const paths = [
    record(evidence.nexusPureStateMachine),
    record(evidence.nexusTrendBreakoutStateMachine),
  ];
  if (paths.every((path) => path.state === "INVALIDATED"))
    return {
      extend: false,
      code: "ALL_PATHS_INVALIDATED",
      nextExpiresAtMs: null,
      recovery: null,
      missing,
    };

  const previousRecovery = record(evidence.analysisContinuityRecovery);
  const originalExpiresAtMs =
    finite(previousRecovery.originalExpiresAtMs) ?? input.currentExpiresAtMs;
  const maximumExtensionMs = Math.max(
    1,
    input.maximumExtensionMs ?? NEXUS_EYE_RECOVERY_MAX_EXTENSION_MS,
  );
  const maximumExpiresAtMs = originalExpiresAtMs + maximumExtensionMs;
  if (input.nowMs >= maximumExpiresAtMs)
    return {
      extend: false,
      code: "RECOVERY_BUDGET_EXHAUSTED",
      nextExpiresAtMs: null,
      recovery: {
        ...previousRecovery,
        version: 1,
        originalExpiresAtMs,
        maximumExpiresAtMs,
        exhaustedAtMs: input.nowMs,
        missing,
      },
      missing,
    };

  const sliceMs = Math.max(1, input.sliceMs ?? NEXUS_EYE_RECOVERY_SLICE_MS);
  const nextExpiresAtMs = Math.min(
    maximumExpiresAtMs,
    Math.max(input.currentExpiresAtMs, input.nowMs) + sliceMs,
  );
  const attempts = Math.max(0, Math.trunc(finite(previousRecovery.attempts) ?? 0)) + 1;
  return {
    extend: true,
    code: "EYE_DATA_RECOVERY_EXTENDED",
    nextExpiresAtMs,
    missing,
    recovery: {
      version: 1,
      originalExpiresAtMs,
      maximumExpiresAtMs,
      extendedUntilMs: nextExpiresAtMs,
      totalExtensionMs: nextExpiresAtMs - originalExpiresAtMs,
      attempts,
      missing,
      lastExtendedAtMs: input.nowMs,
      purpose: "EYE_DATA_RECOVERY_ONLY",
      orderSubmissionAllowed: false,
    },
  };
}
