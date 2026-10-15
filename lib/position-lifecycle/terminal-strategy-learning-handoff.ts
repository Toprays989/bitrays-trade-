import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notLike,
  or,
} from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  livePositionReductions,
  livePositions,
  strategies,
  strategyExecutionTraces,
  strategyLearningCycles,
  strategyPositionEvidence,
} from "../../db/schema.ts";
import { positionRoePercent } from "../position-roe.ts";
import { aggregatePositionReductionCycle } from
  "../live-position-cycle-accounting.ts";
import {
  closedStrategyTraceResult,
  strategyTerminalObservationMinute,
} from "../strategy-trace-lifecycle.ts";
import { resolveNexusEntryAuthorization } from
  "../nexus-entry-authorization.ts";
import {
  patchNexusFastLearningReceipt,
  saveNexusLearningCycle,
  supersedeActualLearningCycleAfterManualIntervention,
} from "../nexus-learning-cycle-store.ts";
import {
  buildTerminalStrategyLearningReceipt,
  shouldFinalizeTerminalFastObservation,
} from "../terminal-strategy-learning-receipt.ts";
import { mergeTerminalPositionObservation } from
  "../position-observation-timing.ts";
import {
  appendClosedStrategyPositionEvent,
  appendStrategyPositionManagementEvent,
} from "./strategy-position-event-store.ts";

export const TERMINAL_STRATEGY_LEARNING_HANDOFF_VERSION =
  "terminal-strategy-learning-handoff-v1" as const;

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

function sqlValueBatches<T>(values: T[], batchSize = 50) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize)
    result.push(values.slice(index, index + batchSize));
  return result;
}

async function recordTerminalStrategyPositionEvidence(input: {
  traceId: string;
  strategyId: number;
  position: typeof livePositions.$inferSelect;
  closedAt: Date;
}) {
  const minuteOffset = strategyTerminalObservationMinute(
    input.position.openedAt,
    input.closedAt,
  );
  if (minuteOffset === null) return false;
  const db = getDb();
  const [rows, reductions] = await Promise.all([
    db
      .select()
      .from(strategyPositionEvidence)
      .where(eq(strategyPositionEvidence.traceId, input.traceId)),
    db
      .select({
        quantity: livePositionReductions.quantity,
        reason: livePositionReductions.reason,
        realizedPnl: livePositionReductions.realizedPnl,
        responseJson: livePositionReductions.responseJson,
      })
      .from(livePositionReductions)
      .where(eq(livePositionReductions.positionId, input.position.id)),
  ]);
  const reductionCycle = aggregatePositionReductionCycle(reductions);
  const exactNetPnl =
    reductionCycle.exactNetAvailable ? reductionCycle.pnl : null;
  const existing = rows.find((row) => row.minuteOffset === minuteOffset);
  const terminalRoePercent = positionRoePercent(
    input.position.entryPrice,
    input.position.markPrice,
    input.position.leverage,
    input.position.positionSide,
  );
  if (!Number.isFinite(terminalRoePercent)) return false;
  const priorMfe = rows
    .map((row) => row.mfeRoePercent)
    .filter((value): value is number => value !== null);
  const priorMae = rows
    .map((row) => row.maeRoePercent)
    .filter((value): value is number => value !== null);
  const mfeRoePercent = Math.max(
    terminalRoePercent,
    ...priorMfe,
  );
  const maeRoePercent = Math.min(
    terminalRoePercent,
    ...priorMae,
  );
  const terminalSettlement = {
    closedAt: input.closedAt.toISOString(),
    exitReason: input.position.exitReason ?? "UNKNOWN",
    exitPrice: input.position.markPrice,
    grossRealizedPnl: Number.isFinite(input.position.realizedPnl)
      ? input.position.realizedPnl
      : null,
    netRealizedPnl: exactNetPnl,
    exactNetAvailable: reductionCycle.exactNetAvailable,
    reductionCount: reductionCycle.count,
    reductionReasons: [...new Set(reductionCycle.reasons)],
    reductionAttributions: [...new Set(reductionCycle.attributions)],
    reductionAttributionCounts: reductionCycle.attributionCounts,
    purpose:
      "REMOVE_LONG_HOLD_SURVIVORSHIP_BIAS_WITH_ACTUAL_POSITION_TERMINAL",
  };
  if (existing) {
    const evidence = record(parseJson(existing.evidenceJson));
    await db
      .update(strategyPositionEvidence)
      .set(mergeTerminalPositionObservation({
        existingEvidence: evidence,
        terminalSettlement,
        netPnlEstimate: exactNetPnl,
        mfeRoePercent,
        maeRoePercent,
      }))
      .where(eq(strategyPositionEvidence.id, existing.id));
    return true;
  }
  await db.insert(strategyPositionEvidence).values({
    traceId: input.traceId,
    strategyId: input.strategyId,
    minuteOffset,
    scheduledAt: input.closedAt,
    sampledAt: input.closedAt,
    sampleDelayMs: 0,
    status: "CLOSED",
    markPrice: input.position.markPrice,
    entryPrice: input.position.entryPrice,
    remainingQty: 0,
    unrealizedPnl: null,
    netPnlEstimate: exactNetPnl,
    roePercent: terminalRoePercent,
    mfeRoePercent,
    maeRoePercent,
    evidenceJson: JSON.stringify({
      source: "ACTUAL_POSITION_TERMINAL_SETTLEMENT",
      evidenceCompleteness: "TERMINAL_SETTLEMENT",
      sampleType: "POSITION_TERMINAL_SETTLEMENT",
      modelCheckpoint: false,
      longHoldObservation: false,
      positionSide: input.position.positionSide,
      leverage: input.position.leverage,
      pnlBasis: reductionCycle.exactNetAvailable
        ? "NET_EXACT_INCLUDES_FEES_AND_ATTRIBUTABLE_FUNDING"
        : "GROSS_EXIT_ROE_EXCLUDES_UNAVAILABLE_COSTS",
      terminalSettlement,
    }),
    createdAt: input.closedAt,
  }).onConflictDoNothing();
  return true;
}

async function persistTerminalStrategyLearningReceipt(input: {
  trace: {
    traceId: string;
    strategyId: number;
    configVersion: number;
    entryEvidenceJson: string;
  };
  position: typeof livePositions.$inferSelect;
  closedAt: Date;
  fastLearningOnly?: boolean;
  finalizeFastObservation?: boolean;
}) {
  const db = getDb();
  const [strategyIdentity, checkpoints, reductions] = await Promise.all([
    db
      .select({
        accountId: strategies.accountId,
        brainKey: strategies.brainKey,
      })
      .from(strategies)
      .where(eq(strategies.id, input.trace.strategyId))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        minuteOffset: strategyPositionEvidence.minuteOffset,
        status: strategyPositionEvidence.status,
      })
      .from(strategyPositionEvidence)
      .where(eq(strategyPositionEvidence.traceId, input.trace.traceId)),
    db
      .select({
        quantity: livePositionReductions.quantity,
        reason: livePositionReductions.reason,
        realizedPnl: livePositionReductions.realizedPnl,
        responseJson: livePositionReductions.responseJson,
      })
      .from(livePositionReductions)
      .where(eq(livePositionReductions.positionId, input.position.id)),
  ]);
  if (!strategyIdentity?.brainKey) return false;
  const reductionCycle = aggregatePositionReductionCycle(reductions);
  const exactInitialMarginUsdt =
    reductionCycle.exactNetAvailable &&
      reductionCycle.quantity > 0 &&
      input.position.entryPrice > 0 &&
      input.position.leverage > 0
      ? input.position.entryPrice * reductionCycle.quantity /
        input.position.leverage
      : null;
  const exactNetRoePercent =
    exactInitialMarginUsdt !== null && exactInitialMarginUsdt > 0
      ? reductionCycle.pnl / exactInitialMarginUsdt * 100
      : null;
  const entryEvidence = record(parseJson(input.trace.entryEvidenceJson));
  const authorization = resolveNexusEntryAuthorization(entryEvidence, {
    allowLegacy: true,
  });
  const manualIntervention =
    input.position.exitReason === "MANUAL" ||
    reductionCycle.reasons.includes("MANUAL");
  const exitReasons = [...new Set([
    ...reductionCycle.reasons,
    ...(input.position.exitReason ? [input.position.exitReason] : []),
  ])];
  const grossRealizedPnlUsdt = reductionCycle.count > 0
    ? reductionCycle.grossPnl
    : input.position.exitReason === "EXTERNAL" &&
        input.position.realizedPnl === 0
      ? null
      : input.position.realizedPnl;
  const holdingDurationMinutes = Math.max(
    0,
    (input.closedAt.getTime() - input.position.openedAt.getTime()) / 60_000,
  );
  const receipt = buildTerminalStrategyLearningReceipt({
    brainKey: strategyIdentity.brainKey,
    strategyId: input.trace.strategyId,
    configVersion: input.trace.configVersion,
    traceId: input.trace.traceId,
    accountId: strategyIdentity.accountId,
    symbol: input.position.symbol,
    positionSide: input.position.positionSide === "SHORT" ? "SHORT" : "LONG",
    positionId: input.position.id,
    entryEvidence,
    entryDecisionHandoffJson: input.position.entryDecisionHandoffJson,
    entryAuthorizationMode:
      authorization.mode === "EXPLORATION_PROBE"
        ? "EXPLORATION_PROBE"
        : "CONFIRMED_EYE",
    manualIntervention,
    checkpoints: checkpoints.map((checkpoint) => ({
      minuteOffset: checkpoint.minuteOffset,
      status: checkpoint.status,
      brainKey: strategyIdentity.brainKey,
      configVersion: input.trace.configVersion,
    })),
    terminalObservationMinute: strategyTerminalObservationMinute(
      input.position.openedAt,
      input.closedAt,
    ),
    exactNetAvailable: reductionCycle.exactNetAvailable,
    exactNetPnlUsdt: reductionCycle.exactNetAvailable
      ? reductionCycle.pnl
      : null,
    exactNetRoePercent,
    grossRealizedPnlUsdt,
    reductionCount: reductionCycle.count,
    exitReasons,
    reductionAttributions: reductionCycle.attributions,
    holdingDurationMinutes,
    netSettlementStatus: reductionCycle.count > 0
      ? reductionCycle.netSettlementStatus
      : "UNAVAILABLE",
    completedAt: input.closedAt,
  });
  if (input.fastLearningOnly) {
    if (!receipt.fastLearning) return false;
    const patched = await patchNexusFastLearningReceipt({
      learningKey: receipt.learningKey,
      fastLearning: receipt.fastLearning,
      memoryCase: receipt.memoryCase,
      finalizeObservationOnly:
        input.finalizeFastObservation === true &&
        shouldFinalizeTerminalFastObservation(receipt),
    });
    if (patched && receipt.manualIntervention) {
      await supersedeActualLearningCycleAfterManualIntervention({
        traceId: input.trace.traceId,
        manualLearningKey: receipt.learningKey,
        observedAt: input.closedAt,
      });
    }
    return patched;
  }
  await saveNexusLearningCycle(receipt, input.closedAt);
  await appendStrategyPositionManagementEvent({
    traceId: input.trace.traceId,
    strategyId: input.trace.strategyId,
    eventType: "TERMINAL_LEARNING_RECEIPT",
    outcome: "INFO",
    message:
      "策略订单平仓结果已由所属大脑快速吸收；费用和时机因果证据由后台继续补全。",
    detail: {
      learningKey: receipt.learningKey,
      positionId: input.position.id,
      configVersion: input.trace.configVersion,
      exactNetAvailable: receipt.exactNetAvailable,
      fastLearningStatus: receipt.fastLearning?.status ?? "UNAVAILABLE",
      timingAttribution:
        receipt.fastLearning?.timingAttribution ?? "UNAVAILABLE",
      netSettlement: receipt.fastLearning?.netSettlement ?? "UNAVAILABLE",
      eligibility: receipt.eligibility,
      blockedReasons: receipt.blockedReasons,
      orderAffecting: false,
      liveConfigMutationAllowed: false,
    },
    eventAt: input.closedAt,
  });
  return true;
}

async function backfillMissingTerminalStrategyLearningReceipts(
  now: Date,
  budget = 25,
) {
  const db = getDb();
  const rows = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      positionId: strategyExecutionTraces.positionId,
      learningKey: strategyLearningCycles.learningKey,
    })
    .from(strategyExecutionTraces)
    .leftJoin(
      strategyLearningCycles,
      eq(strategyExecutionTraces.traceId, strategyLearningCycles.traceId),
    )
    .where(and(
      eq(strategyExecutionTraces.state, "CLOSED"),
      isNotNull(strategyExecutionTraces.positionId),
      ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
      or(
        isNull(strategyLearningCycles.id),
        and(
          eq(strategyLearningCycles.eligibility, "INCOMPLETE"),
          or(
            isNull(strategyLearningCycles.detailJson),
            notLike(
              strategyLearningCycles.detailJson,
              '%"fastLearning"%',
            ),
          ),
        ),
      ),
    ))
    .orderBy(desc(strategyExecutionTraces.completedAt))
    .limit(Math.max(1, Math.min(50, Math.trunc(budget))));
  let recorded = 0;
  let errors = 0;
  for (const trace of rows) {
    const positionId = Number(trace.positionId);
    if (!Number.isInteger(positionId) || positionId < 1) continue;
    try {
      const [position] = await db
        .select()
        .from(livePositions)
        .where(and(
          eq(livePositions.id, positionId),
          eq(livePositions.status, "CLOSED"),
        ))
        .limit(1);
      if (!position?.closedAt) continue;
      if (await persistTerminalStrategyLearningReceipt({
        trace,
        position,
        closedAt: position.closedAt,
        fastLearningOnly: Boolean(trace.learningKey),
        finalizeFastObservation: Boolean(trace.learningKey),
      })) recorded += 1;
    } catch {
      errors += 1;
    }
  }
  return { recorded, errors, checkedAt: now.toISOString() };
}

export async function settleClosedStrategyTraces(
  now: Date,
  refreshStrategyParameterSuggestions: (
    trace: typeof strategyExecutionTraces.$inferSelect,
  ) => Promise<unknown>,
) {
  const db = getDb();
  const traces = await db
    .select()
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.state, "POSITION_OPEN"),
        isNotNull(strategyExecutionTraces.positionId),
      ),
    )
    .orderBy(desc(strategyExecutionTraces.id))
    // Fetch beyond the number of currently OPEN positions so closed traces
    // cannot be starved from the settlement batch by newer live rows.
    .limit(500);
  const positionIds = [
    ...new Set(
      traces
        .map((trace) => Number(trace.positionId))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!positionIds.length) {
    const receiptBackfill =
      await backfillMissingTerminalStrategyLearningReceipts(now);
    return {
      settled: 0,
      learningReceipts: receiptBackfill.recorded,
      learningErrors: receiptBackfill.errors,
    };
  }

  const positions: (typeof livePositions.$inferSelect)[] = [];
  // Production D1 has a deliberately small bind-parameter ceiling.  The
  // settlement backlog can exceed it after a busy trading period, so read the
  // authoritative closed positions in bounded batches instead of allowing one
  // oversized IN clause to disable the whole maintenance cycle.
  for (const positionIdBatch of sqlValueBatches(positionIds)) {
    positions.push(
      ...await db
        .select()
        .from(livePositions)
        .where(
          and(
            inArray(livePositions.id, positionIdBatch),
            eq(livePositions.status, "CLOSED"),
          ),
        ),
    );
  }
  const positionMap = new Map(
    positions.map((position) => [position.id, position]),
  );
  let settled = 0;
  let learningReceipts = 0;
  let learningErrors = 0;
  for (const trace of traces) {
    // Terminal settlement also writes lifecycle events and learning evidence.
    // Keep this work deliberately small so a historical backlog can never
    // monopolize the application during account-audit startup or block the UI.
    if (settled >= 10) break;
    const position = positionMap.get(Number(trace.positionId));
    if (!position) continue;
    const closure = closedStrategyTraceResult(position, now);
    if (!closure) continue;
    const [updated] = await db
      .update(strategyExecutionTraces)
      .set({
        state: closure.state,
        resultCode: closure.resultCode,
        resultMessage: closure.resultMessage,
        completedAt: closure.completedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(strategyExecutionTraces.id, trace.id),
          eq(strategyExecutionTraces.state, "POSITION_OPEN"),
          eq(strategyExecutionTraces.positionId, String(position.id)),
        ),
      )
      .returning({ id: strategyExecutionTraces.id });
    if (!updated) continue;
    settled += 1;
    try {
      await appendClosedStrategyPositionEvent({
        traceId: trace.traceId,
        strategyId: trace.strategyId,
        message: closure.resultMessage,
        detail: closure.detail,
        eventAt: closure.completedAt,
      });
      if (trace.triggerKind !== "THREE_MINUTE_PROBABILITY") {
        await recordTerminalStrategyPositionEvidence({
          traceId: trace.traceId,
          strategyId: trace.strategyId,
          position,
          closedAt: closure.completedAt,
        });
        if (await persistTerminalStrategyLearningReceipt({
          trace,
          position,
          closedAt: closure.completedAt,
        })) learningReceipts += 1;
        await refreshStrategyParameterSuggestions(trace);
      }
    } catch {
      // 轨迹已经完成结算；学习维护失败不得阻塞实盘仓位保护主循环。
      learningErrors += 1;
    }
  }
  const receiptBackfill =
    await backfillMissingTerminalStrategyLearningReceipts(now);
  return {
    settled,
    learningReceipts: learningReceipts + receiptBackfill.recorded,
    learningErrors: learningErrors + receiptBackfill.errors,
  };
}
