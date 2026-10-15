import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  executionQuoteShadows,
  liveOrderEvents,
  livePositionAdditions,
  livePositionReductions,
  strategyExecutionTraces,
  strategyPositionEvidence,
} from "../../../../db/schema";
import { shadowFillEvidence } from "../../../../lib/execution-quote-shadow";
import type {
  EntryExecutionShadow,
  EntryExecutionShadowCheckpoint,
} from "../../../../lib/entry-execution-shadow";
import {
  buildExecutionShadowBrainEvidence,
  entryExecutionShadowFromUnknown,
  summarizeExecutionShadowBrainEvidence,
} from "../../../../lib/execution-shadow-brain-evidence";
import {
  attributeOrderFlowExecution,
  summarizeOrderFlowAttributions,
} from "../../../../lib/order-flow-execution-attribution";
import { isResponse, requirePermission, writeAudit } from "../shared";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;
const SQLITE_IN_BATCH_SIZE = 50;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function parseJson(value: unknown) {
  try {
    return asRecord(JSON.parse(typeof value === "string" ? value : "{}"));
  } catch {
    return {};
  }
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function orderFillPrice(responseJson: string) {
  const response = parseJson(responseJson);
  const data = asRecord(response.data);
  for (const candidate of [
    response.avgPrice,
    response.averagePrice,
    response.price,
    data.avgPrice,
    data.averagePrice,
    data.price,
  ]) {
    const price = positive(candidate);
    if (price !== null) return price;
  }
  const executed = positive(response.executedQty) ?? positive(data.executedQty);
  const quote = positive(response.cumQuote) ?? positive(data.cumQuote);
  return executed && quote ? quote / executed : null;
}

function adverseSlippageBps(
  side: "BUY" | "SELL",
  fill: number | null,
  reference: number,
) {
  if (!fill || !(reference > 0)) return null;
  return (side === "BUY" ? fill - reference : reference - fill) /
    reference * 10_000;
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId")?.trim() || "";
  const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() || "";
  const role = url.searchParams.get("role")?.trim().toUpperCase() || "";
  const verdict = url.searchParams.get("verdict")?.trim().toUpperCase() || "";
  const requestedStrategyId = Number(url.searchParams.get("strategyId"));
  const strategyId = Number.isInteger(requestedStrategyId) && requestedStrategyId > 0
    ? requestedStrategyId
    : null;
  const requestedConfigVersion = Number(url.searchParams.get("configVersion"));
  const configVersion = Number.isInteger(requestedConfigVersion) && requestedConfigVersion > 0
    ? requestedConfigVersion
    : null;
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Math.min(200, Math.max(20, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const db = getDb();
  const allRows = await db
    .select()
    .from(executionQuoteShadows)
    .where(eq(executionQuoteShadows.ownerEmail, user.email))
    .orderBy(desc(executionQuoteShadows.id))
    .limit(500);
  const allTraceIds = [...new Set(allRows
    .map((row) => row.traceId)
    .filter((value): value is string => Boolean(value)))];
  const traceRows: Array<{
    traceId: string;
    strategyId: number | null;
    configVersion: number;
    eventTime: Date;
    entryEvidenceJson: string;
  }> = [];
  for (let index = 0; index < allTraceIds.length; index += SQLITE_IN_BATCH_SIZE) {
    const batch = allTraceIds.slice(index, index + SQLITE_IN_BATCH_SIZE);
    traceRows.push(...await db.select({
        traceId: strategyExecutionTraces.traceId,
        strategyId: strategyExecutionTraces.strategyId,
        configVersion: strategyExecutionTraces.configVersion,
        eventTime: strategyExecutionTraces.eventTime,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      }).from(strategyExecutionTraces).where(
        inArray(strategyExecutionTraces.traceId, batch),
      ));
  }
  const traceById = new Map(traceRows.map((row) => [row.traceId, row]));
  const rows = allRows.filter((row) => {
    const trace = row.traceId ? traceById.get(row.traceId) : null;
    return (
    (!accountId || row.accountId === accountId) &&
    (!symbol || row.symbol.includes(symbol)) &&
    (!role || row.quoteRole === role) &&
    (!strategyId || row.strategyId === strategyId) &&
    (!configVersion || trace?.configVersion === configVersion) &&
    (!verdict || row.operatorVerdict === verdict)
    );
  }).slice(0, limit);

  const traceIds = [...new Set(rows
    .map((row) => row.traceId)
    .filter((value): value is string => Boolean(value)))];
  const evidenceRows: Array<{
    traceId: string;
    minuteOffset: number;
    markPrice: number | null;
    entryPrice: number;
    roePercent: number | null;
    mfeRoePercent: number | null;
    maeRoePercent: number | null;
  }> = [];
  for (let index = 0; index < traceIds.length; index += SQLITE_IN_BATCH_SIZE) {
    const batch = traceIds.slice(index, index + SQLITE_IN_BATCH_SIZE);
    evidenceRows.push(...await db.select({
        traceId: strategyPositionEvidence.traceId,
        minuteOffset: strategyPositionEvidence.minuteOffset,
        markPrice: strategyPositionEvidence.markPrice,
        entryPrice: strategyPositionEvidence.entryPrice,
        roePercent: strategyPositionEvidence.roePercent,
        mfeRoePercent: strategyPositionEvidence.mfeRoePercent,
        maeRoePercent: strategyPositionEvidence.maeRoePercent,
      }).from(strategyPositionEvidence).where(
        inArray(strategyPositionEvidence.traceId, batch),
      ));
  }
  const evidenceByTrace = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const current = evidenceByTrace.get(row.traceId) ?? [];
    current.push(row);
    evidenceByTrace.set(row.traceId, current);
  }

  const [orders, additions, reductions] = await Promise.all([
    db.select().from(liveOrderEvents)
      .where(eq(liveOrderEvents.ownerEmail, user.email))
      .orderBy(desc(liveOrderEvents.id)).limit(1000),
    db.select().from(livePositionAdditions)
      .where(eq(livePositionAdditions.ownerEmail, user.email))
      .orderBy(desc(livePositionAdditions.id)).limit(1000),
    db.select().from(livePositionReductions)
      .where(eq(livePositionReductions.ownerEmail, user.email))
      .orderBy(desc(livePositionReductions.id)).limit(1000),
  ]);
  const orderById = new Map(orders.map((row) => [row.id, row]));
  const additionById = new Map(additions.map((row) => [row.id, row]));
  const reductionByClient = new Map(reductions.map((row) => [row.clientOrderId, row]));

  const items = rows.map((row) => {
    const model = parseJson(row.modelJson);
    const order = row.liveOrderEventId ? orderById.get(row.liveOrderEventId) : null;
    const addition = row.positionAdditionId ? additionById.get(row.positionAdditionId) : null;
    const reduction = reductionByClient.get(row.clientOrderId);
    const actualFillPrice = row.quoteRole === "EXIT"
      ? positive(reduction?.exitPrice)
      : row.quoteRole === "ADD"
        ? positive(addition?.entryPrice)
        : order
          ? orderFillPrice(order.responseJson)
          : null;
    const actualStatus = row.quoteRole === "EXIT"
      ? (reduction ? "FILLED" : "PENDING")
      : row.quoteRole === "ADD"
        ? (addition?.status ?? "PENDING")
        : (order?.status ?? "PENDING");
    const fillEvidence = shadowFillEvidence({
      side: row.side,
      shadowQuotePrice: row.shadowQuotePrice,
      actualFillPrice,
    });
    const entryExecutionShadow = entryExecutionShadowFromUnknown(
      model.entryExecutionShadow,
    );
    const traceEvidence = row.traceId
      ? evidenceByTrace.get(row.traceId) ?? []
      : [];
    const actualEntryPrice =
      positive(traceEvidence[0]?.entryPrice) ??
      actualFillPrice ??
      row.actualRequestedPrice;
    const executionShadowBrainEvidence =
      entryExecutionShadow && row.quoteRole === "ENTRY"
      ? buildExecutionShadowBrainEvidence({
          traceId: row.traceId ?? `quote-shadow-${row.id}`,
          positionSide: row.positionSide,
          actualEntryPrice,
          rawShadow: entryExecutionShadow,
          samples: traceEvidence.map((sample) => ({
            minuteOffset: sample.minuteOffset,
            markPrice: sample.markPrice,
          })),
        })
      : null;
    const entryPolicyCheckpoints = executionShadowBrainEvidence
      ? executionShadowBrainEvidence.checkpoints
      : [];
    const trace = row.traceId ? traceById.get(row.traceId) : null;
    const traceEvidenceRecord = parseJson(trace?.entryEvidenceJson);
    const configuredMarketClusterId =
      typeof traceEvidenceRecord.marketClusterId === "string" &&
      traceEvidenceRecord.marketClusterId.trim()
        ? traceEvidenceRecord.marketClusterId.trim()
        : null;
    const independenceKey = configuredMarketClusterId ??
      `execution-wave-${row.positionSide}-${Math.floor(
        (trace?.eventTime ?? row.createdAt).getTime() / 120_000,
      )}`;
    const orderFlowAttribution = attributeOrderFlowExecution({
      quoteRole: row.quoteRole,
      evidenceKind: model.orderFlowEvidenceKind,
      evidenceReady: model.orderFlowEvidenceReady,
      proxyState: model.orderFlowProxyState,
      confidence: model.orderFlowConfidence,
      directionalPressure: model.directionalOrderFlowPressure,
      leverage: entryExecutionShadow?.leverage,
      actualOrderType: row.actualOrderType,
      actualAdverseSlippageBps: adverseSlippageBps(
        row.side,
        actualFillPrice,
        row.executableReferencePrice,
      ),
      theoreticalImprovementBps: row.theoreticalImprovementBps,
      checkpoints: traceEvidence,
    });
    return {
      ...row,
      model,
      actualStatus,
      actualFillPrice,
      actualAdverseSlippageBps: adverseSlippageBps(
        row.side,
        actualFillPrice,
        row.executableReferencePrice,
      ),
      shadowFillEvidence: fillEvidence,
      entryExecutionShadow,
      entryPolicyCheckpoints,
      executionShadowBrainEvidence,
      configVersion: trace?.configVersion ?? null,
      independenceKey,
      orderFlowAttribution,
    };
  });
  const filled = items.filter((item) => item.actualFillPrice !== null);
  const average = (values: Array<number | null>) => {
    const valid = values.filter((value): value is number => Number.isFinite(value));
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  };
  return Response.json({
    items,
    summary: {
      total: items.length,
      filled: filled.length,
      exchangeRejected: items.filter((item) => item.actualStatus === "REJECTED").length,
      shadowFillConfirmed: items.filter((item) => item.shadowFillEvidence.status === "CONFIRMED_AT_ACTUAL_FILL").length,
      marketRecommendations: items.filter((item) => item.model.recommendedOrderType === "MARKET").length,
      limitRecommendations: items.filter((item) => item.model.recommendedOrderType === "LIMIT").length,
      averageActualAdverseSlippageBps: average(items.map((item) => item.actualAdverseSlippageBps)),
      averageTheoreticalImprovementBps: average(items.map((item) => item.theoreticalImprovementBps)),
    },
    entryPolicySummary: summarizeEntryPolicy(items),
    brainAuxiliaryEvidence: summarizeExecutionShadowBrainEvidence(
      items.map((item) => ({
        traceId: item.traceId ?? `quote-shadow-${item.id}`,
        independenceKey: item.independenceKey,
        strategyId: item.strategyId,
        configVersion: item.configVersion,
        createdAtMs: item.createdAt.getTime(),
        evidence: item.executionShadowBrainEvidence,
      })),
    ),
    orderFlowOutcomeSummary: summarizeOrderFlowAttributions(
      items.map((item) => item.orderFlowAttribution),
    ),
  });
}

function summarizeEntryPolicy(items: Array<{
  entryExecutionShadow: EntryExecutionShadow | null;
  entryPolicyCheckpoints: EntryExecutionShadowCheckpoint[];
}>) {
  const comparable = items.filter((item) => item.entryExecutionShadow);
  const adaptiveLimit = comparable.filter(
    (item) => item.entryExecutionShadow?.adaptiveOrderType === "LIMIT",
  );
  const adaptiveMarket = comparable.length - adaptiveLimit.length;
  const horizons = ([5, 30, 60] as const).map((minute) => {
    const checkpoints = comparable
      .map((item) => ({
        point: item.entryPolicyCheckpoints.find((point) => point.minute === minute),
        feeRoePercent: Math.max(
          0,
          Number(item.entryExecutionShadow?.leverage ?? 1) * 0.08,
        ),
      }))
      .filter((item): item is {
        point: EntryExecutionShadowCheckpoint;
        feeRoePercent: number;
      } => Boolean(item.point) && item.point!.status !== "INSUFFICIENT")
      .map((item) => ({ ...item, point: item.point! }));
    const filled = checkpoints.filter((item) => item.point.status === "FILLED");
    const mean = (values: number[]) => values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    return {
      minute,
      samples: checkpoints.length,
      shadowFilled: filled.length,
      shadowSkipped: checkpoints.length - filled.length,
      actualAverageNetRoePercent: mean(checkpoints
        .map(({ point, feeRoePercent }) =>
          point.actualRoePercent === null
            ? null
            : point.actualRoePercent - feeRoePercent)
        .filter((value): value is number => Number.isFinite(value))),
      shadowAverageNetRoePerOpportunityPercent: mean(checkpoints
        .map(({ point, feeRoePercent }) =>
          point.status === "FILLED" && point.shadowRoePercent !== null
            ? point.shadowRoePercent - feeRoePercent
            : 0)),
      averageNetAdvantageRoePercent: mean(checkpoints
        .map(({ point, feeRoePercent }) => {
          if (point.actualRoePercent === null) return null;
          const actualNet = point.actualRoePercent - feeRoePercent;
          const shadowNet = point.status === "FILLED" && point.shadowRoePercent !== null
            ? point.shadowRoePercent - feeRoePercent
            : 0;
          return shadowNet - actualNet;
        })
        .filter((value): value is number => Number.isFinite(value))),
    };
  });
  return {
    version: "nexus-entry-distance-shadow-v1",
    mode: comparable[0]?.entryExecutionShadow?.activationMode ?? "SHADOW",
    opportunities: comparable.length,
    adaptiveMarket,
    adaptiveLimit: adaptiveLimit.length,
    differsFromActual: comparable.filter(
      (item) => item.entryExecutionShadow?.recommendationDiffers,
    ).length,
    horizons,
    minimumComparableOpportunities: 30,
    recentHoldoutMinimum: 9,
    status: comparable.length >= 30 ? "REVIEW_READY" : "COLLECTING",
    note:
      "未成交影子按0收益计入机会成本；分钟收盘穿越只作为保守可成交证据，不等同于真实交易所成交。",
  };
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const body = asRecord(await request.json().catch(() => ({})));
  const id = Number(body.id);
  const verdict = String(body.verdict || "").toUpperCase();
  const comment = String(body.comment || "").trim().slice(0, 1000);
  if (!Number.isInteger(id) || id <= 0)
    return Response.json({ error: "影子记录编号无效" }, { status: 400 });
  if (!["UNREVIEWED", "KEEP_EXISTING", "PREFER_SHADOW", "NEEDS_INVESTIGATION"].includes(verdict))
    return Response.json({ error: "运营结论无效" }, { status: 400 });
  const db = getDb();
  const [current] = await db.select().from(executionQuoteShadows)
    .where(eq(executionQuoteShadows.id, id)).limit(1);
  if (!current || current.ownerEmail !== user.email)
    return Response.json({ error: "影子记录不存在" }, { status: 404 });
  const [updated] = await db.update(executionQuoteShadows).set({
    operatorVerdict: verdict as typeof current.operatorVerdict,
    operatorComment: comment || null,
    reviewedBy: user.email,
    reviewedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(executionQuoteShadows.id, id)).returning();
  await writeAudit(user, "REVIEW_EXECUTION_QUOTE_SHADOW", "execution_quote_shadow", String(id), {
    verdict,
    comment,
  });
  return Response.json({ item: updated });
}
