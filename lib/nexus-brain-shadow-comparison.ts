import type { NexusBrainShadowState } from "./nexus-brain-shadow-state";

export type NexusBrainOriginalDecision =
  | "TOOK_ENTRY"
  | "SKIPPED_ENTRY"
  | "PENDING";

export type NexusBrainObservedOutcome =
  | "FAVORABLE"
  | "ADVERSE"
  | "MIXED"
  | "INCOMPLETE";

export type NexusBrainObservedReason =
  | "CHECKPOINTS_INCOMPLETE"
  | "STOP_PATH_INCOMPLETE"
  | "STOP_LOSS_HIT"
  | "NET_FAVORABLE"
  | "NET_ADVERSE"
  | "MIXED_PATH";

export type NexusBrainComparisonVerdict =
  | "SUPPORTED"
  | "CONTRADICTED"
  | "INCONCLUSIVE"
  | "NOT_COMPARABLE";

export type NexusBrainShadowComparisonInput = {
  traceId: string;
  independenceKey?: string | null;
  statisticalWeight?: number;
  noiseEligible?: boolean;
  direction: "LONG" | "SHORT";
  shadowState: NexusBrainShadowState | null;
  originalDecision: NexusBrainOriginalDecision;
  causalComplete: boolean;
  estimatedFeeRoePercent?: number;
  stopLossRoePercent?: number | null;
  maeRoePercent?: number | null;
  roe5mPercent: number | null;
  roe30mPercent: number | null;
  roe60mPercent: number | null;
};

export type NexusBrainShadowComparisonSample =
  NexusBrainShadowComparisonInput & {
    observedOutcome: NexusBrainObservedOutcome;
    observedReason: NexusBrainObservedReason;
    shadowVerdict: NexusBrainComparisonVerdict;
    originalVerdict: NexusBrainComparisonVerdict;
    shadowOriginalDisagreement:
      | "SHADOW_READY_ORIGINAL_SKIPPED"
      | "SHADOW_INVALID_ORIGINAL_ENTERED"
      | null;
  };

export function nexusBrainShadowStateFromEvidence(
  evidence: Record<string, unknown>,
): NexusBrainShadowState | null {
  const raw = evidence.nexusBrainShadow;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = (raw as Record<string, unknown>).state;
  return [
    "OBSERVING",
    "ARMED",
    "CONFIRMING",
    "READY_SHADOW",
    "INVALIDATED",
    "DATA_STALE",
  ].includes(String(state))
    ? state as NexusBrainShadowState
    : null;
}

export function compareNexusBrainShadowSample(
  input: NexusBrainShadowComparisonInput,
): NexusBrainShadowComparisonSample {
  const checkpoints = [
    input.roe5mPercent,
    input.roe30mPercent,
    input.roe60mPercent,
  ];
  const requiresStopPath =
    input.stopLossRoePercent !== null &&
    input.stopLossRoePercent !== undefined &&
    Number.isFinite(input.stopLossRoePercent) &&
    input.stopLossRoePercent > 0;
  const hasStopPath =
    input.maeRoePercent !== null &&
    input.maeRoePercent !== undefined &&
    Number.isFinite(input.maeRoePercent);
  const checkpointsComplete =
    input.causalComplete &&
    checkpoints.every((value) => value !== null && Number.isFinite(value));
  const complete = checkpointsComplete && (!requiresStopPath || hasStopPath);
  const observation = complete
    ? checkpointOutcome(
      input.roe5mPercent!,
      input.roe30mPercent!,
      input.roe60mPercent!,
      input.estimatedFeeRoePercent,
      input.stopLossRoePercent,
      input.maeRoePercent,
    )
    : {
        outcome: "INCOMPLETE" as const,
        reason: checkpointsComplete
          ? "STOP_PATH_INCOMPLETE" as const
          : "CHECKPOINTS_INCOMPLETE" as const,
      };
  const observedOutcome = observation.outcome;
  return {
    ...input,
    observedOutcome,
    observedReason: observation.reason,
    shadowVerdict: predictionVerdict(
      shadowPrediction(input.shadowState),
      observedOutcome,
    ),
    originalVerdict: predictionVerdict(
      originalPrediction(input.originalDecision),
      observedOutcome,
    ),
    shadowOriginalDisagreement:
      input.shadowState === "READY_SHADOW" &&
        input.originalDecision === "SKIPPED_ENTRY"
        ? "SHADOW_READY_ORIGINAL_SKIPPED"
        : input.shadowState === "INVALIDATED" &&
            input.originalDecision === "TOOK_ENTRY"
          ? "SHADOW_INVALID_ORIGINAL_ENTERED"
          : null,
  };
}

export function nexusBrainFirstHourMae(
  currentMaeRoePercent: number | null,
  candidateMaeRoePercent: number | null,
  minuteOffset: number,
) {
  if (
    !Number.isFinite(minuteOffset) ||
    minuteOffset < 0 ||
    minuteOffset > 60 ||
    candidateMaeRoePercent === null ||
    !Number.isFinite(candidateMaeRoePercent)
  ) return currentMaeRoePercent;
  if (
    currentMaeRoePercent === null ||
    !Number.isFinite(currentMaeRoePercent)
  ) return candidateMaeRoePercent;
  return Math.min(currentMaeRoePercent, candidateMaeRoePercent);
}

export function summarizeNexusBrainShadowComparisons(
  inputs: NexusBrainShadowComparisonInput[],
  minimumComparableSamples = 20,
) {
  const rows = inputs.map(compareNexusBrainShadowSample);
  const independentVotes = collapseIndependentComparisonVotes(rows);
  const comparable = independentVotes.filter((vote) =>
    vote.shadowVerdict === "SUPPORTED" ||
    vote.shadowVerdict === "CONTRADICTED"
  );
  const originalComparable = independentVotes.filter((vote) =>
    vote.originalVerdict === "SUPPORTED" ||
    vote.originalVerdict === "CONTRADICTED"
  );
  const supported = comparable.filter(
    (vote) => vote.shadowVerdict === "SUPPORTED",
  ).length;
  const contradicted = comparable.length - supported;
  const originalSupported = originalComparable.filter(
    (vote) => vote.originalVerdict === "SUPPORTED",
  ).length;
  const originalContradicted = originalComparable.length - originalSupported;
  const disagreements = independentVotes.filter(
    (vote) => vote.shadowOriginalDisagreement !== null,
  );
  const complete = rows.filter(
    (row) => row.observedOutcome !== "INCOMPLETE",
  );
  const byDirection = {
    LONG: summarizeDirection(
      independentVotes,
      "LONG",
      minimumComparableSamples,
    ),
    SHORT: summarizeDirection(
      independentVotes,
      "SHORT",
      minimumComparableSamples,
    ),
  };
  const reviewReadyDirections = (["LONG", "SHORT"] as const).filter(
    (direction) => byDirection[direction].reviewReady,
  );
  const statisticallySupportedDirections =
    (["LONG", "SHORT"] as const).filter(
      (direction) => byDirection[direction].statisticallySupported,
    );
  const reasonCounts = {
    checkpointsIncomplete: rows.filter(
      (row) => row.observedReason === "CHECKPOINTS_INCOMPLETE",
    ).length,
    stopPathIncomplete: rows.filter(
      (row) => row.observedReason === "STOP_PATH_INCOMPLETE",
    ).length,
    stopLossHit: rows.filter(
      (row) => row.observedReason === "STOP_LOSS_HIT",
    ).length,
    netFavorable: rows.filter(
      (row) => row.observedReason === "NET_FAVORABLE",
    ).length,
    netAdverse: rows.filter(
      (row) => row.observedReason === "NET_ADVERSE",
    ).length,
    mixedPath: rows.filter(
      (row) => row.observedReason === "MIXED_PATH",
    ).length,
  };
  return {
    version: 2 as const,
    feeAware: true as const,
    totalTraces: rows.length,
    independentOpportunities: independentVotes.length,
    completeCausalSamples: complete.length,
    independentCompleteCausalSamples: independentVotes.filter(
      (vote) => vote.completeCausal,
    ).length,
    noiseFilteredTraces: rows.filter(
      (row) => row.noiseEligible === false,
    ).length,
    noiseFilteredOpportunities: independentVotes.filter(
      (vote) => vote.noiseFiltered,
    ).length,
    shadowComparableSamples: comparable.length,
    shadowSupportedSamples: supported,
    shadowContradictedSamples: contradicted,
    shadowInconclusiveSamples: rows.filter(
      (row) => row.shadowVerdict === "INCONCLUSIVE",
    ).length,
    shadowAccuracy:
      comparable.length > 0 ? supported / comparable.length : null,
    originalComparableSamples: originalComparable.length,
    originalSupportedSamples: originalSupported,
    originalContradictedSamples: originalContradicted,
    originalAccuracy:
      originalComparable.length > 0
        ? originalSupported / originalComparable.length
        : null,
    disagreementSamples: disagreements.length,
    shadowReadyOriginalSkipped: disagreements.filter(
      (row) =>
        row.shadowOriginalDisagreement ===
        "SHADOW_READY_ORIGINAL_SKIPPED",
    ).length,
    shadowInvalidOriginalEntered: disagreements.filter(
      (row) =>
        row.shadowOriginalDisagreement ===
        "SHADOW_INVALID_ORIGINAL_ENTERED",
    ).length,
    minimumComparableSamples,
    reviewReady: reviewReadyDirections.length > 0,
    reviewReadyDirections,
    statisticallySupportedDirections,
    reasonCounts,
    orderAffecting: false as const,
    parameterAffecting: false as const,
    byDirection,
    summary:
      reviewReadyDirections.length === 0
        ? `NEXUS大脑影子共 ${comparable.length} 个费用后可比样本，但多空任一方向均未独立达到 ${minimumComparableSamples} 个，继续收集。`
        : `NEXUS大脑影子 ${reviewReadyDirections.join("/")} 方向已达到独立复核门槛；费用后支持 ${supported}、反证 ${contradicted}，仅进入人工复核。`,
    recentRows: rows.slice(-50),
  };
}

function summarizeDirection(
  votes: NexusBrainIndependentComparisonVote[],
  direction: "LONG" | "SHORT",
  minimumComparableSamples: number,
) {
  const directionalVotes = votes.filter(
    (vote) => vote.direction === direction,
  );
  const comparable = directionalVotes.filter(
    (vote) =>
      vote.shadowVerdict === "SUPPORTED" ||
      vote.shadowVerdict === "CONTRADICTED",
  );
  const supported = comparable.filter(
    (vote) => vote.shadowVerdict === "SUPPORTED",
  ).length;
  const accuracy =
    comparable.length > 0 ? supported / comparable.length : null;
  const accuracyWilsonLower =
    comparable.length > 0
      ? wilsonLowerBound(supported, comparable.length)
      : null;
  return {
    totalTraces: directionalVotes.length,
    completeCausalSamples: directionalVotes.filter(
      (vote) => vote.completeCausal,
    ).length,
    comparableSamples: comparable.length,
    supportedSamples: supported,
    contradictedSamples: comparable.length - supported,
    accuracy,
    accuracyWilsonLower,
    minimumComparableSamples,
    reviewReady: comparable.length >= minimumComparableSamples,
    statisticallySupported:
      comparable.length >= minimumComparableSamples &&
      accuracyWilsonLower !== null &&
      accuracyWilsonLower > 0.5,
  };
}

type NexusBrainIndependentComparisonVote = {
  key: string;
  direction: "LONG" | "SHORT";
  completeCausal: boolean;
  noiseFiltered: boolean;
  shadowVerdict: NexusBrainComparisonVerdict;
  originalVerdict: NexusBrainComparisonVerdict;
  shadowOriginalDisagreement:
    | "SHADOW_READY_ORIGINAL_SKIPPED"
    | "SHADOW_INVALID_ORIGINAL_ENTERED"
    | null;
};

function collapseIndependentComparisonVotes(
  rows: NexusBrainShadowComparisonSample[],
) {
  const groups = new Map<string, NexusBrainShadowComparisonSample[]>();
  for (const row of rows) {
    const independenceKey =
      typeof row.independenceKey === "string" &&
      row.independenceKey.trim()
        ? row.independenceKey.trim()
        : row.traceId;
    const key = `${row.direction}:${independenceKey}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const eligibleGroup = group.filter(
      (row) => row.noiseEligible !== false,
    );
    const disagreements = [
      ...new Set(
        group
          .map((row) => row.shadowOriginalDisagreement)
          .filter((value) => value !== null),
      ),
    ];
    return {
      key,
      direction: group[0]!.direction,
      completeCausal: eligibleGroup.some(
        (row) => row.observedOutcome !== "INCOMPLETE",
      ),
      noiseFiltered: eligibleGroup.length === 0,
      shadowVerdict: weightedMajorityVerdict(
        eligibleGroup,
        (row) => row.shadowVerdict,
      ),
      originalVerdict: weightedMajorityVerdict(
        eligibleGroup,
        (row) => row.originalVerdict,
      ),
      shadowOriginalDisagreement:
        disagreements.length === 1 ? disagreements[0]! : null,
    } satisfies NexusBrainIndependentComparisonVote;
  });
}

function weightedMajorityVerdict(
  rows: NexusBrainShadowComparisonSample[],
  verdict: (row: NexusBrainShadowComparisonSample) =>
    NexusBrainComparisonVerdict,
) {
  const weight = (row: NexusBrainShadowComparisonSample) =>
    Number.isFinite(row.statisticalWeight) &&
    Number(row.statisticalWeight) > 0
      ? Number(row.statisticalWeight)
      : 1;
  const supported = rows
    .filter((row) => verdict(row) === "SUPPORTED")
    .reduce((sum, row) => sum + weight(row), 0);
  const contradicted = rows
    .filter((row) => verdict(row) === "CONTRADICTED")
    .reduce((sum, row) => sum + weight(row), 0);
  if (supported > contradicted) return "SUPPORTED" as const;
  if (contradicted > supported) return "CONTRADICTED" as const;
  if (supported > 0)
    return "INCONCLUSIVE" as const;
  return rows.some((row) => verdict(row) === "INCONCLUSIVE")
    ? "INCONCLUSIVE" as const
    : "NOT_COMPARABLE" as const;
}

function wilsonLowerBound(successes: number, total: number) {
  if (total <= 0) return 0;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const z2 = z * z;
  return (
    proportion +
    z2 / (2 * total) -
    z *
      Math.sqrt(
        (proportion * (1 - proportion) + z2 / (4 * total)) / total,
      )
  ) / (1 + z2 / total);
}

function checkpointOutcome(
  roe5mPercent: number,
  roe30mPercent: number,
  roe60mPercent: number,
  estimatedFeeRoePercent = 0,
  stopLossRoePercent: number | null = null,
  maeRoePercent: number | null = null,
): {
  outcome: NexusBrainObservedOutcome;
  reason: NexusBrainObservedReason;
} {
  const stopLoss =
    stopLossRoePercent !== null &&
    Number.isFinite(stopLossRoePercent) &&
    stopLossRoePercent > 0
      ? stopLossRoePercent
      : null;
  if (
    stopLoss !== null &&
    maeRoePercent !== null &&
    Number.isFinite(maeRoePercent) &&
    maeRoePercent <= -stopLoss
  ) return { outcome: "ADVERSE", reason: "STOP_LOSS_HIT" };
  const feeEdge =
    Number.isFinite(estimatedFeeRoePercent) &&
    estimatedFeeRoePercent > 0
      ? estimatedFeeRoePercent
      : 0;
  const positiveCount = [roe5mPercent, roe30mPercent, roe60mPercent].filter(
    (value) => value > feeEdge,
  ).length;
  if (positiveCount >= 2 && roe60mPercent > feeEdge)
    return { outcome: "FAVORABLE", reason: "NET_FAVORABLE" };
  if (positiveCount <= 1 && roe60mPercent <= feeEdge)
    return { outcome: "ADVERSE", reason: "NET_ADVERSE" };
  return { outcome: "MIXED", reason: "MIXED_PATH" };
}

function shadowPrediction(state: NexusBrainShadowState | null) {
  if (state === "READY_SHADOW") return "FAVORABLE" as const;
  if (state === "INVALIDATED") return "ADVERSE" as const;
  return null;
}

function originalPrediction(decision: NexusBrainOriginalDecision) {
  if (decision === "TOOK_ENTRY") return "FAVORABLE" as const;
  if (decision === "SKIPPED_ENTRY") return "ADVERSE" as const;
  return null;
}

function predictionVerdict(
  prediction: "FAVORABLE" | "ADVERSE" | null,
  outcome: NexusBrainObservedOutcome,
): NexusBrainComparisonVerdict {
  if (!prediction || outcome === "INCOMPLETE") return "NOT_COMPARABLE";
  if (outcome === "MIXED") return "INCONCLUSIVE";
  return prediction === outcome ? "SUPPORTED" : "CONTRADICTED";
}
