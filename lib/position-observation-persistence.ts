export const POSITION_OBSERVATION_STORAGE_VERSION = 1;

export type PositionObservationEventKind =
  | "CHECKPOINT"
  | "STRUCTURE_REASSESSMENT"
  | "PROTECTION_CHANGED"
  | "EXIT_DECISION"
  | "CAPITAL_EFFICIENCY_EXIT_OBSERVATION"
  | "RECURRING_HOLD_OBSERVATION";

type JsonRecord = Record<string, unknown>;

const COMPACT_EVIDENCE_FIELDS = [
  "source",
  "observationTiming",
  "evidenceCompleteness",
  "missingCausalDimensions",
  "orderSource",
  "entryEvidenceAvailable",
  "leverage",
  "positionSide",
  "pnlBasis",
  "sampleType",
  "modelCheckpoint",
  "longHoldObservation",
  "recurringHoldObservation",
  "structureBackfillReassessment",
  "observedElapsedMinutes",
  "marketRegime",
  "postEntryFundingVolumeObservation",
  "postEntryTradeVolumeObservation",
  "postEntryContractTrendProfile",
  "entryStructureContext",
  "waveStructure",
  "postEntryTrendPath",
  "breakdownObservation",
  "entryThesisInvalidation",
  "capitalEfficiencyWaveAssessment",
  "postEntryLargeTraderObservation",
  "strategyBranchFamily",
  "contrarianProbeLifecycle",
  "proposedPositionManagementDecision",
  "positionManagementDecision",
  "positionManagementExecutionBinding",
  "positionManagementExecutionOutcome",
  "durableStructureExitIntent",
  "nexusPositionStateMachine",
  "positionThesisUpdate",
] as const;

export function positionObservationEventType(
  kind: PositionObservationEventKind,
) {
  return kind === "STRUCTURE_REASSESSMENT"
    ? "POSITION_STRUCTURE_REASSESSMENT"
    : kind === "PROTECTION_CHANGED"
      ? "POSITION_PROTECTION_CHANGED"
      : kind === "EXIT_DECISION"
        ? "POSITION_EXIT_DECISION"
    : kind === "CAPITAL_EFFICIENCY_EXIT_OBSERVATION"
      ? "POSITION_CAPITAL_EFFICIENCY_EXIT_OBSERVATION"
      : kind === "RECURRING_HOLD_OBSERVATION"
        ? "POSITION_RECURRING_HOLD_OBSERVATION"
      : "POSITION_CHECKPOINT";
}

export function positionObservationRequiresFullSnapshot(input: {
  modelCheckpoint: boolean;
  longHoldObservation: boolean;
  structureBackfillReassessment: boolean;
  decision: unknown;
  executionBinding: unknown;
  durableStructureExitIntent: unknown;
  previousState: unknown;
  currentState: unknown;
}) {
  if (
    input.modelCheckpoint ||
    input.longHoldObservation ||
    input.structureBackfillReassessment
  ) return { required: true, reason: "SCHEDULED_FULL_CHECKPOINT" } as const;

  const decision = record(input.decision);
  if (
    typeof decision.action === "string" &&
    decision.action !== "HOLD_AND_OBSERVE"
  ) return { required: true, reason: "MATERIAL_DECISION" } as const;

  const executionBinding = record(input.executionBinding);
  if (executionBinding.changesPositionImmediately === true)
    return { required: true, reason: "EXECUTION_HANDOFF" } as const;
  if (Object.keys(record(input.durableStructureExitIntent)).length > 0)
    return { required: true, reason: "DURABLE_EXIT_INTENT" } as const;

  const previousState = record(input.previousState);
  const currentState = record(input.currentState);
  if (
    Object.keys(previousState).length > 0 &&
    String(previousState.state ?? "") !== String(currentState.state ?? "")
  ) return { required: true, reason: "POSITION_STATE_TRANSITION" } as const;

  return { required: false, reason: "CONTINUOUS_NO_CHANGE" } as const;
}

export function positionObservationEvidenceForStorage(input: {
  evidence: JsonRecord;
  fullSnapshot: boolean;
  storageReason: string;
}) {
  const storage = {
    version: POSITION_OBSERVATION_STORAGE_VERSION,
    mode: input.fullSnapshot ? "FULL" : "COMPACT",
    reason: input.storageReason,
  } as const;
  if (input.fullSnapshot)
    return {
      ...input.evidence,
      positionObservationStorage: storage,
    };

  const compact: JsonRecord = {};
  for (const field of COMPACT_EVIDENCE_FIELDS) {
    if (input.evidence[field] !== undefined)
      compact[field] = input.evidence[field];
  }
  compact.positionObservationStorage = storage;
  return compact;
}

export function compactPositionObservationEventDetail(input: {
  minuteOffset: number;
  roePercent: number;
  evidence: JsonRecord;
  continuousStructureExitExecutionEligible: boolean;
}) {
  const decision = record(input.evidence.positionManagementDecision);
  const state = record(input.evidence.nexusPositionStateMachine);
  const contractTrend = record(input.evidence.postEntryContractTrendProfile);
  const trendPath = record(input.evidence.postEntryTrendPath);
  const thesis = record(input.evidence.entryThesisInvalidation);
  const assessment = record(input.evidence.capitalEfficiencyWaveAssessment);
  const executionBinding = record(
    input.evidence.positionManagementExecutionBinding,
  );
  return {
    storageVersion: POSITION_OBSERVATION_STORAGE_VERSION,
    minuteOffset: input.minuteOffset,
    roePercent: input.roePercent,
    evidenceCompleteness: input.evidence.evidenceCompleteness,
    missingCausalDimensions: input.evidence.missingCausalDimensions,
    observationTiming: input.evidence.observationTiming,
    structureBackfillReassessment:
      input.evidence.structureBackfillReassessment === true,
    recurringHoldObservation:
      input.evidence.recurringHoldObservation === true,
    continuousStructureExitExecutionEligible:
      input.continuousStructureExitExecutionEligible,
    decision: {
      action: decision.action ?? null,
      state: decision.state ?? null,
      label: decision.label ?? null,
      opportunityId: decision.opportunityId ?? null,
      structureExitAuthorized: decision.structureExitAuthorized === true,
      evidenceRiskReductionAuthorized:
        decision.evidenceRiskReductionAuthorized === true,
      evidenceRiskExitAuthorized:
        decision.evidenceRiskExitAuthorized === true,
      evidenceRiskAssessment: decision.evidenceRiskAssessment ?? null,
    },
    nexusPositionStateMachine: {
      state: state.state ?? null,
      previousState: state.previousState ?? null,
      reason: state.reason ?? null,
      additionCandidate: state.additionCandidate ?? null,
    },
    strategyBranchFamily: input.evidence.strategyBranchFamily,
    postEntryContractTrendProfile: {
      status: contractTrend.status ?? null,
      baseHorizon: contractTrend.baseHorizon ?? null,
      effectiveHorizon: contractTrend.effectiveHorizon ?? null,
      swingExtensionEligible:
        contractTrend.swingExtensionEligible === true,
      swingExtensionState: contractTrend.swingExtensionState ?? null,
      swingExtensionEvidenceCertified:
        contractTrend.swingExtensionEvidenceCertified === true,
      swingExtensionEvidenceStatus:
        contractTrend.swingExtensionEvidenceStatus ?? null,
      currentGrossRoePercent:
        contractTrend.currentGrossRoePercent ?? null,
      estimatedRoundTripCostRoePercent:
        contractTrend.estimatedRoundTripCostRoePercent ?? null,
      currentNetRoePercent:
        contractTrend.currentNetRoePercent ?? null,
      observationHorizonState:
        contractTrend.observationHorizonState ?? null,
      maximumObservationMinutes:
        contractTrend.maximumObservationMinutes ?? null,
      shortCycleExitAuthorized:
        contractTrend.shortCycleExitAuthorized === true,
      reason: contractTrend.reason ?? null,
      horizon: contractTrend.effectiveHorizon ?? null,
      summary: contractTrend.reason ?? null,
    },
    postEntryTrendPath: {
      status: trendPath.status ?? null,
      summary: trendPath.summary ?? null,
    },
    entryThesisInvalidation: {
      status: thesis.status ?? null,
      structuralLevel: thesis.structuralLevel ?? null,
      invalidBoundary: thesis.invalidBoundary ?? null,
      consecutiveClosedMinutesBeyondBoundary:
        thesis.consecutiveClosedMinutesBeyondBoundary ?? null,
      requiredClosedMinutes: thesis.requiredClosedMinutes ?? null,
      reason: thesis.reason ?? null,
      summary: thesis.reason ?? null,
    },
    capitalEfficiencyWaveAssessment: {
      status: assessment.status ?? null,
      exitAuthorized: assessment.exitAuthorized === true,
      reason: assessment.reason ?? null,
      ruleVersion: assessment.ruleVersion ?? null,
    },
    executionBinding: {
      status: executionBinding.status ?? null,
      executor: executionBinding.executor ?? null,
      changesPositionImmediately:
        executionBinding.changesPositionImmediately === true,
      summary: executionBinding.summary ?? null,
    },
    durableStructureExitIntent:
      input.evidence.durableStructureExitIntent ?? null,
  };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}
