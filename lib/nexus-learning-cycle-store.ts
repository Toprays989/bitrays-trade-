import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  strategies,
  strategyLearningCycles,
  strategyLearningReviews,
} from "../db/schema";
import type {
  NexusFastLearningReceipt,
  NexusLearningCycle,
} from "./nexus-learning-cycle.ts";
import type { GlobalSentinelProbeFeedback } from "./nexus-global-sentinel.ts";
import {
  NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION,
  type NexusBrainMemoryCase,
} from "./nexus-brain-collaboration-memory.ts";
import {
  buildManualInterventionLearningSupersessionPatch,
  buildNexusSettlementRefreshPatch,
} from "./strategy-learning-backlog.ts";
import { buildStrategyLearningExperience } from "./strategy-learning-review.ts";
import { STRATEGY_LEARNING_SCHEMA_VERSION } from
  "./strategy-learning-version.ts";

export async function saveNexusLearningCycle(
  cycle: NexusLearningCycle,
  observedAt = new Date(),
) {
  const db = getDb();
  const values = {
    learningKey: cycle.learningKey,
    strategyId: cycle.strategyId,
    brainKey: cycle.brainKey,
    configVersion: cycle.configVersion,
    traceId: cycle.traceId,
    path: cycle.path,
    orderSource: cycle.orderSource,
    manualIntervention: cycle.manualIntervention,
    preTradeFactsComplete: cycle.preTradeFactsComplete,
    checkpointMinutesJson: JSON.stringify(
      cycle.observedCheckpointMinutes,
    ),
    terminalStatus: cycle.terminalStatus,
    exactNetAvailable: cycle.exactNetAvailable,
    exactNetPnlUsdt: cycle.exactNetPnlUsdt,
    eligibility: cycle.eligibility,
    blockedReasonsJson: JSON.stringify(cycle.blockedReasons),
    sourceSampleKeysJson: JSON.stringify(cycle.sourceSampleKeys),
    detailJson: JSON.stringify({
      modelVersion: cycle.modelVersion,
      learningSchemaVersion: STRATEGY_LEARNING_SCHEMA_VERSION,
      requiredCheckpointMinutes: cycle.requiredCheckpointMinutes,
      missingCheckpointMinutes: cycle.missingCheckpointMinutes,
      preTradeFactIds: cycle.preTradeFactIds,
      learningLane: cycle.learningLane,
      entryAuthorizationMode: cycle.entryAuthorizationMode,
      parameterLearningAllowed: cycle.parameterLearningAllowed,
      probeLearningAllowed: cycle.probeLearningAllowed,
      fastLearning: cycle.fastLearning ?? null,
      identities: cycle.identities,
      sentinelProbeFeedback: cycle.sentinelProbeFeedback ?? null,
      feedback: cycle.feedback,
      retrospective: cycle.retrospective ?? null,
      memoryCase: cycle.memoryCase ?? null,
      collaborationMemory: cycle.collaborationMemory ?? null,
    }),
    updatedAt: observedAt,
  };
  await db
    .insert(strategyLearningCycles)
    .values({ ...values, createdAt: observedAt })
    .onConflictDoUpdate({
      target: strategyLearningCycles.learningKey,
      set: values,
    });
  if (
    cycle.path === "MANUAL_INTERVENTION" &&
    cycle.terminalStatus === "CLOSED"
  ) {
    await supersedeActualLearningCycleAfterManualIntervention({
      traceId: cycle.traceId,
      manualLearningKey: cycle.learningKey,
      observedAt,
    });
  }
  if (cycle.terminalStatus === "CLOSED") {
    const [confirmedReview] = await db
      .select({ id: strategyLearningReviews.id })
      .from(strategyLearningReviews)
      .where(and(
        eq(strategyLearningReviews.learningKey, cycle.learningKey),
        eq(strategyLearningReviews.decision, "CONFIRMED"),
      ))
      .limit(1);
    if (confirmedReview) {
      const refreshed = buildStrategyLearningExperience({
        learningKey: cycle.learningKey,
        strategyId: cycle.strategyId,
        brainKey: cycle.brainKey,
        configVersion: cycle.configVersion,
        traceId: cycle.traceId,
        orderSource: cycle.orderSource,
        terminalStatus: cycle.terminalStatus,
        exactNetAvailable: cycle.exactNetAvailable,
        exactNetPnlUsdt: cycle.exactNetPnlUsdt,
        preTradeFactsComplete: cycle.preTradeFactsComplete,
        observedCheckpointMinutes: cycle.observedCheckpointMinutes,
        detailJson: values.detailJson,
        sampleUpdatedAt: observedAt,
      });
      await db
        .update(strategyLearningReviews)
        .set({
          promotionStatus: cycle.exactNetAvailable
            ? "PROMOTED"
            : "PROVISIONAL",
          sampleUpdatedAt: observedAt,
          exactNetAvailable: cycle.exactNetAvailable,
          exactNetPnlUsdt: cycle.exactNetAvailable
            ? cycle.exactNetPnlUsdt
            : null,
          outcome: refreshed.outcome,
          evidenceComplete: refreshed.evidenceComplete,
          experienceJson: JSON.stringify(refreshed.experience),
          updatedAt: observedAt,
        })
        .where(eq(strategyLearningReviews.id, confirmedReview.id));
    }
  }
}

export async function supersedeActualLearningCycleAfterManualIntervention(
  input: {
    traceId: string;
    manualLearningKey: string;
    observedAt?: Date;
  },
) {
  const observedAt = input.observedAt ?? new Date();
  const db = getDb();
  const rows = await db
    .select({
      id: strategyLearningCycles.id,
      learningKey: strategyLearningCycles.learningKey,
      blockedReasonsJson: strategyLearningCycles.blockedReasonsJson,
      detailJson: strategyLearningCycles.detailJson,
    })
    .from(strategyLearningCycles)
    .where(and(
      eq(strategyLearningCycles.traceId, input.traceId),
      eq(strategyLearningCycles.path, "ACTUAL_POSITION"),
      eq(strategyLearningCycles.terminalStatus, "OPEN"),
    ));
  for (const row of rows) {
    await db
      .update(strategyLearningCycles)
      .set(buildManualInterventionLearningSupersessionPatch({
        blockedReasonsJson: row.blockedReasonsJson,
        detailJson: row.detailJson,
        manualLearningKey: input.manualLearningKey,
        observedAt,
      }))
      .where(eq(strategyLearningCycles.id, row.id));
  }
  if (rows.length) {
    await db
      .update(strategyLearningReviews)
      .set({
        promotionStatus: "IGNORED",
        sampleUpdatedAt: observedAt,
        exactNetAvailable: false,
        exactNetPnlUsdt: null,
        outcome: "UNAVAILABLE",
        evidenceComplete: false,
        updatedAt: observedAt,
      })
      .where(inArray(
        strategyLearningReviews.learningKey,
        rows.map((row) => row.learningKey),
      ));
  }
  return rows.length;
}

export async function patchNexusFastLearningReceipt(input: {
  learningKey: string;
  fastLearning: NexusFastLearningReceipt;
  memoryCase?: NexusBrainMemoryCase | null;
  finalizeObservationOnly?: boolean;
}) {
  const db = getDb();
  const [row] = await db
    .select({ detailJson: strategyLearningCycles.detailJson })
    .from(strategyLearningCycles)
    .where(eq(strategyLearningCycles.learningKey, input.learningKey))
    .limit(1);
  if (!row) return false;
  const detail = objectFromJson(row.detailJson);
  const existingMemoryCase = objectRecord(detail.memoryCase);
  const incomingMemoryCase = input.memoryCase
    ? input.memoryCase as unknown as Record<string, unknown>
    : {};
  const exactNetPnlUsdt = finiteOrNull(incomingMemoryCase.exactNetPnlUsdt) ??
    finiteOrNull(existingMemoryCase.exactNetPnlUsdt);
  await db
    .update(strategyLearningCycles)
    .set({
      detailJson: JSON.stringify({
        ...detail,
        fastLearning: input.fastLearning,
        ...(Object.keys(incomingMemoryCase).length
          ? {
              memoryCase: {
                ...existingMemoryCase,
                ...incomingMemoryCase,
                exactNetPnlUsdt,
                eligibility: input.finalizeObservationOnly
                  ? "OBSERVATION_ONLY"
                  : incomingMemoryCase.eligibility,
              },
            }
          : {}),
      }),
      ...(input.finalizeObservationOnly
        ? { eligibility: "OBSERVATION_ONLY" as const }
        : {}),
    })
    .where(eq(strategyLearningCycles.learningKey, input.learningKey));
  return true;
}

export async function markNexusLearningCycleSettlementRefreshPending(
  traceId: string,
  observedAt = new Date(),
) {
  const db = getDb();
  const rows = await db
    .select({
      id: strategyLearningCycles.id,
      detailJson: strategyLearningCycles.detailJson,
    })
    .from(strategyLearningCycles)
    .where(eq(strategyLearningCycles.traceId, traceId));
  for (const row of rows) {
    await db
      .update(strategyLearningCycles)
      .set(buildNexusSettlementRefreshPatch({
        detailJson: row.detailJson,
        observedAt,
      }))
      .where(eq(strategyLearningCycles.id, row.id));
  }
  return rows.length;
}

export async function finalizeNexusFastLearningObservation(
  traceId: string,
) {
  const db = getDb();
  const rows = await db
    .select({
      id: strategyLearningCycles.id,
      detailJson: strategyLearningCycles.detailJson,
    })
    .from(strategyLearningCycles)
    .where(and(
      eq(strategyLearningCycles.traceId, traceId),
      eq(strategyLearningCycles.eligibility, "INCOMPLETE"),
    ));
  let finalized = 0;
  for (const row of rows) {
    const detail = objectFromJson(row.detailJson);
    const fastLearning = objectRecord(detail.fastLearning);
    if (
      fastLearning.status !== "LEARNED" &&
      fastLearning.status !== "PARTIAL"
    ) continue;
    const memoryCase = objectRecord(detail.memoryCase);
    await db
      .update(strategyLearningCycles)
      .set({
        eligibility: "OBSERVATION_ONLY",
        detailJson: JSON.stringify({
          ...detail,
          memoryCase: Object.keys(memoryCase).length
            ? { ...memoryCase, eligibility: "OBSERVATION_ONLY" }
            : detail.memoryCase,
        }),
      })
      .where(eq(strategyLearningCycles.id, row.id));
    finalized += 1;
  }
  return finalized;
}

export async function loadNexusBrainMemoryCasesForAccount(
  ownerEmail: string,
  accountId: string,
  limit = 300,
) {
  const rows = await getDb()
    .select({ detailJson: strategyLearningCycles.detailJson })
    .from(strategyLearningCycles)
    .innerJoin(
      strategies,
      eq(strategyLearningCycles.strategyId, strategies.id),
    )
    .where(
      and(
        eq(strategies.ownerEmail, ownerEmail),
        eq(strategies.accountId, accountId),
      ),
    )
    .orderBy(desc(strategyLearningCycles.updatedAt))
    .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
  return rows
    .map((row) => memoryCaseFromDetail(row.detailJson))
    .filter((item): item is NexusBrainMemoryCase => item !== null);
}

export async function loadGlobalSentinelProbeFeedback(
  ownerEmails: string[],
  limit = 200,
) {
  const owners = [...new Set(ownerEmails.map((item) => item.trim().toLowerCase()))]
    .filter(Boolean);
  if (!owners.length) return [] as GlobalSentinelProbeFeedback[];
  const rows = await getDb()
    .select({ detailJson: strategyLearningCycles.detailJson })
    .from(strategyLearningCycles)
    .innerJoin(
      strategies,
      eq(strategyLearningCycles.strategyId, strategies.id),
    )
    .where(
      and(
        inArray(strategies.ownerEmail, owners),
        eq(strategyLearningCycles.exactNetAvailable, true),
      ),
    )
    .orderBy(desc(strategyLearningCycles.updatedAt))
    .limit(Math.max(1, Math.min(1_000, Math.trunc(limit))));
  return rows
    .map((row) => sentinelProbeFeedbackFromDetail(row.detailJson))
    .filter((item): item is GlobalSentinelProbeFeedback => item !== null);
}

function memoryCaseFromDetail(detailJson: string | null) {
  try {
    const detail = JSON.parse(detailJson ?? "{}") as Record<string, unknown>;
    const memoryCase = detail.memoryCase;
    if (!memoryCase || typeof memoryCase !== "object" || Array.isArray(memoryCase))
      return null;
    const candidate = memoryCase as Partial<NexusBrainMemoryCase>;
    return candidate.version === NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION &&
        typeof candidate.accountId === "string" &&
        typeof candidate.brainKey === "string" &&
        typeof candidate.traceId === "string"
      ? candidate as NexusBrainMemoryCase
      : null;
  } catch {
    return null;
  }
}

function sentinelProbeFeedbackFromDetail(detailJson: string | null) {
  try {
    const detail = JSON.parse(detailJson ?? "{}") as Record<string, unknown>;
    const value = detail.sentinelProbeFeedback;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const positionSide = item.positionSide === "LONG" || item.positionSide === "SHORT"
      ? item.positionSide
      : null;
    if (
      item.authority !== "EYE_CALIBRATION_ONLY" ||
      typeof item.factId !== "string"
    ) return null;
    return {
      factId: item.factId,
      accountId: typeof item.accountId === "string" ? item.accountId : null,
      symbol: typeof item.symbol === "string" ? item.symbol : null,
      positionSide,
      exactNetPnlUsdt: Number.isFinite(Number(item.exactNetPnlUsdt))
        ? Number(item.exactNetPnlUsdt)
        : null,
      eyeCalibration: typeof item.eyeCalibration === "string"
        ? item.eyeCalibration
        : "UNAVAILABLE",
    } satisfies GlobalSentinelProbeFeedback;
  } catch {
    return null;
  }
}

function objectFromJson(value: string | null) {
  try {
    return objectRecord(JSON.parse(value ?? "{}"));
  } catch {
    return {};
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
