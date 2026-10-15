import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import {
  exchangeCredentials,
  liveOrderEvents,
  livePositionAdditions,
  livePositionReductions,
  livePositions,
} from "../../db/schema.ts";
import { getBinanceLiveOrderTrades } from "../binance-usdm-live.ts";
import { resolveFinalPositionFundingContext } from
  "../live-position-funding.ts";
import {
  attachReductionSettlement,
  resolveReductionSettlement,
} from "../live-reduction-settlement.ts";
import { recordLivePositionReduction } from
  "./position-reduction-ledger.ts";

export const POSITION_RECONCILIATION_RUNTIME_VERSION =
  "position-reconciliation-runtime-v1" as const;

type AuditWriter = (
  user: { email: string; accountId: string },
  action: string,
  resourceType: string,
  resourceId: string,
  detail: unknown,
) => Promise<unknown>;

export async function additionalEntryOrdersForPosition(positionId: number) {
  const rows = await getDb()
    .select({
      orderId: livePositionAdditions.exchangeOrderId,
      quantity: livePositionAdditions.quantity,
    })
    .from(livePositionAdditions)
    .where(and(
      eq(livePositionAdditions.positionId, positionId),
      inArray(livePositionAdditions.status, [
        "SUBMITTED",
        "EXECUTION_UNKNOWN",
      ]),
      isNotNull(livePositionAdditions.exchangeOrderId),
    ));
  return rows
    .filter(
      (row): row is { orderId: string; quantity: number } =>
        Boolean(row.orderId) &&
        Number.isFinite(row.quantity) &&
        row.quantity > 0,
    )
    .map((row) => ({ orderId: row.orderId, quantity: row.quantity }));
}

export async function reconcileMissingLocalPosition(
  position: typeof livePositions.$inferSelect,
  credential: typeof exchangeCredentials.$inferSelect,
  keys: { apiKey: string; secretKey: string },
  writeAudit: AuditWriter,
) {
  const db = getDb();
  const [sourceOrder] = await db
    .select()
    .from(liveOrderEvents)
    .where(and(
      eq(liveOrderEvents.id, position.sourceEventId),
      eq(liveOrderEvents.ownerEmail, position.ownerEmail),
    ))
    .limit(1);
  let linkedPositionId: number | null = null;
  let linkedNetPnl: number | null = null;
  if (sourceOrder?.exchangeOrderId) {
    const oppositeSide = position.positionSide === "LONG" ? "SHORT" : "LONG";
    const [opposite] = await db
      .select()
      .from(livePositions)
      .where(and(
        eq(livePositions.ownerEmail, position.ownerEmail),
        eq(livePositions.accountId, position.accountId),
        eq(livePositions.symbol, position.symbol),
        eq(livePositions.positionSide, oppositeSide),
        eq(livePositions.status, "CLOSED"),
        eq(livePositions.exitReason, "EXTERNAL"),
        lte(livePositions.openedAt, position.openedAt),
      ))
      .orderBy(desc(livePositions.openedAt))
      .limit(1);
    const trades = await getBinanceLiveOrderTrades(
      keys,
      position.symbol,
      sourceOrder.exchangeOrderId,
    );
    // The requested side is absent after this one-way order, while the prior
    // opposite local position is already externally closed. Therefore every
    // fill in this order offset the opposite position, including break-even
    // fills whose Binance realizedPnl is exactly zero.
    const closingTrades = opposite ? trades : [];
    const closedQuantity = closingTrades.reduce((sum, trade) => sum + trade.quantity, 0);
    const grossRealizedPnl = closingTrades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    const exitQuote = closingTrades.reduce((sum, trade) => sum + trade.quoteQuantity, 0);
    if (closedQuantity > 0 && Number.isFinite(grossRealizedPnl)) {
      const clientOrderId = `nqx_${sourceOrder.id}_${opposite?.id ?? 0}`.slice(0, 36);
      const [existingReduction] = opposite
        ? await db.select({ id: livePositionReductions.id })
            .from(livePositionReductions)
            .where(and(
              eq(livePositionReductions.positionId, opposite.id),
              eq(livePositionReductions.clientOrderId, clientOrderId),
            ))
            .limit(1)
        : [];
      if (opposite && !existingReduction) {
        const [entryOrder] = await db
          .select({
            exchangeOrderId: liveOrderEvents.exchangeOrderId,
            quantity: liveOrderEvents.quantity,
          })
          .from(liveOrderEvents)
          .where(eq(liveOrderEvents.id, opposite.sourceEventId))
          .limit(1);
        const exitPrice = exitQuote > 0 ? exitQuote / closedQuantity : closingTrades[0]!.price;
        const closedAt = new Date(
          Math.max(...closingTrades.map((trade) => trade.time)),
        );
        const settlement = await resolveReductionSettlement({
          credentials: keys,
          symbol: position.symbol,
          exitOrderId: sourceOrder.exchangeOrderId,
          entryOrderId: entryOrder?.exchangeOrderId ?? null,
          additionalEntryOrders: await additionalEntryOrdersForPosition(
            opposite.id,
          ),
          localGrossRealizedPnl: grossRealizedPnl,
          executedQuantity: closedQuantity,
          entryOrderQuantity: entryOrder?.quantity ?? null,
          finalPositionFunding: await resolveFinalPositionFundingContext({
            position: opposite,
            isFinalReduction: true,
            closedAt,
          }),
        });
        await recordLivePositionReduction({
          positionId: opposite.id,
          lifecycleId: opposite.lifecycleId,
          ownerEmail: opposite.ownerEmail,
          accountId: opposite.accountId,
          clientOrderId,
          exchangeOrderId: sourceOrder.exchangeOrderId,
          symbol: opposite.symbol,
          positionSide: opposite.positionSide,
          quantity: closedQuantity,
          exitPrice,
          realizedPnl: settlement.grossRealizedPnl,
          reason: "EXTERNAL",
          responseJson: JSON.stringify(attachReductionSettlement({
            reconciliation: "ONE_WAY_OPPOSITE_ORDER_OFFSET",
            sourceOrderId: sourceOrder.id,
            exchangeOrderId: sourceOrder.exchangeOrderId,
          }, settlement)),
          createdAt: closedAt,
        }, { idempotent: true });
        await db.update(livePositions).set({
          markPrice: exitPrice,
          realizedPnl: opposite.realizedPnl + settlement.grossRealizedPnl,
          lastError: null,
          updatedAt: new Date(),
        }).where(eq(livePositions.id, opposite.id));
        linkedPositionId = opposite.id;
        linkedNetPnl = settlement.netRealizedPnl;
      }
    }
  }
  await db.update(livePositions).set({
    status: "CLOSED",
    exitReason: "EXTERNAL",
    closedAt: new Date(),
    riskLeaseUntil: null,
    pendingCloseClientOrderId: null,
    pendingCloseReason: null,
    pendingCloseQuantity: null,
    pendingClosePlanJson: null,
    lastError: "Binance 当前方向仓位为 0，已同步真实成交与本地仓位",
    updatedAt: new Date(),
  }).where(eq(livePositions.id, position.id));
  await writeAudit(
    { email: position.ownerEmail, accountId: position.accountId },
    "RECONCILE_MISSING_LIVE_POSITION",
    "live_position",
    String(position.id),
    {
      symbol: position.symbol,
      positionSide: position.positionSide,
      linkedPositionId,
      linkedNetPnl,
      credentialId: credential.id,
    },
  );
  return { linkedPositionId, linkedNetPnl };
}
