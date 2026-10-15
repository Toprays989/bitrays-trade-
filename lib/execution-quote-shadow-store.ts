import { getDb } from "../db";
import { and, eq } from "drizzle-orm";
import {
  exchangeCredentials,
  executionQuoteShadows,
  livePositions,
} from "../db/schema";
import {
  buildExecutionQuoteShadow,
  directionalInventorySkew,
  type ExecutionQuoteOrigin,
  type ExecutionQuoteRole,
} from "./execution-quote-shadow";
import type { EntryExecutionShadow } from "./entry-execution-shadow";
import {
  getNexusLiveOrderFlow,
  type NexusLiveOrderFlow,
} from "./nexus-order-flow-live";

export type RecordExecutionQuoteShadowInput = {
  recordKey: string;
  quoteRole: ExecutionQuoteRole;
  liveOrderEventId?: number | null;
  positionId?: number | null;
  positionAdditionId?: number | null;
  clientOrderId: string;
  ownerEmail: string;
  accountId: string;
  strategyId?: number | null;
  traceId?: string | null;
  origin: ExecutionQuoteOrigin;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  actualOrderType: "MARKET" | "LIMIT";
  actualRequestedPrice: number;
  decisionMarkPrice: number;
  executableReferencePrice: number;
  priceTickSize: number;
  atr5m?: number | null;
  orderHorizonSeconds?: number | null;
  inventorySkewRatio?: number | null;
  tradeIntensityRatio?: number | null;
  bestBidQuantity?: number | null;
  bestAskQuantity?: number | null;
  orderFlow?: NexusLiveOrderFlow | null;
  urgency?: number | null;
  riskAversion?: number | null;
  entryExecutionShadow?: EntryExecutionShadow | null;
};

/**
 * Persist a counterfactual quote only. The function deliberately has no
 * dependency on an exchange client or order coordinator. Callers must treat a
 * null result as non-fatal so observation can never block live execution.
 */
export async function recordExecutionQuoteShadow(
  input: RecordExecutionQuoteShadowInput,
) {
  const model = buildExecutionQuoteShadow(input);
  if (!model) return null;
  const storedModel = {
    ...model,
    ...(input.entryExecutionShadow
      ? { entryExecutionShadow: input.entryExecutionShadow }
      : {}),
  };
  const now = new Date();
  const [row] = await getDb()
    .insert(executionQuoteShadows)
    .values({
      recordKey: input.recordKey,
      quoteRole: input.quoteRole,
      liveOrderEventId: input.liveOrderEventId ?? null,
      positionId: input.positionId ?? null,
      positionAdditionId: input.positionAdditionId ?? null,
      clientOrderId: input.clientOrderId,
      ownerEmail: input.ownerEmail,
      accountId: input.accountId,
      strategyId: input.strategyId ?? null,
      traceId: input.traceId ?? null,
      origin: input.origin,
      symbol: input.symbol,
      side: input.side,
      positionSide: input.positionSide,
      actualOrderType: input.actualOrderType,
      actualRequestedPrice: model.actualRequestedPrice,
      decisionMarkPrice: model.decisionMarkPrice,
      executableReferencePrice: model.executableReferencePrice,
      atr5m: input.atr5m ?? null,
      priceTickSize: input.priceTickSize,
      shadowReservationPrice: model.reservationPrice,
      shadowQuotePrice: model.shadowQuotePrice,
      actualDistanceBps: model.actualDistanceBps,
      shadowDistanceBps: model.shadowDistanceBps,
      theoreticalImprovementBps: model.theoreticalImprovementBps,
      shadowImmediatelyMarketable: model.immediatelyMarketable,
      modelVersion: model.modelVersion,
      modelJson: JSON.stringify(storedModel),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function safelyRecordExecutionQuoteShadow(
  input: RecordExecutionQuoteShadowInput,
) {
  try {
    return await recordExecutionQuoteShadow(input);
  } catch (error) {
    console.warn("[execution-quote-shadow] observation skipped", {
      recordKey: input.recordKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export type ObserveExecutionQuoteInput = Omit<
  RecordExecutionQuoteShadowInput,
  "inventorySkewRatio"
> & { prospectiveNotionalUsdt?: number | null };

/**
 * Resolve the account's signed live inventory before producing the shadow.
 * Synchronized Binance margin balance is preferred; the configured account
 * equity is only a fallback. This lookup is observational and never locks or
 * mutates a position.
 */
export async function observeExecutionQuote(input: ObserveExecutionQuoteInput) {
  try {
    const db = getDb();
    const orderFlowPromise = getNexusLiveOrderFlow([input.symbol])
      .then((snapshot) => snapshot.rows.find(
        (row) => row.symbol === input.symbol.trim().toUpperCase(),
      ) ?? null)
      .catch(() => null);
    const [
      positions,
      credentialRows,
      orderFlow,
    ] = await Promise.all([
      db.select({
        positionSide: livePositions.positionSide,
        quantity: livePositions.quantity,
        markPrice: livePositions.markPrice,
      }).from(livePositions).where(and(
        eq(livePositions.ownerEmail, input.ownerEmail),
        eq(livePositions.accountId, input.accountId),
        eq(livePositions.status, "OPEN"),
      )),
      db.select({
        totalMarginBalance: exchangeCredentials.totalMarginBalance,
        availableBalance: exchangeCredentials.availableBalance,
      }).from(exchangeCredentials).where(and(
        eq(exchangeCredentials.ownerEmail, input.ownerEmail),
        eq(exchangeCredentials.accountId, input.accountId),
      )).limit(1),
      orderFlowPromise,
    ]);
    const accountEquity = positiveNumber(credentialRows[0]?.totalMarginBalance) ??
      positiveNumber(credentialRows[0]?.availableBalance);
    const inventorySkewRatio = directionalInventorySkew({
      positions,
      accountEquityUsdt: accountEquity,
      prospectiveSide: input.side,
      prospectiveNotionalUsdt: input.prospectiveNotionalUsdt ?? null,
    });
    return await recordExecutionQuoteShadow({
      ...input,
      inventorySkewRatio,
      orderFlow,
    });
  } catch (error) {
    console.warn("[execution-quote-shadow] observation skipped", {
      recordKey: input.recordKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function positiveNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
