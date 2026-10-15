import { and, desc, eq, like } from "drizzle-orm";
import { getDb } from "../db";
import {
  strategies,
  strategyConfigValidations,
  strategyExecutionEventRollups,
  strategyLearningCycles,
  strategyParameterSuggestions,
} from "../db/schema";
import { normalizeLiquidationFactorPolicy } from "./liquidation-derived-factors";
import {
  evaluateLiquidationFactorLearning,
  type LiquidationFactorLearningCycle,
  type LiquidationFactorLearningObservation,
  type LiquidationFactorLearningSummary,
} from "./liquidation-factor-learning";
import { resolveLiquidationTrendConfig } from "./liquidation-trend-config";

export const LIQUIDATION_FACTOR_SUGGESTION_PARAMETER =
  "liquidationFactors.mode" as const;

export async function loadLiquidationFactorLearningSummary(input: {
  strategyId: number;
}) {
  const db = getDb();
  const [strategy] = await db
    .select()
    .from(strategies)
    .where(eq(strategies.id, input.strategyId))
    .limit(1);
  if (!strategy) return null;
  const resolved = resolveLiquidationTrendConfig(safeParse(strategy.configJson));
  if (!resolved.config) return null;
  const policy = normalizeLiquidationFactorPolicy(
    resolved.config.liquidationFactors,
    {
      minimumEvents: resolved.config.trigger.minClusterEvents ?? 3,
      minimumAmountUsdt: resolved.config.trigger.minLiquidationNotionalUsdt,
      observationWindowSeconds:
        resolved.config.trigger.maxClusterSpanSeconds ?? 120,
      minimumVolumeRatio: resolved.config.trend.volumeRatio3m,
    },
  );
  const [eventRows, cycleRows, validationRows] = await Promise.all([
    db
      .select({
        traceId: strategyExecutionEventRollups.traceId,
        eventType: strategyExecutionEventRollups.eventType,
        observedAt: strategyExecutionEventRollups.lastEventAt,
      })
      .from(strategyExecutionEventRollups)
      .where(and(
        eq(strategyExecutionEventRollups.strategyId, strategy.id),
        eq(strategyExecutionEventRollups.configVersion, strategy.configVersion),
        like(
          strategyExecutionEventRollups.eventType,
          "NEXUS_LIQUIDATION_FACTORS:%",
        ),
      ))
      .orderBy(desc(strategyExecutionEventRollups.lastEventAt))
      .limit(2_000),
    db
      .select({
        traceId: strategyLearningCycles.traceId,
        terminalStatus: strategyLearningCycles.terminalStatus,
        exactNetAvailable: strategyLearningCycles.exactNetAvailable,
        exactNetPnlUsdt: strategyLearningCycles.exactNetPnlUsdt,
        eligibility: strategyLearningCycles.eligibility,
        manualIntervention: strategyLearningCycles.manualIntervention,
        updatedAt: strategyLearningCycles.updatedAt,
      })
      .from(strategyLearningCycles)
      .where(and(
        eq(strategyLearningCycles.strategyId, strategy.id),
        eq(strategyLearningCycles.configVersion, strategy.configVersion),
      ))
      .orderBy(desc(strategyLearningCycles.updatedAt))
      .limit(2_000),
    db
      .select()
      .from(strategyConfigValidations)
      .where(eq(strategyConfigValidations.strategyId, strategy.id))
      .orderBy(desc(strategyConfigValidations.updatedAt))
      .limit(1),
  ]);
  const observations: LiquidationFactorLearningObservation[] = eventRows.map(
    (row) => ({
      traceId: row.traceId,
      verdict: row.eventType.slice("NEXUS_LIQUIDATION_FACTORS:".length),
      observedAtMs: row.observedAt.getTime(),
    }),
  );
  const cycles: LiquidationFactorLearningCycle[] = cycleRows.map((row) => ({
    traceId: row.traceId,
    terminalStatus: row.terminalStatus,
    exactNetAvailable: row.exactNetAvailable,
    exactNetPnlUsdt: row.exactNetPnlUsdt,
    eligibility: row.eligibility,
    manualIntervention: row.manualIntervention,
    updatedAtMs: row.updatedAt.getTime(),
  }));
  return {
    strategy,
    config: resolved.config,
    policy,
    summary: evaluateLiquidationFactorLearning({
      mode: policy.mode,
      automaticModeSwitch: policy.automaticModeSwitch,
      configVersion: strategy.configVersion,
      targetEpisodes: policy.learningTargetEpisodes,
      minimumExactCycles: policy.learningMinimumExactCycles,
      observations,
      cycles,
      hasUnpublishedDraft: strategy.draftVersion > strategy.publishedVersion,
      validationStatus: validationRows[0]?.status ?? null,
    }),
  };
}

export async function reconcileLiquidationFactorLearningCandidate(input: {
  strategyId: number;
}) {
  const loaded = await loadLiquidationFactorLearningSummary(input);
  if (!loaded) return null;
  const { strategy, summary } = loaded;
  if (!summary.candidateProposalPending)
    return { summary, changed: false };
  const db = getDb();
  const [existing] = await db
    .select()
    .from(strategyParameterSuggestions)
    .where(and(
      eq(strategyParameterSuggestions.strategyId, strategy.id),
      eq(strategyParameterSuggestions.configVersion, strategy.configVersion),
      eq(
        strategyParameterSuggestions.parameterName,
        LIQUIDATION_FACTOR_SUGGESTION_PARAMETER,
      ),
    ))
    .orderBy(desc(strategyParameterSuggestions.createdAt))
    .limit(1);
  if (existing && existing.status !== "PENDING")
    return { summary, changed: false, existingSuggestionId: existing.id };
  const now = new Date();
  const evidence = JSON.stringify({
    label: "爆仓因子进入 LIVE 小样本验证",
    action: "TIGHTEN",
    confidence: liquidationFactorCandidateConfidence(summary),
    reason:
      "SHADOW 成熟事件、支持/拦截对照、精确费用后周期及样本外净收益均达标；需人工带入草稿并发布后才参与新订单判断。",
    proposalMode: "DRAFT_ONLY",
    learningEligible: true,
    automaticPublishAllowed: false,
    sourceConfigVersion: strategy.configVersion,
    candidateKind: "LIQUIDATION_FACTOR_MODE",
    validationPlan: {
      mode: "SMALL_LIVE_SAMPLE",
      requiredCompleteCycles: 8,
      minimumRollbackCycles: 3,
      maximumCompleteCycles: 12,
      automaticExpansionAllowed: false,
      automaticPromotionAllowed: false,
      automaticDeteriorationRollbackAllowed: true,
      oldPositionsKeepBoundVersionOnRollback: true,
    },
    shadowSummary: summary,
  });
  if (existing) {
    await db
      .update(strategyParameterSuggestions)
      .set({
        sampleCount: summary.exactSupportedCycles,
        evidenceJson: evidence,
      })
      .where(and(
        eq(strategyParameterSuggestions.id, existing.id),
        eq(strategyParameterSuggestions.status, "PENDING"),
      ));
    return {
      summary,
      changed: true,
      suggestionId: existing.id,
      candidateCreated: false,
    };
  }
  const [suggestion] = await db
    .insert(strategyParameterSuggestions)
    .values({
      strategyId: strategy.id,
      configVersion: strategy.configVersion,
      sampleCount: summary.exactSupportedCycles,
      parameterName: LIQUIDATION_FACTOR_SUGGESTION_PARAMETER,
      currentValueJson: JSON.stringify("SHADOW"),
      suggestedValueJson: JSON.stringify("LIVE"),
      evidenceJson: evidence,
      status: "PENDING",
      createdAt: now,
    })
    .returning({ id: strategyParameterSuggestions.id });
  return {
    summary,
    changed: true,
    suggestionId: suggestion?.id ?? null,
    candidateCreated: false,
  };
}

function liquidationFactorCandidateConfidence(
  summary: LiquidationFactorLearningSummary,
) {
  const exactCoverage = summary.minimumExactCycles > 0
    ? summary.exactSupportedCycles / summary.minimumExactCycles
    : 0;
  const episodeCoverage = summary.targetEpisodes > 0
    ? summary.matureEpisodes / summary.targetEpisodes
    : 0;
  return Math.min(0.99, Math.max(0.5, (exactCoverage + episodeCoverage) / 2));
}

function safeParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
