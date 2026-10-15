import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { exchangeCredentials, simpleReboundSlots, strategies, tradingAccounts } from "../../../../../db/schema";
import { getBinanceLiveContractRule } from "../../../../../lib/binance-usdm-live";
import { credentialContext, decryptCredential, isSecureCredentialRequest, liveTradingAllowedByServer } from "../../../../../lib/credential-vault";
import { getTradeReadiness } from "../../../../../lib/trade-readiness";
import { submitSimpleReboundLiveExit } from "../../../../../lib/simple-rebound-live-execution";
import { assertSimpleReboundLiveConfirmation } from "../../../../../lib/simple-rebound-live-gate";
import { isResponse, requirePermission } from "../../shared";
import { appendSimpleReboundEvents } from "../../../../../lib/simple-rebound-event-store";
import { releasePersistedSimpleReboundSlot } from "../../../../../lib/simple-rebound-slot-store";
import { SIMPLE_REBOUND_EVENT_TYPES } from "../../../../../lib/simple-rebound-events";

export const dynamic = "force-dynamic";
const EXIT_REASONS = new Set(["EXIT_PROFIT", "EXIT_TIME", "EXIT_ADVERSE"]);

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:live_order:create");
  if (isResponse(user)) return user;
  if (!isSecureCredentialRequest(request)) return Response.json({ error: "真实执行只允许通过可信 HTTPS 连接" }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  try { assertSimpleReboundLiveConfirmation(body.confirmation); } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "SIMPLE_REBOUND 实盘确认失败" }, { status: 400 });
  }
  const strategyId = body.strategyId;
  const slotId = body.slotId;
  const reason = body.reason;
  const quantity = body.quantity;
  if (typeof strategyId !== "number" || !Number.isInteger(strategyId) || typeof slotId !== "number" || !Number.isInteger(slotId) || slotId < 1 || slotId > 5 || typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0 || typeof reason !== "string" || !EXIT_REASONS.has(reason))
    return Response.json({ error: "缺少有效的 strategyId、slotId、quantity 或退出原因" }, { status: 400 });

  const db = getDb();
  const [strategy] = await db.select().from(strategies).where(and(eq(strategies.id, strategyId), eq(strategies.ownerEmail, user.email))).limit(1);
  if (!strategy || strategy.strategyType !== "SIMPLE_REBOUND") return Response.json({ error: "策略不存在或不是 SIMPLE_REBOUND" }, { status: 404 });
  const [slot] = await db.select().from(simpleReboundSlots).where(and(eq(simpleReboundSlots.strategyId, strategyId), eq(simpleReboundSlots.slotId, slotId), eq(simpleReboundSlots.ownerEmail, user.email))).limit(1);
  if (!slot) return Response.json({ error: "SIMPLE_REBOUND 席位不存在或已释放" }, { status: 409 });
  const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, strategy.accountId))).limit(1);
  const [credential] = account ? await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.accountId, account.accountId))).limit(1) : [];
  if (!account || !credential) return Response.json({ error: "SIMPLE_REBOUND 交易账户或凭据不存在" }, { status: 409 });
  const readiness = getTradeReadiness(account, credential, await liveTradingAllowedByServer());
  if (!readiness.liveReady || credential.positionMode !== "HEDGE")
    return Response.json({ error: "SIMPLE_REBOUND 退出前置条件未满足", blockers: [...readiness.blockers, ...(credential.positionMode === "HEDGE" ? [] : ["账户必须是 HEDGE 双向持仓模式"])], readiness }, { status: 409 });

  try {
    const { contract } = await getBinanceLiveContractRule(slot.symbol);
    if (quantity < contract.minOrderQty || quantity * slot.entryPrice < contract.minNotionalUsdt)
      return Response.json({ error: "退出数量低于 Binance 合约规则要求" }, { status: 422 });
    const [apiKey, secretKey] = await Promise.all([
      decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(user.email, account.accountId, "api-key")),
      decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(user.email, account.accountId, "secret-key")),
    ]);
    const result = await submitSimpleReboundLiveExit({ confirmation: body.confirmation, credentials: { apiKey, secretKey }, slot: { slotId: slot.slotId, symbol: slot.symbol, entryPrice: slot.entryPrice, openedAtMs: slot.openedAt.getTime() }, reason: reason as "EXIT_PROFIT" | "EXIT_TIME" | "EXIT_ADVERSE", quantity, quantityStep: contract.quantityStep });
    const exchangeStatus = String(result.result.data.status ?? "").toUpperCase();
    const filled = exchangeStatus === "FILLED" || Number(result.result.data.executedQty ?? 0) > 0;
    if (filled) await releasePersistedSimpleReboundSlot(strategy.id, slot.slotId);
    await appendSimpleReboundEvents({ strategyId: strategy.id, traceId: `srb_exit_${strategy.id}_${slot.slotId}_${Date.now()}`, events: [{ eventType: SIMPLE_REBOUND_EVENT_TYPES.EXIT, stage: "POSITION_MANAGEMENT", outcome: filled ? "PASSED" : "PENDING", symbol: slot.symbol, eventAt: Date.now(), message: filled ? "SIMPLE_REBOUND 退出成交，席位已释放" : `SIMPLE_REBOUND 退出已提交，交易所状态 ${exchangeStatus || "UNKNOWN"}`, detail: { slotId: slot.slotId, reason, exchangeStatus, exchangeOrderId: result.result.data.orderId ?? null } }] });
    return Response.json({ source: "SIMPLE_REBOUND", strategyId, slotId, result }, { status: 202 });
  } catch (error) {
    await appendSimpleReboundEvents({ strategyId: strategy.id, traceId: `srb_exit_error_${strategy.id}_${slot.slotId}_${Date.now()}`, events: [{ eventType: SIMPLE_REBOUND_EVENT_TYPES.EXIT, stage: "POSITION_MANAGEMENT", outcome: "ERROR", symbol: slot.symbol, eventAt: Date.now(), message: "SIMPLE_REBOUND 退出执行失败，保持席位等待对账", detail: { slotId: slot.slotId, reason, error: error instanceof Error ? error.message : "unknown" } }] }).catch(() => undefined);
    return Response.json({ error: error instanceof Error ? error.message : "SIMPLE_REBOUND 退出提交失败" }, { status: 422 });
  }
}
