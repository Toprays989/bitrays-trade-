import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { exchangeCredentials, liveOrderEvents, livePositionReductions, livePositions, strategies, tradingAccounts } from "../../../../db/schema";
import { accountFundingSnapshot } from "../../../../lib/account-funding-snapshot";
import { isSecureCredentialRequest, liveTradingAllowedByServer } from "../../../../lib/credential-vault";
import { getTradeReadiness } from "../../../../lib/trade-readiness";
import { reductionAccountingPnl } from "../../../../lib/live-reduction-settlement";
import { isResponse, readTradingAccountDailyPnl, requirePermission, writeAudit } from "../shared";

export const dynamic = "force-dynamic";

async function ensureMainAccount(email: string) {
  const now = new Date();
  await getDb().insert(tradingAccounts).values({ ownerEmail: email, accountId: "bys-main", name: "主交易账户", accountType: "MAIN", executionMode: "LIVE", equityLimit: 100_000, maxLeverage: 10, createdAt: now, updatedAt: now }).onConflictDoNothing();
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "sys:account:view");
  if (isResponse(user)) return user;
  await ensureMainAccount(user.email);
  const db = getDb();
  await db.update(tradingAccounts).set({ executionMode: "LIVE", updatedAt: new Date() }).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.executionMode, "SIMULATION")));
  const [accountRows, credentials, positions, reductions, orders, strategyRows] = await Promise.all([
    db.select().from(tradingAccounts).where(eq(tradingAccounts.ownerEmail, user.email)).orderBy(desc(tradingAccounts.updatedAt)),
    db.select().from(exchangeCredentials).where(eq(exchangeCredentials.ownerEmail, user.email)),
    db.select({ id: livePositions.id, accountId: livePositions.accountId, symbol: livePositions.symbol, status: livePositions.status, positionSide: livePositions.positionSide, quantity: livePositions.quantity, entryPrice: livePositions.entryPrice, markPrice: livePositions.markPrice, leverage: livePositions.leverage, realizedPnl: livePositions.realizedPnl, closedAt: livePositions.closedAt }).from(livePositions).where(eq(livePositions.ownerEmail, user.email)),
    db.select().from(livePositionReductions).where(eq(livePositionReductions.ownerEmail, user.email)),
    db.select({ accountId: liveOrderEvents.accountId, symbol: liveOrderEvents.symbol, status: liveOrderEvents.status, estimatedNotional: liveOrderEvents.estimatedNotional, testOnly: liveOrderEvents.testOnly }).from(liveOrderEvents).where(and(
      eq(liveOrderEvents.ownerEmail, user.email),
      eq(liveOrderEvents.testOnly, false),
      inArray(liveOrderEvents.status, ["PENDING", "EXECUTION_UNKNOWN"]),
    )),
    db.select({ accountId: strategies.accountId, status: strategies.status }).from(strategies).where(eq(strategies.ownerEmail, user.email)),
  ]);
  const legacyLockedIds = accountRows
    .filter((account) => account.riskLocked)
    .map((account) => account.id);
  if (legacyLockedIds.length)
    await db
      .update(tradingAccounts)
      .set({
        riskLocked: false,
        riskLockReason: null,
        riskLockedAt: null,
        updatedAt: new Date(),
      })
      .where(inArray(tradingAccounts.id, legacyLockedIds));
  const accounts = accountRows.map((account) =>
    legacyLockedIds.includes(account.id)
      ? {
          ...account,
          riskLocked: false,
          riskLockReason: null,
          riskLockedAt: null,
        }
      : account,
  );
  const dailyMetrics = new Map((await Promise.all(accounts.map(async (account) => [account.accountId, await readTradingAccountDailyPnl(user, account)] as const))));
  const serverLiveTradingAllowed = await liveTradingAllowedByServer();
  return Response.json({ accounts: accounts.map((account) => {
    const openPositions = positions.filter((item) => item.accountId === account.accountId && item.status === "OPEN");
    const pendingOrders = orders.filter((item) => item.accountId === account.accountId && !item.testOnly && ["PENDING", "EXECUTION_UNKNOWN"].includes(item.status));
    const credential = credentials.find((item) => item.accountId === account.accountId);
    const funding = credential ? accountFundingSnapshot(credential) : null;
    const marginUsed = funding?.positionInitialMarginUsdt ?? openPositions.reduce((sum, item) => sum + item.quantity * item.markPrice / Math.max(item.leverage, 1), 0);
    const reservedMargin = funding?.openOrderInitialMarginUsdt ?? 0;
    const committedMargin = marginUsed + reservedMargin;
    const reserveAmount = 0;
    const usableEquity = funding?.marginEquityUsdt ?? 0;
    const utilizationPercent = usableEquity > 0 ? Math.min(committedMargin / usableEquity * 100, 999.99) : 0;
    const unrealizedPnl = openPositions.reduce((sum, item) => sum + (item.markPrice - item.entryPrice) * item.quantity * (item.positionSide === "LONG" ? 1 : -1), 0);
    const accountReductions = reductions.filter((item) => item.accountId === account.accountId);
    const reducedPositionIds = new Set(accountReductions.map((item) => item.positionId));
    const standaloneClosedPositions = positions.filter((item) => item.accountId === account.accountId && item.status === "CLOSED" && !reducedPositionIds.has(item.id));
    const realizedPnl = standaloneClosedPositions.reduce((sum, item) => sum + item.realizedPnl, 0) + accountReductions.reduce((sum, item) => sum + reductionAccountingPnl(item).pnl, 0);
    const accountDailyMetrics = dailyMetrics.get(account.accountId)!;
    const dailyRealizedPnl = accountDailyMetrics.dailyRealizedPnl;
    const dailyPnl = accountDailyMetrics.dailyPnl;
    const nextRiskResetAt = accountDailyMetrics.nextResetAt;
    const dailyLossLimitAmount = 0;
    const availableMargin = funding?.availableToOpenUsdt ?? 0;
    const symbolMargins = new Map<string, number>();
    for (const item of openPositions) symbolMargins.set(item.symbol, (symbolMargins.get(item.symbol) ?? 0) + item.quantity * item.markPrice / Math.max(item.leverage, 1));
    for (const item of pendingOrders) symbolMargins.set(item.symbol, (symbolMargins.get(item.symbol) ?? 0) + item.estimatedNotional);
    const topConcentration = [...symbolMargins.entries()].sort((a, b) => b[1] - a[1])[0];
    const topConcentrationPercent = usableEquity > 0 && topConcentration ? topConcentration[1] / usableEquity * 100 : 0;
    const riskLevel = !account.isActive ? "DISABLED" : utilizationPercent >= 80 ? "HIGH" : utilizationPercent >= 60 ? "WATCH" : "NORMAL";
    return { ...account, tradeReadiness: getTradeReadiness(account, credential, serverLiveTradingAllowed), stats: { openPositions: openPositions.length, notionalValue: openPositions.reduce((sum, item) => sum + item.quantity * item.markPrice, 0), pendingOrders: pendingOrders.length, runningStrategies: strategyRows.filter((item) => item.accountId === account.accountId && item.status === "RUNNING").length, marginUsed, reservedMargin, committedMargin, reserveAmount, usableEquity, availableMargin, utilizationPercent, topConcentrationSymbol: topConcentration?.[0] ?? null, topConcentrationPercent, unrealizedPnl, realizedPnl, dailyRealizedPnl, dailyUnrealizedPnlChange: accountDailyMetrics.dailyUnrealizedPnlChange, dailyPnl, dailyLossLimitAmount, nextRiskResetAt, riskLevel } };
  }) });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "sys:account:manage");
  if (isResponse(user)) return user;
  const body = await request.json() as { accountId?: string; name?: string; accountType?: "MAIN" | "STRATEGY"; operatorName?: string; note?: string };
  const accountId = body.accountId?.trim().toLowerCase() ?? "";
  const name = body.name?.trim() ?? "";
  const accountType = body.accountType === "MAIN" ? "MAIN" : "STRATEGY";
  if (!/^[a-z0-9][a-z0-9-]{2,23}$/.test(accountId) || accountId === "bys-main") return Response.json({ error: "账户编号需为 3–24 位小写字母、数字或连字符" }, { status: 400 });
  const validation = validateAccountName(name);
  if (validation) return Response.json({ error: validation }, { status: 400 });
  const now = new Date();
  try {
    const [account] = await getDb().insert(tradingAccounts).values({ ownerEmail: user.email, accountId, name, accountType, executionMode: "LIVE", operatorName: body.operatorName?.trim() || "管理员", note: body.note?.trim() || null, createdAt: now, updatedAt: now }).returning();
    await writeAudit(user, "CREATE_TRADING_ACCOUNT", "trading_account", accountId, { name, accountType });
    return Response.json({ account }, { status: 201 });
  } catch {
    return Response.json({ error: "该子账号编号已存在" }, { status: 409 });
  }
}

export async function PUT(request: Request) {
  const user = await requirePermission(request, "sys:account:manage");
  if (isResponse(user)) return user;
  const body = await request.json() as { id?: number; name?: string; operatorName?: string; note?: string; confirmation?: string; isActive?: boolean };
  if (!Number.isInteger(body.id) || typeof body.isActive !== "boolean") return Response.json({ error: "账户更新参数不完整" }, { status: 400 });
  const validation = validateAccountName(body.name?.trim() ?? "");
  if (validation) return Response.json({ error: validation }, { status: 400 });
  const db = getDb();
  const [current] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.id, body.id!), eq(tradingAccounts.ownerEmail, user.email))).limit(1);
  if (!current) return Response.json({ error: "交易账户不存在" }, { status: 404 });
  if (current.accountType === "MAIN" && !body.isActive) return Response.json({ error: "主交易账户不能停用" }, { status: 400 });
  if (current.accountType === "STRATEGY" && !current.isActive && body.isActive) {
    const serverLiveTradingAllowed = await liveTradingAllowedByServer();
    if (!isSecureCredentialRequest(request) || !serverLiveTradingAllowed) return Response.json({ error: "请先在账户管理页开启服务器实盘总控" }, { status: 423 });
    if (body.confirmation !== `LIVE ${current.accountId}`) return Response.json({ error: `请输入 LIVE ${current.accountId} 确认` }, { status: 400 });
    const [credential] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.accountId, current.accountId))).limit(1);
    const readiness = getTradeReadiness({ ...current, isActive: true }, credential, serverLiveTradingAllowed);
    if (!readiness.liveReady) return Response.json({ error: `该账户尚未达到实盘就绪条件：${readiness.blockers.join("；")}`, code: "ACCOUNT_NOT_LIVE_READY", readiness }, { status: 409 });
  }
  const [openPositions, pendingOrders, runningStrategies] = await Promise.all([
    db.select().from(livePositions).where(and(eq(livePositions.ownerEmail, user.email), eq(livePositions.accountId, current.accountId), eq(livePositions.status, "OPEN"))),
    db.select().from(liveOrderEvents).where(and(eq(liveOrderEvents.ownerEmail, user.email), eq(liveOrderEvents.accountId, current.accountId), eq(liveOrderEvents.testOnly, false), inArray(liveOrderEvents.status, ["PENDING", "NEW", "PARTIALLY_FILLED", "CANCEL_PENDING", "EXECUTION_UNKNOWN"]))),
    db.select().from(strategies).where(and(eq(strategies.ownerEmail, user.email), eq(strategies.accountId, current.accountId), eq(strategies.status, "RUNNING"))),
  ]);
  const now = new Date();
  const safetyActions = { pausedStrategies: 0, canceledOrders: 0, openPositionsKept: openPositions.length };
  if (!body.isActive) {
    if (runningStrategies.length > 0) {
      await db.update(strategies).set({ status: "PAUSED", updatedAt: now }).where(and(eq(strategies.ownerEmail, user.email), eq(strategies.accountId, current.accountId), eq(strategies.status, "RUNNING")));
      safetyActions.pausedStrategies = runningStrategies.length;
    }
    if (pendingOrders.length > 0) return Response.json({ error: "账户仍有待确认的实盘订单，请先完成交易所对账后再停用" }, { status: 409 });
  }
  const [account] = await db.update(tradingAccounts).set({ name: body.name!.trim(), operatorName: body.operatorName?.trim() || "管理员", note: body.note?.trim() || null, executionMode: "LIVE", isActive: body.isActive, updatedAt: now }).where(eq(tradingAccounts.id, current.id)).returning();
  await writeAudit(user, "UPDATE_TRADING_ACCOUNT_AVAILABILITY", "trading_account", current.accountId, { before: { name: current.name, operatorName: current.operatorName, note: current.note, isActive: current.isActive }, after: { name: account.name, operatorName: account.operatorName, note: account.note, isActive: account.isActive }, safetyActions });
  return Response.json({ account, safetyActions });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "sys:account:manage");
  if (isResponse(user)) return user;
  const body = await request.json() as { id?: number; confirmation?: string };
  if (!Number.isInteger(body.id) || body.confirmation !== "PAUSE_ACCOUNT_AUTOMATION") return Response.json({ error: "请确认暂停账户自动化" }, { status: 400 });
  const db = getDb();
  const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.id, body.id!), eq(tradingAccounts.ownerEmail, user.email))).limit(1);
  if (!account) return Response.json({ error: "交易账户不存在" }, { status: 404 });
  if (!account.isActive) return Response.json({ error: "该账户已停用，无需重复暂停" }, { status: 400 });
  const [runningStrategies, pendingOrders, openPositions] = await Promise.all([
    db.select({ id: strategies.id }).from(strategies).where(and(eq(strategies.ownerEmail, user.email), eq(strategies.accountId, account.accountId), eq(strategies.status, "RUNNING"))),
    db.select({ id: liveOrderEvents.id }).from(liveOrderEvents).where(and(eq(liveOrderEvents.ownerEmail, user.email), eq(liveOrderEvents.accountId, account.accountId), eq(liveOrderEvents.testOnly, false), inArray(liveOrderEvents.status, ["PENDING", "NEW", "PARTIALLY_FILLED", "CANCEL_PENDING", "EXECUTION_UNKNOWN"]))),
    db.select({ id: livePositions.id }).from(livePositions).where(and(eq(livePositions.ownerEmail, user.email), eq(livePositions.accountId, account.accountId), eq(livePositions.status, "OPEN"))),
  ]);
  const now = new Date();
  if (runningStrategies.length > 0) await db.update(strategies).set({ status: "PAUSED", updatedAt: now }).where(and(eq(strategies.ownerEmail, user.email), eq(strategies.accountId, account.accountId), eq(strategies.status, "RUNNING")));
  const safetyActions = { pausedStrategies: runningStrategies.length, pendingLiveOrdersKept: pendingOrders.length, openPositionsKept: openPositions.length };
  await writeAudit(user, "PAUSE_ACCOUNT_AUTOMATION", "trading_account", account.accountId, safetyActions);
  return Response.json({ ok: true, safetyActions });
}

export async function DELETE(request: Request) {
  const user = await requirePermission(request, "sys:account:manage");
  if (isResponse(user)) return user;
  const body = await request.json() as { id?: number; confirmation?: string };
  if (!Number.isInteger(body.id)) return Response.json({ error: "请选择要删除的子账户" }, { status: 400 });
  const db = getDb();
  const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.id, body.id!), eq(tradingAccounts.ownerEmail, user.email))).limit(1);
  if (!account) return Response.json({ error: "子账户不存在或已被删除" }, { status: 404 });
  if (account.accountId === "bys-main") return Response.json({ error: "系统内置主账户不能删除" }, { status: 403 });
  if (body.confirmation !== `DELETE ACCOUNT ${account.accountId}`) return Response.json({ error: `请输入 DELETE ACCOUNT ${account.accountId} 确认` }, { status: 400 });
  const [positions, strategyRows, liveOrders] = await Promise.all([
    db.select({ id: livePositions.id }).from(livePositions).where(and(eq(livePositions.ownerEmail, user.email), eq(livePositions.accountId, account.accountId))).limit(1),
    db.select({ id: strategies.id }).from(strategies).where(and(eq(strategies.ownerEmail, user.email), eq(strategies.accountId, account.accountId))).limit(1),
    db.select({ id: liveOrderEvents.id }).from(liveOrderEvents).where(and(eq(liveOrderEvents.ownerEmail, user.email), eq(liveOrderEvents.accountId, account.accountId))).limit(1),
  ]);
  if (positions.length || strategyRows.length || liveOrders.length) return Response.json({ error: "该子账户已有交易或策略历史，不能删除；请改为停用以保留审计记录" }, { status: 409 });
  await writeAudit(user, "DELETE_TRADING_ACCOUNT", "trading_account", account.accountId, { name: account.name });
  await db.delete(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.accountId, account.accountId)));
  await db.delete(tradingAccounts).where(eq(tradingAccounts.id, account.id));
  return Response.json({ ok: true });
}

function validateAccountName(name: string) {
  if (name.length < 2 || name.length > 30) return "账户名称需为 2–30 个字符";
  return "";
}
