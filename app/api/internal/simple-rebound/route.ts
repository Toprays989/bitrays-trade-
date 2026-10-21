import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db/index.ts";
import { strategies, tradingAccounts, exchangeCredentials } from "../../../../db/schema.ts";
import { loadSimpleReboundMarketRows } from "../../../../lib/simple-rebound-market-adapter.ts";
import { loadSimpleReboundSlots, occupyPersistedSimpleReboundSlot, releasePersistedSimpleReboundSlot } from "../../../../lib/simple-rebound-slot-store.ts";
import { runSimpleReboundCycle, shouldSkipSimpleReboundMarketLoad } from "../../../../lib/simple-rebound-runner.ts";
import { appendSimpleReboundEvents } from "../../../../lib/simple-rebound-event-store.ts";
import { SIMPLE_REBOUND_EVENT_TYPES } from "../../../../lib/simple-rebound-events.ts";
import { getBinanceLiveContractRule } from "../../../../lib/binance-usdm-live.ts";
import { credentialContext, decryptCredential, liveTradingAllowedByServer } from "../../../../lib/credential-vault.ts";
import { getTradeReadiness } from "../../../../lib/trade-readiness.ts";
import { submitSimpleReboundLiveEntry, submitSimpleReboundLiveExit } from "../../../../lib/simple-rebound-live-execution.ts";
import { SIMPLE_REBOUND_LIVE_CONFIRMATION } from "../../../../lib/simple-rebound-live-gate.ts";
import { SIMPLE_REBOUND_CONFIG } from "../../../../lib/simple-rebound-config.ts";

function authorized(request: Request) {
  const configured = (
    env as unknown as { NQ_INTERNAL_LIQUIDATION_TOKEN?: string }
  ).NQ_INTERNAL_LIQUIDATION_TOKEN ?? "";
  return configured.length >= 32 &&
    request.headers.get("authorization") === `Bearer ${configured}`;
}

const lastScanLogAt = new Map<number, number>();

/**
 * Independent strategy cycle. Market input is WebSocket/cache-only; when the
 * strategy is RUNNING and the existing server/account gates are ready, order
 * and exit plans are handed to the established exchange gateway and persisted
 * into the normal position/slot reconciliation tables.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { strategyId?: number } = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as { strategyId?: number };
  } catch {
    // An empty body is allowed; the query string can carry strategyId.
  }
  const requestedStrategyId = Number(body.strategyId ?? new URL(request.url).searchParams.get("strategyId") ?? 0);
  const candidates = requestedStrategyId > 0
    ? await getDb().select({
      id: strategies.id,
      strategyType: strategies.strategyType,
      status: strategies.status,
      ownerEmail: strategies.ownerEmail,
      accountId: strategies.accountId,
    }).from(strategies).where(eq(strategies.id, requestedStrategyId)).limit(1)
    : await getDb().select({
      id: strategies.id,
      strategyType: strategies.strategyType,
      status: strategies.status,
      ownerEmail: strategies.ownerEmail,
      accountId: strategies.accountId,
    }).from(strategies).where(eq(strategies.strategyType, "SIMPLE_REBOUND"));
  if (requestedStrategyId > 0 && (!Number.isInteger(requestedStrategyId) || requestedStrategyId <= 0))
    return Response.json({ error: "strategyId 必须为正整数" }, { status: 400 });
  if (candidates.length !== 1)
    return Response.json({ error: candidates.length ? "SIMPLE_REBOUND 策略不唯一，请明确指定 strategyId" : "没有可运行的 SIMPLE_REBOUND 策略" }, { status: candidates.length ? 409 : 404 });
  const [strategy] = candidates;
  const strategyId = strategy.id;
  if (!strategy) return Response.json({ error: "策略不存在" }, { status: 404 });
  if (strategy.strategyType !== "SIMPLE_REBOUND")
    return Response.json({ error: "该策略不是 SIMPLE_REBOUND" }, { status: 409 });

  const nowMs = Date.now();
  const slots = await loadSimpleReboundSlots(strategyId);
  if (shouldSkipSimpleReboundMarketLoad({ strategyStatus: strategy.status, slots })) {
    return Response.json({
      strategyId,
      strategyStatus: strategy.status,
      readOnly: true,
      marketRows: 0,
      occupiedSlots: 0,
      signals: [],
      orderPlans: [],
      exits: [],
      events: [],
      execution: { enabled: false, attempted: 0, filled: 0, exited: 0, errors: [] },
      marketData: { source: "BINANCE_WEBSOCKET_MARK_HISTORY_AND_TICKER_CACHE", upstreamKlineRequests: 0 },
    });
  }
  const market = await loadSimpleReboundMarketRows();
  const result = runSimpleReboundCycle({ market, slots, nowMs });
  const events = [...result.events];
  if (nowMs - (lastScanLogAt.get(strategyId) ?? 0) >= 15_000) {
    lastScanLogAt.set(strategyId, nowMs);
    events.unshift({
      eventType: SIMPLE_REBOUND_EVENT_TYPES.SCAN,
      stage: "SIGNAL",
      outcome: "INFO",
      symbol: "*",
      eventAt: nowMs,
      message: `Simple Rebound 扫描正常：候选 ${market.length}，占用席位 ${slots.filter(Boolean).length}，信号 ${result.signals.length}`,
      detail: { marketRows: market.length, occupiedSlots: slots.filter(Boolean).length, signals: result.signals.length, orderPlans: result.orderPlans.length, exits: result.exits.length },
    });
  }
  const live = strategy.status === "RUNNING";
  let execution: Record<string, unknown> = { enabled: live, attempted: 0, filled: 0, exited: 0, errors: [] };
  if (live && (result.orderPlans.length || result.exits.length)) {
    const [account] = await getDb().select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, strategy.ownerEmail), eq(tradingAccounts.accountId, strategy.accountId))).limit(1);
    const [credential] = account
      ? await getDb().select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, strategy.ownerEmail), eq(exchangeCredentials.accountId, account.accountId))).limit(1)
      : [];
    const readiness = account && credential
      ? getTradeReadiness(account, credential, await liveTradingAllowedByServer())
      : null;
    const blockers = [...(readiness?.blockers ?? ["交易账户或凭据不存在"]), ...(credential?.positionMode === "HEDGE" ? [] : ["账户必须是 HEDGE 双向持仓模式"])];
    if (!account || !credential || !readiness?.liveReady || credential.positionMode !== "HEDGE") {
      execution = { enabled: true, attempted: 0, filled: 0, exited: 0, errors: blockers };
    } else {
      const [apiKey, secretKey] = await Promise.all([
        decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(strategy.ownerEmail, account.accountId, "api-key")),
        decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(strategy.ownerEmail, account.accountId, "secret-key")),
      ]);
      const errors: string[] = [];
      let attempted = 0;
      let filled = 0;
      let exited = 0;
      for (const plan of result.orderPlans) {
        attempted += 1;
        try {
          const { contract } = await getBinanceLiveContractRule(plan.symbol);
          const submitted = await submitSimpleReboundLiveEntry({
            confirmation: SIMPLE_REBOUND_LIVE_CONFIRMATION,
            credentials: { apiKey, secretKey },
            plan,
            account: { accountId: account.accountId, credentialId: credential.id, ownerEmail: strategy.ownerEmail },
            contractRule: { minOrderQty: contract.minOrderQty, quantityStep: contract.quantityStep, minNotionalUsdt: contract.minNotionalUsdt },
          });
          const status = String(submitted.result.data.status ?? "").toUpperCase();
          const didFill = status === "FILLED" || Number(submitted.result.data.executedQty ?? 0) > 0;
          if (didFill) {
            await occupyPersistedSimpleReboundSlot({ strategyId, slotId: plan.slotId, ownerEmail: strategy.ownerEmail, accountId: account.accountId, symbol: plan.symbol, entryPrice: Number(submitted.result.data.avgPrice) || plan.referencePrice, openedAtMs: nowMs, traceId: plan.clientOrderId });
            filled += 1;
          }
          await appendSimpleReboundEvents({ strategyId, traceId: plan.clientOrderId, events: [{ eventType: SIMPLE_REBOUND_EVENT_TYPES.ORDER, stage: "ORDER", outcome: didFill ? "PASSED" : "PENDING", symbol: plan.symbol, eventAt: nowMs, message: didFill ? "SIMPLE_REBOUND 入场成交，已交给持仓管理" : `入场已提交，交易所状态 ${status || "UNKNOWN"}`, detail: { clientOrderId: plan.clientOrderId, exchangeStatus: status, exchangeOrderId: submitted.result.data.orderId ?? null } }] });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${plan.symbol}: ${message}`);
          await appendSimpleReboundEvents({ strategyId, traceId: plan.clientOrderId, events: [{ eventType: SIMPLE_REBOUND_EVENT_TYPES.ORDER, stage: "ORDER", outcome: "ERROR", symbol: plan.symbol, eventAt: nowMs, message: "SIMPLE_REBOUND 入场执行失败，等待对账", detail: { error: message } }] }).catch(() => undefined);
        }
      }
      for (const exit of result.exits) {
        try {
          const slot = slots[exit.slotId - 1];
          if (!slot) continue;
          const { contract } = await getBinanceLiveContractRule(slot.symbol);
          const rawQuantity = SIMPLE_REBOUND_CONFIG.orderNotionalUsdt / slot.entryPrice;
          const quantity = Math.floor(rawQuantity / contract.quantityStep) * contract.quantityStep;
          const submitted = await submitSimpleReboundLiveExit({ confirmation: SIMPLE_REBOUND_LIVE_CONFIRMATION, credentials: { apiKey, secretKey }, slot, reason: exit.reason, quantity, quantityStep: contract.quantityStep });
          const status = String(submitted.result.data.status ?? "").toUpperCase();
          const didFill = status === "FILLED" || Number(submitted.result.data.executedQty ?? 0) > 0;
          if (didFill) { await releasePersistedSimpleReboundSlot(strategyId, exit.slotId); exited += 1; }
          await appendSimpleReboundEvents({ strategyId, traceId: `srb_exit_${strategyId}_${exit.slotId}_${nowMs}`, events: [{ eventType: SIMPLE_REBOUND_EVENT_TYPES.EXIT, stage: "POSITION_MANAGEMENT", outcome: didFill ? "PASSED" : "PENDING", symbol: slot.symbol, eventAt: nowMs, message: didFill ? "SIMPLE_REBOUND 退出成交，已交给持仓管理" : `退出已提交，交易所状态 ${status || "UNKNOWN"}`, detail: { slotId: exit.slotId, reason: exit.reason, exchangeStatus: status } }] });
        } catch (error) { errors.push(`${exit.symbol}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      execution = { enabled: true, attempted, filled, exited, errors };
    }
  }
  if (events.length) await appendSimpleReboundEvents({ strategyId, traceId: `srb_cycle_${strategyId}_${nowMs}`, events });
  return Response.json({
    strategyId,
    strategyStatus: strategy.status,
    readOnly: false,
    marketRows: market.length,
    occupiedSlots: slots.filter(Boolean).length,
    signals: result.signals,
    orderPlans: result.orderPlans,
    exits: result.exits,
    events,
    execution,
    marketData: { source: "BINANCE_WEBSOCKET_MARK_HISTORY_AND_TICKER_CACHE", upstreamKlineRequests: 0 },
  });
}
