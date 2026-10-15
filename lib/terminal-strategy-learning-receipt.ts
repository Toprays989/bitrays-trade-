import {
  buildNexusLearningCycle,
  nexusLearningIdentityChain,
  nexusPreTradeEvidenceIntegrity,
  nexusPreTradeFactIds,
  type NexusLearningCycle,
} from "./nexus-learning-cycle.ts";
import {
  createNexusBrainMemoryCase,
  resolveNexusBrainMemoryMarketMeasures,
} from "./nexus-brain-collaboration-memory.ts";
import { buildNexusLearningMarketContext } from "./nexus-learning-market-context.ts";
import { nexusProbabilityContextFromEvidence } from
  "./nexus-probability-context.ts";

export type TerminalStrategyLearningReceiptInput = {
  brainKey: string;
  strategyId: number;
  configVersion: number;
  traceId: string;
  accountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  positionId: number;
  entryEvidence: Record<string, unknown>;
  entryDecisionHandoffJson?: string | null;
  entryAuthorizationMode: "CONFIRMED_EYE" | "EXPLORATION_PROBE";
  manualIntervention: boolean;
  checkpoints: Array<{
    minuteOffset: number;
    status: "OPEN" | "CLOSED" | "MISSED" | "DATA_STALE";
    brainKey?: string | null;
    configVersion?: number | null;
  }>;
  terminalObservationMinute: number | null;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  exactNetRoePercent?: number | null;
  grossRealizedPnlUsdt: number | null;
  reductionCount: number;
  exitReasons: string[];
  reductionAttributions?: string[];
  holdingDurationMinutes: number | null;
  netSettlementStatus: "READY" | "PENDING" | "UNAVAILABLE";
  completedAt: Date;
};

export type TerminalSemiAutoLearningReceiptInput = {
  brainKey: string;
  strategyId: number;
  configVersion: number;
  traceId: string;
  accountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  positionId: number;
  opportunityContext: Record<string, unknown>;
  entryDecisionHandoffJson?: string | null;
  manualIntervention: boolean;
  checkpoints: TerminalStrategyLearningReceiptInput["checkpoints"];
  terminalObservationMinute: number | null;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  exactNetRoePercent?: number | null;
  grossRealizedPnlUsdt: number | null;
  reductionCount: number;
  exitReasons: string[];
  reductionAttributions?: string[];
  holdingDurationMinutes: number | null;
  netSettlementStatus: "READY" | "PENDING" | "UNAVAILABLE";
  completedAt: Date;
};

/**
 * Persisted immediately when a strategy position reaches terminal state.
 *
 * This receipt is deliberately not parameter-learning eligible yet. It makes
 * the completed lifecycle visible to its owning brain without allowing a
 * lightweight settlement path to manufacture causal conclusions. The
 * background analyzer later upserts the same learning key with the complete
 * retrospective and, only then, may promote it to ELIGIBLE.
 */
export function buildTerminalStrategyLearningReceipt(
  input: TerminalStrategyLearningReceiptInput,
): NexusLearningCycle {
  const path = input.manualIntervention
    ? "MANUAL_INTERVENTION" as const
    : "ACTUAL_POSITION" as const;
  const base = buildNexusLearningCycle({
    brainKey: input.brainKey,
    strategyId: input.strategyId,
    configVersion: input.configVersion,
    traceId: input.traceId,
    path,
    orderSource: "STRATEGY",
    entryAuthorizationMode: input.entryAuthorizationMode,
    manualIntervention: input.manualIntervention,
    preTradeFactIds: nexusPreTradeFactIds(input.entryEvidence),
    preTradeEvidenceIntegrity: nexusPreTradeEvidenceIntegrity(
      input.entryEvidence,
    ),
    checkpoints: input.checkpoints,
    terminalStatus: "CLOSED",
    terminalObservationMinute: input.terminalObservationMinute,
    exactNetAvailable: input.exactNetAvailable,
    exactNetPnlUsdt: input.exactNetPnlUsdt,
    terminalOutcome: {
      grossRealizedPnlUsdt: input.grossRealizedPnlUsdt,
      reductionCount: input.reductionCount,
      exitReasons: input.exitReasons,
      reductionAttributions: input.reductionAttributions ?? [],
      holdingDurationMinutes: input.holdingDurationMinutes,
      netSettlementStatus: input.netSettlementStatus === "READY"
        ? null
        : input.netSettlementStatus,
    },
    identityChain: nexusLearningIdentityChain({
      traceId: input.traceId,
      configVersion: input.configVersion,
      entryEvidence: input.entryEvidence,
      entryDecisionHandoffJson: input.entryDecisionHandoffJson,
      positionId: input.positionId,
      exactNetAvailable: input.exactNetAvailable,
    }),
    sentinelContext: {
      accountId: input.accountId,
      symbol: input.symbol,
      positionSide: input.positionSide,
    },
  });
  const marketContext = buildNexusLearningMarketContext(input.entryEvidence);
  const probabilityContext = nexusProbabilityContextFromEvidence(
    input.entryEvidence,
  );
  const marketMeasures = resolveNexusBrainMemoryMarketMeasures(
    input.entryEvidence,
  );
  const blockedReasons = [...new Set([
    ...base.blockedReasons,
    "TERMINAL_ANALYSIS_PENDING",
  ])];
  const feedback = {
    ...base.feedback,
    brainSignal: base.fastLearning?.status === "UNAVAILABLE"
      ? "INCOMPLETE" as const
      : "NEUTRAL_OBSERVATION" as const,
    eyeCalibration: "UNAVAILABLE" as const,
    positiveEvidence: [],
    correctiveEvidence: [],
    aggregateLearningEligible: false,
    summary: base.fastLearning?.summary ??
      "策略订单已完整平仓；终局成交事实待后台补全，不改变订单或参数。",
  };
  const memoryCase = createNexusBrainMemoryCase({
    accountId: input.accountId,
    brainKey: input.brainKey,
    configVersion: input.configVersion,
    traceId: input.traceId,
    symbol: input.symbol,
    direction: input.positionSide,
    decisionPath: input.entryAuthorizationMode,
    marketContextKey: marketContext.key,
    probabilityDecisionPath:
      probabilityContext.decisionPath === "UNKNOWN"
        ? input.entryAuthorizationMode
        : probabilityContext.decisionPath,
    probabilityMarketContextKey: probabilityContext.marketContextKey,
    volatilityRegime: marketContext.volatility,
    liquidityRegime: marketContext.liquidity,
    liquidationDirection: String(
      input.entryEvidence.liquidationDirection ??
        input.entryEvidence.triggerDirection ??
        "UNKNOWN",
    ),
    position24hPercent: finiteOrNull(
      input.entryEvidence.position24hPercent,
    ),
    position72hPercent: finiteOrNull(
      input.entryEvidence.position72hPercent,
    ),
    relativeVolume: marketMeasures.relativeVolume,
    liquidationNotionalUsdt: marketMeasures.liquidationNotionalUsdt,
    exactNetPnlUsdt: input.exactNetAvailable
      ? input.exactNetPnlUsdt
      : null,
    exactNetRoePercent: input.exactNetAvailable
      ? input.exactNetRoePercent
      : null,
    observedPnlUsdt: base.fastLearning?.observedPnlUsdt ?? null,
    observedPnlBasis:
      base.fastLearning?.pnlBasis ?? "UNAVAILABLE",
    terminalExitReasons: base.fastLearning?.exitReasons ?? [],
    fastLearningStatus:
      base.fastLearning?.status ?? "UNAVAILABLE",
    eligibility: "INCOMPLETE",
    completedAt: input.completedAt,
  });
  return {
    ...base,
    eligibility: "INCOMPLETE",
    parameterLearningAllowed: false,
    probeLearningAllowed: false,
    feedback,
    blockedReasons,
    memoryCase,
  };
}

export function shouldFinalizeTerminalFastObservation(
  receipt: NexusLearningCycle,
) {
  return receipt.exactNetAvailable !== true ||
    receipt.missingCheckpointMinutes.length > 0;
}

export function buildTerminalSemiAutoLearningReceipt(
  input: TerminalSemiAutoLearningReceiptInput,
): NexusLearningCycle {
  const path = input.manualIntervention
    ? "MANUAL_INTERVENTION" as const
    : "ACTUAL_POSITION" as const;
  const analysisRecordId = Number(input.opportunityContext.analysisRecordId);
  const preTradeFactIds = Number.isInteger(analysisRecordId) &&
      analysisRecordId > 0
    ? [`semi-auto-analysis:${analysisRecordId}`]
    : [];
  const base = buildNexusLearningCycle({
    brainKey: input.brainKey,
    strategyId: input.strategyId,
    configVersion: input.configVersion,
    traceId: input.traceId,
    path,
    orderSource: "SEMI_AUTO",
    manualIntervention: input.manualIntervention,
    preTradeFactIds,
    checkpoints: input.checkpoints,
    terminalStatus: "CLOSED",
    terminalObservationMinute: input.terminalObservationMinute,
    exactNetAvailable: input.exactNetAvailable,
    exactNetPnlUsdt: input.exactNetPnlUsdt,
    terminalOutcome: {
      grossRealizedPnlUsdt: input.grossRealizedPnlUsdt,
      reductionCount: input.reductionCount,
      exitReasons: input.exitReasons,
      reductionAttributions: input.reductionAttributions ?? [],
      holdingDurationMinutes: input.holdingDurationMinutes,
      netSettlementStatus: input.netSettlementStatus === "READY"
        ? null
        : input.netSettlementStatus,
    },
    identityChain: nexusLearningIdentityChain({
      traceId: input.traceId,
      configVersion: input.configVersion,
      entryDecisionHandoffJson: input.entryDecisionHandoffJson,
      positionId: input.positionId,
      exactNetAvailable: input.exactNetAvailable,
    }),
  });
  const marketContext = buildNexusLearningMarketContext(
    input.opportunityContext,
  );
  const probabilityContext = nexusProbabilityContextFromEvidence(
    input.opportunityContext,
  );
  const marketMeasures = resolveNexusBrainMemoryMarketMeasures(
    input.opportunityContext,
  );
  const feedback = {
    ...base.feedback,
    brainSignal: base.fastLearning?.status === "UNAVAILABLE"
      ? "INCOMPLETE" as const
      : "NEUTRAL_OBSERVATION" as const,
    eyeCalibration: "UNAVAILABLE" as const,
    positiveEvidence: [],
    correctiveEvidence: [],
    aggregateLearningEligible: false,
    summary: base.fastLearning?.summary ??
      "半自动订单已平仓；终局结果作为所属大脑观察样本，不改变订单或参数。",
  };
  const memoryCase = createNexusBrainMemoryCase({
    accountId: input.accountId,
    brainKey: input.brainKey,
    configVersion: input.configVersion,
    traceId: input.traceId,
    symbol: input.symbol,
    direction: input.positionSide,
    decisionPath: "SEMI_AUTO",
    marketContextKey: marketContext.key,
    probabilityDecisionPath: probabilityContext.decisionPath,
    probabilityMarketContextKey: probabilityContext.marketContextKey,
    volatilityRegime: marketContext.volatility,
    liquidityRegime: marketContext.liquidity,
    liquidationDirection: String(
      input.opportunityContext.liquidationDirection ??
        input.opportunityContext.triggerDirection ??
        "UNKNOWN",
    ),
    position24hPercent: finiteOrNull(
      input.opportunityContext.position24hPercent,
    ),
    position72hPercent: finiteOrNull(
      input.opportunityContext.position72hPercent,
    ),
    relativeVolume: marketMeasures.relativeVolume,
    liquidationNotionalUsdt: marketMeasures.liquidationNotionalUsdt,
    exactNetPnlUsdt: input.exactNetAvailable
      ? input.exactNetPnlUsdt
      : null,
    exactNetRoePercent: input.exactNetAvailable
      ? input.exactNetRoePercent
      : null,
    observedPnlUsdt: base.fastLearning?.observedPnlUsdt ?? null,
    observedPnlBasis:
      base.fastLearning?.pnlBasis ?? "UNAVAILABLE",
    terminalExitReasons: base.fastLearning?.exitReasons ?? [],
    fastLearningStatus:
      base.fastLearning?.status ?? "UNAVAILABLE",
    eligibility: "OBSERVATION_ONLY",
    completedAt: input.completedAt,
  });
  return {
    ...base,
    eligibility: "OBSERVATION_ONLY",
    parameterLearningAllowed: false,
    probeLearningAllowed: false,
    feedback,
    memoryCase,
  };
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
