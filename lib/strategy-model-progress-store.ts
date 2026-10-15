import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  strategyExecutionTraces,
  strategyLearningCycles,
} from "../db/schema";
import { chinaTradingDayWindow } from "./trading-calendar.ts";

const committedEntryPredicate = sql`(
  (${strategyExecutionTraces.positionId} is not null and trim(${strategyExecutionTraces.positionId}) <> '')
  or ${strategyExecutionTraces.state} = 'EXECUTION_UNKNOWN'
  or (
    ${strategyExecutionTraces.exchangeOrderId} is not null
    and trim(${strategyExecutionTraces.exchangeOrderId}) <> ''
    and ${strategyExecutionTraces.state} in (
      'ORDER_PENDING',
      'POSITION_OPEN',
      'TRAILING_ARMED',
      'TRAILING_ACTIVE',
      'EXIT_PENDING',
      'CLOSED'
    )
  )
)`;

/** Compact indexed counters for the hot entry path; no raw trace JSON rows. */
export async function readStrategyModelProgressCounts(input: {
  ownerEmail: string;
  strategyId: number;
  configVersion: number;
}) {
  const db = getDb();
  const { startedAt } = chinaTradingDayWindow();
  const [lifetimeRows, dailyRows, exactRows] = await Promise.all([
    db
      .select({
        value: sql<number>`coalesce(sum(case when ${committedEntryPredicate} then 1 else 0 end), 0)`,
      })
      .from(strategyExecutionTraces)
      .where(
        and(
          eq(strategyExecutionTraces.ownerEmail, input.ownerEmail),
          eq(strategyExecutionTraces.strategyId, input.strategyId),
        ),
      ),
    db
      .select({
        value: sql<number>`coalesce(sum(case when ${committedEntryPredicate} then 1 else 0 end), 0)`,
      })
      .from(strategyExecutionTraces)
      .where(
        and(
          eq(strategyExecutionTraces.ownerEmail, input.ownerEmail),
          eq(strategyExecutionTraces.strategyId, input.strategyId),
          gte(strategyExecutionTraces.createdAt, startedAt),
        ),
      ),
    db
      .select({ value: sql<number>`count(*)` })
      .from(strategyLearningCycles)
      .where(
        and(
          eq(strategyLearningCycles.strategyId, input.strategyId),
          eq(strategyLearningCycles.configVersion, input.configVersion),
          eq(strategyLearningCycles.path, "ACTUAL_POSITION"),
          eq(strategyLearningCycles.terminalStatus, "CLOSED"),
          eq(strategyLearningCycles.exactNetAvailable, true),
        ),
      ),
  ]);
  return {
    committedEntryOrders: normalizedCount(lifetimeRows[0]?.value),
    dailyCommittedEntryOrders: normalizedCount(dailyRows[0]?.value),
    completedExactNetOrders: normalizedCount(exactRows[0]?.value),
  };
}

function normalizedCount(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
