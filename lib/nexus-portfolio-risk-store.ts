import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  executionIntents,
  portfolioRiskStates,
} from "../db/schema";
import {
  nexusCorrelationGroup,
  type NexusPortfolioExposure,
} from "./nexus-portfolio-risk";

const RESERVED_INTENT_STATUSES = [
  "RESERVED",
  "SUBMITTING",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "EXECUTION_UNKNOWN",
] as const;

export async function updateNexusPortfolioEquityPeak(input: {
  ownerEmail: string;
  accountId: string;
  currentEquityUsdt: number;
}) {
  const db = getDb();
  const currentEquityUsdt = Math.max(0, input.currentEquityUsdt);
  const [existing] = await db
    .select()
    .from(portfolioRiskStates)
    .where(
      and(
        eq(portfolioRiskStates.ownerEmail, input.ownerEmail),
        eq(portfolioRiskStates.accountId, input.accountId),
      ),
    )
    .limit(1);
  const peakAccountEquityUsdt = Math.max(
    currentEquityUsdt,
    existing?.peakAccountEquityUsdt ?? 0,
  );
  const lastDrawdownPercent = peakAccountEquityUsdt > 0
    ? Math.max(
        0,
        (peakAccountEquityUsdt - currentEquityUsdt) /
          peakAccountEquityUsdt *
          100,
      )
    : 0;
  const now = new Date();
  await db
    .insert(portfolioRiskStates)
    .values({
      ownerEmail: input.ownerEmail,
      accountId: input.accountId,
      peakAccountEquityUsdt,
      lastAccountEquityUsdt: currentEquityUsdt,
      lastDrawdownPercent,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        portfolioRiskStates.ownerEmail,
        portfolioRiskStates.accountId,
      ],
      set: {
        peakAccountEquityUsdt:
          sql`max(${portfolioRiskStates.peakAccountEquityUsdt}, ${peakAccountEquityUsdt})`,
        lastAccountEquityUsdt: currentEquityUsdt,
        lastDrawdownPercent,
        updatedAt: now,
      },
    });
  const [persisted] = await db
    .select()
    .from(portfolioRiskStates)
    .where(
      and(
        eq(portfolioRiskStates.ownerEmail, input.ownerEmail),
        eq(portfolioRiskStates.accountId, input.accountId),
      ),
    )
    .limit(1);
  const persistedPeak = Math.max(
    currentEquityUsdt,
    persisted?.peakAccountEquityUsdt ?? peakAccountEquityUsdt,
  );
  const persistedDrawdown = persistedPeak > 0
    ? Math.max(
        0,
        (persistedPeak - currentEquityUsdt) / persistedPeak * 100,
      )
    : 0;
  if (
    persisted &&
    Math.abs(persistedDrawdown - persisted.lastDrawdownPercent) > 1e-10
  )
    await db
      .update(portfolioRiskStates)
      .set({
        lastAccountEquityUsdt: currentEquityUsdt,
        lastDrawdownPercent: persistedDrawdown,
        updatedAt: now,
      })
      .where(eq(portfolioRiskStates.id, persisted.id));
  return {
    currentEquityUsdt,
    peakAccountEquityUsdt: persistedPeak,
    drawdownPercent: persistedDrawdown,
  };
}

export async function readNexusReservedRiskExposures(input: {
  ownerEmail: string;
  accountId: string;
  excludeTraceId?: string;
}) {
  const db = getDb();
  const rows = await db
    .select({
      strategyId: executionIntents.strategyId,
      symbol: executionIntents.symbol,
      positionSide: executionIntents.positionSide,
      riskBudgetUsdt: executionIntents.riskBudgetUsdt,
      detailJson: executionIntents.detailJson,
    })
    .from(executionIntents)
    .where(
      and(
        eq(executionIntents.ownerEmail, input.ownerEmail),
        eq(executionIntents.accountId, input.accountId),
        inArray(executionIntents.status, [...RESERVED_INTENT_STATUSES]),
        gt(executionIntents.expiresAt, new Date()),
        ...(input.excludeTraceId
          ? [ne(executionIntents.traceId, input.excludeTraceId)]
          : []),
      ),
    );
  return rows
    .filter((row) => row.riskBudgetUsdt > 0)
    .map(
      (row): NexusPortfolioExposure => ({
        strategyId: row.strategyId,
        symbol: row.symbol,
        positionSide: row.positionSide,
        correlationGroup: nexusCorrelationGroup(row.symbol),
        riskUsdt: row.riskBudgetUsdt,
        riskClass: reservedIntentRiskClass(row.detailJson),
        riskBasis: "RESERVED_INTENT",
      }),
    );
}

function reservedIntentRiskClass(value: string) {
  try {
    const parsed = JSON.parse(value) as {
      riskClass?: unknown;
      coordinator?: {
        decisions?: Array<{ riskClass?: unknown }>;
      };
    };
    return parsed.riskClass === "LEARNING_PROBE" ||
        parsed.coordinator?.decisions?.[0]?.riskClass === "LEARNING_PROBE"
      ? "LEARNING_PROBE" as const
      : "STANDARD" as const;
  } catch {
    return "STANDARD" as const;
  }
}
