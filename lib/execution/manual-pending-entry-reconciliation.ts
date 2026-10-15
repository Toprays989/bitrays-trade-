import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  contractSymbols,
  exchangeCredentials,
  liveOrderEvents,
} from "../../db/schema.ts";
import { cancelLiveOrder, queryLiveOrder } from
  "./exchange-order-gateway.ts";
import {
  credentialContext,
  decryptCredential,
} from "../credential-vault.ts";
import { rebalanceRiskPlan } from "../risk-plan-rebalance.ts";
import { resolvedExchangeFillTime } from "../liquidation-pending-entry.ts";
import { resolvedAutomatedEntryPrice } from "./automated-entry-order.ts";
import {
  cancelOrderWithImmediateReconciliation,
  exchangeOrderLifecycleTerminal,
} from "./cancel-order-reconciliation.ts";
import { buildFilledPositionProtection } from
  "./filled-position-protection.ts";
import {
  buildFilledPositionInsertValues,
  buildFilledPositionRecoveryValues,
} from "./filled-position-persistence.ts";
import { settleFilledManualPosition } from
  "./manual-filled-position-settlement.ts";
import {
  buildUnfilledTerminalOrderFact,
  unfilledTerminalLiveOrderStatus,
} from "./unfilled-terminal-order.ts";

export const MANUAL_PENDING_ENTRY_RECONCILIATION_VERSION =
  "manual-pending-entry-reconciliation-v1" as const;

type AuditWriter = (
  user: { email: string; accountId: string },
  action: string,
  resourceType: string,
  resourceId: string,
  detail: unknown,
) => Promise<unknown>;

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

export async function reconcileManualPendingEntryOrders(input: {
  writeAudit: AuditWriter;
}) {
  const db = getDb();
  const rows = await db
    .select()
    .from(liveOrderEvents)
    .where(
      and(
        eq(liveOrderEvents.orderType, "LIMIT"),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
        ]),
        eq(liveOrderEvents.testOnly, false),
      ),
    )
    .orderBy(liveOrderEvents.id)
    .limit(20);
  const summary = {
    checked: 0,
    waiting: 0,
    filled: 0,
    canceled: 0,
    errors: 0,
  };
  for (const orderEvent of rows) {
    const stored = parseRecord(orderEvent.responseJson);
    const pending = record(stored.manualPendingEntry);
    if (Number(pending.version) !== 1) continue;
    summary.checked += 1;
    try {
      const [credential, symbol] = await Promise.all([
        db
          .select()
          .from(exchangeCredentials)
          .where(
            and(
              eq(exchangeCredentials.id, orderEvent.credentialId),
              eq(exchangeCredentials.ownerEmail, orderEvent.ownerEmail),
            ),
          )
          .limit(1)
          .then((items) => items[0]),
        db
          .select()
          .from(contractSymbols)
          .where(eq(contractSymbols.symbol, orderEvent.symbol))
          .limit(1)
          .then((items) => items[0]),
      ]);
      if (!credential || !symbol)
        throw new Error("人工限价挂单缺少账户或合约元数据");
      const keys = {
        apiKey: await decryptCredential(
          credential.apiKeyCiphertext,
          credential.apiKeyIv,
          credentialContext(
            orderEvent.ownerEmail,
            orderEvent.accountId,
            "api-key",
          ),
        ),
        secretKey: await decryptCredential(
          credential.secretKeyCiphertext,
          credential.secretKeyIv,
          credentialContext(
            orderEvent.ownerEmail,
            orderEvent.accountId,
            "secret-key",
          ),
        ),
      };
      const queried = await queryLiveOrder(
        keys,
        orderEvent.symbol,
        orderEvent.clientOrderId,
      );
      let exchangeOrder = queried.data;
      let exchangeStatus = String(exchangeOrder.status ?? "").toUpperCase();
      let executedQuantity = Number(exchangeOrder.executedQty) || 0;
      const expiresAtMs = new Date(String(pending.expiresAt ?? "")).getTime();
      const expired =
        !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs;
      if (
        (executedQuantity > 0 && exchangeStatus !== "FILLED") ||
        (expired &&
          exchangeStatus !== "FILLED" &&
          !unfilledTerminalLiveOrderStatus(
            exchangeStatus,
            executedQuantity,
          ))
      ) {
        const cancellation = await cancelOrderWithImmediateReconciliation({
          cancel: () =>
            cancelLiveOrder(
              keys,
              orderEvent.symbol,
              orderEvent.clientOrderId,
            ),
          query: () =>
            queryLiveOrder(
              keys,
              orderEvent.symbol,
              orderEvent.clientOrderId,
            ),
        });
        if (cancellation.state === "WAIT") {
          summary.waiting += 1;
          continue;
        }
        exchangeOrder = cancellation.result.data;
        exchangeStatus = String(exchangeOrder.status ?? "").toUpperCase();
        executedQuantity = Number(exchangeOrder.executedQty) || 0;
        if (
          cancellation.source === "QUERY_AFTER_CANCEL_RACE" &&
          !exchangeOrderLifecycleTerminal(exchangeStatus)
        ) {
          summary.waiting += 1;
          continue;
        }
        if (
          executedQuantity <= 0 &&
          !unfilledTerminalLiveOrderStatus(
            exchangeStatus,
            executedQuantity,
          )
        )
          throw new Error(
            `人工限价撤单尚未获得交易所终态确认：${exchangeStatus || "UNKNOWN"}`,
          );
      }
      if (executedQuantity <= 0) {
        const terminalStatus = unfilledTerminalLiveOrderStatus(
          exchangeStatus,
          executedQuantity,
        );
        if (terminalStatus) {
          const terminalFact = buildUnfilledTerminalOrderFact({
            exchangeStatus,
            executedQuantity,
            reasonCode: expired ? "ORDER_TTL_EXPIRED" : terminalStatus,
            source: "SYSTEM",
            terminalAt: new Date(),
            storedResponse: stored,
            exchangeResponse: exchangeOrder,
          });
          await db
            .update(liveOrderEvents)
            .set({
              status: terminalFact.liveOrderStatus,
              responseJson: JSON.stringify(terminalFact.response),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(liveOrderEvents.id, orderEvent.id),
                inArray(liveOrderEvents.status, [
                  "PENDING",
                  "NEW",
                  "PARTIALLY_FILLED",
                ]),
              ),
            );
          summary.canceled += 1;
        } else {
          summary.waiting += 1;
        }
        continue;
      }

      const entryPrice = resolvedAutomatedEntryPrice(
        exchangeOrder,
        orderEvent.referencePrice,
      );
      const dynamicProfitProtectionEnabled =
        pending.dynamicProfitProtectionEnabled !== false &&
        Number(pending.trailingStopPercent) > 0;
      const rawPlan = {
        calculationMode: "ROE",
        dynamicProfitProtectionEnabled,
        takeProfits: Array.isArray(pending.takeProfits)
          ? pending.takeProfits
          : [],
        stopLosses: !dynamicProfitProtectionEnabled &&
            Array.isArray(pending.stopLosses)
          ? pending.stopLosses
          : [],
        orderOrigin:
          pending.orderOrigin === "SEMI_AUTO" ? "SEMI_AUTO" : "MANUAL",
        opportunityContext:
          pending.opportunityContext &&
            typeof pending.opportunityContext === "object" &&
            !Array.isArray(pending.opportunityContext)
            ? pending.opportunityContext
            : null,
        entryStructureBaseline:
          pending.entryStructureBaseline &&
            typeof pending.entryStructureBaseline === "object" &&
            !Array.isArray(pending.entryStructureBaseline)
            ? pending.entryStructureBaseline
            : null,
      };
      const rebalanced = rebalanceRiskPlan(
        rawPlan,
        executedQuantity,
        symbol.minOrderQty,
        symbol.quantityStep,
      );
      const openedAt = resolvedExchangeFillTime(
        exchangeOrder,
        orderEvent.createdAt.getTime(),
      );
      const positionProtection = buildFilledPositionProtection({
        plan: rebalanced.plan,
        activatedAt: openedAt,
        trailingActivationPercent: Math.max(
          0,
          Number(pending.trailingActivationPercent) || 0,
        ),
        trailingStopPercent: Math.max(
          0,
          Number(pending.trailingStopPercent) || 0,
        ),
      });
      const settledAt = new Date();
      const leverage = Math.max(
        1,
        Math.trunc(Number(pending.leverage) || 1),
      );
      const positionValues = buildFilledPositionInsertValues({
        ownerEmail: orderEvent.ownerEmail,
        accountId: orderEvent.accountId,
        credentialId: orderEvent.credentialId,
        sourceEventId: orderEvent.id,
        handoffOrigin: "MANUAL",
        lifecycleId: orderEvent.lifecycleId,
        entryDecisionHandoffJson: orderEvent.entryDecisionHandoffJson,
        symbol: orderEvent.symbol,
        instrumentId: symbol.instrumentId,
        instrumentRuleVersion: symbol.ruleVersion,
        positionSide: orderEvent.positionSide,
        quantity: executedQuantity,
        entryPrice,
        leverage,
        protection: positionProtection,
        openedAt,
        updatedAt: settledAt,
      });
      const settlement = await settleFilledManualPosition({
        db,
        orderEventId: orderEvent.id,
        exchangeOrderId: String(exchangeOrder.orderId || "") || null,
        orderResponseJson: JSON.stringify({
          ...stored,
          ...exchangeOrder,
          pendingEntryCompleted: true,
          partialRemainderCanceled: exchangeStatus !== "FILLED",
          riskPlanRebalanced: true,
          takeProfitGrids: rebalanced.takeProfitGrids,
          stopLossGrids: rebalanced.stopLossGrids,
        }),
        positionValues,
        positionRecoveryValues: buildFilledPositionRecoveryValues({
          lifecycleId: orderEvent.lifecycleId,
          entryDecisionHandoffJson: orderEvent.entryDecisionHandoffJson,
          positionHandoffKey: positionValues.positionHandoffKey,
          positionHandoffVersion: positionValues.positionHandoffVersion,
          positionHandoffJson: positionValues.positionHandoffJson,
          leverage,
          protection: positionProtection,
          updatedAt: settledAt,
        }),
        settledAt,
      });
      if (!settlement.alreadySettled)
        await input.writeAudit(
          {
            email: orderEvent.ownerEmail,
            accountId: orderEvent.accountId,
          },
          "MANUAL_LIMIT_ENTRY_FILLED",
          "live_order",
          String(orderEvent.id),
          {
            symbol: orderEvent.symbol,
            positionSide: orderEvent.positionSide,
            requestedQuantity: orderEvent.quantity,
            executedQuantity,
            entryPrice,
            partialRemainderCanceled: exchangeStatus !== "FILLED",
          },
        );
      summary.filled += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
}
