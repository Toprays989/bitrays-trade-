import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  like,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  strategies,
  strategyExecutionEvents,
  strategyExecutionTraces,
  strategyLearningCycles,
} from "../../db/schema.ts";
import { prioritizeStrategyLearningBacklog } from
  "../strategy-learning-backlog.ts";
import { STRATEGY_LEARNING_SCHEMA_VERSION } from
  "../strategy-learning-version.ts";
import { resolveStrategyTerminalLearningScope } from
  "../strategy-terminal-learning-scope.ts";
import { isStrategyTriggerKind } from "../strategy-trigger-catalog.ts";

export const TERMINAL_LEARNING_CANDIDATE_SERVICE_VERSION =
  "terminal-learning-candidate-service-v3" as const;

export type TerminalLearningCandidate = Readonly<{
  traceId: string;
  strategyId: number;
  configVersion: number;
  configSnapshotJson: string;
  triggerKind: string;
  triggerVersion: string;
  entryEvidenceJson: string;
  completedAt: Date | null;
  learningEligibility:
    | "ELIGIBLE"
    | "OBSERVATION_ONLY"
    | "INCOMPLETE"
    | null;
  learningUpdatedAt: Date | null;
  settlementRefreshPending: number;
  learningSchemaRefreshPending: number;
}>;

type LightweightTerminalLearningCandidate = Omit<
  TerminalLearningCandidate,
  "configSnapshotJson" | "entryEvidenceJson"
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function candidateHasFormalIdentity(row: TerminalLearningCandidate) {
  if (
    !row.traceId.trim() ||
    !Number.isInteger(row.strategyId) ||
    row.strategyId < 1 ||
    !Number.isInteger(row.configVersion) ||
    row.configVersion < 1 ||
    !(row.completedAt instanceof Date)
  ) return false;
  if (!Object.keys(record(parseJson(row.configSnapshotJson))).length)
    return false;
  return resolveStrategyTerminalLearningScope({
    triggerKind: row.triggerKind,
    triggerVersion: row.triggerVersion,
    entryEvidence: record(parseJson(row.entryEvidenceJson)),
  }) !== null;
}

/**
 * Read the next durable terminal-learning lifecycle for any formal LIVE
 * strategy. Discovery selects scalar identity only. The large configuration
 * and entry-evidence JSON values are hydrated for one prioritized lifecycle at
 * a time, so a learning audit cannot retain hundreds of historical payloads.
 */
export async function loadNextTerminalLearningCandidate(
  scanLimit = 200,
): Promise<TerminalLearningCandidate | null> {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(scanLimit)));
  const settlementRefreshPending =
    sql<number>`coalesce(json_extract(${strategyLearningCycles.detailJson}, '$.settlementRefreshPending'), 0)`;
  const settlementRefreshPriorityAt =
    sql<number>`case when coalesce(json_extract(${strategyLearningCycles.detailJson}, '$.settlementRefreshPending'), 0) = 1 then coalesce(${strategyLearningCycles.updatedAt}, 0) else 0 end`;
  const learningSchemaRefreshPending =
    sql<number>`case when ${strategyLearningCycles.path} = 'ACTUAL_POSITION' and ${strategyLearningCycles.exactNetAvailable} = 1 and json_extract(${strategyLearningCycles.detailJson}, '$.retrospective.causalAttributionReady') = 0 and coalesce(json_extract(${strategyLearningCycles.detailJson}, '$.learningSchemaVersion'), '') <> ${STRATEGY_LEARNING_SCHEMA_VERSION} then 1 else 0 end`;
  const selection = {
    traceId: strategyExecutionTraces.traceId,
    strategyId: strategyExecutionTraces.strategyId,
    configVersion: strategyExecutionTraces.configVersion,
    triggerKind: strategyExecutionTraces.triggerKind,
    triggerVersion: strategyExecutionTraces.triggerVersion,
    completedAt: strategyExecutionTraces.completedAt,
    learningEligibility: strategyLearningCycles.eligibility,
    learningUpdatedAt: strategyLearningCycles.updatedAt,
    settlementRefreshPending,
    learningSchemaRefreshPending,
  } as const;
  const validConfigSnapshot = and(
    sql`json_valid(${strategyExecutionTraces.configSnapshotJson}) = 1`,
    sql`json_type(${strategyExecutionTraces.configSnapshotJson}) = 'object'`,
    sql`${strategyExecutionTraces.configSnapshotJson} <> '{}'`,
  );
  const receiptBacklog = await db
    .select(selection)
    .from(strategyExecutionTraces)
    .innerJoin(
      strategies,
      eq(strategyExecutionTraces.strategyId, strategies.id),
    )
    .leftJoin(
      strategyLearningCycles,
      eq(strategyExecutionTraces.traceId, strategyLearningCycles.traceId),
    )
    .where(and(
      eq(strategyExecutionTraces.state, "CLOSED"),
      isNotNull(strategyExecutionTraces.positionId),
      ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
      eq(strategies.runtimeMode, "LIVE"),
      validConfigSnapshot,
      or(
        isNull(strategyLearningCycles.id),
        eq(strategyLearningCycles.eligibility, "INCOMPLETE"),
      ),
    ))
    .orderBy(
      desc(settlementRefreshPending),
      desc(settlementRefreshPriorityAt),
      asc(strategyExecutionTraces.completedAt),
    )
    .limit(safeLimit);
  const schemaRefreshBacklog = await db
    .select(selection)
    .from(strategyExecutionTraces)
    .innerJoin(
      strategies,
      eq(strategyExecutionTraces.strategyId, strategies.id),
    )
    .innerJoin(
      strategyLearningCycles,
      eq(strategyExecutionTraces.traceId, strategyLearningCycles.traceId),
    )
    .where(and(
      eq(strategyExecutionTraces.state, "CLOSED"),
      isNotNull(strategyExecutionTraces.positionId),
      ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
      eq(strategies.runtimeMode, "LIVE"),
      validConfigSnapshot,
      eq(strategyLearningCycles.path, "ACTUAL_POSITION"),
      eq(strategyLearningCycles.exactNetAvailable, true),
      sql`json_extract(${strategyLearningCycles.detailJson}, '$.retrospective.causalAttributionReady') = 0`,
      sql`coalesce(json_extract(${strategyLearningCycles.detailJson}, '$.learningSchemaVersion'), '') <> ${STRATEGY_LEARNING_SCHEMA_VERSION}`,
    ))
    .orderBy(desc(strategyLearningCycles.updatedAt))
    .limit(Math.min(safeLimit, 50));
  const postExitBacklog = await db
    .select(selection)
    .from(strategyExecutionEvents)
    .innerJoin(
      strategyExecutionTraces,
      eq(strategyExecutionEvents.traceId, strategyExecutionTraces.traceId),
    )
    .innerJoin(
      strategies,
      eq(strategyExecutionTraces.strategyId, strategies.id),
    )
    .leftJoin(
      strategyLearningCycles,
      eq(strategyExecutionTraces.traceId, strategyLearningCycles.traceId),
    )
    .where(and(
      eq(strategyExecutionTraces.state, "CLOSED"),
      isNotNull(strategyExecutionTraces.positionId),
      ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
      eq(strategies.runtimeMode, "LIVE"),
      validConfigSnapshot,
      like(
        strategyExecutionEvents.eventType,
        "POSITION_EXIT_COUNTERFACTUAL_%",
      ),
      or(
        isNull(strategyLearningCycles.id),
        gt(strategyExecutionEvents.createdAt, strategyLearningCycles.updatedAt),
      ),
    ))
    .orderBy(asc(strategyExecutionEvents.createdAt))
    .limit(safeLimit);
  const unique = [...new Map(
    [...receiptBacklog, ...postExitBacklog, ...schemaRefreshBacklog]
      .map((row) => [row.traceId, row] as const),
  ).values()];
  const prioritized = prioritizeStrategyLearningBacklog(
    unique.filter((row): row is LightweightTerminalLearningCandidate =>
      Boolean(
        row.traceId.trim() &&
        Number.isInteger(row.strategyId) &&
        row.strategyId > 0 &&
        Number.isInteger(row.configVersion) &&
        row.configVersion > 0 &&
        row.completedAt instanceof Date &&
        isStrategyTriggerKind(row.triggerKind),
      )
    ),
  );
  for (const candidate of prioritized) {
    const [context] = await db
      .select({
        configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      })
      .from(strategyExecutionTraces)
      .where(eq(strategyExecutionTraces.traceId, candidate.traceId))
      .limit(1);
    if (!context) continue;
    const hydrated = { ...candidate, ...context };
    if (candidateHasFormalIdentity(hydrated)) return hydrated;
  }
  return null;
}
