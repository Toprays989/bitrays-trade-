import type { NexusLearningIdentityChain } from "./nexus-mainline-contract.ts";

export const NEXUS_LEARNING_CYCLE_VERSION =
  "nexus-learning-cycle-v1" as const;

export const NEXUS_LEARNING_CHECKPOINT_MINUTES = [
  1, 3, 5, 15, 30, 60,
] as const;

export function nexusRequiredLearningCheckpointMinutes(
  terminalObservationMinute?: number | null,
) {
  const terminalMinute = Number(terminalObservationMinute);
  return Number.isFinite(terminalMinute) && terminalMinute >= 1
    ? NEXUS_LEARNING_CHECKPOINT_MINUTES.filter(
        (minute) => minute <= Math.floor(terminalMinute),
      )
    : [...NEXUS_LEARNING_CHECKPOINT_MINUTES];
}

export type NexusLearningPath =
  | "ACTUAL_POSITION"
  | "REJECTED_COUNTERFACTUAL"
  | "MANUAL_INTERVENTION";

export type NexusLearningEligibility =
  | "ELIGIBLE"
  | "OBSERVATION_ONLY"
  | "INCOMPLETE";

export type NexusLearningLane =
  | "CONFIRMED_STRATEGY"
  | "EXPLORATION_PROBE"
  | "OBSERVATION";

export type NexusFastLearningReceipt = {
  version: "nexus-fast-learning-v1";
  status: "LEARNED" | "PARTIAL" | "UNAVAILABLE";
  outcomeLearning: "READY" | "PARTIAL" | "UNAVAILABLE";
  exitExecutionLearning: "READY" | "PARTIAL" | "UNAVAILABLE";
  timingAttribution: "READY" | "PARTIAL" | "UNAVAILABLE";
  netSettlement: "READY" | "PENDING" | "UNAVAILABLE";
  parameterLearningReady: boolean;
  observedPnlUsdt: number | null;
  pnlBasis:
    | "NET_EXACT"
    | "GROSS_BEFORE_UNSETTLED_COSTS"
    | "EXIT_REASON_ONLY"
    | "UNAVAILABLE";
  outcome: "PROFIT" | "LOSS" | "FLAT" | "UNKNOWN";
  reductionCount: number;
  exitReasons: string[];
  reductionAttributions: string[];
  holdingDurationMinutes: number | null;
  missingOptionalEvidence: string[];
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

export type NexusPreTradeEvidenceIntegrity =
  | "ALIGNED"
  | "COMPLETE_WITH_RECEIPT_SKEW"
  | "INCOMPLETE"
  | "UNAVAILABLE";

export type NexusLearningFeedback = {
  version: "nexus-learning-feedback-v1";
  learningLane: NexusLearningLane;
  preTradeEvidenceIntegrity: NexusPreTradeEvidenceIntegrity;
  brainSignal:
    | "POSITIVE_REINFORCEMENT"
    | "CORRECTIVE_FEEDBACK"
    | "NEUTRAL_OBSERVATION"
    | "INCOMPLETE";
  eyeCalibration:
    | "EVIDENCE_VERIFIED"
    | "EVIDENCE_CONTRADICTED"
    | "EVIDENCE_MIXED"
    | "UNAVAILABLE";
  positiveEvidence: string[];
  correctiveEvidence: string[];
  aggregateLearningEligible: boolean;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

export type NexusDailyReinforcement = {
  version: "nexus-daily-reinforcement-v1";
  tradingDay: string;
  marketContextKey: string;
  learningLane: NexusLearningLane;
  eligibleCycles: number;
  exactNetPnlUsdt: number;
  positiveCycles: number;
  correctiveCycles: number;
  neutralCycles: number;
  eyeVerifiedCycles: number;
  eyeContradictedCycles: number;
  duplicateCyclesIgnored: number;
  winningCycles: number;
  losingCycles: number;
  flatCycles: number;
  winRate: number;
  averageNetPnlUsdt: number;
  averageWinUsdt: number;
  averageLossMagnitudeUsdt: number;
  payoffRatio: number | null;
  profitFactor: number | null;
  longestWinningStreak: number;
  longestLosingStreak: number;
  contextSampleMaxDrawdownUsdt: number;
  maximumDrawdownDeclineCycles: number;
  maximumDrawdownRecoveryCycles: number | null;
  maximumUnderwaterCycles: number;
  signal:
    | "POSITIVE_REINFORCEMENT"
    | "CORRECTIVE_FEEDBACK"
    | "MIXED_OBSERVATION"
    | "AWAITING_INDEPENDENT_SAMPLES";
  independentSampleThreshold: number;
  brainCalibrationReady: boolean;
  eyeCalibrationReady: boolean;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

export type NexusLearningCycle = {
  modelVersion: typeof NEXUS_LEARNING_CYCLE_VERSION;
  learningKey: string;
  brainKey: string;
  strategyId: number;
  configVersion: number;
  traceId: string;
  path: NexusLearningPath;
  orderSource: "STRATEGY" | "SEMI_AUTO" | "MANUAL";
  learningLane: NexusLearningLane;
  entryAuthorizationMode: "CONFIRMED_EYE" | "EXPLORATION_PROBE" | null;
  manualIntervention: boolean;
  preTradeFactsComplete: boolean;
  preTradeEvidenceIntegrity: NexusPreTradeEvidenceIntegrity;
  preTradeFactIds: string[];
  requiredCheckpointMinutes: number[];
  observedCheckpointMinutes: number[];
  missingCheckpointMinutes: number[];
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED";
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  eligibility: NexusLearningEligibility;
  parameterLearningAllowed: boolean;
  probeLearningAllowed: boolean;
  fastLearning?: NexusFastLearningReceipt;
  feedback: NexusLearningFeedback;
  sourceSampleKeys: string[];
  blockedReasons: string[];
  identities: NexusLearningIdentityChain;
  sentinelProbeFeedback?: {
    version: 1;
    factId: string;
    authority: "EYE_CALIBRATION_ONLY";
    orderAffecting: false;
    liveConfigMutationAllowed: false;
    exactNetAvailable: boolean;
    exactNetPnlUsdt: number | null;
    eyeCalibration: NexusLearningFeedback["eyeCalibration"];
    accountId: string | null;
    symbol: string | null;
    positionSide: "LONG" | "SHORT" | null;
    brainKey: string;
    configVersion: number;
  };
  retrospective?: import("./nexus-lifecycle-retrospective.ts").NexusLifecycleRetrospective;
  memoryCase?: import("./nexus-brain-collaboration-memory.ts").NexusBrainMemoryCase;
  collaborationMemory?: import("./nexus-brain-collaboration-memory.ts").NexusBrainCollaborationMemory;
};

export function nexusLearningKey(input: {
  brainKey: string;
  configVersion: number;
  traceId: string;
  path: NexusLearningPath;
}) {
  return [
    clean(input.brainKey),
    integer(input.configVersion),
    clean(input.traceId),
    input.path,
  ].join(":");
}

export function nexusLearningIdentityChain(input: {
  traceId: string;
  configVersion: number;
  entryEvidence?: unknown;
  entryDecisionHandoffJson?: string | null;
  positionId?: string | number | null;
  exactNetAvailable?: boolean;
}) {
  const traceId = clean(input.traceId);
  const configVersion = integer(input.configVersion);
  const evidence = objectRecord(input.entryEvidence);
  const handoff = parseObjectRecord(input.entryDecisionHandoffJson);
  const frozen = objectRecord(handoff.identities);
  const snapshot = objectRecord(evidence.nexusDecisionSnapshot);
  const coordinator = objectRecord(evidence.nexusExecutionCoordinator);
  const decisions = Array.isArray(coordinator.decisions)
    ? coordinator.decisions.map(objectRecord)
    : [];
  const matchingIntent = decisions.find(
    (item) => clean(item.traceId) === traceId,
  ) ?? decisions[0];
  return {
    factSnapshotId:
      optionalIdentity(frozen.factSnapshotId) ??
      optionalIdentity(snapshot.factSnapshotId),
    decisionId:
      optionalIdentity(frozen.decisionId) ??
      (traceId ? `nqd:${traceId}:v${configVersion}` : null),
    executionIntentId:
      optionalIdentity(frozen.executionIntentId) ??
      optionalIdentity(matchingIntent?.intentKey),
    positionId: optionalIdentity(input.positionId),
    settlementId:
      input.exactNetAvailable && traceId
        ? `nqsettle:${traceId}:v${configVersion}`
        : null,
  };
}

export function buildNexusLearningCycle(input: {
  brainKey: string;
  strategyId: number;
  configVersion: number;
  traceId: string;
  path: NexusLearningPath;
  orderSource: "STRATEGY" | "SEMI_AUTO" | "MANUAL";
  entryAuthorizationMode?: "CONFIRMED_EYE" | "EXPLORATION_PROBE" | null;
  manualIntervention?: boolean;
  preTradeFactIds?: Iterable<string>;
  preTradeEvidenceIntegrity?: NexusPreTradeEvidenceIntegrity | null;
  checkpoints: Array<{
    minuteOffset: number;
    status: "OPEN" | "CLOSED" | "MISSED" | "DATA_STALE";
    brainKey?: string | null;
    configVersion?: number | null;
  }>;
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED";
  terminalObservationMinute?: number | null;
  exactNetAvailable?: boolean;
  exactNetPnlUsdt?: number | null;
  terminalOutcome?: {
    grossRealizedPnlUsdt?: number | null;
    reductionCount?: number | null;
    exitReasons?: Iterable<string>;
    reductionAttributions?: Iterable<string>;
    holdingDurationMinutes?: number | null;
    netSettlementStatus?: "PENDING" | "UNAVAILABLE" | null;
  };
  retrospective?: import("./nexus-lifecycle-retrospective.ts").NexusLifecycleRetrospective;
  memoryCase?: import("./nexus-brain-collaboration-memory.ts").NexusBrainMemoryCase;
  identityChain?: {
    factSnapshotId?: string | null;
    decisionId?: string | null;
    executionIntentId?: string | null;
    positionId?: string | number | null;
    settlementId?: string | number | null;
  };
  sentinelContext?: {
    accountId?: string | null;
    symbol?: string | null;
    positionSide?: "LONG" | "SHORT" | null;
  };
  additionalSourceSampleKeys?: Iterable<string>;
}): NexusLearningCycle {
  const brainKey = clean(input.brainKey);
  const configVersion = integer(input.configVersion);
  const traceId = clean(input.traceId);
  const preTradeFactIds = [...new Set(
    [...(input.preTradeFactIds ?? [])]
      .map(clean)
      .filter(Boolean),
  )].sort();
  const preTradeEvidenceIntegrity = normalizeEvidenceIntegrity(
    input.preTradeEvidenceIntegrity,
  );
  const manualIntervention =
    Boolean(input.manualIntervention) ||
    input.orderSource === "MANUAL" ||
    input.path === "MANUAL_INTERVENTION";
  const entryAuthorizationMode = input.orderSource === "STRATEGY"
    ? input.entryAuthorizationMode === "EXPLORATION_PROBE"
      ? "EXPLORATION_PROBE" as const
      : "CONFIRMED_EYE" as const
    : null;
  const learningLane: NexusLearningLane = input.orderSource !== "STRATEGY"
    ? "OBSERVATION"
    : entryAuthorizationMode === "EXPLORATION_PROBE"
      ? "EXPLORATION_PROBE"
      : "CONFIRMED_STRATEGY";
  const versionMismatch = input.checkpoints.some(
    (sample) =>
      (sample.brainKey !== undefined &&
        sample.brainKey !== null &&
        clean(sample.brainKey) !== brainKey) ||
      (sample.configVersion !== undefined &&
        sample.configVersion !== null &&
        integer(sample.configVersion) !== configVersion),
  );
  const validCheckpointMinutes = new Set(
    input.checkpoints
      .filter(
        (sample) =>
          sample.status !== "DATA_STALE" &&
          (input.path === "REJECTED_COUNTERFACTUAL"
            ? sample.status === "MISSED"
            : sample.status === "OPEN" || sample.status === "CLOSED"),
      )
      .map((sample) => integer(sample.minuteOffset)),
  );
  const explicitTerminalObservationMinute =
    input.terminalStatus === "CLOSED" &&
      Number.isFinite(Number(input.terminalObservationMinute)) &&
      Number(input.terminalObservationMinute) >= 1
      ? Math.floor(Number(input.terminalObservationMinute))
      : null;
  const terminalCheckpointMinutes = input.checkpoints
    .filter((sample) => sample.status === "CLOSED")
    .map((sample) => integer(sample.minuteOffset))
    .filter((minute) => minute >= 1);
  const terminalObservationMinute =
    input.terminalStatus === "CLOSED"
      ? explicitTerminalObservationMinute ??
        (terminalCheckpointMinutes.length
          ? Math.max(...terminalCheckpointMinutes)
          : null)
      : null;
  // A position closed before a future checkpoint cannot produce that future
  // observation. Requiring it forever would make every short lifecycle
  // permanently incomplete and introduce survivorship bias toward long holds.
  const requiredCheckpointMinutes = nexusRequiredLearningCheckpointMinutes(
    terminalObservationMinute,
  );
  const observedCheckpointMinutes = requiredCheckpointMinutes.filter(
    (minute) => validCheckpointMinutes.has(minute),
  );
  const missingCheckpointMinutes = requiredCheckpointMinutes.filter(
    (minute) => !validCheckpointMinutes.has(minute),
  );
  const exactNetPnl = finiteOrNull(input.exactNetPnlUsdt);
  const exactNetAvailable =
    Boolean(input.exactNetAvailable) &&
    exactNetPnl !== null;
  const preTradeFactsComplete =
    preTradeFactIds.length > 0 &&
    preTradeEvidenceIntegrity !== "INCOMPLETE";
  const blockedReasons = [
    !brainKey ? "BRAIN_KEY_MISSING" : null,
    configVersion < 1 && input.orderSource === "STRATEGY"
      ? "CONFIG_VERSION_INVALID"
      : null,
    !traceId ? "TRACE_ID_MISSING" : null,
    versionMismatch ? "SAMPLE_VERSION_MISMATCH" : null,
    !preTradeFactsComplete ? "PRE_TRADE_FACTS_INCOMPLETE" : null,
    missingCheckpointMinutes.length
      ? `CHECKPOINTS_MISSING:${missingCheckpointMinutes.join(",")}`
      : null,
    input.terminalStatus === "OPEN" ? "POSITION_CYCLE_OPEN" : null,
    input.path === "ACTUAL_POSITION" && !exactNetAvailable
      ? "EXACT_NET_SETTLEMENT_INCOMPLETE"
      : null,
    manualIntervention ? "MANUAL_INTERVENTION_SEPARATE_PATH" : null,
    input.path === "REJECTED_COUNTERFACTUAL"
      ? "COUNTERFACTUAL_OBSERVATION_ONLY"
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  const structurallyComplete =
    Boolean(brainKey) &&
    Boolean(traceId) &&
    !versionMismatch &&
    preTradeFactsComplete &&
    missingCheckpointMinutes.length === 0 &&
    input.terminalStatus !== "OPEN";
  const parameterLearningAllowed =
    structurallyComplete &&
    input.path === "ACTUAL_POSITION" &&
    input.orderSource === "STRATEGY" &&
    learningLane === "CONFIRMED_STRATEGY" &&
    !manualIntervention &&
    exactNetAvailable;
  const probeLearningAllowed =
    structurallyComplete &&
    input.path === "ACTUAL_POSITION" &&
    input.orderSource === "STRATEGY" &&
    learningLane === "EXPLORATION_PROBE" &&
    !manualIntervention &&
    exactNetAvailable;
  const fastLearning = buildNexusFastLearningReceipt({
    terminalStatus: input.terminalStatus,
    exactNetAvailable,
    exactNetPnlUsdt: exactNetAvailable ? exactNetPnl : null,
    grossRealizedPnlUsdt:
      input.terminalOutcome?.grossRealizedPnlUsdt ?? null,
    reductionCount: input.terminalOutcome?.reductionCount ?? 0,
    exitReasons: input.terminalOutcome?.exitReasons ?? [],
    reductionAttributions:
      input.terminalOutcome?.reductionAttributions ?? [],
    holdingDurationMinutes:
      input.terminalOutcome?.holdingDurationMinutes ?? null,
    netSettlementStatus:
      input.terminalOutcome?.netSettlementStatus ?? null,
    requiredCheckpointMinutes,
    observedCheckpointMinutes,
    missingCheckpointMinutes,
    parameterLearningReady: parameterLearningAllowed,
  });
  const fastObservationReady =
    input.path === "ACTUAL_POSITION" &&
    input.terminalStatus === "CLOSED" &&
    fastLearning.status !== "UNAVAILABLE";
  const eligibility: NexusLearningEligibility = parameterLearningAllowed
    ? "ELIGIBLE"
    : probeLearningAllowed ||
        (structurallyComplete &&
        (input.path === "REJECTED_COUNTERFACTUAL" ||
          input.orderSource === "SEMI_AUTO" ||
          manualIntervention)) ||
        fastObservationReady
      ? "OBSERVATION_ONLY"
      : "INCOMPLETE";
  const sourceSampleKeys = observedCheckpointMinutes.map(
    (minute) =>
      `${brainKey}:${configVersion}:${traceId}:${input.path}:${minute}`,
  );
  if (input.terminalStatus !== "OPEN")
    sourceSampleKeys.push(
      `${brainKey}:${configVersion}:${traceId}:${input.path}:TERMINAL`,
    );
  sourceSampleKeys.push(
    ...[...new Set(
      [...(input.additionalSourceSampleKeys ?? [])]
        .map(clean)
        .filter(Boolean),
    )].filter((key) => !sourceSampleKeys.includes(key)),
  );
  const feedback = buildNexusLearningFeedback({
    learningLane,
    preTradeEvidenceIntegrity,
    parameterLearningAllowed,
    probeLearningAllowed,
    exactNetPnlUsdt: exactNetAvailable ? exactNetPnl : null,
    retrospective: input.retrospective,
  });
  const learningKey = nexusLearningKey({
    brainKey,
    configVersion,
    traceId,
    path: input.path,
  });
  const identities = {
    cycleId: traceId,
    factSnapshotId: optionalIdentity(input.identityChain?.factSnapshotId),
    decisionId: optionalIdentity(input.identityChain?.decisionId),
    executionIntentId: optionalIdentity(
      input.identityChain?.executionIntentId,
    ),
    positionId: optionalIdentity(input.identityChain?.positionId),
    settlementId: optionalIdentity(input.identityChain?.settlementId),
    learningSampleId: `nqls:${learningKey}`,
    configVersion,
  };
  return {
    modelVersion: NEXUS_LEARNING_CYCLE_VERSION,
    learningKey,
    brainKey,
    strategyId: integer(input.strategyId),
    configVersion,
    traceId,
    path: input.path,
    orderSource: input.orderSource,
    learningLane,
    entryAuthorizationMode,
    manualIntervention,
    preTradeFactsComplete,
    preTradeEvidenceIntegrity,
    preTradeFactIds,
    requiredCheckpointMinutes,
    observedCheckpointMinutes,
    missingCheckpointMinutes,
    terminalStatus: input.terminalStatus,
    exactNetAvailable,
    exactNetPnlUsdt: exactNetAvailable ? exactNetPnl : null,
    eligibility,
    parameterLearningAllowed,
    probeLearningAllowed,
    fastLearning,
    feedback,
    sourceSampleKeys,
    blockedReasons,
    identities,
    ...(learningLane === "EXPLORATION_PROBE"
      ? {
          sentinelProbeFeedback: {
            version: 1 as const,
            factId: `nqprobe:${learningKey}`,
            authority: "EYE_CALIBRATION_ONLY" as const,
            orderAffecting: false as const,
            liveConfigMutationAllowed: false as const,
            exactNetAvailable,
            exactNetPnlUsdt: exactNetAvailable ? exactNetPnl : null,
            eyeCalibration: feedback.eyeCalibration,
            accountId: optionalIdentity(input.sentinelContext?.accountId),
            symbol: optionalIdentity(input.sentinelContext?.symbol)?.toUpperCase() ?? null,
            positionSide: input.sentinelContext?.positionSide ?? null,
            brainKey,
            configVersion,
          },
        }
      : {}),
    ...(input.retrospective
      ? { retrospective: input.retrospective }
      : {}),
    ...(input.memoryCase ? { memoryCase: input.memoryCase } : {}),
  };
}

export function buildNexusFastLearningReceipt(input: {
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED";
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  grossRealizedPnlUsdt?: number | null;
  reductionCount?: number | null;
  exitReasons?: Iterable<string>;
  reductionAttributions?: Iterable<string>;
  holdingDurationMinutes?: number | null;
  netSettlementStatus?: "PENDING" | "UNAVAILABLE" | null;
  requiredCheckpointMinutes: number[];
  observedCheckpointMinutes: number[];
  missingCheckpointMinutes: number[];
  parameterLearningReady: boolean;
}): NexusFastLearningReceipt {
  const exactNetPnl = finiteOrNull(input.exactNetPnlUsdt);
  const grossRealizedPnl = finiteOrNull(input.grossRealizedPnlUsdt);
  const observedPnlUsdt = input.exactNetAvailable && exactNetPnl !== null
    ? exactNetPnl
    : grossRealizedPnl;
  const exitReasons = [...new Set(
    [...(input.exitReasons ?? [])].map(clean).filter(Boolean),
  )];
  const reductionAttributions = [...new Set(
    [...(input.reductionAttributions ?? [])].map(clean).filter(Boolean),
  )];
  const reductionCount = Math.max(0, integer(input.reductionCount));
  const terminalClosed = input.terminalStatus === "CLOSED";
  const outcomeLearning = terminalClosed && observedPnlUsdt !== null
    ? "READY" as const
    : terminalClosed && exitReasons.length
      ? "PARTIAL" as const
      : "UNAVAILABLE" as const;
  const exitExecutionLearning = terminalClosed &&
      reductionCount > 0 && exitReasons.length > 0
    ? "READY" as const
    : terminalClosed && (reductionCount > 0 || exitReasons.length > 0)
      ? "PARTIAL" as const
      : "UNAVAILABLE" as const;
  const timingAttribution = input.missingCheckpointMinutes.length === 0 &&
      input.requiredCheckpointMinutes.length > 0
    ? "READY" as const
    : input.observedCheckpointMinutes.length > 0
      ? "PARTIAL" as const
      : "UNAVAILABLE" as const;
  const netSettlement = input.exactNetAvailable && exactNetPnl !== null
    ? "READY" as const
    : input.netSettlementStatus === "UNAVAILABLE"
      ? "UNAVAILABLE" as const
      : terminalClosed && observedPnlUsdt !== null
        ? "PENDING" as const
        : "UNAVAILABLE" as const;
  const status = outcomeLearning === "READY" &&
      exitExecutionLearning === "READY"
    ? "LEARNED" as const
    : outcomeLearning !== "UNAVAILABLE" ||
        exitExecutionLearning !== "UNAVAILABLE"
      ? "PARTIAL" as const
      : "UNAVAILABLE" as const;
  const pnlBasis = input.exactNetAvailable && exactNetPnl !== null
    ? "NET_EXACT" as const
    : grossRealizedPnl !== null
      ? "GROSS_BEFORE_UNSETTLED_COSTS" as const
      : exitReasons.length
        ? "EXIT_REASON_ONLY" as const
        : "UNAVAILABLE" as const;
  const outcome = observedPnlUsdt === null
    ? "UNKNOWN" as const
    : observedPnlUsdt > 0
      ? "PROFIT" as const
      : observedPnlUsdt < 0
        ? "LOSS" as const
        : "FLAT" as const;
  const missingOptionalEvidence = [
    input.missingCheckpointMinutes.length
      ? `CHECKPOINTS:${input.missingCheckpointMinutes.join(",")}`
      : null,
    netSettlement === "PENDING" ? "EXACT_NET_SETTLEMENT" : null,
    netSettlement === "UNAVAILABLE" && terminalClosed
      ? "EXACT_NET_SETTLEMENT_UNAVAILABLE"
      : null,
  ].filter((item): item is string => Boolean(item));
  const resultLabel = outcome === "PROFIT"
    ? "盈利"
    : outcome === "LOSS"
      ? "亏损"
      : outcome === "FLAT"
        ? "持平"
        : "结果待补";
  return {
    version: "nexus-fast-learning-v1",
    status,
    outcomeLearning,
    exitExecutionLearning,
    timingAttribution,
    netSettlement,
    parameterLearningReady: input.parameterLearningReady,
    observedPnlUsdt,
    pnlBasis,
    outcome,
    reductionCount,
    exitReasons,
    reductionAttributions,
    holdingDurationMinutes: finiteOrNull(input.holdingDurationMinutes),
    missingOptionalEvidence,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    summary: status === "UNAVAILABLE"
      ? "尚无真实平仓结果可吸收；等待终局成交事实。"
      : `已吸收真实平仓${resultLabel}、减仓原因和持仓时长；${
        netSettlement === "READY"
          ? "费用后净收益已确认"
          : netSettlement === "PENDING"
            ? "费用后净收益异步补齐中"
            : "费用后净收益不可补齐"
      }，缺失检查点只限制对应时机归因，不阻塞结果学习，也不自动修改实盘参数。`,
  };
}

export function attachNexusBrainCollaborationMemory(
  cycle: NexusLearningCycle,
  collaborationMemory:
    import("./nexus-brain-collaboration-memory.ts").NexusBrainCollaborationMemory,
): NexusLearningCycle {
  return { ...cycle, collaborationMemory };
}

export function buildNexusLearningFeedback(input: {
  learningLane?: NexusLearningLane;
  preTradeEvidenceIntegrity?: NexusPreTradeEvidenceIntegrity | null;
  parameterLearningAllowed: boolean;
  probeLearningAllowed?: boolean;
  exactNetPnlUsdt: number | null;
  retrospective?: import("./nexus-lifecycle-retrospective.ts").NexusLifecycleRetrospective;
}): NexusLearningFeedback {
  const learningLane = input.learningLane ?? "CONFIRMED_STRATEGY";
  const preTradeEvidenceIntegrity = normalizeEvidenceIntegrity(
    input.preTradeEvidenceIntegrity,
  );
  const retrospective = input.retrospective;
  const exactNetPnlUsdt = Number(input.exactNetPnlUsdt);
  const causalReady =
    (input.parameterLearningAllowed || input.probeLearningAllowed === true) &&
    retrospective?.status === "COMPLETE" &&
    retrospective.causalAttributionReady === true &&
    preTradeEvidenceIntegrity !== "INCOMPLETE" &&
    Number.isFinite(exactNetPnlUsdt);
  if (!causalReady)
    return {
      version: "nexus-learning-feedback-v1",
      learningLane,
      preTradeEvidenceIntegrity,
      brainSignal: "INCOMPLETE",
      eyeCalibration: "UNAVAILABLE",
      positiveEvidence: [],
      correctiveEvidence: [],
      aggregateLearningEligible: false,
      orderAffecting: false,
      liveConfigMutationAllowed: false,
      summary:
        "完整周期、精确净收益或因果证据尚未闭合；只保留观察，不向大脑强化，也不校准眼睛。",
    };

  const hypotheses = retrospective.hypotheses;
  const latestExitCheckpointByAction = new Map<
    string,
    NonNullable<
      typeof retrospective.exitCounterfactual
    >["checkpoints"][number]
  >();
  for (const checkpoint of retrospective.exitCounterfactual?.checkpoints ?? []) {
    const key = checkpoint.reductionId !== null
      ? `reduction:${checkpoint.reductionId}`
      : `legacy:${checkpoint.positionId ?? "unknown"}:${checkpoint.exitAtMs ?? 0}`;
    const current = latestExitCheckpointByAction.get(key);
    if (
      !current ||
      checkpoint.horizonMinutes > current.horizonMinutes ||
      (checkpoint.horizonMinutes === current.horizonMinutes &&
        (checkpoint.labelAvailableAtMs ?? 0) >
          (current.labelAvailableAtMs ?? 0))
    ) latestExitCheckpointByAction.set(key, checkpoint);
  }
  const exitPositiveEvidence = [...latestExitCheckpointByAction.values()]
    .filter((checkpoint) =>
      checkpoint.exitReason && checkpoint.pathOutcome === "EXIT_CONFIRMED"
    )
    .map((checkpoint) => `${checkpoint.exitReason}_PATH_CONFIRMED`);
  const exitCorrectiveEvidence = [...latestExitCheckpointByAction.values()]
    .flatMap((checkpoint) => [
      checkpoint.exitReason && checkpoint.pathOutcome === "EXIT_EARLY"
        ? `${checkpoint.exitReason}_PATH_EARLY`
        : null,
      checkpoint.exitReason && checkpoint.executionTiming === "LATE"
        ? `${checkpoint.exitReason}_EXECUTION_LATE`
        : null,
    ])
    .filter((item): item is string => Boolean(item));
  const positiveEvidence = [
    exactNetPnlUsdt > 0 ? "EXACT_NET_PROFIT" : null,
    hypotheses.waveDirection === "SUPPORTED"
      ? "WAVE_DIRECTION_SUPPORTED"
      : null,
    hypotheses.entryTiming === "SUPPORTED"
      ? "ENTRY_TIMING_SUPPORTED"
      : null,
    hypotheses.positionManagement === "SUPPORTED"
      ? "POSITION_MANAGEMENT_SUPPORTED"
      : null,
    hypotheses.entryVolumeTiming === "SUPPORTED"
      ? "ENTRY_VOLUME_TIMING_SUPPORTED"
      : null,
    retrospective?.exitCounterfactual?.latestClassification ===
        "EXIT_CONFIRMED"
      ? "EXIT_TIMING_CONFIRMED"
      : null,
    ...exitPositiveEvidence,
  ].filter((item): item is string => Boolean(item));
  const correctiveEvidence = [
    exactNetPnlUsdt < 0 ? "EXACT_NET_LOSS" : null,
    hypotheses.waveDirection === "CONTRADICTED"
      ? "WAVE_DIRECTION_CONTRADICTED"
      : null,
    hypotheses.entryTiming === "TOO_EARLY"
      ? "ENTRY_TIMING_TOO_EARLY"
      : null,
    hypotheses.entryTiming === "CHASED" ? "ENTRY_TIMING_CHASED" : null,
    hypotheses.positionManagement === "CONTRADICTED"
      ? "POSITION_MANAGEMENT_CONTRADICTED"
      : null,
    retrospective?.exitCounterfactual?.latestClassification === "EXIT_EARLY"
      ? "EXIT_TIMING_EARLY"
      : null,
    retrospective?.exitCounterfactual?.latestClassification === "EXIT_LATE"
      ? "EXIT_TIMING_LATE"
      : null,
    ...exitCorrectiveEvidence,
    hypotheses.fundingVolume === "RISK_WARNED"
      ? "FUNDING_VOLUME_RISK_WARNED"
      : null,
  ].filter((item): item is string => Boolean(item));
  const brainSignal =
    exactNetPnlUsdt > 0 && correctiveEvidence.length === 0
      ? "POSITIVE_REINFORCEMENT" as const
      : exactNetPnlUsdt < 0 || correctiveEvidence.length > 0
        ? "CORRECTIVE_FEEDBACK" as const
        : "NEUTRAL_OBSERVATION" as const;
  const eyeCalibration =
    hypotheses.waveDirection === "SUPPORTED" &&
      hypotheses.entryVolumeTiming === "SUPPORTED"
      ? "EVIDENCE_VERIFIED" as const
      : hypotheses.waveDirection === "CONTRADICTED"
        ? "EVIDENCE_CONTRADICTED" as const
        : "EVIDENCE_MIXED" as const;
  const integrityNote = preTradeEvidenceIntegrity ===
      "COMPLETE_WITH_RECEIPT_SKEW"
    ? "入场事实完整，但来自不同缓存批次，已单独保留该数据质量标签；"
    : preTradeEvidenceIntegrity === "ALIGNED"
      ? "入场事实同批对齐；"
      : "历史样本未记录眼睛批次质量；";
  return {
    version: "nexus-learning-feedback-v1",
    learningLane,
    preTradeEvidenceIntegrity,
    brainSignal,
    eyeCalibration,
    positiveEvidence,
    correctiveEvidence,
    aggregateLearningEligible: true,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    summary:
      integrityNote +
      (brainSignal === "POSITIVE_REINFORCEMENT"
        ? learningLane === "EXPLORATION_PROBE"
          ? `探针完整周期净盈利 ${exactNetPnlUsdt.toFixed(4)} USDT，且当前证据没有出现反证；仅进入探针验证记忆并校准眼睛，不并入正常策略参数样本。`
          : `完整周期净盈利 ${exactNetPnlUsdt.toFixed(4)} USDT，且当前证据没有出现反证；作为大脑正向样本并校准眼睛可靠性。`
        : brainSignal === "CORRECTIVE_FEEDBACK"
          ? `${learningLane === "EXPLORATION_PROBE" ? "探针" : ""}完整周期净结果 ${exactNetPnlUsdt.toFixed(4)} USDT，发现 ${correctiveEvidence.join("、") || "结果反证"}；进入纠偏样本，不把盈利或亏损简单倒灌成方向结论。`
          : `完整周期净结果 ${exactNetPnlUsdt.toFixed(4)} USDT，但证据结论混合；保留中性样本，等待独立周期验证。`),
  };
}

export function buildNexusDailyReinforcement(input: {
  samples: Array<{
    cycle: NexusLearningCycle;
    observedAt: Date | string | number;
    marketContextKey?: string | null;
  }>;
  independentSampleThreshold?: number;
}) {
  const independentSampleThreshold = Math.max(
    2,
    integer(input.independentSampleThreshold ?? 5),
  );
  const groups = new Map<string, {
    samples: typeof input.samples;
    learningKeys: Set<string>;
    duplicateCyclesIgnored: number;
  }>();
  for (const sample of input.samples) {
    if (!sample.cycle.feedback.aggregateLearningEligible) continue;
    const tradingDay = shanghaiTradingDay(sample.observedAt);
    if (!tradingDay) continue;
    const marketContextKey = clean(sample.marketContextKey) ||
      "MARKET_CONTEXT_UNAVAILABLE";
    const key = `${tradingDay}:${sample.cycle.learningLane}:${marketContextKey}`;
    const group = groups.get(key) ?? {
      samples: [],
      learningKeys: new Set<string>(),
      duplicateCyclesIgnored: 0,
    };
    const learningKey = clean(sample.cycle.learningKey) || [
      sample.cycle.brainKey,
      sample.cycle.configVersion,
      sample.cycle.traceId,
      sample.cycle.path,
    ].join(":");
    if (group.learningKeys.has(learningKey)) {
      group.duplicateCyclesIgnored += 1;
      groups.set(key, group);
      continue;
    }
    group.learningKeys.add(learningKey);
    group.samples.push(sample);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]): NexusDailyReinforcement => {
      const { samples, duplicateCyclesIgnored } = group;
      const firstSplit = key.indexOf(":");
      const secondSplit = key.indexOf(":", firstSplit + 1);
      const tradingDay = key.slice(0, firstSplit);
      const learningLane = key.slice(
        firstSplit + 1,
        secondSplit,
      ) as NexusLearningLane;
      const marketContextKey = key.slice(secondSplit + 1);
      const eligibleCycles = samples.length;
      const exactNetPnlUsdt = rounded(
        samples.reduce(
          (total, sample) =>
            total + (Number(sample.cycle.exactNetPnlUsdt) || 0),
          0,
        ),
      );
      const countBrain = (signal: NexusLearningFeedback["brainSignal"]) =>
        samples.filter(
          (sample) => sample.cycle.feedback.brainSignal === signal,
        ).length;
      const countEye = (
        calibration: NexusLearningFeedback["eyeCalibration"],
      ) =>
        samples.filter(
          (sample) => sample.cycle.feedback.eyeCalibration === calibration,
        ).length;
      const positiveCycles = countBrain("POSITIVE_REINFORCEMENT");
      const correctiveCycles = countBrain("CORRECTIVE_FEEDBACK");
      const neutralCycles = countBrain("NEUTRAL_OBSERVATION");
      const eyeVerifiedCycles = countEye("EVIDENCE_VERIFIED");
      const eyeContradictedCycles = countEye("EVIDENCE_CONTRADICTED");
      const orderedOutcomes = [...samples]
        .sort(
          (left, right) =>
            timestamp(left.observedAt) - timestamp(right.observedAt),
        )
        .map((sample) => Number(sample.cycle.exactNetPnlUsdt) || 0);
      const sequenceMetrics = outcomeSequenceMetrics(orderedOutcomes);
      const longestWinningStreak = longestOutcomeStreak(
        orderedOutcomes,
        (value) => value > 0,
      );
      const longestLosingStreak = longestOutcomeStreak(
        orderedOutcomes,
        (value) => value < 0,
      );
      const contextSampleMaxDrawdownUsdt = rounded(
        maximumSequenceDrawdown(orderedOutcomes),
      );
      const enoughSamples = eligibleCycles >= independentSampleThreshold;
      const signal = !enoughSamples
        ? "AWAITING_INDEPENDENT_SAMPLES" as const
        : exactNetPnlUsdt > 0 &&
            positiveCycles > correctiveCycles &&
            eyeVerifiedCycles >= eyeContradictedCycles
          ? "POSITIVE_REINFORCEMENT" as const
          : exactNetPnlUsdt < 0 ||
              correctiveCycles > positiveCycles ||
              eyeContradictedCycles > eyeVerifiedCycles
            ? "CORRECTIVE_FEEDBACK" as const
            : "MIXED_OBSERVATION" as const;
      const brainCalibrationReady =
        enoughSamples && signal !== "MIXED_OBSERVATION";
      const eyeCalibrationReady =
        enoughSamples && eyeVerifiedCycles !== eyeContradictedCycles;
      return {
        version: "nexus-daily-reinforcement-v1",
        tradingDay,
        marketContextKey,
        learningLane,
        eligibleCycles,
        exactNetPnlUsdt,
        positiveCycles,
        correctiveCycles,
        neutralCycles,
        eyeVerifiedCycles,
        eyeContradictedCycles,
        duplicateCyclesIgnored,
        winningCycles: sequenceMetrics.winningCycles,
        losingCycles: sequenceMetrics.losingCycles,
        flatCycles: sequenceMetrics.flatCycles,
        winRate: sequenceMetrics.winRate,
        averageNetPnlUsdt: sequenceMetrics.averageNetPnlUsdt,
        averageWinUsdt: sequenceMetrics.averageWinUsdt,
        averageLossMagnitudeUsdt:
          sequenceMetrics.averageLossMagnitudeUsdt,
        payoffRatio: sequenceMetrics.payoffRatio,
        profitFactor: sequenceMetrics.profitFactor,
        longestWinningStreak,
        longestLosingStreak,
        contextSampleMaxDrawdownUsdt,
        maximumDrawdownDeclineCycles:
          sequenceMetrics.maximumDrawdownDeclineCycles,
        maximumDrawdownRecoveryCycles:
          sequenceMetrics.maximumDrawdownRecoveryCycles,
        maximumUnderwaterCycles: sequenceMetrics.maximumUnderwaterCycles,
        signal,
        independentSampleThreshold,
        brainCalibrationReady,
        eyeCalibrationReady,
        orderAffecting: false,
        liveConfigMutationAllowed: false,
        summary: !enoughSamples
          ? `${tradingDay} · ${learningLane === "EXPLORATION_PROBE" ? "探针" : "正常策略"} · ${marketContextKey} 已形成 ${eligibleCycles}/${independentSampleThreshold} 个独立完整周期；胜率 ${percent(sequenceMetrics.winRate)}、单周期期望 ${sequenceMetrics.averageNetPnlUsdt.toFixed(4)} USDT，最长连赢 ${longestWinningStreak}、连亏 ${longestLosingStreak}，样本序列最大回撤 ${contextSampleMaxDrawdownUsdt.toFixed(4)} USDT。继续采集，不提前强化。`
          : signal === "POSITIVE_REINFORCEMENT"
            ? `${tradingDay} · ${marketContextKey} 净结果 ${exactNetPnlUsdt.toFixed(4)} USDT，胜率 ${percent(sequenceMetrics.winRate)}、单周期期望 ${sequenceMetrics.averageNetPnlUsdt.toFixed(4)} USDT，正反馈 ${positiveCycles}、纠偏 ${correctiveCycles}，最长连赢 ${longestWinningStreak}、连亏 ${longestLosingStreak}，样本序列最大回撤 ${contextSampleMaxDrawdownUsdt.toFixed(4)} USDT；允许进入大脑正向校准和眼睛证据可靠性记忆。`
            : signal === "CORRECTIVE_FEEDBACK"
              ? `${tradingDay} · ${marketContextKey} 净结果 ${exactNetPnlUsdt.toFixed(4)} USDT，胜率 ${percent(sequenceMetrics.winRate)}、单周期期望 ${sequenceMetrics.averageNetPnlUsdt.toFixed(4)} USDT，正反馈 ${positiveCycles}、纠偏 ${correctiveCycles}，最长连赢 ${longestWinningStreak}、连亏 ${longestLosingStreak}，样本序列最大回撤 ${contextSampleMaxDrawdownUsdt.toFixed(4)} USDT；进入当日纠偏，不沿用该环境下的错误判断。`
              : `${tradingDay} · ${marketContextKey} 的净结果与证据方向混合；只保留观察，不形成正负强化。`,
      };
    })
    .sort(
      (left, right) =>
        right.tradingDay.localeCompare(left.tradingDay) ||
        right.eligibleCycles - left.eligibleCycles ||
        left.marketContextKey.localeCompare(right.marketContextKey),
    );
}

function outcomeSequenceMetrics(values: number[]) {
  const winning = values.filter((value) => value > 0);
  const losing = values.filter((value) => value < 0);
  const flatCycles = values.length - winning.length - losing.length;
  const grossProfit = winning.reduce((total, value) => total + value, 0);
  const grossLossMagnitude = losing.reduce(
    (total, value) => total + Math.abs(value),
    0,
  );
  const decisiveCycles = winning.length + losing.length;
  const averageWinUsdt = winning.length ? grossProfit / winning.length : 0;
  const averageLossMagnitudeUsdt = losing.length
    ? grossLossMagnitude / losing.length
    : 0;
  const equityCurve = [0];
  for (const value of values)
    equityCurve.push(equityCurve[equityCurve.length - 1] + value);

  let peakIndex = 0;
  let maximumDrawdown = 0;
  let maximumDrawdownPeakIndex = 0;
  let maximumDrawdownTroughIndex = 0;
  let underwaterStartIndex: number | null = null;
  let maximumUnderwaterCycles = 0;
  for (let index = 1; index < equityCurve.length; index += 1) {
    if (equityCurve[index] >= equityCurve[peakIndex]) {
      if (underwaterStartIndex !== null)
        maximumUnderwaterCycles = Math.max(
          maximumUnderwaterCycles,
          index - underwaterStartIndex,
        );
      peakIndex = index;
      underwaterStartIndex = null;
      continue;
    }
    if (underwaterStartIndex === null) underwaterStartIndex = peakIndex;
    maximumUnderwaterCycles = Math.max(
      maximumUnderwaterCycles,
      index - underwaterStartIndex,
    );
    const drawdown = equityCurve[peakIndex] - equityCurve[index];
    if (drawdown > maximumDrawdown) {
      maximumDrawdown = drawdown;
      maximumDrawdownPeakIndex = peakIndex;
      maximumDrawdownTroughIndex = index;
    }
  }
  const recoveryIndex = maximumDrawdown > 0
    ? equityCurve.findIndex(
        (equity, index) =>
          index > maximumDrawdownTroughIndex &&
          equity >= equityCurve[maximumDrawdownPeakIndex],
      )
    : 0;

  return {
    winningCycles: winning.length,
    losingCycles: losing.length,
    flatCycles,
    winRate: rounded(decisiveCycles ? winning.length / decisiveCycles : 0),
    averageNetPnlUsdt: values.length
      ? rounded(
          values.reduce((total, value) => total + value, 0) / values.length,
        )
      : 0,
    averageWinUsdt: rounded(averageWinUsdt),
    averageLossMagnitudeUsdt: rounded(averageLossMagnitudeUsdt),
    payoffRatio: averageLossMagnitudeUsdt > 0
      ? rounded(averageWinUsdt / averageLossMagnitudeUsdt)
      : null,
    profitFactor: grossLossMagnitude > 0
      ? rounded(grossProfit / grossLossMagnitude)
      : null,
    maximumDrawdownDeclineCycles:
      maximumDrawdownTroughIndex - maximumDrawdownPeakIndex,
    maximumDrawdownRecoveryCycles:
      recoveryIndex > maximumDrawdownTroughIndex
        ? recoveryIndex - maximumDrawdownTroughIndex
        : null,
    maximumUnderwaterCycles,
  };
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function rounded(value: number, digits = 8) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function longestOutcomeStreak(
  values: number[],
  matches: (value: number) => boolean,
) {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    current = matches(value) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function maximumSequenceDrawdown(values: number[]) {
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  return maximumDrawdown;
}

function timestamp(value: Date | string | number) {
  const parsed = value instanceof Date
    ? value.getTime()
    : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildNexusDraftSuggestionProposal(input: {
  cycle: NexusLearningCycle;
  parameterName: string;
  currentValue: unknown;
  suggestedValue: unknown;
  currentDraftVersion: number;
}) {
  if (!input.cycle.parameterLearningAllowed)
    return {
      allowed: false,
      reason: "LEARNING_CYCLE_NOT_ELIGIBLE" as const,
      proposal: null,
    };
  return {
    allowed: true,
    reason: "DRAFT_PROPOSAL_READY" as const,
    proposal: {
      proposalMode: "DRAFT_ONLY" as const,
      brainKey: input.cycle.brainKey,
      sourceConfigVersion: input.cycle.configVersion,
      targetDraftVersion: Math.max(
        input.cycle.configVersion,
        integer(input.currentDraftVersion),
      ) + 1,
      parameterName: clean(input.parameterName),
      currentValue: input.currentValue,
      suggestedValue: input.suggestedValue,
      sourceLearningKeys: [input.cycle.learningKey],
      sourceLearningSampleId: input.cycle.identities.learningSampleId,
      sourceSampleKeys: input.cycle.sourceSampleKeys,
      liveConfigMutationAllowed: false as const,
      automaticPublishAllowed: false as const,
    },
  };
}

export function nexusPreTradeFactIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const candidateCollections = [
    record.nexusMarketFactsShadow,
    record.marketFacts,
    record.preTradeFacts,
  ];
  const ids: string[] = [];
  for (const collection of candidateCollections) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (typeof item === "string") ids.push(item);
      else if (item && typeof item === "object" && !Array.isArray(item)) {
        const id = (item as Record<string, unknown>).id;
        if (typeof id === "string") ids.push(id);
      }
    }
  }
  const brainShadow =
    record.nexusBrainShadow &&
    typeof record.nexusBrainShadow === "object" &&
    !Array.isArray(record.nexusBrainShadow)
      ? record.nexusBrainShadow as Record<string, unknown>
      : {};
  if (typeof brainShadow.triggerFactId === "string")
    ids.push(brainShadow.triggerFactId);
  if (Array.isArray(brainShadow.confirmationFactIds))
    ids.push(
      ...brainShadow.confirmationFactIds.filter(
        (id): id is string => typeof id === "string",
      ),
    );
  return [...new Set(ids.map(clean).filter(Boolean))].sort();
}

export function nexusPreTradeEvidenceIntegrity(
  value: unknown,
): NexusPreTradeEvidenceIntegrity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "UNAVAILABLE";
  const record = value as Record<string, unknown>;
  const snapshot =
    record.nexusDecisionSnapshot &&
      typeof record.nexusDecisionSnapshot === "object" &&
      !Array.isArray(record.nexusDecisionSnapshot)
      ? record.nexusDecisionSnapshot as Record<string, unknown>
      : {};
  return normalizeEvidenceIntegrity(snapshot.integrity);
}

function normalizeEvidenceIntegrity(
  value: unknown,
): NexusPreTradeEvidenceIntegrity {
  return value === "ALIGNED" ||
      value === "COMPLETE_WITH_RECEIPT_SKEW" ||
      value === "INCOMPLETE"
    ? value
    : "UNAVAILABLE";
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function optionalIdentity(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseObjectRecord(value: string | null | undefined) {
  try {
    return objectRecord(JSON.parse(value ?? "{}"));
  } catch {
    return {};
  }
}

function integer(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) ? number : 0;
}

function shanghaiTradingDay(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
}
