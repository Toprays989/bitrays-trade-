import { and, asc, desc, eq, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  contractSymbols,
  exchangeCredentials,
  executionIntents,
  liveOrderMetricBuckets,
  liveOrderEvents,
  livePositionReductions,
  livePositions,
  rateLimitBuckets,
  riskStates,
  strategies,
  strategyEventRetentionState,
  strategyExecutionEventRollups,
  strategyExecutionEvents,
  strategyExecutionTraces,
  tradingAccounts,
} from "../../../../db/schema";
import {
  getBinanceLiveContractUniverse,
  getBinanceLiveMarkPrices,
  getBinanceLiveSystemMetrics,
} from "../../../../lib/binance-usdm-live";
import { accountFundingSnapshot } from "../../../../lib/account-funding-snapshot";
import { reductionAccountingPnl } from "../../../../lib/live-reduction-settlement";
import {
  chinaTradingDayWindow,
  chinaTradingHourWindow,
  chinaTradingMonthStartedAt,
} from "../../../../lib/trading-calendar";
import { nexusBrainDisplayName } from "../../../../lib/nexus-brain-identity";
import { buildPortfolioProfitFunnel } from "../../../../lib/portfolio-profit-funnel";
import { isAutomaticCloseReason } from "../../../../lib/daily-operations-report";
import { strategyTraceIdFromClientOrderId } from "../../../../lib/strategy-order-attribution";
import {
  buildStrategyFunnelCohort,
  buildStrategyFunnelWaitBreakdown,
} from "../../../../lib/strategy-funnel-cohort";
import {
  inverseDirectionLaneFromEvidence,
  inverseExecutionObservationFromEvidence,
  medianFinite,
  type InverseDirectionLane,
} from "../../../../lib/inverse-strategy-observability";
import {
  ensureAccountState,
  ensureSeedData,
  isResponse,
  requirePermission,
} from "../shared";

export const dynamic = "force-dynamic";

const RISK_HEARTBEAT_FRESH_MS = 15_000;
const MARKET_SNAPSHOT_REFRESH_MS = 5_000;
const OVERVIEW_TRACE_QUERY_CHUNK_SIZE = 80;
const OVERVIEW_INVERSE_DETAIL_ORDER_LIMIT = 2_000;

type OverviewMarketSnapshot = {
  tickers: Awaited<ReturnType<typeof getBinanceLiveContractUniverse>>;
  marks: Awaited<ReturnType<typeof getBinanceLiveMarkPrices>>;
  systemMetrics: Awaited<ReturnType<typeof getBinanceLiveSystemMetrics>> | null;
  tickerError: string | null;
  markError: string | null;
  systemError: string | null;
  completedAt: number;
};

let overviewMarketSnapshot: OverviewMarketSnapshot | null = null;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function readOverviewMarketSnapshot(positionSymbols: string[]) {
  const now = Date.now();
  if (
    overviewMarketSnapshot &&
    now - overviewMarketSnapshot.completedAt < MARKET_SNAPSHOT_REFRESH_MS
  ) return overviewMarketSnapshot;

  const [tickerResult, markResult, systemResult] = await Promise.allSettled([
    getBinanceLiveContractUniverse(),
    getBinanceLiveMarkPrices(positionSymbols),
    getBinanceLiveSystemMetrics(),
  ]);
  overviewMarketSnapshot = {
    tickers: tickerResult.status === "fulfilled"
      ? tickerResult.value
      : overviewMarketSnapshot?.tickers ?? [],
    marks: markResult.status === "fulfilled"
      ? markResult.value
      : overviewMarketSnapshot?.marks ?? [],
    systemMetrics: systemResult.status === "fulfilled"
      ? systemResult.value
      : overviewMarketSnapshot?.systemMetrics ?? null,
    tickerError: tickerResult.status === "rejected"
      ? errorMessage(tickerResult.reason, "合约行情不可用")
      : null,
    markError: markResult.status === "rejected"
      ? errorMessage(markResult.reason, "标记价格不可用")
      : null,
    systemError: systemResult.status === "rejected"
      ? errorMessage(systemResult.reason, "系统行情指标不可用")
      : null,
    completedAt: Date.now(),
  };
  return overviewMarketSnapshot;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function timestampMs(value: unknown) {
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : null;
  }
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const requestedAccountId = new URL(request.url).searchParams
    .get("accountId")
    ?.trim();
  await Promise.all([ensureSeedData(), ensureAccountState(user)]);
  const db = getDb();
  const [
    allPositions,
    allReductions,
    allStrategyRows,
    buckets,
    risks,
    symbols,
    credentials,
    accountRows,
  ] = await Promise.all([
    db.select().from(livePositions).where(eq(livePositions.ownerEmail, user.email)).orderBy(desc(livePositions.updatedAt)),
    db.select().from(livePositionReductions).where(eq(livePositionReductions.ownerEmail, user.email)).orderBy(desc(livePositionReductions.createdAt)),
    db.select().from(strategies).where(eq(strategies.ownerEmail, user.email)).orderBy(desc(strategies.updatedAt)),
    db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.ownerEmail, user.email)).limit(1),
    db.select().from(riskStates).where(eq(riskStates.ownerEmail, user.email)).limit(1),
    db.select().from(contractSymbols).where(eq(contractSymbols.isActive, true)),
    db.select().from(exchangeCredentials).where(eq(exchangeCredentials.ownerEmail, user.email)),
    db.select().from(tradingAccounts).where(eq(tradingAccounts.ownerEmail, user.email)),
  ]);

  const accountById = new Map(accountRows.map((account) => [account.accountId, account]));
  const accountOptions = accountRows
    .filter((account) => account.accountType === "STRATEGY")
    .map((account) => ({
      accountId: account.accountId,
      name: account.name,
      isActive: account.isActive,
      executionMode: account.executionMode,
    }))
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
  if (
    requestedAccountId &&
    !accountOptions.some((account) => account.accountId === requestedAccountId)
  ) {
    return Response.json({ error: "资金账户不存在或不属于当前用户" }, { status: 400 });
  }
  const accountMatches = (accountId: string) =>
    !requestedAccountId || accountId === requestedAccountId;
  const positions = allPositions.filter((position) => accountMatches(position.accountId));
  const reductions = allReductions.filter((reduction) => accountMatches(reduction.accountId));
  const strategyRows = allStrategyRows.filter((strategy) => accountMatches(strategy.accountId));
  const eligibleCredentials = credentials.filter((credential) => {
    const account = accountById.get(credential.accountId);
    return Boolean(
      account &&
      accountMatches(credential.accountId) &&
      account.accountType === "STRATEGY" &&
      account.executionMode === "LIVE" &&
      account.isActive &&
      credential.connectionStatus === "VERIFIED" &&
      credential.liveTradingEnabled,
    );
  });
  const accountBalances: Array<{
    accountId: string;
    name: string;
    totalWalletBalance: number | null;
    totalUnrealizedProfit: number | null;
    totalMarginBalance: number | null;
    totalPositionInitialMargin: number | null;
    totalOpenOrderInitialMargin: number | null;
    availableBalance: number | null;
    syncedAt: string | null;
    status: "FRESH" | "STALE" | "ERROR";
    error: string | null;
  }> = [];
  for (let index = 0; index < eligibleCredentials.length; index += 3) {
    const batch = eligibleCredentials.slice(index, index + 3);
    accountBalances.push(...await Promise.all(batch.map(async (credential) => {
      const funding = accountFundingSnapshot(credential);
      return {
        accountId: credential.accountId,
        name: accountById.get(credential.accountId)?.name ?? credential.label,
        totalWalletBalance: funding.walletBalanceUsdt,
        totalUnrealizedProfit: funding.unrealizedPnlUsdt,
        totalMarginBalance: funding.marginEquityUsdt,
        totalPositionInitialMargin: funding.positionInitialMarginUsdt,
        totalOpenOrderInitialMargin: funding.openOrderInitialMarginUsdt,
        availableBalance: funding.availableToOpenUsdt,
        syncedAt: funding.syncedAt,
        status: funding.status === "FRESH" ? "FRESH" as const : "STALE" as const,
        error: null,
      };
    })));
  }

  const activePositions = positions.filter((position) => position.status !== "CLOSED");
  const closedPositions = positions.filter((position) => position.status === "CLOSED");
  const activeNames = new Set(symbols.map((symbol) => symbol.symbol));
  const positionSymbols = [...new Set(activePositions.map((position) => position.symbol))];
  const marketSnapshot = await readOverviewMarketSnapshot(positionSymbols);
  const tickers = (marketSnapshot?.tickers ?? []).filter((ticker) => activeNames.has(ticker.symbol));
  const markRows = marketSnapshot?.marks ?? [];
  // The proxy heartbeat is the single source of truth for the realtime
  // connection badge.  Do not wait for the much heavier universe/mark-price
  // refresh on a cold process, otherwise a healthy WebSocket is shown as
  // disconnected until the next 30-second browser poll.
  const systemMetrics = marketSnapshot?.systemMetrics ?? await getBinanceLiveSystemMetrics()
    .catch(() => null);
  const marks = new Map(markRows.map((item) => [item.symbol, item.markPrice]));
  const markedPositions = activePositions.map((position) => ({
    ...position,
    markPrice: marks.get(position.symbol) ?? position.markPrice,
    priceSource: marks.has(position.symbol) ? "BINANCE_MARK_PRICE" : "CACHED_POSITION_PRICE",
  }));
  const positionPricesComplete = activePositions.every((position) => marks.has(position.symbol));

  const reductionsByPosition = new Map<number, typeof reductions>();
  const reductionAccountingById = new Map(
    reductions.map((reduction) => [
      reduction.id,
      reductionAccountingPnl(reduction),
    ]),
  );
  for (const reduction of [...reductions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const rows = reductionsByPosition.get(reduction.positionId) ?? [];
    rows.push(reduction);
    reductionsByPosition.set(reduction.positionId, rows);
  }
  const standaloneClosedPositions = closedPositions.filter(
    (position) => !(reductionsByPosition.get(position.id)?.length),
  );
  const realizedRecords = [
    ...standaloneClosedPositions.map((position) => ({
      pnl: position.realizedPnl,
      time: position.closedAt!,
      funnel: {
        grossRealizedPnl: position.realizedPnl,
        accountingPnl: position.realizedPnl,
        netRealizedPnl: null,
        exactNetAvailable: false,
        tradeDetailsAvailable: false,
        exitCommission: null,
        entryCommissionAllocated: null,
        commissionAsset: null,
        fundingIncome: null,
        fundingAsset: null,
      },
    })),
    ...reductions.map((reduction) => {
      const accounting = reductionAccountingById.get(reduction.id)!;
      return {
        pnl: accounting.pnl,
        time: reduction.createdAt,
        funnel: {
          grossRealizedPnl: accounting.grossRealizedPnl,
          accountingPnl: accounting.pnl,
          netRealizedPnl: accounting.netRealizedPnl,
          exactNetAvailable: accounting.exactNetAvailable,
          tradeDetailsAvailable: accounting.tradeDetailsAvailable,
          exitCommission: accounting.exitCommission,
          entryCommissionAllocated: accounting.entryCommissionAllocated,
          commissionAsset: accounting.commissionAsset,
          fundingIncome: accounting.fundingIncome,
          fundingAsset: accounting.fundingAsset,
        },
      };
    }),
  ];
  const closedTradeResults = closedPositions.map((position) => {
    const legs = reductionsByPosition.get(position.id) ?? [];
    return {
      pnl: legs.length
        ? legs.reduce(
            (sum, leg) =>
              sum + (reductionAccountingById.get(leg.id)?.pnl ?? leg.realizedPnl),
            0,
          )
        : position.realizedPnl,
      time: position.closedAt,
    };
  });
  const sourceOrderIds = [...new Set(positions.map((position) => position.sourceEventId))];
  const sourceOrders: Array<{ id: number; quantity: number }> = [];
  for (
    let offset = 0;
    offset < sourceOrderIds.length;
    offset += OVERVIEW_TRACE_QUERY_CHUNK_SIZE
  ) {
    sourceOrders.push(...await db.select({
      id: liveOrderEvents.id,
      quantity: liveOrderEvents.quantity,
    }).from(liveOrderEvents).where(and(
      eq(liveOrderEvents.ownerEmail, user.email),
      inArray(
        liveOrderEvents.id,
        sourceOrderIds.slice(
          offset,
          offset + OVERVIEW_TRACE_QUERY_CHUNK_SIZE,
        ),
      ),
    )));
  }
  const sourceOrderQuantityById = new Map(
    sourceOrders.map((order) => [order.id, order.quantity]),
  );
  const initialQuantityByPosition = new Map(
    positions.map((position) => [
      position.id,
      sourceOrderQuantityById.get(position.sourceEventId) ?? position.quantity,
    ]),
  );
  let partialReductionActions = 0;
  for (const [positionId, legs] of reductionsByPosition) {
    let cumulative = 0;
    const initialQuantity = initialQuantityByPosition.get(positionId) ?? 0;
    for (const leg of legs) {
      cumulative += leg.quantity;
      if (initialQuantity > 0 && cumulative < initialQuantity - 1e-12)
        partialReductionActions += 1;
    }
  }

  const positionEstimatedUnrealizedPnl = markedPositions.reduce(
    (sum, position) => sum + (position.positionSide === "LONG"
      ? (position.markPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - position.markPrice) * position.quantity),
    0,
  );
  const realizedPnl = realizedRecords.reduce((sum, record) => sum + record.pnl, 0);
  const hourStartedAt = chinaTradingHourWindow().startedAt.getTime();
  const todayStartedAt = chinaTradingDayWindow().startedAt.getTime();
  const monthStartedAt = chinaTradingMonthStartedAt().getTime();
  const orderMetricScope = and(
    eq(liveOrderMetricBuckets.ownerEmail, user.email),
    requestedAccountId
      ? eq(liveOrderMetricBuckets.accountId, requestedAccountId)
      : undefined,
  );
  const detailOrderScope = and(
    eq(liveOrderEvents.ownerEmail, user.email),
    eq(liveOrderEvents.testOnly, false),
    gte(liveOrderEvents.createdAt, new Date(todayStartedAt)),
    requestedAccountId
      ? eq(liveOrderEvents.accountId, requestedAccountId)
      : undefined,
    or(
      like(liveOrderEvents.clientOrderId, "nql_%"),
      like(liveOrderEvents.clientOrderId, "nqs_%"),
      like(liveOrderEvents.clientOrderId, "nqi_%"),
      like(liveOrderEvents.clientOrderId, "nqp_%"),
      like(liveOrderEvents.clientOrderId, "srb_%"),
    ),
  );
  const workingOrderRows = await db
    .select({
      id: liveOrderEvents.id,
      accountId: liveOrderEvents.accountId,
      symbol: liveOrderEvents.symbol,
      positionSide: liveOrderEvents.positionSide,
      status: liveOrderEvents.status,
      clientOrderId: liveOrderEvents.clientOrderId,
      lifecycleId: liveOrderEvents.lifecycleId,
      createdAt: liveOrderEvents.createdAt,
      updatedAt: liveOrderEvents.updatedAt,
      traceState: strategyExecutionTraces.state,
      intentStatus: executionIntents.status,
    })
    .from(liveOrderEvents)
    .leftJoin(
      strategyExecutionTraces,
      eq(strategyExecutionTraces.traceId, liveOrderEvents.lifecycleId),
    )
    .leftJoin(
      executionIntents,
      eq(executionIntents.liveOrderEventId, liveOrderEvents.id),
    )
    .where(and(
      eq(liveOrderEvents.ownerEmail, user.email),
      eq(liveOrderEvents.testOnly, false),
      inArray(liveOrderEvents.status, [
        "PENDING",
        "SUBMITTED",
        "NEW",
        "PARTIALLY_FILLED",
        "CANCEL_PENDING",
        "EXECUTION_UNKNOWN",
      ]),
      requestedAccountId
        ? eq(liveOrderEvents.accountId, requestedAccountId)
        : undefined,
    ))
    .orderBy(asc(liveOrderEvents.createdAt), asc(liveOrderEvents.id))
    .limit(1_000);
  const distinctWorkingOrders = [
    ...new Map(workingOrderRows.map((row) => [row.id, row])).values(),
  ];
  const terminalTraceStates = new Set([
    "CLOSED",
    "EXPIRED",
    "REJECTED",
    "CANCELED",
  ]);
  const terminalTraceWorkingOrders = distinctWorkingOrders.filter((row) =>
    row.traceState !== null && terminalTraceStates.has(row.traceState)
  );
  const expiredIntentWorkingOrders = distinctWorkingOrders.filter(
    (row) => row.intentStatus === "EXPIRED",
  );
  const unknownWorkingOrders = distinctWorkingOrders.filter(
    (row) => row.status === "EXECUTION_UNKNOWN",
  );
  const oldestWorkingOrder = distinctWorkingOrders[0] ?? null;
  const oldestWorkingAgeMs = oldestWorkingOrder
    ? Math.max(0, Date.now() - oldestWorkingOrder.createdAt.getTime())
    : 0;
  const orderHealth = {
    status:
      terminalTraceWorkingOrders.length > 0 ||
        expiredIntentWorkingOrders.length > 0 ||
        unknownWorkingOrders.length > 0
        ? "ATTENTION" as const
        : "HEALTHY" as const,
    workingCount: distinctWorkingOrders.length,
    oldestWorkingAgeMs,
    terminalTraceWorkingCount: terminalTraceWorkingOrders.length,
    expiredIntentWorkingCount: expiredIntentWorkingOrders.length,
    executionUnknownCount: unknownWorkingOrders.length,
    details: distinctWorkingOrders.slice(0, 10).map((row) => ({
      id: row.id,
      accountId: row.accountId,
      symbol: row.symbol,
      positionSide: row.positionSide,
      status: row.status,
      clientOrderId: row.clientOrderId,
      lifecycleId: row.lifecycleId,
      traceState: row.traceState,
      intentStatus: row.intentStatus,
      ageMs: Math.max(0, Date.now() - row.createdAt.getTime()),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
  const [todayOrderBuckets, orderMetricTotalRows, todayOrders] =
    await Promise.all([
      db.select().from(liveOrderMetricBuckets).where(and(
        orderMetricScope,
        gte(
          liveOrderMetricBuckets.bucketStartedAt,
          new Date(todayStartedAt),
        ),
      )),
      db.select({
        orderCount: sql<number>`coalesce(sum(${liveOrderMetricBuckets.orderCount}), 0)`,
        pendingOrderCount: sql<number>`coalesce(sum(${liveOrderMetricBuckets.pendingOrderCount}), 0)`,
        submittedOrderCount: sql<number>`coalesce(sum(${liveOrderMetricBuckets.submittedOrderCount}), 0)`,
        filledOrderCount: sql<number>`coalesce(sum(${liveOrderMetricBuckets.filledOrderCount}), 0)`,
        rejectedOrderCount: sql<number>`coalesce(sum(${liveOrderMetricBuckets.rejectedOrderCount}), 0)`,
        executionUnknownOrderCount: sql<number>`coalesce(sum(${liveOrderMetricBuckets.executionUnknownOrderCount}), 0)`,
      }).from(liveOrderMetricBuckets).where(orderMetricScope),
      db.select({
        id: liveOrderEvents.id,
        clientOrderId: liveOrderEvents.clientOrderId,
        orderType: liveOrderEvents.orderType,
        status: liveOrderEvents.status,
        estimatedNotional: liveOrderEvents.estimatedNotional,
        createdAt: liveOrderEvents.createdAt,
        updatedAt: liveOrderEvents.updatedAt,
      }).from(liveOrderEvents).where(detailOrderScope)
        .orderBy(desc(liveOrderEvents.id))
        .limit(OVERVIEW_INVERSE_DETAIL_ORDER_LIMIT),
    ]);
  const emptyOrderMetrics = () => ({
    orderCount: 0,
    pendingOrderCount: 0,
    submittedOrderCount: 0,
    filledOrderCount: 0,
    canceledOrderCount: 0,
    rejectedOrderCount: 0,
    executionUnknownOrderCount: 0,
    orderNotional: 0,
    filledOrderNotional: 0,
  });
  const addOrderBucket = (
    total: ReturnType<typeof emptyOrderMetrics>,
    bucket: (typeof todayOrderBuckets)[number],
  ) => {
    total.orderCount += bucket.orderCount;
    total.pendingOrderCount += bucket.pendingOrderCount;
    total.submittedOrderCount += bucket.submittedOrderCount;
    total.filledOrderCount += bucket.filledOrderCount;
    total.canceledOrderCount += bucket.canceledOrderCount;
    total.rejectedOrderCount += bucket.rejectedOrderCount;
    total.executionUnknownOrderCount += bucket.executionUnknownOrderCount;
    total.orderNotional += bucket.orderNotional;
    total.filledOrderNotional += bucket.filledOrderNotional;
    return total;
  };
  const todayOrderMetrics = todayOrderBuckets.reduce(
    addOrderBucket,
    emptyOrderMetrics(),
  );
  const hourOrderMetrics = todayOrderBuckets
    .filter((bucket) => bucket.bucketStartedAt.getTime() >= hourStartedAt)
    .reduce(addOrderBucket, emptyOrderMetrics());
  const totalOrderMetrics = orderMetricTotalRows[0] ?? emptyOrderMetrics();
  const todayStrategyTraceDatabaseIds = [...new Set(
    todayOrders
      .map((order) => strategyTraceIdFromClientOrderId(order.clientOrderId))
      .filter((id): id is number => id !== null),
  )];
  const todayOrderTraceRows: Array<{
    id: number;
    strategyId: number;
    traceId: string;
    entryEvidenceJson: string;
  }> = [];
  for (
    let offset = 0;
    offset < todayStrategyTraceDatabaseIds.length;
    offset += OVERVIEW_TRACE_QUERY_CHUNK_SIZE
  ) {
    todayOrderTraceRows.push(...await db
        .select({
          id: strategyExecutionTraces.id,
          strategyId: strategyExecutionTraces.strategyId,
          traceId: strategyExecutionTraces.traceId,
          entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
        })
        .from(strategyExecutionTraces)
        .where(
          and(
            eq(strategyExecutionTraces.ownerEmail, user.email),
            inArray(
              strategyExecutionTraces.id,
              todayStrategyTraceDatabaseIds.slice(
                offset,
                offset + OVERVIEW_TRACE_QUERY_CHUNK_SIZE,
              ),
            ),
          ),
        ));
  }
  const [retentionState] = await db
    .select({ rollupStartedAt: strategyEventRetentionState.rollupStartedAt })
    .from(strategyEventRetentionState)
    .where(eq(strategyEventRetentionState.id, 1))
    .limit(1);
  const rollupStartedAt = retentionState?.rollupStartedAt.getTime() ??
    Date.now();
  const historicalWindowEndsAt = Math.max(todayStartedAt, rollupStartedAt);
  const [historicalFunnelEvents, rolledFunnelEvents] = await Promise.all([
    historicalWindowEndsAt > todayStartedAt
      ? db
          .select({
            traceId: strategyExecutionEvents.traceId,
            strategyId: strategyExecutionEvents.strategyId,
            accountId: strategyExecutionTraces.accountId,
            eventType: strategyExecutionEvents.eventType,
          })
          .from(strategyExecutionEvents)
          .innerJoin(
            strategyExecutionTraces,
            eq(strategyExecutionEvents.traceId, strategyExecutionTraces.traceId),
          )
          .where(and(
            eq(strategyExecutionTraces.ownerEmail, user.email),
            gte(strategyExecutionEvents.createdAt, new Date(todayStartedAt)),
            lt(
              strategyExecutionEvents.createdAt,
              new Date(historicalWindowEndsAt),
            ),
          ))
          .groupBy(
            strategyExecutionEvents.traceId,
            strategyExecutionEvents.strategyId,
            strategyExecutionTraces.accountId,
            strategyExecutionEvents.eventType,
          )
      : Promise.resolve([]),
    db
      .select({
        traceId: strategyExecutionEventRollups.traceId,
        strategyId: strategyExecutionEventRollups.strategyId,
        accountId: strategyExecutionEventRollups.accountId,
        eventType: strategyExecutionEventRollups.eventType,
      })
      .from(strategyExecutionEventRollups)
      .where(and(
        eq(strategyExecutionEventRollups.ownerEmail, user.email),
        gte(
          strategyExecutionEventRollups.lastEventAt,
          new Date(Math.max(todayStartedAt, rollupStartedAt)),
        ),
      )),
  ]);
  const todayFunnelEvents = [
    ...historicalFunnelEvents,
    ...rolledFunnelEvents,
  ];
  const scopedTodayFunnelEvents = todayFunnelEvents.filter((event) =>
    accountMatches(event.accountId)
  );
  const funnelTraceIds = [
    ...new Set(scopedTodayFunnelEvents.map((event) => event.traceId)),
  ];
  const funnelTraceRows: Array<{
    id: number;
    traceId: string;
    strategyId: number;
    entryEvidenceJson: string;
  }> = [];
  for (
    let offset = 0;
    offset < funnelTraceIds.length;
    offset += OVERVIEW_TRACE_QUERY_CHUNK_SIZE
  ) {
    funnelTraceRows.push(...await db
      .select({
        id: strategyExecutionTraces.id,
        traceId: strategyExecutionTraces.traceId,
        strategyId: strategyExecutionTraces.strategyId,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      })
      .from(strategyExecutionTraces)
      .where(and(
        eq(strategyExecutionTraces.ownerEmail, user.email),
        requestedAccountId
          ? eq(strategyExecutionTraces.accountId, requestedAccountId)
          : undefined,
        inArray(
          strategyExecutionTraces.traceId,
          funnelTraceIds.slice(
            offset,
            offset + OVERVIEW_TRACE_QUERY_CHUNK_SIZE,
          ),
        ),
      )));
  }
  const strategyIdByTraceDatabaseId = new Map(
    todayOrderTraceRows.map((trace) => [trace.id, trace.strategyId]),
  );
  const traceByDatabaseId = new Map(
    [...todayOrderTraceRows, ...funnelTraceRows].map((trace) => [trace.id, trace]),
  );
  const todayOrdersByStrategy = new Map<number, typeof todayOrders>();
  for (const order of todayOrders) {
    const traceDatabaseId = strategyTraceIdFromClientOrderId(
      order.clientOrderId,
    );
    const strategyId = traceDatabaseId === null
      ? null
      : strategyIdByTraceDatabaseId.get(traceDatabaseId) ?? null;
    if (strategyId === null) continue;
    const rows = todayOrdersByStrategy.get(strategyId) ?? [];
    rows.push(order);
    todayOrdersByStrategy.set(strategyId, rows);
  }
  const distinctEventTraces = (
    strategyId: number,
    matches: (eventType: string) => boolean,
  ) => new Set(
    scopedTodayFunnelEvents
      .filter(
        (event) =>
          event.strategyId === strategyId && matches(event.eventType),
      )
      .map((event) => event.traceId),
  ).size;
  const positionSourceOrderIds = new Set(
    positions.map((position) => position.sourceEventId),
  );
  const strategyFunnels = strategyRows.map((strategy) => {
    const strategyOrders = todayOrdersByStrategy.get(strategy.id) ?? [];
    const strategyConfig = parseRecord(strategy.configJson);
    const executionConfig = parseRecord(strategyConfig.execution);
    const directionMode = executionConfig.directionMode === "INVERSE_BRAIN"
      ? "INVERSE_BRAIN" as const
      : "FOLLOW_BRAIN" as const;
    const eyeConfirmedTraceIds = [
      ...new Set(
        scopedTodayFunnelEvents
          .filter(
            (event) =>
              event.strategyId === strategy.id &&
              event.eventType === "NEXUS_MARKET_EYE:CONFIRMED",
          )
          .map((event) => event.traceId),
      ),
    ];
    const confirmedTraceIds = [
      ...new Set(
        scopedTodayFunnelEvents
          .filter(
            (event) =>
              event.strategyId === strategy.id &&
              event.eventType.startsWith(
                "NEXUS_BRAIN_CANDIDATE_APPROVED:",
              ),
          )
          .map((event) => event.traceId),
      ),
    ];
    const executionAuthorizedTraceIds = [
      ...new Set(
        scopedTodayFunnelEvents
          .filter(
            (event) =>
              event.strategyId === strategy.id &&
              event.eventType.startsWith("NEXUS_EXECUTION_AUTHORIZED:"),
          )
          .map((event) => event.traceId),
      ),
    ];
    const confirmedTraceRows = funnelTraceRows.filter(
      (trace) =>
        trace.strategyId === strategy.id &&
        (
          confirmedTraceIds.includes(trace.traceId) ||
          executionAuthorizedTraceIds.includes(trace.traceId)
        ),
    );
    const cohort = buildStrategyFunnelCohort({
      confirmedTraceIds,
      executionAuthorizedTraceIds,
      traces: confirmedTraceRows.map((trace) => {
        const evidence = parseRecord(trace.entryEvidenceJson);
        const observation = inverseExecutionObservationFromEvidence(evidence);
        const frozenDecision = parseRecord(evidence.frozenExecutionDecision);
        return {
          traceId: trace.traceId,
          databaseId: trace.id,
          approvedAtMs:
            observation?.approvedAtMs ?? timestampMs(frozenDecision.approvedAt),
        };
      }),
      orders: strategyOrders.map((order) => ({
        traceDatabaseId: strategyTraceIdFromClientOrderId(
          order.clientOrderId,
        ),
        orderType: order.orderType,
        status: order.status,
        createdAtMs: order.createdAt.getTime(),
        updatedAtMs: order.updatedAt.getTime(),
        hasPosition: positionSourceOrderIds.has(order.id),
      })),
    });
    const eyeConfirmed = eyeConfirmedTraceIds.length;
    const confirmed = cohort.confirmed;
    const authorized = cohort.authorized;
    const netExpectancyRejected = distinctEventTraces(
      strategy.id,
      (eventType) =>
        eventType === "NET_EXPECTANCY_NON_POSITIVE" ||
        eventType.endsWith(":NET_EXPECTANCY_NON_POSITIVE"),
    );
    const priceTooFar = distinctEventTraces(
      strategy.id,
      (eventType) =>
        eventType === "PILOT_ENTRY_REVALIDATION_WAIT:PRICE_TOO_FAR" ||
        eventType === "SHORT_ENTRY_REVALIDATION_WAIT:PRICE_TOO_FAR" ||
        eventType ===
          "PILOT_REJECTED:PILOT_ENTRY_REVALIDATION_TERMINATED:PRICE_TOO_FAR" ||
        eventType ===
          "SHORT_ENTRY_REVALIDATION_TERMINATED:PRICE_TOO_FAR",
    );
    const expired = distinctEventTraces(
      strategy.id,
      (eventType) => eventType === "NEXUS_FROZEN_EXECUTION_EXPIRED",
    );
    const existingPosition = distinctEventTraces(
      strategy.id,
      (eventType) =>
        eventType ===
          "PILOT_REJECTED:PILOT_SYMBOL_POSITION_ALREADY_OPEN" ||
        eventType === "SHORT_LIVE_SYMBOL_POSITION_ALREADY_OPEN",
    );
    const analysisExpired = distinctEventTraces(
      strategy.id,
      (eventType) => eventType === "ANALYSIS_EXPIRED",
    );
    const directionConflict = distinctEventTraces(
      strategy.id,
      (eventType) => eventType === "NEXUS_EXPLORATION_DIRECTION_CONFLICT",
    );
    const marketDataWaitBreakdown = buildStrategyFunnelWaitBreakdown(
      scopedTodayFunnelEvents.filter(
        (event) => event.strategyId === strategy.id,
      ),
    );
    const marketDataWait = marketDataWaitBreakdown.total;
    const capacityInsufficient = distinctEventTraces(
      strategy.id,
      (eventType) => eventType === "EXECUTION_CAPACITY:INSUFFICIENT",
    );
    const strategyRiskRejected = distinctEventTraces(
      strategy.id,
      (eventType) =>
        eventType.includes("NEXUS_PORTFOLIO_RISK:") ||
        eventType.includes("DAILY_LOSS_LIMIT"),
    );
    const filled = cohort.filled;
    const canceled = cohort.canceled;
    const laneForEvent = (
      event: (typeof scopedTodayFunnelEvents)[number],
    ) => {
      if (directionMode !== "INVERSE_BRAIN") return null;
      return event.traceId.startsWith("short-")
        ? "SHORT_TO_LONG" as const
        : "LONG_TO_SHORT" as const;
    };
    const laneForOrder = (order: (typeof strategyOrders)[number]) => {
      if (directionMode !== "INVERSE_BRAIN") return null;
      const traceDatabaseId = strategyTraceIdFromClientOrderId(
        order.clientOrderId,
      );
      if (traceDatabaseId === null) return null;
      const trace = traceByDatabaseId.get(traceDatabaseId);
      return trace
        ? inverseDirectionLaneFromEvidence(
            parseRecord(trace.entryEvidenceJson),
            trace.traceId.startsWith("short-") ? "SHORT" : "LONG",
          )
        : null;
    };
    const laneEventCount = (
      lane: InverseDirectionLane,
      matches: (eventType: string) => boolean,
    ) => new Set(
      scopedTodayFunnelEvents
        .filter(
          (event) =>
            event.strategyId === strategy.id &&
            laneForEvent(event) === lane &&
            matches(event.eventType),
        )
        .map((event) => event.traceId),
    ).size;
    const laneOrderStats = (lane: InverseDirectionLane) => {
      const rows = strategyOrders.filter((order) => laneForOrder(order) === lane);
      return {
        orders: rows.length,
        filled: rows.filter((order) =>
          order.status === "FILLED"
        ).length,
      };
    };
    const inverseLanes = directionMode === "INVERSE_BRAIN"
      ? {
          LONG_TO_SHORT: {
            confirmed: laneEventCount(
              "LONG_TO_SHORT",
              (eventType) => eventType === "NEXUS_MARKET_EYE:CONFIRMED",
            ),
            ...laneOrderStats("LONG_TO_SHORT"),
          },
          SHORT_TO_LONG: {
            confirmed: laneEventCount(
              "SHORT_TO_LONG",
              (eventType) => eventType === "NEXUS_MARKET_EYE:CONFIRMED",
            ),
            ...laneOrderStats("SHORT_TO_LONG"),
          },
        }
      : null;
    const inverseOrderObservations = strategyOrders
      .map((order) => {
        const traceDatabaseId = strategyTraceIdFromClientOrderId(
          order.clientOrderId,
        );
        const trace = traceDatabaseId === null
          ? null
          : traceByDatabaseId.get(traceDatabaseId) ?? null;
        if (!trace) return null;
        const evidence = parseRecord(trace.entryEvidenceJson);
        const observation = inverseExecutionObservationFromEvidence(evidence);
        const frozenDecision = parseRecord(evidence.frozenExecutionDecision);
        const approvedAtMs = observation?.approvedAtMs ??
          timestampMs(frozenDecision.approvedAt);
        return {
          lane: laneForOrder(order),
          confirmationToOrderMs:
            observation?.confirmationToOrderMs ??
            (approvedAtMs === null
              ? null
              : Math.max(0, order.createdAt.getTime() - approvedAtMs)),
          priceDeviationBps: observation?.priceDeviationBps ?? null,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const confirmationToOrderMedianMs = medianFinite(
      inverseOrderObservations.map((item) => item.confirmationToOrderMs),
    );
    const priceDeviationMedianBps = medianFinite(
      inverseOrderObservations.map((item) => item.priceDeviationBps),
    );
    return {
      strategyId: strategy.id,
      name: strategy.name,
      displayName: nexusBrainDisplayName(strategy.name),
      status: strategy.status,
      directionMode,
      eyeConfirmed,
      confirmed,
      netExpectancyRejected,
      authorized,
      priceTooFar,
      expired,
      existingPosition,
      analysisExpired,
      directionConflict,
      marketDataWait,
      marketDataWaitBreakdown,
      capacityInsufficient,
      strategyRiskRejected,
      orders: cohort.submitted,
      orderAttempts: cohort.orderAttempts,
      retryAttempts: cohort.retryAttempts,
      filled,
      canceled,
      working: cohort.working,
      noOrder: cohort.noOrder,
      conversionPercent: cohort.conversionPercent,
      inverseLanes,
      confirmationToOrderMedianMs:
        cohort.confirmationToOrderP50Ms ?? confirmationToOrderMedianMs,
      confirmationToOrderP90Ms: cohort.confirmationToOrderP90Ms,
      orderToTerminalP50Ms: cohort.orderToTerminalP50Ms,
      orderToTerminalP90Ms: cohort.orderToTerminalP90Ms,
      marketOrderToTerminalP50Ms: cohort.marketOrderToTerminalP50Ms,
      marketOrderToTerminalP90Ms: cohort.marketOrderToTerminalP90Ms,
      limitOrderToTerminalP50Ms: cohort.limitOrderToTerminalP50Ms,
      limitOrderToTerminalP90Ms: cohort.limitOrderToTerminalP90Ms,
      priceDeviationMedianBps,
      slowConfirmedOrders: inverseOrderObservations.filter(
        (item) =>
          item.confirmationToOrderMs !== null &&
          item.confirmationToOrderMs > 3_000,
      ).length,
      unknownInverseDirectionOrders: directionMode === "INVERSE_BRAIN"
        ? strategyOrders.filter((order) => laneForOrder(order) === null).length
        : 0,
    };
  });
  const todayStrategyOrderCount = todayOrderBuckets.reduce(
    (sum, bucket) => sum + (bucket.strategyId > 0 ? bucket.orderCount : 0),
    0,
  );
  const todayAutomaticReductions = reductions.filter(
    (reduction) =>
      reduction.createdAt.getTime() >= todayStartedAt &&
      isAutomaticCloseReason(reduction.reason),
  );
  const todayRealizedRecords = realizedRecords.filter((record) => record.time && record.time.getTime() >= todayStartedAt);
  const monthRealizedRecords = realizedRecords.filter((record) => record.time && record.time.getTime() >= monthStartedAt);
  const todayClosedTrades = closedTradeResults.filter((record) => record.time && record.time.getTime() >= todayStartedAt);
  const todayNewPositions = positions.filter(
    (position) => position.openedAt.getTime() >= todayStartedAt,
  );
  const todayClosedPositions = closedPositions.filter(
    (position) =>
      position.closedAt && position.closedAt.getTime() >= todayStartedAt,
  );
  const freshBalances = accountBalances.filter((account) => account.status === "FRESH");
  // Only current, fully dimensional Binance snapshots may enter account
  // aggregates. Stale cached values remain visible per account with STALE
  // status, but must never masquerade as current capital or execution input.
  const accountBalance = freshBalances.reduce((sum, account) => sum + (account.totalWalletBalance ?? 0), 0);
  const accountAvailableBalance = freshBalances.reduce((sum, account) => sum + (account.availableBalance ?? 0), 0);
  // Account-level unrealized PnL must come from the same fresh Binance
  // account snapshot as wallet/equity/available balance. Per-position marks
  // are refreshed on a separate path and may be briefly incomplete; they are
  // useful for position detail and consistency diagnostics, but must not blank
  // or replace Binance's authoritative account total.
  const balanceComplete = accountBalances.length > 0 && freshBalances.length === accountBalances.length;
  const unrealizedPnlAvailable = Boolean(
    balanceComplete &&
    freshBalances.every((account) => account.totalUnrealizedProfit !== null),
  );
  const unrealizedPnl = unrealizedPnlAvailable
    ? freshBalances.reduce((sum, account) => sum + (account.totalUnrealizedProfit ?? 0), 0)
    : 0;
  const unrealizedPnlDifference = unrealizedPnlAvailable && positionPricesComplete
    ? positionEstimatedUnrealizedPnl - unrealizedPnl
    : null;
  const accountEquityAvailable = Boolean(
    balanceComplete &&
    freshBalances.every((account) => account.totalMarginBalance !== null),
  );
  const accountEquity = accountEquityAvailable
    ? freshBalances.reduce(
        (sum, account) => sum + (account.totalMarginBalance ?? 0),
        0,
      )
    : null;
  const profitFunnel = buildPortfolioProfitFunnel({
    realizedRecords: realizedRecords.map((record) => record.funnel),
    unrealizedPnl: unrealizedPnlAvailable ? unrealizedPnl : null,
    accountEquity,
  });
  const notionalValue = markedPositions.reduce((sum, position) => sum + position.markPrice * position.quantity, 0);
  const estimatedMarginUsed = markedPositions.reduce(
    (sum, position) => sum + (position.markPrice * position.quantity) / Math.max(position.leverage, 1),
    0,
  );
  const proxyRate = systemMetrics?.rest;
  const fallbackRate = buckets[0];
  const rateLimit = proxyRate
    ? {
        usedWeight: Number(
          proxyRate.tradingEstimatedWeight ?? proxyRate.localEstimatedWeight ?? 0,
        ),
        projectUsedWeight: Number(
          proxyRate.tradingEstimatedWeight ?? proxyRate.localEstimatedWeight ?? 0,
        ),
        binanceObservedWeight: Number(proxyRate.binanceObservedWeight ?? 0),
        unattributedWeight: Number(proxyRate.unattributedWeight ?? 0),
        limitWeight: Number(
          proxyRate.tradingWeightLimitPerMinute ??
            proxyRate.hardLimitPerMinute ??
            800,
        ),
        reservedTradingWeight: Number(proxyRate.safetyReserve ?? 40),
        remainingWeight: Number(
          proxyRate.tradingRemainingWeight ?? proxyRate.remainingWeight ?? 0,
        ),
        observationUsedWeight: Number(
          proxyRate.observationEstimatedWeight ?? 0,
        ),
        observationLimitWeight: Number(
          proxyRate.observationWeightLimitPerMinute ?? 500,
        ),
        observationRemainingWeight: Number(
          proxyRate.observationRemainingWeight ?? 0,
        ),
        globalIpLimitWeight: Number(
          proxyRate.globalIpWeightLimitPerMinute ?? 2200,
        ),
        globalRemainingWeight: Number(
          proxyRate.globalRemainingWeight ?? 0,
        ),
        source: "BINANCE_PROXY" as const,
      }
    : fallbackRate
      ? {
          ...fallbackRate,
          projectUsedWeight: fallbackRate.usedWeight,
          binanceObservedWeight: 0,
          unattributedWeight: 0,
          remainingWeight: Math.max(0, fallbackRate.limitWeight - fallbackRate.usedWeight),
          observationUsedWeight: 0,
          observationLimitWeight: 500,
          observationRemainingWeight: 500,
          globalIpLimitWeight: 2200,
          globalRemainingWeight: 2200,
          source: "DATABASE_FALLBACK" as const,
        }
      : null;
  const websocketHealthy = Boolean(
    systemMetrics?.websocket?.connected &&
    Number(systemMetrics.websocket.ageMs ?? Number.POSITIVE_INFINITY) < 5_000,
  );
  const riskState = risks[0] ?? null;
  const riskHeartbeatHealthy = Boolean(
    riskState?.riskHeartbeatAt &&
    Date.now() - riskState.riskHeartbeatAt.getTime() < RISK_HEARTBEAT_FRESH_MS,
  );
  const accountBalanceAvailable = balanceComplete;
  const systemHealthy = Boolean(
    websocketHealthy &&
    riskHeartbeatHealthy &&
    rateLimit &&
    rateLimit.usedWeight < rateLimit.limitWeight - rateLimit.reservedTradingWeight,
  );

  return Response.json({
    mode: "LIVE",
    accountScope: requestedAccountId
      ? {
          mode: "SINGLE" as const,
          accountId: requestedAccountId,
          name: accountById.get(requestedAccountId)?.name ?? requestedAccountId,
        }
      : { mode: "ALL" as const, accountId: null, name: "全部账户" },
    accountOptions,
    metrics: {
      realizedPnl,
      unrealizedPnl,
      unrealizedPnlAvailable,
      positionEstimatedUnrealizedPnl,
      unrealizedPnlDifference,
      notionalValue,
      marginUsed: estimatedMarginUsed,
      marginIsEstimate: true,
      openPositions: activePositions.length,
      closedPositions: closedPositions.length,
      partialReductions: partialReductionActions,
      realizedRecords: realizedRecords.length,
      profitableRecords: realizedRecords.filter((record) => record.pnl > 0).length,
      losingRecords: realizedRecords.filter((record) => record.pnl < 0).length,
      breakevenRecords: realizedRecords.filter((record) => record.pnl === 0).length,
      closedTradeWins: closedTradeResults.filter((record) => record.pnl > 0).length,
      closedTradeLosses: closedTradeResults.filter((record) => record.pnl < 0).length,
      closedTradeBreakeven: closedTradeResults.filter((record) => record.pnl === 0).length,
      totalOrders: Number(totalOrderMetrics.orderCount),
      pendingOrders: Number(totalOrderMetrics.pendingOrderCount),
      filledOrders:
        Number(totalOrderMetrics.filledOrderCount) +
        Number(totalOrderMetrics.submittedOrderCount),
      rejectedOrders: Number(totalOrderMetrics.rejectedOrderCount),
      executionUnknownOrders:
        Number(totalOrderMetrics.executionUnknownOrderCount),
      runningStrategies: strategyRows.filter((strategy) => strategy.status === "RUNNING").length,
      totalStrategies: strategyRows.length,
      activeSymbols: symbols.length,
      hourOrders: hourOrderMetrics.orderCount,
      hourOrderNotional: hourOrderMetrics.orderNotional,
      hourFilledOrders:
        hourOrderMetrics.filledOrderCount +
        hourOrderMetrics.submittedOrderCount,
      hourFilledNotional: hourOrderMetrics.filledOrderNotional,
      todayOrders: todayOrderMetrics.orderCount,
      todayOrderNotional: todayOrderMetrics.orderNotional,
      todayNewPositions: todayNewPositions.length,
      todayClosedPositions: todayClosedPositions.length,
      todayStrategyOrders: todayStrategyOrderCount,
      todayManualOrders: todayOrderMetrics.orderCount - todayStrategyOrderCount,
      todayAutomaticReductions: todayAutomaticReductions.length,
      todayAutomaticReductionPnl: todayAutomaticReductions.reduce(
        (sum, reduction) =>
          sum + (reductionAccountingById.get(reduction.id)?.pnl ?? reduction.realizedPnl),
        0,
      ),
      todayFilledOrders:
        todayOrderMetrics.filledOrderCount +
        todayOrderMetrics.submittedOrderCount,
      todayFilledNotional: todayOrderMetrics.filledOrderNotional,
      todayProfitableRecords: todayClosedTrades.filter((record) => record.pnl > 0).length,
      todayLosingRecords: todayClosedTrades.filter((record) => record.pnl < 0).length,
      todayBreakevenRecords: todayClosedTrades.filter((record) => record.pnl === 0).length,
      todayRealizedPnl: todayRealizedRecords.reduce((sum, record) => sum + record.pnl, 0),
      monthRealizedPnl: monthRealizedRecords.reduce((sum, record) => sum + record.pnl, 0),
      accountBalance,
      accountAvailableBalance,
      accountBalanceComplete: balanceComplete,
      accountBalanceAvailable,
      eligibleAccountCount: accountBalances.length,
      freshAccountCount: freshBalances.length,
      positionPricesComplete,
    },
    accountBalances,
    orderHealth,
    profitFunnel,
    positions: markedPositions.slice(0, 5),
    strategies: strategyRows.slice(0, 5).map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      displayName: nexusBrainDisplayName(strategy.name),
      brainTemplate: strategy.brainTemplate,
      strategyType: strategy.strategyType,
      symbolScope: strategy.symbolScope,
      status: strategy.status,
      configVersion: strategy.configVersion,
      accountId: strategy.accountId,
    })),
    strategyFunnels,
    orderMetricsSource: {
      mode: "MINUTE_BUCKETS",
      inverseDetailSampleLimit: OVERVIEW_INVERSE_DETAIL_ORDER_LIMIT,
      inverseDetailRows: todayOrders.length,
    },
    rateLimit,
    traffic: {
      futuresData: systemMetrics?.futuresData ?? null,
      klineWeightAudit: systemMetrics?.klineWeightAudit ?? null,
      liquidationNotionalDistribution:
        systemMetrics?.liquidationNotionalDistribution ?? null,
      topInternalRequest: systemMetrics?.topByInternalRequestCount ?? null,
      topUpstreamRequest: systemMetrics?.topByUpstreamRequestCount ?? null,
    },
    riskState,
    systemStatus: {
      healthy: systemHealthy,
      websocketHealthy,
      riskHeartbeatHealthy,
      balanceComplete,
      positionPricesComplete,
      checkedAt: new Date().toISOString(),
    },
    events: [],
    marketStatus: {
      source: "BINANCE_WEBSOCKET_MARK_AND_TICKER",
      // Universe and per-position mark refreshes are independent consumers of
      // the shared WebSocket. Their temporary failure must not downgrade the
      // actual socket connection state for the whole workspace.
      reachable: websocketHealthy,
      error: marketSnapshot?.tickerError ?? marketSnapshot?.markError ?? marketSnapshot?.systemError ?? null,
      updatedAt: systemMetrics?.websocket?.lastMessageAt ?? new Date().toISOString(),
    },
    markets: symbols.map((symbol) => {
      const ticker = tickers.find((row) => row.symbol === symbol.symbol);
      return ticker ? {
        symbol: symbol.symbol,
        name: symbol.displayName,
        min: String(symbol.minOrderQty),
        price: ticker.price,
        change: ticker.change,
        high: ticker.high,
        low: ticker.low,
        volume: ticker.quoteVolume,
      } : null;
    }).filter(Boolean),
  });
}
