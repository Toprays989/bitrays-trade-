import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  livePositionStructureExitIntents,
  strategyExecutionTraces,
  strategyPositionEvidence,
} from "../../db/schema.ts";
import {
  readDurableStructureExitIntent,
  type DurableStructureExitIntent,
} from "../durable-structure-exit-intent.ts";

export const STRUCTURE_EXIT_INTENT_STORE_VERSION =
  "live-position-structure-exit-intent-store-v1" as const;

export type StructureExitIntentPosition = Readonly<{
  id: number;
  lifecycleId: string | null;
}>;

type IntentSource = "POSITION_INTELLIGENCE" | "EVIDENCE_BACKFILL";

function intentFromProjection(
  row: typeof livePositionStructureExitIntents.$inferSelect,
): DurableStructureExitIntent | null {
  if (
    row.status !== "ACTIVE" ||
    !row.traceId ||
    !row.opportunityId ||
    !Number.isInteger(row.observedMinute) ||
    !(row.observedAt instanceof Date) ||
    !(row.authorizedAt instanceof Date) ||
    !Number.isInteger(row.ruleVersion)
  ) return null;
  return {
    opportunityId: row.opportunityId,
    traceId: row.traceId,
    observedMinute: row.observedMinute!,
    observedAtMs: row.observedAt.getTime(),
    authorizedAtMs: row.authorizedAt.getTime(),
    ruleVersion: row.ruleVersion!,
  };
}

async function insertProjection(input: {
  position: StructureExitIntentPosition;
  intent: DurableStructureExitIntent | null;
  source: IntentSource;
  observedAt: Date;
}) {
  const intent = input.intent;
  await getDb()
    .insert(livePositionStructureExitIntents)
    .values({
      positionId: input.position.id,
      lifecycleId: input.position.lifecycleId,
      status: intent ? "ACTIVE" : "NONE",
      traceId: intent?.traceId ?? null,
      opportunityId: intent?.opportunityId ?? null,
      observedMinute: intent?.observedMinute ?? null,
      observedAt: intent ? new Date(intent.observedAtMs) : null,
      authorizedAt: intent ? new Date(intent.authorizedAtMs) : null,
      ruleVersion: intent?.ruleVersion ?? null,
      source: input.source,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    })
    .onConflictDoNothing();
}

/**
 * Read the compact runtime projection first. Historical evidence is consulted
 * only once for positions that predate this projection, after which even a
 * negative result is materialized as NONE. The five-second protection lane
 * therefore never repeatedly parses the learning evidence store.
 */
export async function loadActiveStructureExitIntents(
  positions: readonly StructureExitIntentPosition[],
) {
  const result = new Map<number, DurableStructureExitIntent>();
  if (!positions.length) return result;
  const db = getDb();
  const positionIds = positions.map((position) => position.id);
  const projectionRows = await db
    .select()
    .from(livePositionStructureExitIntents)
    .where(inArray(livePositionStructureExitIntents.positionId, positionIds));
  const projectedPositionIds = new Set<number>();
  for (const row of projectionRows) {
    projectedPositionIds.add(row.positionId);
    const intent = intentFromProjection(row);
    if (intent) result.set(row.positionId, intent);
  }
  const missingPositions = positions.filter(
    (position) => !projectedPositionIds.has(position.id),
  );
  if (!missingPositions.length) return result;

  const missingPositionIds = missingPositions.map((position) =>
    String(position.id)
  );
  const lifecycleIds = missingPositions.flatMap((position) =>
    position.lifecycleId ? [position.lifecycleId] : []
  );
  const traceRows = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      positionId: strategyExecutionTraces.positionId,
    })
    .from(strategyExecutionTraces)
    .where(and(
      eq(strategyExecutionTraces.state, "POSITION_OPEN"),
      lifecycleIds.length
        ? or(
            inArray(strategyExecutionTraces.traceId, lifecycleIds),
            inArray(strategyExecutionTraces.positionId, missingPositionIds),
          )
        : inArray(strategyExecutionTraces.positionId, missingPositionIds),
    ))
    .orderBy(desc(strategyExecutionTraces.id));
  const positionIdByLifecycle = new Map(
    missingPositions.flatMap((position) =>
      position.lifecycleId
        ? [[position.lifecycleId, position.id] as const]
        : []
    ),
  );
  const positionIdByTrace = new Map<string, number>();
  for (const row of traceRows) {
    const positionId =
      positionIdByLifecycle.get(row.traceId) ?? Number(row.positionId);
    if (
      row.traceId &&
      Number.isInteger(positionId) &&
      !positionIdByTrace.has(row.traceId)
    ) positionIdByTrace.set(row.traceId, positionId);
  }
  const traceIds = [...positionIdByTrace.keys()];
  const evidenceRows = traceIds.length
    ? await db
        .select({
          traceId: strategyPositionEvidence.traceId,
          minuteOffset: strategyPositionEvidence.minuteOffset,
          evidenceJson: strategyPositionEvidence.evidenceJson,
          createdAt: strategyPositionEvidence.createdAt,
        })
        .from(strategyPositionEvidence)
        .where(and(
          inArray(strategyPositionEvidence.traceId, traceIds),
          like(
            strategyPositionEvidence.evidenceJson,
            '%"structureExitAuthorized":true%',
          ),
        ))
        .orderBy(desc(strategyPositionEvidence.createdAt))
    : [];
  const evidenceRowsByTrace = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const rows = evidenceRowsByTrace.get(row.traceId) ?? [];
    rows.push(row);
    evidenceRowsByTrace.set(row.traceId, rows);
  }
  const intentByPosition = new Map<number, DurableStructureExitIntent>();
  for (const [traceId, rows] of evidenceRowsByTrace) {
    const positionId = positionIdByTrace.get(traceId);
    if (!positionId) continue;
    const intent = readDurableStructureExitIntent(rows);
    if (intent) intentByPosition.set(positionId, intent);
  }
  const projectedAt = new Date();
  for (const position of missingPositions) {
    const intent = intentByPosition.get(position.id) ?? null;
    await insertProjection({
      position,
      intent,
      source: "EVIDENCE_BACKFILL",
      observedAt: projectedAt,
    });
    if (intent) result.set(position.id, intent);
  }
  return result;
}

export async function persistActiveStructureExitIntent(input: {
  position: StructureExitIntentPosition;
  intent: DurableStructureExitIntent;
  observedAt?: Date;
}) {
  const observedAt = input.observedAt ?? new Date();
  await getDb()
    .insert(livePositionStructureExitIntents)
    .values({
      positionId: input.position.id,
      lifecycleId: input.position.lifecycleId,
      status: "ACTIVE",
      traceId: input.intent.traceId,
      opportunityId: input.intent.opportunityId,
      observedMinute: input.intent.observedMinute,
      observedAt: new Date(input.intent.observedAtMs),
      authorizedAt: new Date(input.intent.authorizedAtMs),
      ruleVersion: input.intent.ruleVersion,
      source: "POSITION_INTELLIGENCE",
      createdAt: observedAt,
      updatedAt: observedAt,
    })
    .onConflictDoUpdate({
      target: livePositionStructureExitIntents.positionId,
      set: {
        lifecycleId: input.position.lifecycleId,
        status: "ACTIVE",
        traceId: input.intent.traceId,
        opportunityId: input.intent.opportunityId,
        observedMinute: input.intent.observedMinute,
        observedAt: new Date(input.intent.observedAtMs),
        authorizedAt: new Date(input.intent.authorizedAtMs),
        ruleVersion: input.intent.ruleVersion,
        source: "POSITION_INTELLIGENCE",
        updatedAt: observedAt,
      },
    });
}
