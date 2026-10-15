import type {
  NexusBrainOriginalDecision,
} from "./nexus-brain-shadow-comparison";
import type {
  NexusBrainShadowState,
} from "./nexus-brain-shadow-state";

export const NEXUS_BRAIN_LIFECYCLE_VERSION =
  "nexus-brain-lifecycle-v1";

export type NexusBrainLifecycleStage =
  | "EYES_WAITING"
  | "BRAIN_REASONING"
  | "DECISION_FROZEN"
  | "POSITION_MANAGING"
  | "LEARNING_COLLECTING"
  | "LEARNING_READY";

export type NexusBrainLifecycleSnapshot = {
  version: typeof NEXUS_BRAIN_LIFECYCLE_VERSION;
  stage: NexusBrainLifecycleStage;
  eyesComplete: boolean;
  decisionComplete: boolean;
  positionManagementObserved: boolean;
  learningEligible: boolean;
  factCount: number;
  checkpointCount: number;
  blockers: string[];
  orderAffecting: false;
  parameterAffecting: false;
};

export function nexusBrainFactIdsFromEvidence(
  evidence: Record<string, unknown>,
) {
  const shadow = record(evidence.nexusBrainShadow);
  const reasons = Array.isArray(shadow.reasons) ? shadow.reasons : [];
  return [
    typeof shadow.triggerFactId === "string"
      ? shadow.triggerFactId
      : null,
    ...(Array.isArray(shadow.confirmationFactIds)
      ? shadow.confirmationFactIds
      : []),
    ...reasons.flatMap((reason) => {
      const value = record(reason);
      return Array.isArray(value.factIds) ? value.factIds : [];
    }),
  ]
    .filter((value): value is string =>
      typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function deriveNexusBrainLifecycle(input: {
  factIds: string[];
  brainState: NexusBrainShadowState | null;
  originalDecision: NexusBrainOriginalDecision;
  hasPosition: boolean;
  causalCheckpointMinutes: number[];
  stopPathRequired: boolean;
  stopPathAvailable: boolean;
  positionManagementObserved: boolean;
}): NexusBrainLifecycleSnapshot {
  const factCount = new Set(
    input.factIds.map((value) => value.trim()).filter(Boolean),
  ).size;
  const checkpoints = new Set(
    input.causalCheckpointMinutes.filter((minute) =>
      [5, 30, 60].includes(minute)),
  );
  const eyesComplete = factCount > 0;
  const decisionComplete =
    input.brainState !== null &&
    input.originalDecision !== "PENDING";
  const stopPathComplete =
    !input.stopPathRequired || input.stopPathAvailable;
  const checkpointsComplete = [5, 30, 60].every((minute) =>
    checkpoints.has(minute));
  const learningEligible =
    eyesComplete &&
    decisionComplete &&
    checkpointsComplete &&
    stopPathComplete;
  const blockers = [
    eyesComplete ? null : "EYES_FACTS_MISSING",
    decisionComplete ? null : "BRAIN_DECISION_PENDING",
    checkpoints.has(5) ? null : "CHECKPOINT_5M_MISSING",
    checkpoints.has(30) ? null : "CHECKPOINT_30M_MISSING",
    checkpoints.has(60) ? null : "CHECKPOINT_60M_MISSING",
    stopPathComplete ? null : "STOP_PATH_MISSING",
  ].filter((value): value is string => value !== null);
  const stage: NexusBrainLifecycleStage = learningEligible
    ? "LEARNING_READY"
    : checkpoints.size > 0
      ? "LEARNING_COLLECTING"
      : input.hasPosition
        ? "POSITION_MANAGING"
        : decisionComplete
          ? "DECISION_FROZEN"
          : eyesComplete
            ? "BRAIN_REASONING"
            : "EYES_WAITING";
  return {
    version: NEXUS_BRAIN_LIFECYCLE_VERSION,
    stage,
    eyesComplete,
    decisionComplete,
    positionManagementObserved: input.positionManagementObserved,
    learningEligible,
    factCount,
    checkpointCount: checkpoints.size,
    blockers,
    orderAffecting: false,
    parameterAffecting: false,
  };
}

export function summarizeNexusBrainLifecycles(
  snapshots: NexusBrainLifecycleSnapshot[],
) {
  const count = (stage: NexusBrainLifecycleStage) =>
    snapshots.filter((snapshot) => snapshot.stage === stage).length;
  const blockerCounts = new Map<string, number>();
  for (const snapshot of snapshots)
    for (const blocker of snapshot.blockers)
      blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1);
  return {
    version: NEXUS_BRAIN_LIFECYCLE_VERSION,
    totalTraces: snapshots.length,
    eyesComplete: snapshots.filter((snapshot) => snapshot.eyesComplete).length,
    decisionComplete: snapshots.filter(
      (snapshot) => snapshot.decisionComplete,
    ).length,
    positionManagementObserved: snapshots.filter(
      (snapshot) => snapshot.positionManagementObserved,
    ).length,
    learningEligible: snapshots.filter(
      (snapshot) => snapshot.learningEligible,
    ).length,
    stages: {
      eyesWaiting: count("EYES_WAITING"),
      brainReasoning: count("BRAIN_REASONING"),
      decisionFrozen: count("DECISION_FROZEN"),
      positionManaging: count("POSITION_MANAGING"),
      learningCollecting: count("LEARNING_COLLECTING"),
      learningReady: count("LEARNING_READY"),
    },
    topBlockers: [...blockerCounts.entries()]
      .sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([code, traces]) => ({ code, traces })),
    orderAffecting: false as const,
    parameterAffecting: false as const,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
