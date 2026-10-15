import { and, asc, eq, lte } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  contractSymbols,
  exchangeCredentials,
  liveOrderEvents,
  strategyExecutionTraces,
} from "../../db/schema.ts";
import {
  getBinanceLiveMarkPrices,
} from "../binance-usdm-live.ts";
import { cancelLiveOrder, queryLiveOrder } from
  "./exchange-order-gateway.ts";
import { loadBoundLiquidationTrendConfig } from
  "../bound-liquidation-config.ts";
import {
  credentialContext,
  decryptCredential,
} from "../credential-vault.ts";
import {
  decidePendingEntryOrder,
  mayRearmAnalyzedLimit,
  resolvedExchangeFillTime,
} from "../liquidation-pending-entry.ts";
import {
  effectiveStrategyEntryOrderTtlMs,
  type LiquidationTrendConfig,
} from "../liquidation-trend-config.ts";
import { liveOrderStatusFromExchange } from "../live-order-status.ts";
import { nexusConfigValidationEntryBlock } from
  "../nexus-config-validation-runtime.ts";
import { advanceNexusExecutionIntentForTrace, settleNexusExecutionIntentWithLiveOrder } from
  "../nexus-execution-intent-store.ts";
import { pendingOrderLeverage } from "../live-order-reserved-margin.ts";
import { pendingOrderRestFallbackRequired } from
  "../pending-order-reconciliation.ts";
import { resolvedAutomatedEntryPrice } from "./automated-entry-order.ts";
import {
  cancelOrderWithImmediateReconciliation,
  exchangeOrderLifecycleTerminal,
} from "./cancel-order-reconciliation.ts";
import {
  buildUnfilledTerminalOrderFact,
  unfilledTerminalLiveOrderStatus,
} from "./unfilled-terminal-order.ts";
import { strategyPendingEntryRearmState } from
  "./strategy-entry-rearm-state.ts";

export const STRATEGY_PENDING_ENTRY_RECONCILIATION_VERSION =
  "strategy-pending-entry-reconciliation-v1" as const;

const PENDING_ENTRY_POLL_INTERVAL_MS = 250;
const PENDING_ENTRY_REST_FALLBACK_MS = 15_000;

type StrategyTrace = typeof strategyExecutionTraces.$inferSelect;
type Credential = typeof exchangeCredentials.$inferSelect;
type ContractSymbol = typeof contractSymbols.$inferSelect;
type LiveOrder = typeof liveOrderEvents.$inferSelect;

type StrategyEvent = {
  eventType: string;
  stage:
    | "SIGNAL"
    | "POSITION"
    | "TREND_1H"
    | "STRUCTURE_30M"
    | "LIQUIDITY_SWEEP_5M"
    | "RECLAIM_5M"
    | "ENTRY_3M"
    | "ORDER"
    | "POSITION_MANAGEMENT";
  outcome: "PASSED" | "PENDING" | "REJECTED" | "INFO" | "ERROR";
  message: string;
  detail: unknown;
  eventAt: Date;
};

type FilledEntryInput = {
  trace: StrategyTrace;
  config: LiquidationTrendConfig;
  credential: Credential;
  symbol: ContractSymbol;
  orderEvent: LiveOrder;
  evidence: Record<string, unknown>;
  positionSide: "LONG" | "SHORT";
  exchangeOrderId: string;
  executedQuantity: number;
  entryPrice: number;
  leverage: number;
  response: unknown;
  openedAt: Date;
  executionLatencyMs: number;
  fillMode:
    | "CONFIRMED_MARKET"
    | "ANALYZED_LIMIT"
    | "ANALYZED_LIMIT_PARTIAL";
  executionIntentSettlement: {
    intentKey?: string;
    traceId?: string;
    clientOrderId?: string;
    nextStatus?: "FILLED" | "CANCELED";
    liveOrderStatus?: "FILLED" | "CANCELED";
    detail?: Record<string, unknown>;
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseRecord(value: string) {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

export async function reconcileStrategyPendingEntryOrders(input: {
  finalizeFilledEntry: (input: FilledEntryInput) => Promise<unknown>;
  appendEvent: (
    traceId: string,
    strategyId: number,
    event: StrategyEvent,
  ) => Promise<unknown>;
}) {
  const db = getDb();
  const pollCutoff = new Date(Date.now() - PENDING_ENTRY_POLL_INTERVAL_MS);
  const traces = await db
    .select()
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.state, "ORDER_PENDING"),
        lte(strategyExecutionTraces.updatedAt, pollCutoff),
      ),
    )
    .orderBy(
      asc(strategyExecutionTraces.updatedAt),
      asc(strategyExecutionTraces.id),
    )
    .limit(10);
  const summary = {
    checked: traces.length,
    privateStreamSnapshots: 0,
    restFallbackQueries: 0,
    waiting: 0,
    filled: 0,
    canceled: 0,
    rearmed: 0,
    errors: 0,
  };
  for (const trace of traces) {
    try {
      const config = await loadBoundLiquidationTrendConfig(trace);
      const evidence = parseRecord(trace.entryEvidenceJson);
      const [orderEvent, credential, symbol] = await Promise.all([
        db
          .select()
          .from(liveOrderEvents)
          .where(
            and(
              eq(liveOrderEvents.ownerEmail, trace.ownerEmail),
              eq(liveOrderEvents.accountId, trace.accountId),
              eq(liveOrderEvents.exchangeOrderId, trace.exchangeOrderId ?? ""),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select()
          .from(exchangeCredentials)
          .where(
            and(
              eq(exchangeCredentials.ownerEmail, trace.ownerEmail),
              eq(exchangeCredentials.accountId, trace.accountId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select()
          .from(contractSymbols)
          .where(eq(contractSymbols.symbol, trace.symbol))
          .limit(1)
          .then((rows) => rows[0]),
      ]);
      if (!orderEvent || !credential || !symbol) {
        summary.errors += 1;
        await db
          .update(strategyExecutionTraces)
          .set({
            state: "EXECUTION_UNKNOWN",
            resultCode: "PENDING_ORDER_LOCAL_RECORD_MISSING",
            resultMessage: "待成交限价的本地订单、凭据或合约记录不完整",
            updatedAt: new Date(),
          })
          .where(eq(strategyExecutionTraces.id, trace.id));
        try {
          await advanceNexusExecutionIntentForTrace({
            traceId: trace.traceId,
            nextStatus: "EXECUTION_UNKNOWN",
            reasonCode: "LOCAL_ORDER_RECORD_MISSING",
            reasonMessage:
              "待成交限价的本地订单、凭据或合约记录不完整",
          });
        } catch {
          // Missing intent remains visible for independent reconciliation.
        }
        continue;
      }
      const keys = {
        apiKey: await decryptCredential(
          credential.apiKeyCiphertext,
          credential.apiKeyIv,
          credentialContext(trace.ownerEmail, trace.accountId, "api-key"),
        ),
        secretKey: await decryptCredential(
          credential.secretKeyCiphertext,
          credential.secretKeyIv,
          credentialContext(trace.ownerEmail, trace.accountId, "secret-key"),
        ),
      };
      const storedResponse = parseRecord(orderEvent.responseJson);
      const privateLifecycle = record(
        storedResponse.nexusPrivateOrderLifecycle,
      );
      if (Object.keys(privateLifecycle).length > 0)
        summary.privateStreamSnapshots += 1;
      let order: Record<string, unknown> = {
        ...storedResponse,
        orderId:
          storedResponse.orderId ?? orderEvent.exchangeOrderId ?? undefined,
        status:
          privateLifecycle.exchangeStatus ??
          privateLifecycle.state ??
          storedResponse.status ??
          orderEvent.status,
        executedQty:
          privateLifecycle.cumulativeQuantity ??
          storedResponse.executedQty ??
          "0",
        avgPrice:
          privateLifecycle.averagePrice ?? storedResponse.avgPrice ?? "0",
        updateTime:
          privateLifecycle.eventTime ?? storedResponse.updateTime,
      };
      let queryLatencyMs = 0;
      const localStatus = String(order.status ?? orderEvent.status).toUpperCase();
      if (
        pendingOrderRestFallbackRequired({
          status: localStatus,
          lastLocalUpdateMs: orderEvent.updatedAt.getTime(),
          nowMs: Date.now(),
          fallbackAfterMs: PENDING_ENTRY_REST_FALLBACK_MS,
        })
      ) {
        summary.restFallbackQueries += 1;
        const queried = await queryLiveOrder(
          keys,
          trace.symbol,
          orderEvent.clientOrderId,
        );
        order = queried.data as unknown as Record<string, unknown>;
        queryLatencyMs = queried.latencyMs;
        const synchronizedAt = new Date();
        await db
          .update(liveOrderEvents)
          .set({
            exchangeOrderId:
              String(order.orderId ?? "") || orderEvent.exchangeOrderId,
            status: liveOrderStatusFromExchange(
              order.status,
              order.executedQty,
            ),
            responseJson: JSON.stringify({
              ...storedResponse,
              ...order,
              lifecycleSynchronizedAt: synchronizedAt.toISOString(),
              lifecycleSynchronizationSource: "REST_FALLBACK",
            }),
            updatedAt: synchronizedAt,
          })
          .where(eq(liveOrderEvents.id, orderEvent.id));
      }
      let executedQuantity = Number(order.executedQty);
      const observedFillTime = resolvedExchangeFillTime(
        order,
        orderEvent.createdAt.getTime(),
      );
      const status = String(order.status).toUpperCase();
      if (status === "FILLED") {
        const entryPrice = resolvedAutomatedEntryPrice(
          order,
          orderEvent.referencePrice,
        );
        await input.finalizeFilledEntry({
          trace,
          config,
          credential,
          symbol,
          orderEvent,
          evidence,
          exchangeOrderId: String(order.orderId),
          executedQuantity,
          entryPrice,
          leverage: pendingOrderLeverage(
            orderEvent,
            config.execution.leverage,
          ),
          response: order,
          openedAt: observedFillTime,
          executionLatencyMs: queryLatencyMs,
          positionSide: orderEvent.positionSide,
          fillMode: "ANALYZED_LIMIT",
          executionIntentSettlement: { traceId: trace.traceId },
        });
        summary.filled += 1;
        continue;
      }

      const entryAnchorResolution = record(
        evidence.entryAnchorResolution,
      );
      const invalidBoundary = Number(
        entryAnchorResolution.invalidBoundary,
      );
      const validationBlock = await nexusConfigValidationEntryBlock({
        strategyId: trace.strategyId,
        configVersion: trace.configVersion,
      });
      const pendingDecision = validationBlock
        ? {
            action: "CANCEL_STRUCTURE_INVALIDATED" as const,
            structureInvalidated: true,
            ttlExpired: false,
            terminalWithoutFill: false,
          }
        : await getBinanceLiveMarkPrices([trace.symbol]).then(([mark]) =>
            decidePendingEntryOrder({
              exchangeStatus: status,
              executedQuantity,
              nowMs: Date.now(),
              createdAtMs: orderEvent.createdAt.getTime(),
              orderTtlSeconds: config.execution.orderTtlSeconds,
              orderTtlMs: effectiveStrategyEntryOrderTtlMs({
                config,
                exchangeOrderType:
                  orderEvent.orderType === "LIMIT" ? "LIMIT" : "MARKET",
              }),
              analysisExpiresAtMs: trace.expiresAt.getTime(),
              currentMarkPrice: Number(mark?.markPrice),
              invalidBoundary: Number.isFinite(invalidBoundary)
                ? invalidBoundary
                : null,
              positionSide: orderEvent.positionSide,
            })
          );
      const {
        structureInvalidated,
        ttlExpired,
        terminalWithoutFill,
      } = pendingDecision;
      if (pendingDecision.action === "WAIT") {
        await db
          .update(strategyExecutionTraces)
          .set({ updatedAt: new Date() })
          .where(eq(strategyExecutionTraces.id, trace.id));
        summary.waiting += 1;
        continue;
      }

      if (
        pendingDecision.action === "CANCEL_REMAINDER" ||
        pendingDecision.action === "CANCEL_EXPIRED" ||
        pendingDecision.action === "CANCEL_STRUCTURE_INVALIDATED"
      ) {
        const cancellation = await cancelOrderWithImmediateReconciliation({
          cancel: () =>
            cancelLiveOrder(
              keys,
              trace.symbol,
              orderEvent.clientOrderId,
            ),
          query: () =>
            queryLiveOrder(
              keys,
              trace.symbol,
              orderEvent.clientOrderId,
            ),
        });
        if (cancellation.state === "WAIT") {
          await db
            .update(strategyExecutionTraces)
            .set({ updatedAt: new Date() })
            .where(eq(strategyExecutionTraces.id, trace.id));
          summary.waiting += 1;
          continue;
        }
        order = cancellation.result.data as Record<string, unknown>;
        queryLatencyMs = Math.max(
          queryLatencyMs,
          Number(cancellation.result.latencyMs) || 0,
        );
        executedQuantity = Number(order.executedQty);
        if (
          cancellation.source === "QUERY_AFTER_CANCEL_RACE" &&
          !exchangeOrderLifecycleTerminal(order.status)
        ) {
          await db
            .update(strategyExecutionTraces)
            .set({ updatedAt: new Date() })
            .where(eq(strategyExecutionTraces.id, trace.id));
          summary.waiting += 1;
          continue;
        }
      }
      if (executedQuantity > 0) {
        const entryPrice = resolvedAutomatedEntryPrice(
          order,
          orderEvent.referencePrice,
        );
        await input.finalizeFilledEntry({
          trace,
          config,
          credential,
          symbol,
          orderEvent,
          evidence,
          exchangeOrderId: String(order.orderId),
          executedQuantity,
          entryPrice,
          leverage: pendingOrderLeverage(
            orderEvent,
            config.execution.leverage,
          ),
          response: order,
          openedAt: observedFillTime,
          executionLatencyMs: queryLatencyMs,
          positionSide: orderEvent.positionSide,
          fillMode: "ANALYZED_LIMIT_PARTIAL",
          executionIntentSettlement: {
            traceId: trace.traceId,
            nextStatus: "CANCELED",
            liveOrderStatus: "CANCELED",
            detail: {
              partialFillAccepted: true,
              remainderCanceled: true,
              exchangeOrderId: order.orderId,
              executedQuantity,
            },
          },
        });
        summary.filled += 1;
        continue;
      }

      const postDecisionStatus = String(order.status ?? "").toUpperCase();
      if (
        (
          pendingDecision.action === "CANCEL_REMAINDER" ||
          pendingDecision.action === "CANCEL_EXPIRED" ||
          pendingDecision.action === "CANCEL_STRUCTURE_INVALIDATED"
        ) &&
        !unfilledTerminalLiveOrderStatus(
          postDecisionStatus,
          executedQuantity,
        )
      )
        throw new Error(
          `策略限价撤单尚未获得交易所终态确认：${postDecisionStatus || "UNKNOWN"}`,
        );

      const attempt = Math.max(
        1,
        Math.min(2, Math.trunc(Number(evidence.entryOrderAttempt) || 1)),
      );
      const canRearm = validationBlock
        ? false
        : mayRearmAnalyzedLimit({
            action: pendingDecision.action,
            allowSecondOrder: config.execution.allowSecondOrder,
            attempt,
            nowMs: Date.now(),
            analysisExpiresAtMs: trace.expiresAt.getTime(),
          });
      const canceledEntryOrder = {
        clientOrderId: orderEvent.clientOrderId,
        limitPrice: orderEvent.referencePrice,
        submittedAt: orderEvent.createdAt.toISOString(),
        canceledAt: new Date().toISOString(),
        reason: validationBlock
          ? "CONFIG_VALIDATION_ROLLBACK"
          : structureInvalidated
          ? "STRUCTURE_INVALIDATED"
          : ttlExpired
            ? "ORDER_TTL_EXPIRED"
            : status,
        entryOrderAttempt: attempt,
        entryAnalysis: evidence.analyzedEntryOrder ?? null,
        automaticMarketFallback: false,
      };
      const priorCanceledEntryOrders = Array.isArray(
          evidence.canceledEntryOrders,
        )
        ? evidence.canceledEntryOrders.slice(-1)
        : [];
      const firstCanceledEntryOrder = record(
        priorCanceledEntryOrders[0] ?? canceledEntryOrder,
      );
      const firstCanceledAnalysis = record(
        firstCanceledEntryOrder.entryAnalysis,
      );
      const firstDecisionAtMs = new Date(
        String(firstCanceledEntryOrder.submittedAt ?? ""),
      ).getTime();
      const firstDecisionMarkPrice = Number(
        firstCanceledAnalysis.currentMarkPrice,
      );
      const nextEvidence = {
        ...evidence,
        activePendingOrder: null,
        entryOrderAttempt: canRearm ? attempt + 1 : attempt,
        lastCanceledEntryOrder: canceledEntryOrder,
        canceledEntryOrders: [
          ...priorCanceledEntryOrders,
          canceledEntryOrder,
        ],
        unfilledLimitCounterfactual: {
          decisionAtMs: Number.isFinite(firstDecisionAtMs)
            ? firstDecisionAtMs
            : orderEvent.createdAt.getTime(),
          decisionMarkPrice:
            Number.isFinite(firstDecisionMarkPrice) &&
              firstDecisionMarkPrice > 0
              ? firstDecisionMarkPrice
              : orderEvent.referencePrice,
          firstLimitPrice: Number(firstCanceledEntryOrder.limitPrice),
          attempts: canRearm ? attempt : Math.max(1, attempt),
          configuredOrderMode:
            firstCanceledAnalysis.requestedMode ?? null,
          finalReason: canceledEntryOrder.reason,
        },
      };
      const terminalFact = buildUnfilledTerminalOrderFact({
        exchangeStatus: postDecisionStatus,
        executedQuantity,
        reasonCode: validationBlock
          ? "CONFIG_VALIDATION_ROLLBACK"
          : structureInvalidated
          ? "STRUCTURE_INVALIDATED"
          : ttlExpired
            ? "ORDER_TTL_EXPIRED"
            : status,
        source: "SYSTEM",
        terminalAt: new Date(),
        exchangeResponse: order,
        detail: {
          locallyCanceled: !terminalWithoutFill,
          structureInvalidated,
          ttlExpired,
        },
      });
      const rearmState = strategyPendingEntryRearmState({
        canRearm,
        evidence: nextEvidence,
      });
      const preservesFrozenDecision = rearmState === "ORDER_READY" &&
        record(nextEvidence.frozenExecutionDecision).approved === true;
      const traceResultCode = canRearm
        ? "ANALYZED_LIMIT_RECALCULATE"
        : validationBlock
          ? "NEXUS_CONFIG_VALIDATION_ROLLBACK"
        : structureInvalidated
          ? "ANALYZED_LIMIT_STRUCTURE_INVALIDATED"
          : "ANALYZED_LIMIT_NOT_FILLED";
      const traceResultMessage = canRearm
        ? preservesFrozenDecision
          ? "首笔委托到期未成交；保留已批准方向，仅重新读取新鲜盘口、价格与结构失效事实后选择第二次委托方式"
          : "首笔委托到期未成交，将重新读取行情并按当前策略重新选择委托方式"
        : validationBlock
          ? "候选参数已触发恶化回退，待成交限价已撤销且禁止重挂"
        : structureInvalidated
          ? "价格继续跌破结构失效位，分析限价已撤销"
          : "分析限价在有效期内未成交，本次验证结束";
      await settleNexusExecutionIntentWithLiveOrder({
        traceId: trace.traceId,
        liveOrderEventId: orderEvent.id,
        nextStatus: terminalFact.intentStatus,
        liveOrderStatus: terminalFact.liveOrderStatus,
        exchangeOrderId:
          order.orderId === undefined || order.orderId === null
            ? orderEvent.exchangeOrderId
            : String(order.orderId),
        responseJson: JSON.stringify(terminalFact.response),
        detail: {
          clientOrderId: orderEvent.clientOrderId,
          exchangeOrderId: order.orderId,
          executedQuantity: 0,
          rearmAllowed: canRearm,
        },
        reasonCode: canRearm
          ? "LIMIT_REARM_REQUIRED"
          : validationBlock
            ? "CONFIG_VALIDATION_ROLLBACK"
          : structureInvalidated
            ? "ENTRY_STRUCTURE_INVALIDATED"
            : "LIMIT_NOT_FILLED",
        reasonMessage: canRearm
          ? preservesFrozenDecision
            ? "首笔限价已撤销；保留冻结批准，第二次委托必须使用新的独立执行意图并重新复核实时交易安全条件"
            : "首笔限价已撤销；重新分析必须创建新的独立执行意图"
          : validationBlock
            ? "候选参数恶化，限价撤销并释放资金，旧版本禁止再次开仓"
          : structureInvalidated
            ? "入场结构失效，限价撤销并释放资金"
            : "限价未成交，订单结束并释放资金",
        traceSettlement: {
          databaseId: trace.id,
          expectedStates: ["ORDER_PENDING"],
          state: rearmState,
          resultCode: traceResultCode,
          resultMessage: traceResultMessage,
          entryEvidenceJson: JSON.stringify(nextEvidence),
          exchangeOrderId: null,
          positionId: null,
          completedAt: canRearm ? null : new Date(),
        },
      });
      await input.appendEvent(trace.traceId, trace.strategyId, {
        eventType: canRearm
          ? `ANALYZED_LIMIT_RECALCULATE:${attempt}`
          : `ANALYZED_LIMIT_CANCELED:${attempt}`,
        stage: "ORDER",
        outcome: canRearm ? "PENDING" : "REJECTED",
        message: canRearm
          ? preservesFrozenDecision
            ? "原委托已确认零成交；不重新判断方向，仅复核最新盘口、价格、结构失效与资金后最多再执行一次"
            : "原委托已确认零成交；重新分析趋势、价格与委托方式后最多再执行一次"
          : validationBlock
            ? "候选参数已恶化回退，旧版本待成交限价已撤销"
          : structureInvalidated
            ? "原入场逻辑已经失效，限价撤销且禁止追单"
            : "限价有效期结束，本次没有用成交去强行证明判断",
        detail: nextEvidence.lastCanceledEntryOrder,
        eventAt: new Date(),
      });
      if (canRearm) summary.rearmed += 1;
      else summary.canceled += 1;
    } catch (error) {
      summary.errors += 1;
      await db
        .update(strategyExecutionTraces)
        .set({ updatedAt: new Date() })
        .where(eq(strategyExecutionTraces.id, trace.id));
      await input.appendEvent(trace.traceId, trace.strategyId, {
        eventType: "ANALYZED_LIMIT_RECONCILE_ERROR",
        stage: "ORDER",
        outcome: "ERROR",
        message: error instanceof Error ? error.message : "分析限价核对失败",
        detail: {
          executionStateChanged: false,
          retryNextMonitorCycle: true,
        },
        eventAt: new Date(),
      });
    }
  }
  return summary;
}
