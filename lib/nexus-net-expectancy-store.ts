import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { strategyLearningCycles } from "../db/schema";
import type {
  NexusProbabilityPolicy,
  NexusProbabilitySample,
} from "./nexus-net-expectancy.ts";
import { summarizeNexusColdStartCycles } from "./nexus-net-expectancy.ts";

/**
 * Load only compact, already-settled learning summaries. Raw execution traces,
 * candles and position paths deliberately stay outside the order hot path.
 */
export async function loadNexusProbabilitySamples(input: {
  strategyId: number;
  policy: NexusProbabilityPolicy;
  now?: Date;
}): Promise<NexusProbabilitySample[]> {
  if (input.policy.mode !== "NET_EXPECTANCY") return [];
  const now = input.now ?? new Date();
  const strategyIds = [
    ...new Set(
      [input.strategyId, input.policy.sourceStrategyId]
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
  const maximumRows = Math.max(
    20,
    Math.min(2_000, input.policy.maximumComparableSamples * 4),
  );
  const rows = await getDb()
    .select({
      strategyId: strategyLearningCycles.strategyId,
      exactNetPnlUsdt: strategyLearningCycles.exactNetPnlUsdt,
      detailJson: strategyLearningCycles.detailJson,
      updatedAt: strategyLearningCycles.updatedAt,
    })
    .from(strategyLearningCycles)
    .where(
      and(
        inArray(strategyLearningCycles.strategyId, strategyIds),
        eq(strategyLearningCycles.path, "ACTUAL_POSITION"),
        eq(strategyLearningCycles.orderSource, "STRATEGY"),
        eq(strategyLearningCycles.manualIntervention, false),
        eq(strategyLearningCycles.terminalStatus, "CLOSED"),
        eq(strategyLearningCycles.exactNetAvailable, true),
        eq(strategyLearningCycles.eligibility, "ELIGIBLE"),
        gte(
          strategyLearningCycles.updatedAt,
          new Date(
            now.getTime() - input.policy.maximumSampleAgeDays * 86_400_000,
          ),
        ),
      ),
    )
    .orderBy(desc(strategyLearningCycles.updatedAt))
    .limit(maximumRows);
  return rows.flatMap((row) => {
    if (
      row.exactNetPnlUsdt === null ||
      row.exactNetPnlUsdt === undefined ||
      row.exactNetPnlUsdt === ""
    ) return [];
    const pnl = Number(row.exactNetPnlUsdt);
    if (!Number.isFinite(pnl)) return [];
    const detail = safeRecord(row.detailJson);
    const memory = record(detail.memoryCase);
    const direction = memory.direction === "LONG" || memory.direction === "SHORT"
      ? memory.direction
      : "UNKNOWN";
    return [{
      exactNetPnlUsdt: pnl,
      exactNetRoePercent: finiteOrNull(memory.exactNetRoePercent),
      direction,
      decisionPath:
        clean(memory.probabilityDecisionPath ?? memory.decisionPath) ||
        "UNKNOWN",
      marketContextKey:
        clean(memory.probabilityMarketContextKey ?? memory.marketContextKey) ||
        "UNKNOWN",
      observedAt: row.updatedAt.getTime(),
      sourceStrategyId: row.strategyId,
    } satisfies NexusProbabilitySample];
  });
}

export async function loadNexusProbabilityContext(input: {
  strategyId: number;
  policy: NexusProbabilityPolicy;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [samples, ownCycles] = await Promise.all([
    loadNexusProbabilitySamples({ ...input, now }),
    getDb()
      .select({
        traceId: strategyLearningCycles.traceId,
        terminalStatus: strategyLearningCycles.terminalStatus,
        exactNetAvailable: strategyLearningCycles.exactNetAvailable,
        eligibility: strategyLearningCycles.eligibility,
        updatedAt: strategyLearningCycles.updatedAt,
      })
      .from(strategyLearningCycles)
      .where(
        and(
          eq(strategyLearningCycles.strategyId, input.strategyId),
          eq(strategyLearningCycles.path, "ACTUAL_POSITION"),
          eq(strategyLearningCycles.orderSource, "STRATEGY"),
          eq(strategyLearningCycles.manualIntervention, false),
          gte(
            strategyLearningCycles.updatedAt,
            new Date(
              now.getTime() - input.policy.maximumSampleAgeDays * 86_400_000,
            ),
          ),
        ),
      )
      .orderBy(desc(strategyLearningCycles.updatedAt))
      .limit(Math.max(20, input.policy.minimumComparableSamples * 4)),
  ]);
  const requiredCompletedSamples = Math.max(
    1,
    Math.trunc(input.policy.minimumComparableSamples),
  );
  const coldStart = summarizeNexusColdStartCycles({
    cycles: ownCycles,
    requiredCompletedSamples,
    nowMs: now.getTime(),
  });
  return {
    samples,
    coldStart,
  };
}

function safeRecord(value: string | null) {
  try {
    return record(JSON.parse(value ?? "{}"));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
