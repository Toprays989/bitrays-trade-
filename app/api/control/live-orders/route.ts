import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  contractSymbols,
  exchangeCredentials,
  liveOrderEvents,
  livePositionAdditions,
  livePositionReductions,
  livePositions,
  semiAutoAnalyses,
  strategies,
  strategyExecutionTraces,
  tradingAccounts,
} from "../../../../db/schema";
import {
  BinanceLiveError,
  getBinanceLiveContractRule,
  getBinanceLiveMarkPrices,
  getLiveAccountPositionSnapshots,
  getLivePositionSnapshot,
} from "../../../../lib/binance-usdm-live";
import {
  cancelLiveOrder,
  queryLiveOrder,
  submitLiveEntryOrder,
} from "../../../../lib/execution/exchange-order-gateway";
import { maximumAllowedLeverageFromError } from "../../../../lib/binance-leverage-error";
import {
  credentialContext,
  decryptCredential,
  isSecureCredentialRequest,
  liveTradingAllowedByServer,
} from "../../../../lib/credential-vault";
import {
  effectiveMarketMinimumOrderQuantity,
  effectiveMinimumOrderQuantity,
} from "../../../../lib/order-quantity";
import { buildEntryStructureBaseline, type EntryStructureBaseline } from "../../../../lib/entry-structure-baseline";
import { nexusUnifiedMarketData } from "../../../../lib/nexus-unified-market-data-live";
import {
  activateProtectionPlan,
  buildInstrumentId,
} from "../../../../lib/position-protection-version";
import { isResponse, requirePermission, writeAudit } from "../shared";
import {
  canonicalStoredLiveOrderStatus,
  liveOrderIsWorking,
  liveOrderStatusFromExchange,
} from "../../../../lib/live-order-status";
import {
  SEMI_AUTO_CONFIRMATION_WINDOW_MS,
  SEMI_AUTO_MAX_REFERENCE_PRICE_DRIFT_RATIO,
  parseSemiAutoStoredPlan,
  semiAutoConfirmationExpiresAt,
  semiAutoReferencePriceDriftRatio,
  semiAutoSubmissionMismatch,
} from "../../../../lib/nexus-semi-auto-confirmation";
import { liveEntryClientOrderIds } from "../../../../lib/live-order-idempotency";
import { findBlockingOpenSymbolPosition } from "../../../../lib/position-exposure";
import { observeExecutionQuote } from "../../../../lib/execution-quote-shadow-store";
import { AUTOMATED_STRATEGY_LEVERAGE } from "../../../../lib/liquidation-trend-config";
import {
  maximumConfiguredStopRoePercent,
  withCapitalPreservationStop,
} from "../../../../lib/capital-preservation-stop";
import { chunkSqlQueryValues } from "../../../../lib/sql-query-batching";
import { normalizeRiskLevelsForExecution } from "../../../../lib/risk-grid";
import {
  buildFilledPositionHandoff,
  FILLED_POSITION_HANDOFF_CONTRACT_VERSION,
} from "../../../../lib/position-lifecycle/filled-position-handoff";

export const dynamic = "force-dynamic";
const ORDER_HISTORY_READ_LIMIT = 500;

function safeResponse(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  return {
    orderId: source.orderId,
    clientOrderId: source.clientOrderId,
    status: source.status,
    executedQty: source.executedQty,
    avgPrice: source.avgPrice,
  };
}

function parsedResponse(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveLeverage(...values: unknown[]) {
  for (const value of values) {
    const leverage = Number(value);
    if (Number.isInteger(leverage) && leverage > 0) return leverage;
  }
  return null;
}
type RiskLevel = {
  triggerPercent: number;
  closePercent: number;
  closeQuantity?: number;
};
type ManualOrderContext = {
  origin: "SEMI_AUTO";
  analysisRecordId: number;
  strategyId: number;
  strategyConfigVersion: number;
  analysisVersion: string;
  analyzedAt: string;
  thesis: string;
  horizon: "SCALP" | "INTRADAY" | "SWING";
  verdict: "EXECUTABLE";
  entryStructureBaseline: EntryStructureBaseline;
};

function validEntryStructureBaseline(
  value: unknown,
): value is EntryStructureBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    source.version === 1 &&
    source.source === "HISTORICAL_MARK_PRICE_5M_BACKFILL_AT_SIGNAL_TIME" &&
    source.managementEligibility === true &&
    source.entryAttributionEligibility === "PRICE_STRUCTURE_ONLY" &&
    Number.isFinite(source.priorSupport) &&
    Number(source.priorSupport) > 0 &&
    Number.isFinite(source.priorResistance) &&
    Number(source.priorResistance) > Number(source.priorSupport) &&
    Number.isFinite(source.atr5m) &&
    Number(source.atr5m) > 0 &&
    Number.isFinite(Date.parse(String(source.eventTime ?? ""))) &&
    Math.abs(Date.now() - Date.parse(String(source.eventTime))) <=
      SEMI_AUTO_CONFIRMATION_WINDOW_MS
  );
}

function validatedOrderContext(value: unknown): ManualOrderContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const analyzedAt = Date.parse(String(source.analyzedAt ?? ""));
  if (
    source.origin !== "SEMI_AUTO" ||
    !Number.isInteger(source.analysisRecordId) ||
    Number(source.analysisRecordId) <= 0 ||
    !Number.isInteger(source.strategyId) ||
    !Number.isInteger(source.strategyConfigVersion) ||
    source.verdict !== "EXECUTABLE" ||
    !["SCALP", "INTRADAY", "SWING"].includes(String(source.horizon)) ||
    typeof source.analysisVersion !== "string" ||
    !/^nexus-semi-auto-opportunity-v\d+$/.test(source.analysisVersion) ||
    typeof source.thesis !== "string" ||
    source.thesis.trim().length < 8 ||
    source.thesis.trim().length > 1000 ||
    !validEntryStructureBaseline(source.entryStructureBaseline) ||
    !Number.isFinite(analyzedAt) ||
    analyzedAt > Date.now() + 5_000 ||
    Date.now() >= semiAutoConfirmationExpiresAt(analyzedAt)
  )
    return null;
  return {
    origin: "SEMI_AUTO",
    analysisRecordId: Number(source.analysisRecordId),
    strategyId: Number(source.strategyId),
    strategyConfigVersion: Number(source.strategyConfigVersion),
    analysisVersion: source.analysisVersion,
    analyzedAt: new Date(analyzedAt).toISOString(),
    thesis: source.thesis.trim(),
    horizon: source.horizon as ManualOrderContext["horizon"],
    verdict: "EXECUTABLE",
    entryStructureBaseline: source.entryStructureBaseline,
  };
}
function validateLiveRiskPlan(
  levels: RiskLevel[] | undefined,
  label: string,
) {
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > 10)
    return `${label}计划需设置 1–10 档`;
  let previous = 0;
  for (const level of levels) {
    if (
      !Number.isFinite(level.triggerPercent) ||
      level.triggerPercent <= 0 ||
      level.triggerPercent <= previous
    )
      return `${label}ROE触发比例必须大于 0 且依次增大`;
    if (
      !Number.isFinite(level.closePercent) ||
      level.closePercent < 1 ||
      level.closePercent > 100
    )
      return `${label}每档减仓比例需为 1%–100%`;
    previous = level.triggerPercent;
  }
  return levels.at(-1)?.closePercent === 100
    ? ""
    : `${label}最后一档必须关闭全部剩余仓位`;
}

async function handleGet(request: Request) {
  const user = await requirePermission(request, "sys:account:view");
  if (isResponse(user)) return user;
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, ORDER_HISTORY_READ_LIMIT)
    : ORDER_HISTORY_READ_LIMIT;
  const requestedCursor = Number(url.searchParams.get("beforeId"));
  const beforeId = Number.isInteger(requestedCursor) && requestedCursor > 0
    ? requestedCursor
    : null;
  const resultRows = await getDb()
    .select()
    .from(liveOrderEvents)
    .where(and(
      eq(liveOrderEvents.ownerEmail, user.email),
      beforeId === null ? undefined : lt(liveOrderEvents.id, beforeId),
    ))
    .orderBy(desc(liveOrderEvents.id))
    .limit(limit + 1);
  const hasMore = resultRows.length > limit;
  const rows = resultRows.slice(0, limit);
  if (!rows.length)
    return Response.json({
      readLimit: limit,
      hasMore: false,
      nextCursor: null,
      orders: [],
    });
  const db = getDb();
  const oldestVisibleOrderAt = rows.at(-1)!.createdAt;
  const [entryPositions, additions, reductions] = await Promise.all([
    db
      .select({
        positionId: livePositions.id,
        sourceEventId: livePositions.sourceEventId,
        leverage: livePositions.leverage,
      })
      .from(livePositions)
      .innerJoin(
        liveOrderEvents,
        eq(liveOrderEvents.id, livePositions.sourceEventId),
      )
      .where(
        and(
          eq(liveOrderEvents.ownerEmail, user.email),
          gte(liveOrderEvents.createdAt, oldestVisibleOrderAt),
        ),
      ),
    db
      .select({
        positionId: livePositions.id,
        clientOrderId: livePositionAdditions.clientOrderId,
        leverage: livePositions.leverage,
      })
      .from(livePositionAdditions)
      .innerJoin(
        livePositions,
        eq(livePositions.id, livePositionAdditions.positionId),
      )
      .innerJoin(
        liveOrderEvents,
        eq(
          liveOrderEvents.clientOrderId,
          livePositionAdditions.clientOrderId,
        ),
      )
      .where(
        and(
          eq(liveOrderEvents.ownerEmail, user.email),
          gte(liveOrderEvents.createdAt, oldestVisibleOrderAt),
        ),
      ),
    db
      .select({
        positionId: livePositions.id,
        clientOrderId: livePositionReductions.clientOrderId,
      })
      .from(livePositionReductions)
      .innerJoin(
        livePositions,
        eq(livePositions.id, livePositionReductions.positionId),
      )
      .innerJoin(
        liveOrderEvents,
        eq(
          liveOrderEvents.clientOrderId,
          livePositionReductions.clientOrderId,
        ),
      )
      .where(
        and(
          eq(liveOrderEvents.ownerEmail, user.email),
          gte(liveOrderEvents.createdAt, oldestVisibleOrderAt),
        ),
      ),
  ]);
  const entryEventIds = new Set(
    entryPositions.map((position) => position.sourceEventId),
  );
  const entryLeverageByEventId = new Map(
    entryPositions.map((position) => [
      position.sourceEventId,
      position.leverage,
    ]),
  );
  const additionOrderIds = new Set(
    additions.map((addition) => addition.clientOrderId),
  );
  const additionLeverageByOrderId = new Map(
    additions.map((addition) => [
      addition.clientOrderId,
      addition.leverage,
    ]),
  );
  const reductionOrderIds = new Set(
    reductions.map((reduction) => reduction.clientOrderId),
  );
  const visiblePositionIds = [...new Set([
    ...entryPositions.map((position) => position.positionId),
    ...additions.map((addition) => addition.positionId),
    ...reductions.map((reduction) => reduction.positionId),
  ].map(String))];
  const visibleExchangeOrderIds = [...new Set(
    rows.flatMap((row) => row.exchangeOrderId ? [row.exchangeOrderId] : []),
  )];
  let strategyByPositionId = new Map<number, number>();
  let strategyByExchangeOrderId = new Map<string, number>();
  try {
    const traces: Array<{
      positionId: string | null;
      exchangeOrderId: string | null;
      strategyId: number;
    }> = [];
    for (const positionIdChunk of chunkSqlQueryValues(visiblePositionIds)) {
      traces.push(...await db
        .select({
          positionId: strategyExecutionTraces.positionId,
          exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
          strategyId: strategyExecutionTraces.strategyId,
        })
        .from(strategyExecutionTraces)
        .where(and(
          eq(strategyExecutionTraces.ownerEmail, user.email),
          inArray(strategyExecutionTraces.positionId, positionIdChunk),
        )));
    }
    for (
      const exchangeOrderIdChunk of chunkSqlQueryValues(
        visibleExchangeOrderIds,
      )
    ) {
      traces.push(...await db
        .select({
          positionId: strategyExecutionTraces.positionId,
          exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
          strategyId: strategyExecutionTraces.strategyId,
        })
        .from(strategyExecutionTraces)
        .where(and(
          eq(strategyExecutionTraces.ownerEmail, user.email),
          inArray(
            strategyExecutionTraces.exchangeOrderId,
            exchangeOrderIdChunk,
          ),
        )));
    }
    strategyByPositionId = new Map(
      traces.map((trace) => [Number(trace.positionId), trace.strategyId]),
    );
    strategyByExchangeOrderId = new Map(
      traces
        .filter((trace) => trace.exchangeOrderId)
        .map((trace) => [trace.exchangeOrderId!, trace.strategyId]),
    );
  } catch (error) {
    console.error(
      "live order strategy attribution unavailable",
      error instanceof Error ? error.message : "unknown error",
    );
  }
  const entryStrategyByEventId = new Map(
    entryPositions.map((position) => [
      position.sourceEventId,
      strategyByPositionId.get(position.positionId) ?? null,
    ]),
  );
  const additionStrategyByOrderId = new Map(
    additions.map((addition) => [
      addition.clientOrderId,
      strategyByPositionId.get(addition.positionId) ?? null,
    ]),
  );
  const reductionStrategyByOrderId = new Map(
    reductions.map((reduction) => [
      reduction.clientOrderId,
      strategyByPositionId.get(reduction.positionId) ?? null,
    ]),
  );
  return Response.json({
    readLimit: limit,
    hasMore,
    nextCursor: hasMore ? rows.at(-1)!.id : null,
    orders: rows.map((row) => {
      const response = parsedResponse(row.responseJson);
      const status = canonicalStoredLiveOrderStatus({
        storedStatus: row.status,
        response,
        requestedQuantity: row.quantity,
      });
      const lifecycle =
        response.nexusPrivateOrderLifecycle &&
        typeof response.nexusPrivateOrderLifecycle === "object"
          ? (response.nexusPrivateOrderLifecycle as Record<string, unknown>)
          : {};
      const executedQuantity = Math.min(
        row.quantity,
        Math.max(
          0,
          Number(lifecycle.cumulativeQuantity ?? response.executedQty) || 0,
        ),
      );
      const purpose = reductionOrderIds.has(row.clientOrderId)
        ? "REDUCTION"
        : additionOrderIds.has(row.clientOrderId)
          ? "ADDITION"
          : entryEventIds.has(row.id)
            ? "ENTRY"
            : "UNKNOWN";
      const positionStrategyId = purpose === "ENTRY"
        ? entryStrategyByEventId.get(row.id) ?? null
        : purpose === "ADDITION"
          ? additionStrategyByOrderId.get(row.clientOrderId) ?? null
          : purpose === "REDUCTION"
            ? reductionStrategyByOrderId.get(row.clientOrderId) ?? null
            : null;
      const strategyId = positionStrategyId ??
        (row.exchangeOrderId
          ? strategyByExchangeOrderId.get(row.exchangeOrderId) ?? null
          : null);
      const timing =
        response.timing &&
          typeof response.timing === "object" &&
          !Array.isArray(response.timing)
          ? response.timing as Record<string, unknown>
          : {};
      const strategyOrder = /^(?:nql|nqs|nqi|nqp|nqa|srb)_/.test(row.clientOrderId);
      const leverage = positiveLeverage(
        response.confirmedLeverage,
        timing.confirmedLeverage,
        entryLeverageByEventId.get(row.id),
        additionLeverageByOrderId.get(row.clientOrderId),
        response.requestedLeverage,
        strategyOrder ? AUTOMATED_STRATEGY_LEVERAGE : null,
      );
      return {
        ...row,
        status,
        executedQuantity,
        remainingQuantity: Math.max(0, row.quantity - executedQuantity),
        leverage,
        initialMarginUsdt:
          purpose === "REDUCTION" || leverage === null
            ? null
            : row.estimatedNotional / leverage,
        responseJson: undefined,
        response,
        expiresAt:
          typeof response.expiresAt === "string"
            ? response.expiresAt
            : null,
        cancelReason:
          typeof response.cancelReason === "string"
            ? response.cancelReason
            : null,
        canCancel:
          !row.testOnly &&
          row.orderType === "LIMIT" &&
          liveOrderIsWorking(status) &&
          !["CANCEL_PENDING", "EXECUTION_UNKNOWN"].includes(status),
        purpose,
        strategyId,
      };
    }),
  });
}

export async function GET(request: Request) {
  try {
    return await handleGet(request);
  } catch (error) {
    console.error(
      "live order ledger read failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return Response.json(
      {
        error:
          "订单已提交后的列表数据暂时无法读取，请勿重复下单，稍后点击刷新",
        code: "LIVE_ORDER_LIST_TEMPORARILY_UNAVAILABLE",
      },
      { status: 503 },
    );
  }
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:order:cancel");
  if (isResponse(user)) return user;
  const body = (await request.json()) as {
    id?: number;
    action?: "CANCEL";
  };
  if (!Number.isInteger(body.id) || body.action !== "CANCEL")
    return Response.json({ error: "撤单参数无效" }, { status: 400 });
  const db = getDb();
  const [order] = await db
    .select()
    .from(liveOrderEvents)
    .where(
      and(
        eq(liveOrderEvents.id, body.id!),
        eq(liveOrderEvents.ownerEmail, user.email),
      ),
    )
    .limit(1);
  if (!order)
    return Response.json({ error: "订单不存在" }, { status: 404 });
  if (
    order.testOnly ||
    order.orderType !== "LIMIT" ||
    !liveOrderIsWorking(order.status) ||
    ["CANCEL_PENDING", "EXECUTION_UNKNOWN"].includes(order.status)
  )
    return Response.json(
      { error: "只有交易所中的等待限价单可以撤销" },
      { status: 409 },
    );
  const [credential] = await db
    .select()
    .from(exchangeCredentials)
    .where(
      and(
        eq(exchangeCredentials.id, order.credentialId),
        eq(exchangeCredentials.ownerEmail, user.email),
      ),
    )
    .limit(1);
  if (!credential)
    return Response.json({ error: "订单账户密钥不存在" }, { status: 409 });
  const credentials = {
    apiKey: await decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(user.email, credential.accountId, "api-key"),
    ),
    secretKey: await decryptCredential(
      credential.secretKeyCiphertext,
      credential.secretKeyIv,
      credentialContext(user.email, credential.accountId, "secret-key"),
    ),
  };
  const queried = await queryLiveOrder(
    credentials,
    order.symbol,
    order.clientOrderId,
  );
  const exchangeStatus = String(queried.data.status ?? "").toUpperCase();
  const queriedExecutedQuantity = Number(queried.data.executedQty) || 0;
  if (exchangeStatus === "FILLED")
    return Response.json(
      {
        error: "订单已经全部成交，不能撤销；系统将同步成交仓位",
        code: "ORDER_ALREADY_EXECUTED",
      },
      { status: 409 },
    );
  const priorResponse = parsedResponse(order.responseJson);
  let canceled = queried.data;
  if (!["CANCELED", "EXPIRED", "REJECTED"].includes(exchangeStatus)) {
    const [cancelPending] = await db
      .update(liveOrderEvents)
      .set({
        status: "CANCEL_PENDING",
        responseJson: JSON.stringify({
          ...priorResponse,
          ...safeResponse(queried.data),
          cancelSource: "MANUAL",
          cancelRequestedAt: new Date().toISOString(),
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(liveOrderEvents.id, order.id),
          inArray(liveOrderEvents.status, [
            "PENDING",
            "NEW",
            "PARTIALLY_FILLED",
          ]),
        ),
      )
      .returning();
    if (!cancelPending)
      return Response.json(
        { error: "订单状态刚刚发生变化，请刷新后重试" },
        { status: 409 },
      );
    canceled = (
      await cancelLiveOrder(
        credentials,
        order.symbol,
        order.clientOrderId,
      )
    ).data;
  }
  const canceledExecutedQuantity = Number(canceled.executedQty) || 0;
  if (canceledExecutedQuantity > 0 || queriedExecutedQuantity > 0) {
    await db
      .update(liveOrderEvents)
      .set({
        status: "EXECUTION_UNKNOWN",
        responseJson: JSON.stringify({
          ...priorResponse,
          ...safeResponse(canceled),
          cancelSource: "MANUAL",
          cancelReason: "USER_REQUESTED",
          cancellationHasExecution: true,
          canceledAt: new Date().toISOString(),
        }),
        updatedAt: new Date(),
      })
      .where(eq(liveOrderEvents.id, order.id));
    return Response.json(
      {
        error: "撤销时检测到部分成交，剩余委托已撤；系统将先同步实际成交仓位",
        code: "ORDER_PARTIALLY_EXECUTED_DURING_CANCEL",
        reconciliationRequired: true,
      },
      { status: 202 },
    );
  }
  const canceledAt = new Date();
  const [updated] = await db
    .update(liveOrderEvents)
    .set({
      status: "CANCELED",
      responseJson: JSON.stringify({
        ...priorResponse,
        ...safeResponse(canceled),
        cancelSource: "MANUAL",
        cancelReason: "USER_REQUESTED",
        canceledAt: canceledAt.toISOString(),
      }),
      updatedAt: canceledAt,
    })
    .where(
      and(
        eq(liveOrderEvents.id, order.id),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
          "CANCEL_PENDING",
        ]),
      ),
    )
    .returning();
  if (!updated)
    return Response.json(
      { error: "订单状态刚刚发生变化，请刷新后重试" },
      { status: 409 },
    );
  const [trace] = await db
    .select()
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.exchangeOrderId, order.exchangeOrderId ?? ""))
    .limit(1);
  if (trace) {
    const evidence = parsedResponse(trace.entryEvidenceJson);
    await db
      .update(strategyExecutionTraces)
      .set({
        state: "CANCELED",
        resultCode: "MANUAL_PENDING_ORDER_CANCELED",
        resultMessage: "运营人员已在订单状态中撤销等待限价单",
        entryEvidenceJson: JSON.stringify({
          ...evidence,
          activePendingOrder: null,
          manualCancellation: {
            clientOrderId: order.clientOrderId,
            exchangeOrderId: order.exchangeOrderId,
            canceledAt: canceledAt.toISOString(),
            reason: "USER_REQUESTED",
          },
        }),
        exchangeOrderId: null,
        completedAt: canceledAt,
        updatedAt: canceledAt,
      })
      .where(eq(strategyExecutionTraces.id, trace.id));
  }
  await writeAudit(
    user,
    "CANCEL_LIVE_PENDING_ORDER",
    "live_order",
    String(order.id),
    {
      accountId: order.accountId,
      symbol: order.symbol,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      strategyTraceId: trace?.traceId ?? null,
      cancelReason: "USER_REQUESTED",
    },
  );
  return Response.json({
    order: {
      ...updated,
      responseJson: undefined,
      response: parsedResponse(updated.responseJson),
      canCancel: false,
    },
    clearedPendingState: true,
  });
}

async function createLiveOrder(request: Request) {
  const user = await requirePermission(request, "trade:live_order:create");
  if (isResponse(user)) return user;
  if (!isSecureCredentialRequest(request))
    return Response.json(
      {
        error: "实盘订单只能通过可信 HTTPS 提交",
        code: "HTTPS_REQUIRED_FOR_LIVE_ORDER",
      },
      { status: 426 },
    );
  const body = (await request.json()) as {
    credentialId?: number;
    symbol?: string;
    positionSide?: "LONG" | "SHORT";
    orderType?: "MARKET" | "LIMIT";
    price?: number;
    quantity?: number;
    leverage?: number;
    confirmation?: string;
    idempotencyKey?: string;
    takeProfitPlan?: RiskLevel[];
    stopLossPlan?: RiskLevel[];
    capitalPreservationStopRoePercent?: number;
    trailingActivationPercent?: number;
    trailingStopPercent?: number;
    cancelAfterMinutes?: number;
    orderContext?: unknown;
  };
  if ("testOnly" in body)
    return Response.json(
      { error: "生产下单接口不接受测试订单参数" },
      { status: 400 },
    );
  const orderContext = body.orderContext
    ? validatedOrderContext(body.orderContext)
    : null;
  if (body.orderContext && !orderContext)
    return Response.json(
      { error: "半自动机会分析已过期或来源信息无效，请重新分析" },
      { status: 409 },
    );
  if (
    !Number.isInteger(body.credentialId) ||
    !["LONG", "SHORT"].includes(body.positionSide ?? "") ||
    !Number.isFinite(body.quantity) ||
    body.quantity! <= 0 ||
    !Number.isInteger(body.leverage) ||
    body.leverage! < 1
  )
    return Response.json({ error: "实盘订单参数不完整" }, { status: 400 });
  const symbol = body.symbol?.trim().toUpperCase() ?? "";
  const orderType = body.orderType ?? "MARKET";
  if (!["MARKET", "LIMIT"].includes(orderType))
    return Response.json({ error: "订单类型不正确" }, { status: 400 });
  if (
    orderType === "LIMIT" &&
    (!Number.isFinite(body.price) || body.price! <= 0)
  )
    return Response.json({ error: "限价单必须填写有效价格" }, { status: 400 });
  const cancelAfterMinutes =
    orderType === "LIMIT" ? Number(body.cancelAfterMinutes) : 0;
  if (
    orderType === "LIMIT" &&
    (!Number.isInteger(cancelAfterMinutes) ||
      cancelAfterMinutes < 1 ||
      cancelAfterMinutes > 3)
  )
    return Response.json(
      { error: "限价自动撤单时间需为 1–3 分钟" },
      { status: 400 },
    );
  if (!/^[A-Z0-9]{5,20}$/.test(symbol))
    return Response.json({ error: "合约代码格式不正确" }, { status: 400 });
  const db = getDb();
  const [contextStrategy] = orderContext
    ? await db
        .select({
          id: strategies.id,
          accountId: strategies.accountId,
          configVersion: strategies.configVersion,
        })
        .from(strategies)
        .where(
          and(
            eq(strategies.id, orderContext.strategyId),
            eq(strategies.ownerEmail, user.email),
          ),
        )
        .limit(1)
    : [];
  if (
    orderContext &&
    (!contextStrategy ||
      contextStrategy.configVersion !== orderContext.strategyConfigVersion)
  )
    return Response.json(
      { error: "半自动分析所用大脑版本已变化，请按最新参数重新分析" },
      { status: 409 },
    );
  const [semiAutoAnalysis] = orderContext
    ? await db
        .select()
        .from(semiAutoAnalyses)
        .where(
          and(
            eq(semiAutoAnalyses.id, orderContext.analysisRecordId),
            eq(semiAutoAnalyses.ownerEmail, user.email),
            eq(semiAutoAnalyses.strategyId, orderContext.strategyId),
            eq(semiAutoAnalyses.configVersion, orderContext.strategyConfigVersion),
            eq(semiAutoAnalyses.symbol, symbol),
            eq(semiAutoAnalyses.positionSide, body.positionSide!),
            eq(semiAutoAnalyses.verdict, "EXECUTABLE"),
          ),
        )
        .limit(1)
    : [];
  if (
    orderContext &&
    (!semiAutoAnalysis ||
      semiAutoAnalysis.analysisVersion !== orderContext.analysisVersion ||
      semiAutoAnalysis.thesis !== orderContext.thesis ||
      semiAutoAnalysis.createdAt.toISOString() !== orderContext.analyzedAt)
  )
    return Response.json(
      {
        error:
          "半自动分析记录不存在、已使用或内容不一致，请重新分析后再下单",
      },
      { status: 409 },
    );
  const semiAutoPlan = orderContext
    ? parseSemiAutoStoredPlan(
        semiAutoAnalysis?.planJson
          ? parsedResponse(semiAutoAnalysis.planJson)
          : null,
      )
    : null;
  if (orderContext && !semiAutoPlan)
    return Response.json(
      {
        error:
          "半自动确认计划不完整或已损坏，请重新分析后再下单",
      },
      { status: 409 },
    );
  const [cachedSymbol] = await db
    .select({
      instrumentId: contractSymbols.instrumentId,
      ruleVersion: contractSymbols.ruleVersion,
      isActive: contractSymbols.isActive,
      source: contractSymbols.source,
    })
    .from(contractSymbols)
    .where(eq(contractSymbols.symbol, symbol))
    .limit(1);
  if (
    !cachedSymbol ||
    !cachedSymbol.isActive ||
    cachedSymbol.source === "MANUAL_EXCLUDE"
  )
    return Response.json(
      { error: `${symbol} 不在当前合约池，请先到合约池搜索添加` },
      { status: 409 },
    );
  let liveContract;
  try {
    liveContract = (await getBinanceLiveContractRule(symbol)).contract;
  } catch (error) {
    if (error instanceof BinanceLiveError)
      return Response.json(
        { error: error.message },
        { status: error.status },
      );
    return Response.json(
      { error: `${symbol} Binance 当前交易规则不可用，未创建订单` },
      { status: 503 },
    );
  }
  const allowedSymbol = {
    ...liveContract,
    instrumentId:
      cachedSymbol?.instrumentId ?? buildInstrumentId({ symbol }),
    ruleVersion: cachedSymbol?.ruleVersion ?? 1,
  };
  if (
    orderType === "LIMIT" &&
    Math.abs(
      body.price! / allowedSymbol.priceTickSize -
        Math.round(body.price! / allowedSymbol.priceTickSize),
    ) > 1e-8
  )
    return Response.json(
      { error: `限价必须按 ${allowedSymbol.priceTickSize} 的价格步长递增` },
      { status: 400 },
    );
  if (body.quantity! < allowedSymbol.minOrderQty)
    return Response.json(
      { error: `最小下单量为 ${allowedSymbol.minOrderQty}` },
      { status: 400 },
    );
  const quantitySteps = body.quantity! / allowedSymbol.quantityStep;
  if (Math.abs(quantitySteps - Math.round(quantitySteps)) > 1e-8)
    return Response.json(
      {
        error: `下单数量需满足最小量 ${allowedSymbol.minOrderQty}，并按 ${allowedSymbol.quantityStep} 的步长递增`,
      },
      { status: 400 },
    );
  const takeProfitPlan = body.takeProfitPlan ?? [];
  const stopLossPlan = body.stopLossPlan ?? [];
  const trailingActivationPercent = Number(body.trailingActivationPercent ?? 0);
  const trailingStopPercent = Number(body.trailingStopPercent ?? 0);
  const dynamicStopEnabled = trailingStopPercent > 0;
  // Dynamic trailing protection and the fixed stop grid are mutually
  // exclusive. The client intentionally sends an empty fixed-stop plan when
  // trailing protection is enabled; do not run the fixed-grid validator in
  // that mode. Normalize again on the server so stale clients cannot persist
  // two competing stop mechanisms on the same position.
  const effectiveStopLossPlan = dynamicStopEnabled ? [] : stopLossPlan;
  const requestedCapitalStop = Number(
    body.capitalPreservationStopRoePercent,
  );
  const capitalPreservationStopRoePercent =
    Number.isFinite(requestedCapitalStop) && requestedCapitalStop > 0
      ? requestedCapitalStop
      : maximumConfiguredStopRoePercent(stopLossPlan);
  if (dynamicStopEnabled && capitalPreservationStopRoePercent === null)
    return Response.json(
      { error: "移动止损只在盈利后生效，请同时配置大于 0 的本金保护止损" },
      { status: 400 },
    );
  const planError =
    validateLiveRiskPlan(takeProfitPlan, "止盈") ||
    (!dynamicStopEnabled
      ? validateLiveRiskPlan(effectiveStopLossPlan, "止损")
      : null);
  if (planError) return Response.json({ error: planError }, { status: 400 });
  if (
    !Number.isFinite(trailingActivationPercent) ||
    !Number.isFinite(trailingStopPercent) ||
    trailingActivationPercent < 0 ||
    trailingActivationPercent > 100 ||
    trailingStopPercent < 0 ||
    trailingStopPercent > 50 ||
    (trailingStopPercent > 0 && trailingActivationPercent < 0.1)
  )
    return Response.json({ error: "移动止损参数无效" }, { status: 400 });
  for (const level of [...takeProfitPlan, ...stopLossPlan]) {
    if (
      !Number.isFinite(level.closeQuantity) ||
      level.closeQuantity! < allowedSymbol.minOrderQty ||
      Math.abs(
        level.closeQuantity! / allowedSymbol.quantityStep -
          Math.round(level.closeQuantity! / allowedSymbol.quantityStep),
      ) > 1e-8
    )
      return Response.json(
        {
          error: `风险网格单格数量不能低于 ${allowedSymbol.minOrderQty}，并须按 ${allowedSymbol.quantityStep} 步长对齐`,
        },
        { status: 400 },
      );
  }
  const [credential] = await db
    .select()
    .from(exchangeCredentials)
    .where(
      and(
        eq(exchangeCredentials.id, body.credentialId!),
        eq(exchangeCredentials.ownerEmail, user.email),
      ),
    )
    .limit(1);
  if (!credential)
    return Response.json({ error: "实盘账户密钥不存在" }, { status: 404 });
  if (
    orderContext &&
    contextStrategy?.accountId !== credential.accountId
  )
    return Response.json(
      { error: "半自动计划账户与实盘密钥账户不一致" },
      { status: 409 },
    );
  if (orderContext && semiAutoPlan) {
    const mismatches = semiAutoSubmissionMismatch(semiAutoPlan, {
      accountId: credential.accountId,
      symbol,
      direction: body.positionSide!,
      orderType,
      price: body.price,
      quantity: body.quantity!,
      leverage: body.leverage!,
      cancelAfterMinutes,
      takeProfitPlan: takeProfitPlan.map((item) => ({
        triggerPercent: item.triggerPercent,
        closePercent: item.closePercent,
        closeQuantity: Number(item.closeQuantity),
      })),
      stopLossPlan: stopLossPlan.map((item) => ({
        triggerPercent: item.triggerPercent,
        closePercent: item.closePercent,
        closeQuantity: Number(item.closeQuantity),
      })),
      trailingActivationPercent,
      trailingStopPercent,
      entryStructureBaseline: orderContext.entryStructureBaseline,
    });
    if (mismatches.length)
      return Response.json(
        {
          error: `半自动确认内容与大脑保存计划不一致：${mismatches.join("、")}；请重新分析`,
          code: "SEMI_AUTO_PLAN_MISMATCH",
        },
        { status: 409 },
      );
  }
  const [account] = await db
    .select()
    .from(tradingAccounts)
    .where(
      and(
        eq(tradingAccounts.ownerEmail, user.email),
        eq(tradingAccounts.accountId, credential.accountId),
      ),
    )
    .limit(1);
  if (!account?.isActive)
    return Response.json(
      { error: "站内账户已停用" },
      { status: 423 },
    );
  if (account.accountType === "MAIN")
    return Response.json(
      { error: "主账户只用于配置和资金识别，禁止下单" },
      { status: 403 },
    );
  if (account.executionMode !== "LIVE")
    return Response.json(
      { error: "该子账户尚未启用实盘，请先到账户管理完成密钥校验并启用" },
      { status: 423 },
    );
  if (
    credential.connectionStatus !== "VERIFIED" ||
    credential.lastError ||
    !credential.lastVerifiedAt
  )
    return Response.json(
      {
        error: "该账户的 Binance 密钥尚未通过校验，请到账户管理处理",
        code: "ACCOUNT_CREDENTIAL_NOT_VERIFIED",
      },
      { status: 409 },
    );
  if (!(await liveTradingAllowedByServer()) || !credential.liveTradingEnabled)
    return Response.json(
      { error: "实盘总开关或该账户实盘开关未启用" },
      { status: 423 },
    );
  const side = body.positionSide === "LONG" ? "BUY" : "SELL";
  const expectedConfirmation =
    orderType === "LIMIT"
      ? `LIVE ${credential.accountId} ${symbol} ${side} ${body.quantity} LIMIT ${body.price}`
      : `LIVE ${credential.accountId} ${symbol} ${side} ${body.quantity}`;
  if (body.confirmation !== expectedConfirmation)
    return Response.json(
      { error: `确认文字不匹配，应为：${expectedConfirmation}` },
      { status: 400 },
    );
  const idempotency = body.idempotencyKey?.trim();
  if (!idempotency || !/^[a-zA-Z0-9_-]{12,64}$/.test(idempotency))
    return Response.json({ error: "订单幂等编号无效" }, { status: 400 });
  const clientOrderIds = await liveEntryClientOrderIds({
    ownerEmail: user.email,
    accountId: credential.accountId,
    credentialId: credential.id,
    idempotencyKey: idempotency,
  });
  const clientOrderId = clientOrderIds.primary;
  const duplicateCandidates = await db
    .select()
    .from(liveOrderEvents)
    .where(
      and(
        eq(liveOrderEvents.ownerEmail, user.email),
        eq(liveOrderEvents.accountId, credential.accountId),
        eq(liveOrderEvents.credentialId, credential.id),
        inArray(liveOrderEvents.clientOrderId, [
          clientOrderIds.primary,
          clientOrderIds.legacy,
        ]),
      ),
    )
    .limit(2);
  const duplicate =
    duplicateCandidates.find(
      (candidate) => candidate.clientOrderId === clientOrderIds.primary,
    ) ?? duplicateCandidates[0];
  if (duplicate) {
    const sameRequest =
      duplicate.symbol === symbol &&
      duplicate.positionSide === body.positionSide &&
      duplicate.side === side &&
      duplicate.orderType === orderType &&
      Math.abs(duplicate.quantity - body.quantity!) <= 1e-12 &&
      (orderType !== "LIMIT" ||
        Math.abs(duplicate.referencePrice - body.price!) <= 1e-12);
    if (!sameRequest)
      return Response.json(
        {
          error: "该订单幂等编号已用于不同的下单参数，请重新确认后提交",
          code: "IDEMPOTENCY_KEY_REUSED",
          orderSubmitted: false,
        },
        { status: 409 },
      );
    if (
      orderContext &&
      semiAutoAnalysis?.liveOrderEventId !== duplicate.id
    )
      return Response.json(
        {
          error: "该半自动分析已绑定其他订单，请重新分析",
          code: "SEMI_AUTO_ANALYSIS_ALREADY_CONSUMED",
          orderSubmitted: false,
        },
        { status: 409 },
      );
    return Response.json({
      order: {
        ...duplicate,
        responseJson: undefined,
        response: parsedResponse(duplicate.responseJson),
      },
      duplicate: true,
      pending: duplicate.status === "PENDING",
    });
  }
  if (orderContext && semiAutoAnalysis?.liveOrderEventId)
    return Response.json(
      {
        error: "该半自动分析已被其他订单使用，请重新分析",
        code: "SEMI_AUTO_ANALYSIS_ALREADY_CONSUMED",
        orderSubmitted: false,
      },
      { status: 409 },
    );
  const requestedPrice =
    (await getBinanceLiveMarkPrices([symbol]))[0]?.markPrice ?? Number.NaN;
  if (!Number.isFinite(requestedPrice) || requestedPrice <= 0)
    return Response.json(
      { error: "Binance 标记价格暂不可用，已阻止下单" },
      { status: 503 },
    );
  if (
    semiAutoPlan &&
    semiAutoReferencePriceDriftRatio(
      semiAutoPlan.referencePrice,
      requestedPrice,
    ) > SEMI_AUTO_MAX_REFERENCE_PRICE_DRIFT_RATIO
  )
    return Response.json(
      {
        error:
          "半自动计划生成后市场价格变动已超过 1%，原证据与风险预估可能失效，请重新分析",
        code: "SEMI_AUTO_MARKET_MOVED",
      },
      { status: 409 },
    );
  let manualEntryStructureBaseline: EntryStructureBaseline | null = null;
  if (!orderContext) {
    try {
      const fiveMinute = await nexusUnifiedMarketData.closedCandles({
        symbol,
        interval: "5m",
        limit: 80,
      });
      manualEntryStructureBaseline = buildEntryStructureBaseline({
        eventTimeMs: Date.now(),
        capturedAtMs: Date.now(),
        candles: fiveMinute.rows.map((row) => ({
          ...row,
          closeTime: row.openTime + 5 * 60_000 - 1,
        })),
      });
    } catch {
      // The manual order keeps its explicit TP/SL protection. A later
      // historical backfill may reconstruct this exact pre-entry structure,
      // but missing structure can never fabricate a disciplinary exit.
    }
  }
  if (
    orderType === "LIMIT" &&
    Math.abs(body.price! - requestedPrice) / requestedPrice > 0.2
  )
    return Response.json(
      { error: "限价偏离 Binance 实时价格超过 20%，已阻止下单" },
      { status: 400 },
    );
  const executionReferencePrice =
    orderType === "LIMIT" ? body.price! : requestedPrice;
  const effectiveMinimumQuantity =
    orderType === "MARKET"
      ? effectiveMarketMinimumOrderQuantity(
          allowedSymbol.minOrderQty,
          allowedSymbol.quantityStep,
          allowedSymbol.minNotionalUsdt,
          executionReferencePrice,
        )
      : effectiveMinimumOrderQuantity(
          allowedSymbol.minOrderQty,
          allowedSymbol.quantityStep,
          allowedSymbol.minNotionalUsdt,
          executionReferencePrice,
        );
  if (body.quantity! < effectiveMinimumQuantity - 1e-12)
    return Response.json(
      {
        error: `按当前价格计算的有效最小下单量为 ${Number(effectiveMinimumQuantity.toPrecision(15))}（最小名义价值 ${allowedSymbol.minNotionalUsdt} USDT）`,
      },
      { status: 400 },
    );
  const notional = executionReferencePrice * body.quantity!;
  if (notional < allowedSymbol.minNotionalUsdt)
    return Response.json(
      {
        error: `预计名义价值 ${notional.toFixed(2)} USDT，不能低于 Binance 最小名义价值 ${allowedSymbol.minNotionalUsdt} USDT`,
      },
      { status: 400 },
    );
  const executableTakeProfitPlan = normalizeRiskLevelsForExecution({
    levels: takeProfitPlan.map((item) => ({
      triggerPercent: item.triggerPercent,
      closePercent: item.closePercent,
      closeQuantity: Number(item.closeQuantity),
    })),
    totalQuantity: body.quantity!,
    minQuantity: allowedSymbol.minOrderQty,
    quantityStep: allowedSymbol.quantityStep,
    referencePrice: executionReferencePrice,
    minNotionalUsdt: allowedSymbol.minNotionalUsdt,
  });
  const executableStopLossPlan = dynamicStopEnabled
    ? {
        levels: [] as ReturnType<typeof normalizeRiskLevelsForExecution>["levels"],
        exitPolicy: executableTakeProfitPlan.exitPolicy,
      }
    : normalizeRiskLevelsForExecution({
        levels: effectiveStopLossPlan.map((item) => ({
          triggerPercent: item.triggerPercent,
          closePercent: item.closePercent,
          closeQuantity: Number(item.closeQuantity),
        })),
        totalQuantity: body.quantity!,
        minQuantity: allowedSymbol.minOrderQty,
        quantityStep: allowedSymbol.quantityStep,
        referencePrice: executionReferencePrice,
        minNotionalUsdt: allowedSymbol.minNotionalUsdt,
      });
  const persistPreflightRejection = async (input: {
    code: string;
    error: string;
    details?: Record<string, unknown>;
  }) => {
    const rejectedAt = new Date();
    try {
      let [rejected] = await db
        .insert(liveOrderEvents)
        .values({
          ownerEmail: user.email,
          accountId: credential.accountId,
          credentialId: credential.id,
          clientOrderId,
          symbol,
          side,
          positionSide: body.positionSide!,
          orderType,
          quantity: body.quantity!,
          referencePrice: executionReferencePrice,
          estimatedNotional: notional,
          testOnly: false,
          status: "REJECTED",
          responseJson: JSON.stringify({
            error: input.error,
            code: input.code,
            stage: "PREFLIGHT",
            orderSubmitted: false,
            ...input.details,
          }),
          createdAt: rejectedAt,
          updatedAt: rejectedAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!rejected) {
        [rejected] = await db
          .select()
          .from(liveOrderEvents)
          .where(
            and(
              eq(liveOrderEvents.ownerEmail, user.email),
              eq(liveOrderEvents.accountId, credential.accountId),
              eq(liveOrderEvents.credentialId, credential.id),
              eq(liveOrderEvents.clientOrderId, clientOrderId),
            ),
          )
          .limit(1);
      }
      return rejected ?? null;
    } catch {
      // A ledger write problem must never turn a correctly blocked preflight
      // into an exchange submission. The response still states that no order
      // was sent, and the runtime health loop will surface the database fault.
      return null;
    }
  };
  const credentials = {
    apiKey: await decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(user.email, credential.accountId, "api-key"),
    ),
    secretKey: await decryptCredential(
      credential.secretKeyCiphertext,
      credential.secretKeyIv,
      credentialContext(user.email, credential.accountId, "secret-key"),
    ),
  };
  let positionMode = credential.positionMode;
  let liveAccountPositions:
    Awaited<ReturnType<typeof getLiveAccountPositionSnapshots>>["positions"] =
      [];
  try {
    const liveAccountSnapshot = await getLiveAccountPositionSnapshots(
      credentials,
    );
    liveAccountPositions = liveAccountSnapshot.positions;
    const livePositionMode = liveAccountSnapshot.hedgeMode
      ? "HEDGE"
      : "ONE_WAY";
    if (positionMode !== livePositionMode) {
      positionMode = livePositionMode;
      await db.update(exchangeCredentials).set({
        positionMode: livePositionMode,
        updatedAt: new Date(),
      }).where(eq(exchangeCredentials.id, credential.id));
    }
  } catch (error) {
    const message = `Binance 当前持仓模式核对失败，未发送订单${error instanceof BinanceLiveError ? `（${error.message}）` : ""}`;
    const rejected = await persistPreflightRejection({
      code: "POSITION_MODE_CHECK_FAILED",
      error: message,
    });
    return Response.json(
      {
        error: message,
        code: "POSITION_MODE_CHECK_FAILED",
        orderSubmitted: false,
        order: rejected
          ? { ...rejected, responseJson: undefined }
          : undefined,
      },
      { status: error instanceof BinanceLiveError ? error.status : 503 },
    );
  }
  const existingSymbolPosition = findBlockingOpenSymbolPosition(
    liveAccountPositions,
    {
      symbol,
      targetPositionSide: body.positionSide!,
      positionMode,
    },
  );
  if (existingSymbolPosition) {
    const message = positionMode === "HEDGE"
      ? `${symbol} 已有${existingSymbolPosition.positionSide === "LONG" ? "多" : "空"}仓 ${existingSymbolPosition.quantity}；双向持仓只禁止重复新开同一方向，补仓请从仓位管理进入`
      : `${symbol} 已有${existingSymbolPosition.positionSide === "LONG" ? "多" : "空"}仓 ${existingSymbolPosition.quantity}；当前为单向持仓，请先平仓`;
    const rejected = await persistPreflightRejection({
      code: "SYMBOL_POSITION_ALREADY_OPEN",
      error: message,
      details: {
        existingPositionSide: existingSymbolPosition.positionSide,
        existingQuantity: existingSymbolPosition.quantity,
        positionMode,
      },
    });
    return Response.json(
      {
        error: message,
        code: "SYMBOL_POSITION_ALREADY_OPEN",
        existingPositionSide: existingSymbolPosition.positionSide,
        existingQuantity: existingSymbolPosition.quantity,
        positionMode,
        orderSubmitted: false,
        order: rejected
          ? { ...rejected, responseJson: undefined }
          : undefined,
      },
      { status: 409 },
    );
  }
  const now = new Date();
  let [event] = await db
    .insert(liveOrderEvents)
    .values({
      ownerEmail: user.email,
      accountId: credential.accountId,
      credentialId: credential.id,
      clientOrderId,
      symbol,
      side,
      positionSide: body.positionSide!,
      orderType,
      quantity: body.quantity!,
      referencePrice: executionReferencePrice,
      estimatedNotional: executionReferencePrice * body.quantity!,
      testOnly: false,
      status: "PENDING",
      responseJson: JSON.stringify({ requestedLeverage: body.leverage }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!event) {
    [event] = await db
      .select()
      .from(liveOrderEvents)
      .where(
        and(
          eq(liveOrderEvents.ownerEmail, user.email),
          eq(liveOrderEvents.accountId, credential.accountId),
          eq(liveOrderEvents.credentialId, credential.id),
          eq(liveOrderEvents.clientOrderId, clientOrderId),
        ),
      )
      .limit(1);
    if (!event)
      return Response.json(
        {
          error: "订单幂等编号发生冲突，订单尚未发送，请重新确认后提交",
          code: "IDEMPOTENCY_CONFLICT",
          orderSubmitted: false,
        },
        { status: 409 },
      );
    const sameConcurrentRequest =
      event.symbol === symbol &&
      event.positionSide === body.positionSide &&
      event.side === side &&
      event.orderType === orderType &&
      Math.abs(event.quantity - body.quantity!) <= 1e-12 &&
      (orderType !== "LIMIT" ||
        Math.abs(event.referencePrice - body.price!) <= 1e-12);
    if (!sameConcurrentRequest)
      return Response.json(
        {
          error: "该订单幂等编号正用于不同的下单参数，订单尚未重复发送",
          code: "IDEMPOTENCY_KEY_REUSED",
          orderSubmitted: false,
        },
        { status: 409 },
      );
    if (
      orderContext &&
      semiAutoAnalysis?.liveOrderEventId !== event.id
    )
      return Response.json(
        {
          error: "该半自动订单正在确认，请刷新订单列表，勿重复下单",
          code: "SEMI_AUTO_ORDER_IN_PROGRESS",
          orderSubmitted: false,
        },
        { status: 409 },
      );
    return Response.json({
      order: {
        ...event,
        responseJson: undefined,
        response: parsedResponse(event.responseJson),
      },
      duplicate: true,
      pending: event.status === "PENDING",
    });
  }
  if (orderContext) {
    const linked = await db
      .update(semiAutoAnalyses)
      .set({
        liveOrderEventId: event.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(semiAutoAnalyses.id, orderContext.analysisRecordId),
          isNull(semiAutoAnalyses.liveOrderEventId),
        ),
      )
      .returning({ id: semiAutoAnalyses.id });
    if (!linked.length) {
      await db
        .update(liveOrderEvents)
        .set({
          status: "REJECTED",
          responseJson: JSON.stringify({
            error: "SEMI_AUTO_ANALYSIS_ALREADY_CONSUMED",
          }),
          updatedAt: new Date(),
        })
        .where(eq(liveOrderEvents.id, event.id));
      return Response.json(
        { error: "该半自动分析已被其他订单使用，请重新分析" },
        { status: 409 },
      );
    }
  }
  await observeExecutionQuote({
    recordKey: `ENTRY:${event.id}`,
    quoteRole: "ENTRY",
    liveOrderEventId: event.id,
    clientOrderId,
    ownerEmail: user.email,
    accountId: credential.accountId,
    strategyId: orderContext?.strategyId ?? null,
    traceId: null,
    origin: orderContext ? "SEMI_AUTO" : "MANUAL",
    symbol,
    side,
    positionSide: body.positionSide!,
    actualOrderType: orderType,
    actualRequestedPrice: executionReferencePrice,
    decisionMarkPrice: requestedPrice,
    executableReferencePrice: requestedPrice,
    priceTickSize: allowedSymbol.priceTickSize,
    atr5m: orderContext?.entryStructureBaseline?.atr5m ??
      manualEntryStructureBaseline?.atr5m ?? null,
    prospectiveNotionalUsdt: notional,
  });
  let confirmedFillRecoveryPayload: Record<string, unknown> | null = null;
  try {
    const result = await submitLiveEntryOrder(credentials, {
      symbol,
      side,
      positionSide: body.positionSide!,
      quantity: body.quantity!,
      clientOrderId,
      leverage: body.leverage!,
      orderType,
      price: body.price,
      timeInForce: orderType === "LIMIT" ? "GTC" : undefined,
      positionMode,
      requireExactLeverage: true,
    });
    const effectiveLeverage = result.timing.confirmedLeverage;
    let execution: Awaited<ReturnType<typeof queryLiveOrder>>["data"] =
      result.data;
    let executedQuantity = Number(execution.executedQty) || 0;
    let executedPrice = Number(execution.avgPrice) || 0;
    if (
      execution.status !== "FILLED" ||
      executedQuantity <= 0 ||
      executedPrice <= 0
    ) {
      try {
        const queried = await queryLiveOrder(credentials, symbol, clientOrderId);
        execution = queried.data;
        executedQuantity = Number(execution.executedQty) || 0;
        executedPrice =
          Number(execution.avgPrice) ||
          (executedQuantity > 0
            ? Number(
                ("cumQuote" in execution ? execution.cumQuote : 0) || 0,
              ) / executedQuantity
            : 0);
      } catch {
        // The submit response remains the best available exchange evidence.
        // Never substitute the requested quantity for an unverified fill.
      }
    }
    const response = safeResponse(execution);
    const manualPendingEntry = {
      version: 1,
      orderOrigin: orderContext ? "SEMI_AUTO" : "MANUAL",
      opportunityContext: orderContext,
      entryStructureBaseline:
        orderContext?.entryStructureBaseline ?? manualEntryStructureBaseline,
      leverage: effectiveLeverage,
      requestedLeverage: body.leverage,
      takeProfits: executableTakeProfitPlan.levels,
      stopLosses: executableStopLossPlan.levels,
      notionalExitPolicy: executableTakeProfitPlan.exitPolicy,
      trailingActivationPercent,
      trailingStopPercent,
      dynamicProfitProtectionEnabled: trailingStopPercent > 0,
      capitalPreservationStopRoePercent,
      minOrderQty: allowedSymbol.minOrderQty,
      quantityStep: allowedSymbol.quantityStep,
    };
    if (
      orderType === "LIMIT" &&
      String(execution.status ?? "").toUpperCase() !== "FILLED"
    ) {
      const expiresAt = new Date(
        now.getTime() + cancelAfterMinutes * 60_000,
      );
      const [pending] = await db
        .update(liveOrderEvents)
        .set({
          exchangeOrderId: String(execution.orderId || "") || null,
          status: liveOrderStatusFromExchange(
            execution.status,
            executedQuantity,
          ),
          responseJson: JSON.stringify({
            ...response,
            timeInForce: "GTC",
            expiresAt: expiresAt.toISOString(),
            manualPendingEntry: {
              ...manualPendingEntry,
              expiresAt: expiresAt.toISOString(),
            },
          }),
          updatedAt: new Date(),
        })
        .where(eq(liveOrderEvents.id, event.id))
        .returning();
      await writeAudit(
        user,
        "LIVE_LIMIT_ORDER_PENDING",
        "live_order",
        String(event.id),
        {
          accountId: credential.accountId,
          clientOrderId,
          symbol,
          side,
          quantity: body.quantity,
          limitPrice: body.price,
          exchangeStatus: execution.status,
          expiresAt: expiresAt.toISOString(),
        },
      );
      return Response.json(
        {
          pending: true,
          message: `限价单已挂入 Binance；${cancelAfterMinutes} 分钟未成交将自动撤单`,
          requestedLeverage: body.leverage,
          effectiveLeverage,
          leverageAdjusted: effectiveLeverage !== body.leverage,
          order: { ...pending, responseJson: undefined, response },
        },
        { status: 202 },
      );
    }
    if (executedQuantity <= 0 || executedPrice <= 0) {
      const [unknown] = await db
        .update(liveOrderEvents)
        .set({
          exchangeOrderId: String(execution.orderId || "") || null,
          status: "EXECUTION_UNKNOWN",
          responseJson: JSON.stringify({
            ...response,
            manualPendingEntry,
          }),
          updatedAt: new Date(),
        })
        .where(eq(liveOrderEvents.id, event.id))
        .returning();
      await writeAudit(
        user,
        "LIVE_ENTRY_EXECUTION_UNKNOWN",
        "live_order",
        String(event.id),
        {
          accountId: credential.accountId,
          clientOrderId,
          symbol,
          side,
          requestedQuantity: body.quantity,
          exchangeStatus: execution.status,
          exchangeOrderId: execution.orderId,
        },
      );
      return Response.json(
        {
          error:
            "Binance 已接收下单请求，但暂未返回可核验的真实成交数量或均价；系统未按请求数量虚构仓位，请先核对订单状态",
          orderSubmitted: true,
          order: { ...unknown, responseJson: undefined, response },
        },
        { status: 409 },
      );
    }
    const filledQuantity = executedQuantity;
    const entryPrice = executedPrice;
    const filledTakeProfitPlan = normalizeRiskLevelsForExecution({
      levels: takeProfitPlan.map((item) => ({
        triggerPercent: item.triggerPercent,
        closePercent: item.closePercent,
        closeQuantity: Number(item.closeQuantity),
      })),
      totalQuantity: filledQuantity,
      minQuantity: allowedSymbol.minOrderQty,
      quantityStep: allowedSymbol.quantityStep,
      referencePrice: entryPrice,
      minNotionalUsdt: allowedSymbol.minNotionalUsdt,
    });
    const filledStopLossPlan = dynamicStopEnabled
      ? { levels: [] as typeof filledTakeProfitPlan.levels }
      : normalizeRiskLevelsForExecution({
          levels: effectiveStopLossPlan.map((item) => ({
            triggerPercent: item.triggerPercent,
            closePercent: item.closePercent,
            closeQuantity: Number(item.closeQuantity),
          })),
          totalQuantity: filledQuantity,
          minQuantity: allowedSymbol.minOrderQty,
          quantityStep: allowedSymbol.quantityStep,
          referencePrice: entryPrice,
          minNotionalUsdt: allowedSymbol.minNotionalUsdt,
        });
    const confirmedManualPendingEntry = {
      ...manualPendingEntry,
      takeProfits: filledTakeProfitPlan.levels,
      stopLosses: filledStopLossPlan.levels,
      notionalExitPolicy: filledTakeProfitPlan.exitPolicy,
    };
    confirmedFillRecoveryPayload = {
      ...response,
      manualPendingEntry: confirmedManualPendingEntry,
      exchangeFillConfirmedAt: new Date().toISOString(),
    };
    let position: typeof livePositions.$inferSelect | undefined;
    try {
      const positionOpenedAt = new Date();
      const positionHandoff = buildFilledPositionHandoff({
        origin: "MANUAL",
        sourceEventId: event.id,
        lifecycleId: event.lifecycleId,
        entryDecisionHandoffJson: event.entryDecisionHandoffJson,
        symbol,
        positionSide: body.positionSide!,
        quantity: filledQuantity,
        entryPrice,
        leverage: effectiveLeverage,
        filledAt: positionOpenedAt,
      });
      [position] = await db
        .insert(livePositions)
        .values({
        ownerEmail: user.email,
        accountId: credential.accountId,
        credentialId: credential.id,
        sourceEventId: event.id,
        positionHandoffKey: positionHandoff.handoffKey,
        positionHandoffVersion: FILLED_POSITION_HANDOFF_CONTRACT_VERSION,
        positionHandoffJson: JSON.stringify(positionHandoff),
        symbol,
        instrumentId: allowedSymbol.instrumentId ??
          buildInstrumentId({ symbol }),
        instrumentRuleVersion: allowedSymbol.ruleVersion,
        positionSide: body.positionSide!,
        quantity: filledQuantity,
        entryPrice,
        markPrice: entryPrice,
        leverage: effectiveLeverage,
        riskPlanJson: JSON.stringify(activateProtectionPlan({ plan:
          withCapitalPreservationStop({
          calculationMode: "ROE",
          orderOrigin: orderContext ? "SEMI_AUTO" : "MANUAL",
          opportunityContext: orderContext,
          entryStructureBaseline:
            orderContext?.entryStructureBaseline ??
            manualEntryStructureBaseline,
          dynamicProfitProtectionEnabled: trailingStopPercent > 0,
          takeProfits: filledTakeProfitPlan.levels,
          stopLosses: filledStopLossPlan.levels,
          notionalExitPolicy: filledTakeProfitPlan.exitPolicy,
          }, capitalPreservationStopRoePercent), nowMs: Date.now() })),
        trailingActivationPercent,
        trailingStopPercent,
        favorablePrice: entryPrice,
        status: "OPEN",
        openedAt: positionOpenedAt,
        updatedAt: positionOpenedAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!position) {
        [position] = await db
          .select()
          .from(livePositions)
          .where(eq(livePositions.sourceEventId, event.id))
          .limit(1);
      }
    } catch {
      // Binance has already confirmed the fill. A transient local ledger
      // failure is recovered by live-risk; it must never relabel the exchange
      // fill as rejected or invite the operator to submit a duplicate order.
      position = undefined;
    }
    const filledResponse = {
      ...response,
      manualPendingEntry,
      positionPersistence: position
        ? {
            state: "BOUND",
            positionId: position.id,
            resolvedAt: new Date().toISOString(),
          }
        : {
            state: "PENDING_RECOVERY",
            detectedAt: new Date().toISOString(),
          },
    };
    const [updated] = await db
      .update(liveOrderEvents)
      .set({
        exchangeOrderId:
          "orderId" in response && response.orderId
            ? String(response.orderId)
            : null,
        status: "FILLED",
        responseJson: JSON.stringify(filledResponse),
        updatedAt: new Date(),
      })
      .where(eq(liveOrderEvents.id, event.id))
      .returning();
    if (!position) {
      try {
        await writeAudit(
          user,
          "LIVE_FILLED_POSITION_RECOVERY_PENDING",
          "live_order",
          String(event.id),
          {
            accountId: credential.accountId,
            clientOrderId,
            exchangeOrderId: updated.exchangeOrderId,
            symbol,
            positionSide: body.positionSide,
            executedQuantity: filledQuantity,
            entryPrice,
          },
        );
      } catch {
        // The FILLED ledger row is authoritative; audit failure must not alter
        // exchange execution truth or prevent the recovery loop from running.
      }
      return Response.json(
        {
          pending: true,
          message:
            "Binance 已确认成交，订单状态已完整记录；本地仓位正在自动恢复，请勿重复下单",
          order: {
            ...updated,
            responseJson: undefined,
            response: filledResponse,
          },
          mode: "LIVE",
          requestedLeverage: body.leverage,
          effectiveLeverage,
          leverageAdjusted: effectiveLeverage !== body.leverage,
        },
        { status: 202 },
      );
    }
    try {
      const snapshot = await getLivePositionSnapshot(
        credentials,
        symbol,
        body.positionSide!,
      );
      if (
        snapshot.quantity > 0 &&
        snapshot.entryPrice > 0 &&
        snapshot.markPrice > 0
      ) {
        const aggregateBasis = {
          entryPrice: snapshot.entryPrice,
          markPrice: snapshot.markPrice,
          leverage:
            Number.isFinite(snapshot.leverage) && snapshot.leverage > 0
              ? snapshot.leverage
              : effectiveLeverage,
          liquidationPrice: Number.isFinite(snapshot.liquidationPrice)
            ? snapshot.liquidationPrice > 0
              ? snapshot.liquidationPrice
              : null
            : position.liquidationPrice,
          liquidationPriceRaw: snapshot.liquidationPriceRaw,
          liquidationPriceStatus: snapshot.liquidationPriceStatus,
          liquidationPriceObservedAt: new Date(
            snapshot.liquidationPriceObservedAt,
          ),
          favorablePrice: snapshot.markPrice,
          updatedAt: new Date(),
        };
        await db
          .update(livePositions)
          .set(aggregateBasis)
          .where(
            and(
              eq(livePositions.ownerEmail, user.email),
              eq(livePositions.accountId, credential.accountId),
              eq(livePositions.credentialId, credential.id),
              eq(livePositions.symbol, symbol),
              eq(livePositions.positionSide, body.positionSide!),
              inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
            ),
          );
        if (Number.isFinite(snapshot.leverage) && snapshot.leverage > 0) {
          // Binance USDⓈ-M leverage is symbol-wide, including LONG and SHORT
          // legs in hedge mode.
          await db.update(livePositions).set({
            leverage: snapshot.leverage,
            updatedAt: new Date(),
          }).where(and(
            eq(livePositions.ownerEmail, user.email),
            eq(livePositions.accountId, credential.accountId),
            eq(livePositions.credentialId, credential.id),
            eq(livePositions.symbol, symbol),
            inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
          ));
        }
        position = { ...position, ...aggregateBasis };
      }
    } catch {
      // The periodic live-risk reconciliation repeats this exchange-basis
      // synchronization. A transient snapshot failure must not turn a
      // confirmed Binance fill into an HTTP error.
    }
    try {
      await writeAudit(
        user,
        "SUBMIT_LIVE_ORDER",
        "live_order",
        String(event.id),
        {
          accountId: credential.accountId,
          clientOrderId,
          symbol,
          side,
          positionSide: body.positionSide,
          orderType,
          requestedPrice,
          binancePositionMode: positionMode,
          quantity: body.quantity,
          requestedLeverage: body.leverage,
          leverage: effectiveLeverage,
          leverageAdjusted: effectiveLeverage !== body.leverage,
          estimatedNotional: notional,
          exchangeOrderId: updated.exchangeOrderId,
          executionLatencyMs: "timing" in result ? result.timing.totalMs : null,
        },
      );
    } catch {
      // The order and position ledgers are already durable. Audit logging is
      // best effort after a confirmed fill and cannot roll back execution.
    }
    return Response.json(
      {
        order: { ...updated, responseJson: undefined, response },
        position,
        mode: "LIVE",
        requestedLeverage: body.leverage,
        effectiveLeverage,
        leverageAdjusted: effectiveLeverage !== body.leverage,
      },
      { status: 201 },
    );
  } catch (error) {
    const known = error instanceof BinanceLiveError;
    const exchangeFillConfirmed = confirmedFillRecoveryPayload !== null;
    const status = exchangeFillConfirmed || (known && error.executionUnknown)
      ? "EXECUTION_UNKNOWN"
      : "REJECTED";
    const message = known ? error.message : "Binance 实盘订单请求失败";
    const maximumLeverage = maximumAllowedLeverageFromError(error);
    const [currentOrder] = await db
      .select()
      .from(liveOrderEvents)
      .where(eq(liveOrderEvents.id, event.id))
      .limit(1);
    if (currentOrder?.status === "FILLED") {
      return Response.json(
        {
          pending: true,
          orderSubmitted: true,
          message:
            "Binance 成交已经确认，订单状态已保留；本地后续数据正在自动核对，请勿重复下单",
          order: { ...currentOrder, responseJson: undefined },
        },
        { status: 202 },
      );
    }
    await db
      .update(liveOrderEvents)
      .set({
        status,
        responseJson: JSON.stringify({
          ...(confirmedFillRecoveryPayload ?? {}),
          error: message,
          code: known ? error.code : undefined,
          positionPersistence: exchangeFillConfirmed
            ? {
                state: "PENDING_RECOVERY",
                detectedAt: new Date().toISOString(),
              }
            : undefined,
        }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(liveOrderEvents.id, event.id),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
          "EXECUTION_UNKNOWN",
        ]),
      ));
    try {
      await writeAudit(
        user,
        exchangeFillConfirmed
          ? "LIVE_FILLED_POSITION_RECOVERY_PENDING"
          : "LIVE_ORDER_FAILED",
        "live_order",
        String(event.id),
        { clientOrderId, status, error: message },
      );
    } catch {
      // Status tracking is the primary ledger; audit failure is non-fatal.
    }
    if (exchangeFillConfirmed) {
      return Response.json(
        {
          pending: true,
          orderSubmitted: true,
          executionUnknown: true,
          message:
            "Binance 成交已经确认，本地仓位正在自动恢复，请勿重复下单",
        },
        { status: 202 },
      );
    }
    return Response.json(
      {
        error:
          status === "EXECUTION_UNKNOWN"
            ? "交易所返回执行状态未知，禁止重试；请立即到 Binance 核对订单"
            : message,
        executionUnknown: status === "EXECUTION_UNKNOWN",
        maximumLeverage,
      },
      { status: known ? Math.min(Math.max(error.status, 400), 599) : 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    return await createLiveOrder(request);
  } catch (error) {
    const known = error instanceof BinanceLiveError;
    const maximumLeverage = maximumAllowedLeverageFromError(error);
    return Response.json(
      {
        error: known
          ? `${error.message}，未发送订单`
          : "人工下单预检失败，未发送订单；请刷新数据后重试",
        code: known ? error.code : "LIVE_ORDER_PREFLIGHT_FAILED",
        executionUnknown: false,
        orderSubmitted: false,
        maximumLeverage,
      },
      {
        status: known
          ? Math.min(Math.max(error.status, 400), 599)
          : 503,
      },
    );
  }
}
