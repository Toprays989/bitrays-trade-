import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import {
  livePositionReductions,
  livePositions,
  nexusEyeFactSnapshots,
  strategyExecutionEventRollups,
  strategyExecutionEvents,
  strategyExecutionSummaries,
  strategyExecutionTraces,
  strategyConfigValidations,
  strategyLearningCycles,
  strategyParameterSuggestions,
  strategyPositionEvidence,
} from "../../../../../../db/schema";
import { resolveLiquidationTrendConfig } from "../../../../../../lib/liquidation-trend-config";
import { analyzePostEntryPerformance } from "../../../../../../lib/strategy-post-entry-analysis";
import { positionRoePercent } from "../../../../../../lib/position-roe";
import { aggregatePositionReductionCycle } from "../../../../../../lib/live-position-cycle-accounting";
import { positionObservationCausalLearningEligible } from "../../../../../../lib/position-observation-timing";
import { buildNexusConfigValidation } from "../../../../../../lib/nexus-config-validation";
import {
  decisionEngineVersionFromEvidence,
  LIQUIDATION_DECISION_ENGINE_VERSION,
} from "../../../../../../lib/liquidation-decision-engine";
import {
  learningSchemaVersionFromEvidence,
  STRATEGY_LEARNING_SCHEMA_VERSION,
} from "../../../../../../lib/strategy-learning-version";
import { isResponse, requirePermission } from "../../../shared";

export async function GET(
  request: Request,
  context: { params: Promise<{ traceId: string }> },
) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const { traceId } = await context.params;
  if (!/^[A-Za-z0-9:_-]{8,100}$/.test(traceId))
    return Response.json({ error: "执行链路编号无效" }, { status: 400 });
  const [trace] = await getDb()
    .select()
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.traceId, traceId),
        eq(strategyExecutionTraces.ownerEmail, user.email),
      ),
    )
    .limit(1);
  if (!trace)
    return Response.json({ error: "执行链路不存在或无权查看" }, { status: 404 });
  const positionId = Number(trace.positionId);
  const [events, eventRollups, summaryRows, evidence, suggestions, acceptedSuggestions, validationCycles, positionRows, reductionRows, validationRows] = await Promise.all([
    getDb()
      .select()
      .from(strategyExecutionEvents)
      .where(
        and(
          eq(strategyExecutionEvents.traceId, traceId),
          eq(strategyExecutionEvents.strategyId, trace.strategyId),
        ),
      )
      .orderBy(
        desc(strategyExecutionEvents.eventAt),
        desc(strategyExecutionEvents.sequence),
      ),
    getDb()
      .select()
      .from(strategyExecutionEventRollups)
      .where(and(
        eq(strategyExecutionEventRollups.traceId, traceId),
        eq(strategyExecutionEventRollups.strategyId, trace.strategyId),
      ))
      .orderBy(desc(strategyExecutionEventRollups.lastEventAt)),
    getDb()
      .select()
      .from(strategyExecutionSummaries)
      .where(eq(strategyExecutionSummaries.traceId, traceId))
      .limit(1),
    getDb()
      .select()
      .from(strategyPositionEvidence)
      .where(
        and(
          eq(strategyPositionEvidence.traceId, traceId),
          eq(strategyPositionEvidence.strategyId, trace.strategyId),
        ),
      )
      .orderBy(asc(strategyPositionEvidence.minuteOffset)),
    getDb()
      .select()
      .from(strategyParameterSuggestions)
      .where(
        and(
          eq(strategyParameterSuggestions.strategyId, trace.strategyId),
          eq(strategyParameterSuggestions.configVersion, trace.configVersion),
          eq(strategyParameterSuggestions.status, "PENDING"),
        ),
      )
      .orderBy(desc(strategyParameterSuggestions.createdAt))
      .limit(20),
    getDb()
      .select({
        id: strategyParameterSuggestions.id,
        status: strategyParameterSuggestions.status,
        evidenceJson: strategyParameterSuggestions.evidenceJson,
      })
      .from(strategyParameterSuggestions)
      .where(
        and(
          eq(strategyParameterSuggestions.strategyId, trace.strategyId),
          eq(strategyParameterSuggestions.status, "ACCEPTED"),
        ),
      )
      .orderBy(desc(strategyParameterSuggestions.reviewedAt))
      .limit(20),
    getDb()
      .select({
        configVersion: strategyLearningCycles.configVersion,
        terminalStatus: strategyLearningCycles.terminalStatus,
        exactNetAvailable: strategyLearningCycles.exactNetAvailable,
        exactNetPnlUsdt: strategyLearningCycles.exactNetPnlUsdt,
        eligibility: strategyLearningCycles.eligibility,
        manualIntervention: strategyLearningCycles.manualIntervention,
        updatedAt: strategyLearningCycles.updatedAt,
      })
      .from(strategyLearningCycles)
      .where(
        eq(strategyLearningCycles.strategyId, trace.strategyId),
      )
      .orderBy(desc(strategyLearningCycles.updatedAt))
      .limit(240),
    Number.isInteger(positionId) && positionId > 0
      ? getDb()
          .select()
          .from(livePositions)
          .where(
            and(
              eq(livePositions.id, positionId),
              eq(livePositions.ownerEmail, user.email),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    Number.isInteger(positionId) && positionId > 0
      ? getDb()
          .select({
            quantity: livePositionReductions.quantity,
            reason: livePositionReductions.reason,
            realizedPnl: livePositionReductions.realizedPnl,
            responseJson: livePositionReductions.responseJson,
          })
          .from(livePositionReductions)
          .where(
            and(
              eq(livePositionReductions.positionId, positionId),
              eq(livePositionReductions.ownerEmail, user.email),
            ),
          )
      : Promise.resolve([]),
    getDb()
      .select()
      .from(strategyConfigValidations)
      .where(and(
        eq(strategyConfigValidations.strategyId, trace.strategyId),
        eq(strategyConfigValidations.candidateVersion, trace.configVersion),
      ))
      .limit(1),
  ]);
  const retentionSummary = summaryRows[0] ?? null;
  const archivedFactIds = retentionSummary
    ? stringArray(safeParse(retentionSummary.marketFactIdsJson))
    : [];
  const archivedEyeFacts = archivedFactIds.length
    ? await getDb()
        .select({
          factId: nexusEyeFactSnapshots.factId,
          symbol: nexusEyeFactSnapshots.symbol,
          kind: nexusEyeFactSnapshots.kind,
          interval: nexusEyeFactSnapshots.interval,
          source: nexusEyeFactSnapshots.source,
          eventAt: nexusEyeFactSnapshots.eventAt,
          receivedAt: nexusEyeFactSnapshots.receivedAt,
          expiresAt: nexusEyeFactSnapshots.expiresAt,
          factJson: nexusEyeFactSnapshots.factJson,
        })
        .from(nexusEyeFactSnapshots)
        .where(inArray(
          nexusEyeFactSnapshots.factId,
          archivedFactIds.slice(0, 128),
        ))
    : [];
  const finalPosition = positionRows[0];
  const reductionCycle = aggregatePositionReductionCycle(reductionRows);
  const reductionPnl = reductionCycle.pnl;
  const finalPnlExact = reductionCycle.exactNetAvailable;
  const finalRealizedPnl = finalPosition?.status === "CLOSED"
    ? reductionRows.length
      ? reductionPnl
      : finalPosition.exitReason === "EXTERNAL" && finalPosition.realizedPnl === 0
        ? null
        : finalPosition.realizedPnl
    : null;
  const reducedQuantity = reductionCycle.quantity;
  const exactInitialMarginUsdt =
    finalPnlExact &&
    finalPosition &&
    reducedQuantity > 0 &&
    finalPosition.entryPrice > 0 &&
    finalPosition.leverage > 0
      ? finalPosition.entryPrice * reducedQuantity / finalPosition.leverage
      : null;
  const finalNetRoePercent =
    finalRealizedPnl !== null &&
    exactInitialMarginUsdt !== null &&
    exactInitialMarginUsdt > 0
      ? finalRealizedPnl / exactInitialMarginUsdt * 100
      : null;
  const lifetimeBestRoePercent =
    finalPosition?.favorablePrice &&
    finalPosition.favorablePrice > 0
      ? positionRoePercent(
          finalPosition.entryPrice,
          finalPosition.favorablePrice,
          finalPosition.leverage,
          finalPosition.positionSide,
        )
      : null;
  const holdingDurationMinutes =
    finalPosition?.status === "CLOSED" &&
    finalPosition.closedAt
      ? Math.max(
          0,
          (finalPosition.closedAt.getTime() -
            finalPosition.openedAt.getTime()) /
            60_000,
        )
      : null;
  const configSnapshot = safeParse(trace.configSnapshotJson);
  const entryEvidence = safeParse(trace.entryEvidenceJson);
  const entryEvidenceRecord = asRecord(entryEvidence);
  if (!Object.keys(asRecord(entryEvidenceRecord.triggerIdentity)).length)
    entryEvidenceRecord.triggerIdentity = {
      triggerKind: trace.triggerKind,
      triggerVersion: trace.triggerVersion,
      direction: trace.triggerDirection,
      factSnapshotId: trace.triggerFactSnapshotId,
      sourceId: trace.triggerSourceId,
      referencePrice: trace.triggerReferencePrice,
      canAuthorizeOrder: false,
    };
  const traceEngineVersion = decisionEngineVersionFromEvidence(entryEvidenceRecord);
  const currentSuggestions = traceEngineVersion === LIQUIDATION_DECISION_ENGINE_VERSION
    ? suggestions.filter((suggestion) => {
        const evidence = asRecord(safeParse(suggestion.evidenceJson));
        return (
          evidence.decisionEngineVersion === traceEngineVersion &&
          learningSchemaVersionFromEvidence(evidence) ===
            STRATEGY_LEARNING_SCHEMA_VERSION
        );
      })
    : [];
  const sampledPositionSide = evidence
    .map((sample) => asRecord(safeParse(sample.evidenceJson)).positionSide)
    .find((side) => side === "LONG" || side === "SHORT");
  const resolvedConfigSnapshot = resolveLiquidationTrendConfig(configSnapshot, {
    allowHistoricalLeverage: true,
  });
  const postEntryAnalysis =
    resolvedConfigSnapshot.config
      ? analyzePostEntryPerformance({
          config: resolvedConfigSnapshot.config,
          symbol: trace.symbol,
          entryEvidence: entryEvidenceRecord,
          samples: evidence,
          decisionAtMs: trace.eventTime instanceof Date
            ? trace.eventTime.getTime()
            : null,
          positionSide: sampledPositionSide === "SHORT" ? "SHORT" : "LONG",
          observationMode: evidence.length > 0 && evidence.every((sample) => sample.status === "MISSED")
            ? "REJECTED_COUNTERFACTUAL"
            : "ACTUAL_POSITION",
          rejectionCode: trace.resultCode,
          finalRealizedPnl,
          finalPnlExact,
          finalNetRoePercent,
          lifetimeBestRoePercent,
          holdingDurationMinutes,
          reductionReasons: reductionRows.map((reduction) => reduction.reason),
          finalExitReason: finalPosition?.status === "CLOSED"
            ? finalPosition.exitReason
            : null,
        })
      : null;
  return Response.json({
    execution: {
      ...trace,
      configSnapshot,
      entryEvidence,
      configSnapshotJson: undefined,
      entryEvidenceJson: undefined,
    },
    events: events.map((event) => ({
      ...event,
      detail: safeParse(event.detailJson),
      detailJson: undefined,
    })),
    eventArchive: retentionSummary
      ? {
          summary: {
            ...retentionSummary,
            eyeDecision: safeParse(retentionSummary.eyeDecisionJson),
            marketFactIds: archivedFactIds,
            keyEvents: safeParse(retentionSummary.keyEventsJson),
            archive: safeParse(retentionSummary.archiveJson),
            eyeDecisionJson: undefined,
            marketFactIdsJson: undefined,
            keyEventsJson: undefined,
            archiveJson: undefined,
          },
          rollups: eventRollups,
          eyeFacts: archivedEyeFacts.map((fact) => ({
            ...fact,
            fact: safeParse(fact.factJson),
            factJson: undefined,
          })),
          rawEventsAvailable: retentionSummary.rawEventsDeletedAt === null,
        }
      : null,
    evidence: evidence.map((sample) => {
      const detail = safeParse(sample.evidenceJson);
      const causalLearningEligible = positionObservationCausalLearningEligible({
        ...sample,
        timing: asRecord(detail).observationTiming,
      });
      return {
        ...sample,
        detail,
        causalLearningEligible,
        learningUse: causalLearningEligible
          ? "PARAMETER_LEARNING"
          : "HISTORICAL_ONLY",
        evidenceJson: undefined,
      };
    }),
    postEntryAnalysis,
    configValidation: buildNexusConfigValidation({
      configVersion: trace.configVersion,
      sourceConfigVersion: validationRows[0]?.baselineVersion ?? null,
      suggestions: acceptedSuggestions,
      cycles: validationCycles.map((cycle) => ({
        ...cycle,
        updatedAtMs: cycle.updatedAt.getTime(),
      })),
      directCandidate:
        asRecord(safeParse(validationRows[0]?.evaluationJson ?? "{}"))
          .candidateKind === "LIQUIDATION_FACTOR_MODE",
    }),
    suggestions: currentSuggestions.map((suggestion) => ({
      ...suggestion,
      currentValue: safeParse(suggestion.currentValueJson),
      suggestedValue: safeParse(suggestion.suggestedValueJson),
      evidence: safeParse(suggestion.evidenceJson),
      currentValueJson: undefined,
      suggestedValueJson: undefined,
      evidenceJson: undefined,
    })),
  });
}

function safeParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === "string" && Boolean(item.trim())
      ))]
    : [];
}
