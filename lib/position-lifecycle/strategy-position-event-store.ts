import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  livePositionReductions,
  strategyExecutionEvents,
  strategyExecutionTraces,
} from "../../db/schema.ts";
import { reductionAccountingPnl } from
  "../live-reduction-accounting.ts";
import type { ExecutedRiskProgress } from
  "../risk-execution-progress.ts";
import {
  strategyPositionReductionEvent,
  strategyProfitProtectionActivationEvent,
} from "../strategy-trace-lifecycle.ts";

export const STRATEGY_POSITION_EVENT_STORE_VERSION =
  "strategy-position-event-store-v1" as const;

const REDUCTION_EVENT_BACKFILL_INTERVAL_MS = 30_000;
let lastReductionEventBackfillAt = 0;

export type StrategyPositionManagementEventInput = {
  traceId: string;
  strategyId: number;
  eventType: string;
  outcome: "PASSED" | "PENDING" | "REJECTED" | "INFO" | "ERROR";
  message: string;
  detail: unknown;
  eventAt: Date;
};

/**
 * Durable, idempotent handoff from position management into the strategy
 * lifecycle. This store records facts only and cannot mutate live strategy
 * parameters or authorize a new order.
 */
export async function appendStrategyPositionManagementEvent(
  input: StrategyPositionManagementEventInput,
) {
  const db = getDb();
  const detailJson = JSON.stringify(input.detail);
  const [duplicate] = await db
    .select({ id: strategyExecutionEvents.id })
    .from(strategyExecutionEvents)
    .where(
      and(
        eq(strategyExecutionEvents.traceId, input.traceId),
        eq(strategyExecutionEvents.eventType, input.eventType),
        eq(strategyExecutionEvents.detailJson, detailJson),
      ),
    )
    .limit(1);
  if (duplicate) return false;
  const [last] = await db
    .select({ sequence: strategyExecutionEvents.sequence })
    .from(strategyExecutionEvents)
    .where(eq(strategyExecutionEvents.traceId, input.traceId))
    .orderBy(desc(strategyExecutionEvents.sequence))
    .limit(1);
  const [created] = await db
    .insert(strategyExecutionEvents)
    .values({
      traceId: input.traceId,
      strategyId: input.strategyId,
      sequence: (last?.sequence ?? 0) + 1,
      eventType: input.eventType,
      stage: "POSITION_MANAGEMENT",
      outcome: input.outcome,
      message: input.message,
      detailJson,
      eventAt: input.eventAt,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: strategyExecutionEvents.id });
  return Boolean(created);
}

export function appendClosedStrategyPositionEvent(input: {
  traceId: string;
  strategyId: number;
  message: string;
  detail: unknown;
  eventAt: Date;
}) {
  return appendStrategyPositionManagementEvent({
    ...input,
    eventType: "POSITION_CLOSED",
    outcome: "INFO",
  });
}

export async function appendStrategyProfitProtectionActivation(input: {
  positionId: number;
  symbol: string;
  positionSide: string;
  currentRoePercent: number;
  previous: ExecutedRiskProgress;
  current: ExecutedRiskProgress;
}) {
  const current = input.current.dynamicProfitReduction;
  const event = strategyProfitProtectionActivationEvent({
    positionId: input.positionId,
    symbol: input.symbol,
    positionSide: input.positionSide,
    currentRoePercent: input.currentRoePercent,
    anchorQuantity: current?.anchorQuantity ?? 0,
    executedQuantity: current?.executedQuantity ?? 0,
    completedStages: current?.completedStages ?? [],
    softActivationRuleVersion: current?.softActivationRuleVersion ?? null,
    softActivatedAtMs: current?.softActivatedAtMs ?? null,
    softActivationRoePercent: current?.softActivationRoePercent ?? null,
    previousSoftActivatedAtMs:
      input.previous.dynamicProfitReduction?.softActivatedAtMs ?? null,
  });
  if (!event) return false;
  const [trace] = await getDb()
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
    })
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.positionId, String(input.positionId)))
    .orderBy(desc(strategyExecutionTraces.createdAt))
    .limit(1);
  if (!trace) return false;
  return appendStrategyPositionManagementEvent({
    traceId: trace.traceId,
    strategyId: trace.strategyId,
    ...event,
  });
}

export async function backfillStrategyReductionEvents(now: Date) {
  if (
    now.getTime() - lastReductionEventBackfillAt <
    REDUCTION_EVENT_BACKFILL_INTERVAL_MS
  )
    return { written: 0, errors: 0, deferred: true };
  lastReductionEventBackfillAt = now.getTime();
  const db = getDb();
  const reductions = await db
    .select()
    .from(livePositionReductions)
    .orderBy(desc(livePositionReductions.id))
    .limit(100);
  const positionIds = [
    ...new Set(reductions.map((reduction) => reduction.positionId)),
  ];
  if (!positionIds.length)
    return { written: 0, errors: 0, deferred: false };
  const traces = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      positionId: strategyExecutionTraces.positionId,
    })
    .from(strategyExecutionTraces)
    .where(
      inArray(
        strategyExecutionTraces.positionId,
        positionIds.map(String),
      ),
    );
  const traceByPosition = new Map(
    traces.map((trace) => [Number(trace.positionId), trace]),
  );
  let written = 0;
  let errors = 0;
  for (const reduction of reductions) {
    const trace = traceByPosition.get(reduction.positionId);
    if (!trace) continue;
    try {
      const accounting = reductionAccountingPnl(reduction);
      const reductionResponse = record(parseJson(reduction.responseJson));
      const dynamicReduction = record(
        reductionResponse.dynamicProfitReduction,
      );
      const dynamicStage = Number(dynamicReduction.stage);
      const event = strategyPositionReductionEvent({
        reductionId: reduction.id,
        positionId: reduction.positionId,
        symbol: reduction.symbol,
        positionSide: reduction.positionSide,
        reason: reduction.reason,
        quantity: reduction.quantity,
        exitPrice: reduction.exitPrice,
        grossRealizedPnl: accounting.grossRealizedPnl,
        netRealizedPnl: accounting.netRealizedPnl,
        exactNetAvailable: accounting.exactNetAvailable,
        exitCommission: accounting.exitCommission,
        entryCommissionAllocated: accounting.entryCommissionAllocated,
        fundingIncome: accounting.fundingIncome,
        createdAt: reduction.createdAt,
        dynamicProfitReduction:
          Number.isInteger(dynamicStage) &&
            dynamicStage >= 1 &&
            dynamicStage <= 3
            ? {
                stage: dynamicStage,
                targetCumulativeRatio: Number(
                  dynamicReduction.targetCumulativeRatio,
                ),
                givebackRoePoints: Number(
                  dynamicReduction.givebackRoePoints,
                ),
                reason: String(dynamicReduction.reason ?? ""),
                softActivationRuleVersion: finiteNumber(
                  dynamicReduction.softActivationRuleVersion,
                ),
                softActivatedAtMs: finiteNumber(
                  dynamicReduction.softActivatedAtMs,
                ),
                softActivationRoePercent: finiteNumber(
                  dynamicReduction.softActivationRoePercent,
                ),
              }
            : null,
      });
      if (
        event &&
        await appendStrategyPositionManagementEvent({
          traceId: trace.traceId,
          strategyId: trace.strategyId,
          ...event,
        })
      ) written += 1;
    } catch {
      errors += 1;
    }
  }
  return { written, errors, deferred: false };
}

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

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
