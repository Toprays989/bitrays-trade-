import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { exchangeCredentials, strategies, tradingAccounts } from "../../../../../db/schema";
import { getBinanceLiveContractRule } from "../../../../../lib/binance-usdm-live";
import { liveTradingAllowedByServer } from "../../../../../lib/credential-vault";
import { getTradeReadiness } from "../../../../../lib/trade-readiness";
import { buildSimpleReboundExecutionRequest } from "../../../../../lib/simple-rebound-execution-adapter";
import { validateSimpleReboundConfig } from "../../../../../lib/simple-rebound-config";
import { parseSimpleReboundOrderPlan } from "../../../../../lib/simple-rebound-execution-input";
import { isResponse, requirePermission } from "../../shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:live_order:create");
  if (isResponse(user)) return user;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }

  const strategyId = body.strategyId;
  if (typeof strategyId !== "number" || !Number.isInteger(strategyId))
    return Response.json({ error: "缺少有效的 SIMPLE_REBOUND strategyId" }, { status: 400 });
  const plan = parseSimpleReboundOrderPlan(body.plan);
  if (!plan)
    return Response.json({ error: "订单计划不是独立的 SIMPLE_REBOUND 固定规则计划" }, { status: 400 });

  const db = getDb();
  const [strategy] = await db.select().from(strategies).where(and(eq(strategies.id, strategyId), eq(strategies.ownerEmail, user.email))).limit(1);
  if (!strategy || strategy.strategyType !== "SIMPLE_REBOUND")
    return Response.json({ error: "策略不存在或不是 SIMPLE_REBOUND" }, { status: 404 });
  let strategyConfig: unknown;
  try {
    strategyConfig = JSON.parse(strategy.configJson || "{}");
  } catch {
    return Response.json({ error: "SIMPLE_REBOUND 配置不是有效 JSON" }, { status: 409 });
  }
  if (!validateSimpleReboundConfig(strategyConfig))
    return Response.json({ error: "SIMPLE_REBOUND 配置未通过独立规则校验" }, { status: 409 });
  if (strategy.status === "ARCHIVED" || strategy.status === "ERROR" || strategy.status === "BLOCKED")
    return Response.json({ error: `策略当前状态不可准备执行: ${strategy.status}` }, { status: 409 });

  const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, strategy.accountId))).limit(1);
  const [credential] = account
    ? await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.accountId, account.accountId))).limit(1)
    : [];
  if (!account) return Response.json({ error: "策略交易账户不存在" }, { status: 409 });

  const serverLiveAllowed = await liveTradingAllowedByServer();
  const readiness = getTradeReadiness(account, credential, serverLiveAllowed);
  if (!readiness.liveReady) {
    return Response.json({
      error: "SIMPLE_REBOUND 尚未满足真实执行前置条件",
      code: "SIMPLE_REBOUND_NOT_READY",
      blockers: readiness.blockers,
      readiness,
    }, { status: 409 });
  }
  if (credential?.positionMode !== "HEDGE")
    return Response.json({ error: "SIMPLE_REBOUND 只允许 HEDGE 双向持仓模式" }, { status: 409 });

  try {
    const { contract } = await getBinanceLiveContractRule(plan.symbol);
    const requestPlan = buildSimpleReboundExecutionRequest(plan, {
      accountId: account.accountId,
      credentialId: credential.id,
      ownerEmail: user.email,
    }, {
      minOrderQty: contract.minOrderQty,
      quantityStep: contract.quantityStep,
      minNotionalUsdt: contract.minNotionalUsdt,
    });
    return Response.json({
      source: "SIMPLE_REBOUND",
      executionMode: "PENDING_CONFIRMATION",
      strategyId: strategy.id,
      strategyStatus: strategy.status,
      accountId: account.accountId,
      readiness,
      contract: {
        symbol: contract.symbol,
        minOrderQty: contract.minOrderQty,
        quantityStep: contract.quantityStep,
        minNotionalUsdt: contract.minNotionalUsdt,
      },
      request: requestPlan,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "合约规则校验失败" }, { status: 422 });
  }
}
