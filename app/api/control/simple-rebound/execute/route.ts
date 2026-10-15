import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { exchangeCredentials, strategies, tradingAccounts } from "../../../../../db/schema";
import { getBinanceLiveContractRule } from "../../../../../lib/binance-usdm-live";
import { credentialContext, decryptCredential, isSecureCredentialRequest, liveTradingAllowedByServer } from "../../../../../lib/credential-vault";
import { getTradeReadiness } from "../../../../../lib/trade-readiness";
import { buildSimpleReboundExecutionRequest } from "../../../../../lib/simple-rebound-execution-adapter";
import { parseSimpleReboundOrderPlan } from "../../../../../lib/simple-rebound-execution-input";
import { submitSimpleReboundLiveEntry } from "../../../../../lib/simple-rebound-live-execution";
import { appendSimpleReboundEvents } from "../../../../../lib/simple-rebound-event-store";
import { occupyPersistedSimpleReboundSlot } from "../../../../../lib/simple-rebound-slot-store";
import { SIMPLE_REBOUND_EVENT_TYPES } from "../../../../../lib/simple-rebound-events";
import { validateSimpleReboundConfig } from "../../../../../lib/simple-rebound-config";
import { assertSimpleReboundLiveConfirmation } from "../../../../../lib/simple-rebound-live-gate";
import { isResponse, requirePermission } from "../../shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:live_order:create");
  if (isResponse(user)) return user;
  if (!isSecureCredentialRequest(request))
    return Response.json({ error: "真实执行只允许通过可信 HTTPS 连接" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  try {
    assertSimpleReboundLiveConfirmation(body.confirmation);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "SIMPLE_REBOUND 实盘确认失败" }, { status: 400 });
  }
  const strategyId = body.strategyId;
  const plan = parseSimpleReboundOrderPlan(body.plan);
  if (typeof strategyId !== "number" || !Number.isInteger(strategyId) || !plan)
    return Response.json({ error: "缺少有效的 SIMPLE_REBOUND strategyId 或订单计划" }, { status: 400 });

  const db = getDb();
  const [strategy] = await db.select().from(strategies).where(and(eq(strategies.id, strategyId), eq(strategies.ownerEmail, user.email))).limit(1);
  if (!strategy || strategy.strategyType !== "SIMPLE_REBOUND")
    return Response.json({ error: "策略不存在或不是 SIMPLE_REBOUND" }, { status: 404 });
  let config: unknown;
  try { config = JSON.parse(strategy.configJson || "{}"); } catch { return Response.json({ error: "SIMPLE_REBOUND 配置不是有效 JSON" }, { status: 409 }); }
  if (!validateSimpleReboundConfig(config))
    return Response.json({ error: "SIMPLE_REBOUND 配置未通过独立规则校验" }, { status: 409 });
  if (["ARCHIVED", "ERROR", "BLOCKED"].includes(strategy.status))
    return Response.json({ error: `策略当前状态不可真实执行: ${strategy.status}` }, { status: 409 });

  const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, strategy.accountId))).limit(1);
  const [credential] = account
    ? await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.accountId, account.accountId))).limit(1)
    : [];
  if (!account || !credential)
    return Response.json({ error: "SIMPLE_REBOUND 交易账户或凭据不存在" }, { status: 409 });
  const readiness = getTradeReadiness(account, credential, await liveTradingAllowedByServer());
  if (!readiness.liveReady || credential.positionMode !== "HEDGE")
    return Response.json({ error: "SIMPLE_REBOUND 实盘前置条件未满足", blockers: [...readiness.blockers, ...(credential.positionMode === "HEDGE" ? [] : ["账户必须是 HEDGE 双向持仓模式"])], readiness }, { status: 409 });

  try {
    const { contract } = await getBinanceLiveContractRule(plan.symbol);
    buildSimpleReboundExecutionRequest(plan, { accountId: account.accountId, credentialId: credential.id, ownerEmail: user.email }, {
      minOrderQty: contract.minOrderQty,
      quantityStep: contract.quantityStep,
      minNotionalUsdt: contract.minNotionalUsdt,
    });
    const [apiKey, secretKey] = await Promise.all([
      decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(user.email, account.accountId, "api-key")),
      decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(user.email, account.accountId, "secret-key")),
    ]);
    const result = await submitSimpleReboundLiveEntry({ confirmation: body.confirmation, credentials: { apiKey, secretKey }, plan, account: { accountId: account.accountId, credentialId: credential.id, ownerEmail: user.email }, contractRule: { minOrderQty: contract.minOrderQty, quantityStep: contract.quantityStep, minNotionalUsdt: contract.minNotionalUsdt } });
    const exchangeStatus = String(result.result.data.status ?? "").toUpperCase();
    const filled = exchangeStatus === "FILLED" || Number(result.result.data.executedQty ?? 0) > 0;
    if (filled) {
      await occupyPersistedSimpleReboundSlot({ strategyId: strategy.id, slotId: plan.slotId, ownerEmail: user.email, accountId: account.accountId, symbol: plan.symbol, entryPrice: Number(result.result.data.avgPrice) || plan.referencePrice, openedAtMs: Date.now(), traceId: plan.clientOrderId });
    }
    await appendSimpleReboundEvents({ strategyId: strategy.id, traceId: plan.clientOrderId, events: [{ eventType: SIMPLE_REBOUND_EVENT_TYPES.ORDER, stage: "ORDER", outcome: filled ? "PASSED" : "PENDING", symbol: plan.symbol, eventAt: Date.now(), message: filled ? "SIMPLE_REBOUND 入场成交，席位已占用" : `SIMPLE_REBOUND 入场已提交，交易所状态 ${exchangeStatus || "UNKNOWN"}`, detail: { clientOrderId: plan.clientOrderId, exchangeStatus, exchangeOrderId: result.result.data.orderId ?? null } }] });
    return Response.json({ source: "SIMPLE_REBOUND", strategyId: strategy.id, result }, { status: 202 });
  } catch (error) {
    await appendSimpleReboundEvents({ strategyId: strategy.id, traceId: plan.clientOrderId, events: [{ eventType: SIMPLE_REBOUND_EVENT_TYPES.ORDER, stage: "ORDER", outcome: "ERROR", symbol: plan.symbol, eventAt: Date.now(), message: "SIMPLE_REBOUND 入场执行失败，等待人工/对账处理", detail: { error: error instanceof Error ? error.message : "unknown" } }] }).catch(() => undefined);
    return Response.json({ error: error instanceof Error ? error.message : "SIMPLE_REBOUND 实盘提交失败" }, { status: 422 });
  }
}
