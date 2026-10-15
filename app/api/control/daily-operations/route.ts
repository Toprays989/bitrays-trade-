import { and, eq, gte, inArray, lt, lte, ne } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  dailyOperationsSnapshots,
  liveOrderMetricBuckets,
  liveOrderEvents,
  livePositionReductions,
  livePositions,
  strategies,
  strategyExecutionTraces,
  tradingAccounts,
} from "../../../../db/schema";
import { getBinanceLiveMarkPrices } from "../../../../lib/binance-usdm-live";
import {
  buildDailyOperationsReport,
  mergeDailyOperationsReportRows,
  type DailyOperationsReportRow,
} from "../../../../lib/daily-operations-report";
import { reductionAccountingPnl } from "../../../../lib/live-reduction-settlement";
import { strategyTraceIdFromClientOrderId } from "../../../../lib/strategy-order-attribution";
import { chinaTradingDayWindow } from "../../../../lib/trading-calendar";
import { chunkSqlQueryValues } from "../../../../lib/sql-query-batching";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 90;
const SNAPSHOT_SCHEMA_VERSION = 1;
const CURRENT_DAY_SNAPSHOT_TTL_MS = 15_000;

function parseChinaDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day) - CHINA_OFFSET_MS;
  const shifted = new Date(timestamp + CHINA_OFFSET_MS);
  if (
    shifted.getUTCFullYear() !== year ||
    shifted.getUTCMonth() !== month - 1 ||
    shifted.getUTCDate() !== day
  ) return null;
  return timestamp;
}

function formatChinaDate(timestamp: number) {
  return new Date(timestamp + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

function tradingDates(startedAtMs: number, endedAtMs: number) {
  const dates: string[] = [];
  for (let cursor = startedAtMs; cursor < endedAtMs; cursor += DAY_MS)
    dates.push(formatChinaDate(cursor));
  return dates;
}

function parseSnapshotRows(value: string): DailyOperationsReportRow[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as DailyOperationsReportRow[] : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;

  const url = new URL(request.url);
  const today = chinaTradingDayWindow();
  const requestedFrom = url.searchParams.get("from");
  const requestedTo = url.searchParams.get("to");
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const startedAtMs = requestedFrom
    ? parseChinaDate(requestedFrom)
    : today.startedAt.getTime();
  const selectedToMs = requestedTo
    ? parseChinaDate(requestedTo)
    : today.startedAt.getTime();
  if (startedAtMs === null || selectedToMs === null)
    return Response.json({ error: "日期格式无效" }, { status: 400 });

  const endedAtMs = selectedToMs + DAY_MS;
  if (endedAtMs <= startedAtMs)
    return Response.json({ error: "结束日期不能早于开始日期" }, { status: 400 });
  if (endedAtMs - startedAtMs > MAX_RANGE_DAYS * DAY_MS)
    return Response.json(
      { error: `单次最多查询 ${MAX_RANGE_DAYS} 天` },
      { status: 400 },
    );

  const db = getDb();
  const requestedDates = tradingDates(startedAtMs, endedAtMs);
  const todayDate = formatChinaDate(today.startedAt.getTime());
  const now = new Date();
  const existingSnapshots = await db
    .select({
      tradingDate: dailyOperationsSnapshots.tradingDate,
      schemaVersion: dailyOperationsSnapshots.schemaVersion,
      rowsJson: dailyOperationsSnapshots.rowsJson,
      generatedAt: dailyOperationsSnapshots.generatedAt,
    })
    .from(dailyOperationsSnapshots)
    .where(and(
      eq(dailyOperationsSnapshots.ownerEmail, user.email),
      gte(dailyOperationsSnapshots.tradingDate, requestedDates[0]),
      lte(
        dailyOperationsSnapshots.tradingDate,
        requestedDates[requestedDates.length - 1],
      ),
    ));
  const existingByDate = new Map(
    existingSnapshots.map((snapshot) => [snapshot.tradingDate, snapshot]),
  );
  const datesToMaterialize = requestedDates.filter((date) => {
    const existing = existingByDate.get(date);
    if (forceRefresh || !existing) return true;
    if (existing.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return true;
    return date === todayDate &&
      now.getTime() - existing.generatedAt.getTime() >
        CURRENT_DAY_SNAPSHOT_TTL_MS;
  });

  const strategyRows = await db
    .select({ id: strategies.id, name: strategies.name })
    .from(strategies)
    .where(eq(strategies.ownerEmail, user.email));

  if (datesToMaterialize.length) {
    const materializeStartedAtMs = Math.min(
      ...datesToMaterialize.map((date) => parseChinaDate(date) ?? startedAtMs),
    );
    const materializeEndedAtMs = Math.max(
      ...datesToMaterialize.map((date) =>
        (parseChinaDate(date) ?? startedAtMs) + DAY_MS
      ),
    );
    const materializeStartedAt = new Date(materializeStartedAtMs);
    const materializeEndedAt = new Date(materializeEndedAtMs);
    // Deliberately project only report fields. The former unbounded select()
    // loaded 200+ MB of evidence/response JSON and could restart the app.
    const selectedReductions = await db.select({
      id: livePositionReductions.id,
      positionId: livePositionReductions.positionId,
      reason: livePositionReductions.reason,
      realizedPnl: livePositionReductions.realizedPnl,
      responseJson: livePositionReductions.responseJson,
      createdAt: livePositionReductions.createdAt,
    }).from(livePositionReductions).where(and(
      eq(livePositionReductions.ownerEmail, user.email),
      gte(livePositionReductions.createdAt, materializeStartedAt),
      lt(livePositionReductions.createdAt, materializeEndedAt),
    ));
    const reductionPositionIds = [
      ...new Set(selectedReductions.map((reduction) => reduction.positionId)),
    ];
    const closedPositionCondition = and(
      eq(livePositions.status, "CLOSED"),
      gte(livePositions.closedAt, materializeStartedAt),
      lt(livePositions.closedAt, materializeEndedAt),
    );
    const reportPositionFields = {
      id: livePositions.id,
      sourceEventId: livePositions.sourceEventId,
      accountId: livePositions.accountId,
      status: livePositions.status,
      positionSide: livePositions.positionSide,
      quantity: livePositions.quantity,
      entryPrice: livePositions.entryPrice,
      markPrice: livePositions.markPrice,
      realizedPnl: livePositions.realizedPnl,
      exitReason: livePositions.exitReason,
      closedAt: livePositions.closedAt,
    };
    const closedPositions = await db.select(reportPositionFields)
      .from(livePositions).where(and(
      eq(livePositions.ownerEmail, user.email),
      closedPositionCondition,
    ));
    const positionById = new Map(
      closedPositions.map((position) => [position.id, position]),
    );
    for (
      const reductionPositionIdChunk of chunkSqlQueryValues(
        reductionPositionIds,
      )
    ) {
      const reductionPositions = await db.select(reportPositionFields)
        .from(livePositions).where(and(
          eq(livePositions.ownerEmail, user.email),
          inArray(livePositions.id, reductionPositionIdChunk),
        ));
      for (const position of reductionPositions)
        positionById.set(position.id, position);
    }
    const positions = [...positionById.values()];
    const orderBuckets = await db.select()
      .from(liveOrderMetricBuckets)
      .where(and(
        eq(liveOrderMetricBuckets.ownerEmail, user.email),
        gte(liveOrderMetricBuckets.bucketStartedAt, materializeStartedAt),
        lt(liveOrderMetricBuckets.bucketStartedAt, materializeEndedAt),
      ));
    const sourceEventIds = [
      ...new Set(positions.map((position) => position.sourceEventId)),
    ];
    const sourceOrders: Array<{
      id: number;
      accountId: string;
      clientOrderId: string;
      status: string;
      estimatedNotional: number;
      testOnly: boolean;
      createdAt: Date;
    }> = [];
    for (let offset = 0; offset < sourceEventIds.length; offset += 80) {
      sourceOrders.push(...await db.select({
        id: liveOrderEvents.id,
        accountId: liveOrderEvents.accountId,
        clientOrderId: liveOrderEvents.clientOrderId,
        status: liveOrderEvents.status,
        estimatedNotional: liveOrderEvents.estimatedNotional,
        testOnly: liveOrderEvents.testOnly,
        createdAt: liveOrderEvents.createdAt,
      }).from(liveOrderEvents).where(and(
        eq(liveOrderEvents.ownerEmail, user.email),
        inArray(liveOrderEvents.id, sourceEventIds.slice(offset, offset + 80)),
      )));
    }
    const traceIds = [
      ...new Set(sourceOrders.flatMap((order) => {
        const traceId = strategyTraceIdFromClientOrderId(order.clientOrderId);
        return traceId === null ? [] : [traceId];
      })),
    ];
    const traces: Array<{
      id: number;
      strategyId: number;
      configVersion: number;
    }> = [];
    for (let offset = 0; offset < traceIds.length; offset += 80) {
      traces.push(...await db.select({
        id: strategyExecutionTraces.id,
        strategyId: strategyExecutionTraces.strategyId,
        configVersion: strategyExecutionTraces.configVersion,
      }).from(strategyExecutionTraces).where(and(
        eq(strategyExecutionTraces.ownerEmail, user.email),
        inArray(
          strategyExecutionTraces.id,
          traceIds.slice(offset, offset + 80),
        ),
      )));
    }
    const reductionIndex: Array<{
      id: number;
      positionId: number;
      reason: typeof selectedReductions[number]["reason"];
      realizedPnl: number;
      responseJson: string;
      createdAt: Date;
    }> = [];
    const materializedPositionIds = positions.map((position) => position.id);
    for (let offset = 0; offset < materializedPositionIds.length; offset += 80) {
      reductionIndex.push(...await db.select({
        id: livePositionReductions.id,
        positionId: livePositionReductions.positionId,
        reason: livePositionReductions.reason,
        realizedPnl: livePositionReductions.realizedPnl,
        responseJson: livePositionReductions.responseJson,
        createdAt: livePositionReductions.createdAt,
      }).from(livePositionReductions).where(and(
        eq(livePositionReductions.ownerEmail, user.email),
        inArray(
          livePositionReductions.positionId,
          materializedPositionIds.slice(offset, offset + 80),
        ),
      )));
    }
    const reportInput = {
      orders: sourceOrders.map((order) => ({
        id: order.id,
        accountId: order.accountId,
        clientOrderId: order.clientOrderId,
        status: order.status,
        estimatedNotional: order.estimatedNotional,
        createdAtMs: order.createdAt.getTime(),
        countable: false,
      })),
      traces: traces.map((trace) => ({
        id: trace.id,
        strategyId: trace.strategyId,
        configVersion: trace.configVersion,
      })),
      strategies: strategyRows,
      positions: positions.map((position) => ({
        id: position.id,
        sourceEventId: position.sourceEventId,
        accountId: position.accountId,
        status: position.status,
        positionSide: position.positionSide,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
        realizedPnl: position.realizedPnl,
        exitReason: position.exitReason,
        closedAtMs: position.closedAt?.getTime() ?? null,
      })),
      reductions: reductionIndex.map((reduction) => ({
        id: reduction.id,
        positionId: reduction.positionId,
        reason: reduction.reason,
        accountingPnl: reductionAccountingPnl({
          realizedPnl: reduction.realizedPnl,
          responseJson: reduction.responseJson,
        }).pnl,
        createdAtMs: reduction.createdAt.getTime(),
      })),
    };
    const strategyById = new Map(
      strategyRows.map((strategy) => [strategy.id, strategy]),
    );
    for (const date of datesToMaterialize) {
      const dayStartedAtMs = parseChinaDate(date) ?? startedAtMs;
      const ledgerReport = buildDailyOperationsReport({
        startedAtMs: dayStartedAtMs,
        endedAtMs: dayStartedAtMs + DAY_MS,
        ...reportInput,
      }, { includeCurrentExposure: false });
      const orderRows: DailyOperationsReportRow[] = orderBuckets
        .filter((bucket) => {
          const bucketAt = bucket.bucketStartedAt.getTime();
          return bucketAt >= dayStartedAtMs &&
            bucketAt < dayStartedAtMs + DAY_MS &&
            bucket.orderCount > 0;
        })
        .map((bucket) => {
          const strategy = strategyById.get(bucket.strategyId);
          const strategyOwned = bucket.strategyId > 0;
          return {
            key: strategyOwned
              ? `STRATEGY:${bucket.accountId}:${bucket.strategyId}:V${bucket.configVersion}`
              : `MANUAL:${bucket.accountId}`,
            sourceType: strategyOwned ? "STRATEGY" as const : "MANUAL" as const,
            strategyId: strategyOwned ? bucket.strategyId : null,
            strategyName: strategyOwned
              ? strategy?.name ?? `历史策略 #${bucket.strategyId}`
              : "人工下单（含半自动确认）",
            configVersion: strategyOwned ? bucket.configVersion : null,
            accountId: bucket.accountId,
            orderCount: bucket.orderCount,
            filledOrderCount:
              bucket.filledOrderCount + bucket.submittedOrderCount,
            orderNotional: bucket.orderNotional,
            closeCount: 0,
            automaticCloseCount: 0,
            manualCloseCount: 0,
            realizedPnl: 0,
            automaticClosePnl: 0,
            openPositionCount: 0,
            unrealizedPnl: 0,
          };
        });
      const report = mergeDailyOperationsReportRows([
        orderRows,
        ledgerReport.rows,
      ]);
      await db.insert(dailyOperationsSnapshots).values({
        ownerEmail: user.email,
        tradingDate: date,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        rowsJson: JSON.stringify(report.rows),
        generatedAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [
          dailyOperationsSnapshots.ownerEmail,
          dailyOperationsSnapshots.tradingDate,
        ],
        set: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          rowsJson: JSON.stringify(report.rows),
          generatedAt: now,
          updatedAt: now,
        },
      });
    }
  }

  const snapshots = await db
    .select({
      tradingDate: dailyOperationsSnapshots.tradingDate,
      rowsJson: dailyOperationsSnapshots.rowsJson,
    })
    .from(dailyOperationsSnapshots)
    .where(and(
      eq(dailyOperationsSnapshots.ownerEmail, user.email),
      gte(dailyOperationsSnapshots.tradingDate, requestedDates[0]),
      lte(
        dailyOperationsSnapshots.tradingDate,
        requestedDates[requestedDates.length - 1],
      ),
    ));
  const snapshotByDate = new Map(
    snapshots.map((snapshot) => [
      snapshot.tradingDate,
      parseSnapshotRows(snapshot.rowsJson),
    ]),
  );

  // Current exposure remains live and is intentionally not frozen into a
  // historical daily snapshot. Its attribution query is bounded by open
  // positions and never reads large ledger JSON.
  const [activePositions, accounts] = await Promise.all([
    db.select({
      id: livePositions.id,
      sourceEventId: livePositions.sourceEventId,
      accountId: livePositions.accountId,
      symbol: livePositions.symbol,
      status: livePositions.status,
      positionSide: livePositions.positionSide,
      quantity: livePositions.quantity,
      entryPrice: livePositions.entryPrice,
      markPrice: livePositions.markPrice,
      realizedPnl: livePositions.realizedPnl,
      exitReason: livePositions.exitReason,
      closedAt: livePositions.closedAt,
    }).from(livePositions).where(and(
      eq(livePositions.ownerEmail, user.email),
      ne(livePositions.status, "CLOSED"),
    )),
    db.select({
      accountId: tradingAccounts.accountId,
      name: tradingAccounts.name,
    }).from(tradingAccounts).where(
      eq(tradingAccounts.ownerEmail, user.email),
    ),
  ]);
  const sourceEventIds = [
    ...new Set(activePositions.map((position) => position.sourceEventId)),
  ];
  const sourceOrders = sourceEventIds.length
    ? await db.select({
        id: liveOrderEvents.id,
        accountId: liveOrderEvents.accountId,
        clientOrderId: liveOrderEvents.clientOrderId,
        status: liveOrderEvents.status,
        estimatedNotional: liveOrderEvents.estimatedNotional,
        createdAt: liveOrderEvents.createdAt,
      }).from(liveOrderEvents).where(and(
        eq(liveOrderEvents.ownerEmail, user.email),
        inArray(liveOrderEvents.id, sourceEventIds),
      ))
    : [];
  const sourceTraceIds = [
    ...new Set(sourceOrders.flatMap((order) => {
      const traceId = strategyTraceIdFromClientOrderId(order.clientOrderId);
      return traceId === null ? [] : [traceId];
    })),
  ];
  const sourceTraces = sourceTraceIds.length
    ? await db.select({
        id: strategyExecutionTraces.id,
        strategyId: strategyExecutionTraces.strategyId,
        configVersion: strategyExecutionTraces.configVersion,
      }).from(strategyExecutionTraces).where(
        inArray(strategyExecutionTraces.id, sourceTraceIds),
      )
    : [];
  const activeSymbols = [
    ...new Set(activePositions.map((position) => position.symbol)),
  ];
  const liveMarks = activeSymbols.length
    ? await getBinanceLiveMarkPrices(activeSymbols).catch(() => [])
    : [];
  const markBySymbol = new Map(
    liveMarks.map((mark) => [mark.symbol, mark.markPrice]),
  );
  const exposureReport = buildDailyOperationsReport({
    startedAtMs: 0,
    endedAtMs: 0,
    orders: sourceOrders.map((order) => ({
      id: order.id,
      accountId: order.accountId,
      clientOrderId: order.clientOrderId,
      status: order.status,
      estimatedNotional: order.estimatedNotional,
      createdAtMs: order.createdAt.getTime(),
    })),
    traces: sourceTraces,
    strategies: strategyRows,
    positions: activePositions.map((position) => ({
      id: position.id,
      sourceEventId: position.sourceEventId,
      accountId: position.accountId,
      status: position.status,
      positionSide: position.positionSide,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      markPrice: markBySymbol.get(position.symbol) ?? position.markPrice,
      realizedPnl: position.realizedPnl,
      exitReason: position.exitReason,
      closedAtMs: position.closedAt?.getTime() ?? null,
    })),
    reductions: [],
  }, { includeLedger: false });
  const report = mergeDailyOperationsReportRows([
    ...requestedDates.map((date) => snapshotByDate.get(date) ?? []),
    exposureReport.rows,
  ]);
  const accountNameById = new Map(
    accounts.map((account) => [account.accountId, account.name]),
  );

  return Response.json({
    range: {
      from: formatChinaDate(startedAtMs),
      to: formatChinaDate(endedAtMs - 1),
      timezone: "Asia/Shanghai",
    },
    generatedAt: new Date().toISOString(),
    storage: {
      mode: "MATERIALIZED_DAILY",
      materializedDates: datesToMaterialize,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    },
    currentPositionPricing: {
      source: "BINANCE_MARK_PRICE",
      complete: activePositions.every((position) =>
        markBySymbol.has(position.symbol)
      ),
      markedPositions: activePositions.filter((position) =>
        markBySymbol.has(position.symbol)
      ).length,
      totalPositions: activePositions.length,
    },
    total: report.total,
    rows: report.rows.map((row) => ({
      ...row,
      accountName: accountNameById.get(row.accountId) ?? row.accountId,
    })),
  });
}
