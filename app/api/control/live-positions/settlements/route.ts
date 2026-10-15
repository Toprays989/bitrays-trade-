import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  exchangeCredentials,
  liveOrderEvents,
  livePositionAdditions,
  livePositionReductions,
  livePositions,
} from "../../../../../db/schema";
import {
  getBinanceLiveSystemMetrics,
} from "../../../../../lib/binance-usdm-live";
import { queryLiveOrder } from
  "../../../../../lib/execution/exchange-order-gateway";
import {
  credentialContext,
  decryptCredential,
  isSecureCredentialRequest,
} from "../../../../../lib/credential-vault";
import {
  attachReductionSettlement,
  reductionAccountingPnl,
  resolveReductionSettlement,
} from "../../../../../lib/live-reduction-settlement";
import { resolveFinalPositionFundingContext } from "../../../../../lib/live-position-funding";
import {
  isResponse,
  requirePermission,
  writeAudit,
} from "../../shared";

export const dynamic = "force-dynamic";

function parseResponse(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function additionalEntryOrders(positionId: number) {
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

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  if (!isSecureCredentialRequest(request))
    return Response.json(
      { error: "成交明细核对只能通过可信连接提交" },
      { status: 426 },
    );

  const metrics = await getBinanceLiveSystemMetrics().catch(() => null);
  const remainingWeight = Number(metrics?.rest?.remainingWeight);
  if (!Number.isFinite(remainingWeight) || remainingWeight < 200)
    return Response.json(
      { error: "当前优先保留交易接口额度，成交明细将在额度恢复后自动核对" },
      { status: 429 },
    );

  const db = getDb();
  const recent = await db
    .select()
    .from(livePositionReductions)
    .where(eq(livePositionReductions.ownerEmail, user.email))
    .orderBy(desc(livePositionReductions.id))
    .limit(200);
  const candidates = recent
    .filter(
      (reduction) =>
        Boolean(reduction.exchangeOrderId) &&
        reductionAccountingPnl(reduction).settlementStatus ===
          "TRADE_DETAILS_PENDING",
    )
    .slice(0, 3);

  let updated = 0;
  let exact = 0;
  let pending = 0;
  let errors = 0;
  for (const reduction of candidates) {
    try {
      const [[position], [entryOrder]] = await Promise.all([
        db
          .select()
          .from(livePositions)
          .where(and(
            eq(livePositions.id, reduction.positionId),
            eq(livePositions.ownerEmail, user.email),
          ))
          .limit(1),
        db
          .select({
            exchangeOrderId: liveOrderEvents.exchangeOrderId,
            quantity: liveOrderEvents.quantity,
          })
          .from(liveOrderEvents)
          .innerJoin(
            livePositions,
            eq(livePositions.sourceEventId, liveOrderEvents.id),
          )
          .where(and(
            eq(livePositions.id, reduction.positionId),
            eq(liveOrderEvents.ownerEmail, user.email),
          ))
          .limit(1),
      ]);
      if (!position || !entryOrder?.exchangeOrderId) {
        pending += 1;
        continue;
      }
      const [credential] = await db
        .select()
        .from(exchangeCredentials)
        .where(and(
          eq(exchangeCredentials.id, position.credentialId),
          eq(exchangeCredentials.ownerEmail, user.email),
        ))
        .limit(1);
      if (!credential) {
        pending += 1;
        continue;
      }
      const keys = {
        apiKey: await decryptCredential(
          credential.apiKeyCiphertext,
          credential.apiKeyIv,
          credentialContext(user.email, position.accountId, "api-key"),
        ),
        secretKey: await decryptCredential(
          credential.secretKeyCiphertext,
          credential.secretKeyIv,
          credentialContext(user.email, position.accountId, "secret-key"),
        ),
      };
      const storedResponse = parseResponse(reduction.responseJson);
      const reconciliation = storedResponse.nexusReconciliation;
      const positionZeroReconciliation =
        reconciliation !== null &&
        typeof reconciliation === "object" &&
        !Array.isArray(reconciliation) &&
        (reconciliation as Record<string, unknown>).basis ===
          "BINANCE_POSITION_ZERO";
      let exitOrderId = reduction.exchangeOrderId!;
      if (positionZeroReconciliation) {
        // Position convergence deliberately does not wait for Binance trade
        // details. Recover the numeric exchange order id from the client id
        // before the asynchronous accounting pass reads user trades.
        const queried = await queryLiveOrder(
          keys,
          reduction.symbol,
          reduction.clientOrderId,
        );
        const recoveredOrderId = String(queried.data.orderId ?? "").trim();
        if (!recoveredOrderId) {
          pending += 1;
          continue;
        }
        exitOrderId = recoveredOrderId;
      }
      const closedAt = position.closedAt ?? reduction.createdAt;
      const settlement = await resolveReductionSettlement({
        credentials: keys,
        symbol: reduction.symbol,
        exitOrderId,
        entryOrderId: entryOrder.exchangeOrderId,
        additionalEntryOrders: await additionalEntryOrders(position.id),
        localGrossRealizedPnl: reduction.realizedPnl,
        executedQuantity: reduction.quantity,
        entryOrderQuantity: entryOrder.quantity,
        finalPositionFunding: await resolveFinalPositionFundingContext({
          position,
          isFinalReduction: position.status === "CLOSED",
          closedAt,
        }),
      });
      await db
        .update(livePositionReductions)
        .set({
          exchangeOrderId: exitOrderId,
          responseJson: JSON.stringify(
            attachReductionSettlement(
              storedResponse,
              settlement,
            ),
          ),
        })
        .where(and(
          eq(livePositionReductions.id, reduction.id),
          eq(livePositionReductions.ownerEmail, user.email),
        ));
      updated += 1;
      if (settlement.exactNetAvailable) exact += 1;
      else pending += 1;
      await writeAudit(
        { email: user.email, accountId: position.accountId },
        "LIVE_REDUCTION_SETTLEMENT_SYNCED",
        "live_position_reduction",
        String(reduction.id),
        {
          positionId: position.id,
          exactNetAvailable: settlement.exactNetAvailable,
          source: settlement.source,
        },
      );
    } catch {
      errors += 1;
    }
  }
  return Response.json({
    scanned: candidates.length,
    updated,
    exact,
    pending,
    errors,
    remainingPending: Math.max(0, candidates.length - exact),
  });
}
