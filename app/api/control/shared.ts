import { and, eq, gte, inArray, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { contractSymbols, livePositionReductions, livePositions, portfolioRiskStates, rateLimitBuckets, riskStates, strategyExecutionTraces, tradingAccounts, userAccess } from "../../../db/schema";
import { getSession, resolveRequestEmail } from "../../../lib/app-auth";
import { chinaTradingDayWindow } from "../../../lib/trading-calendar";
import { buildInstrumentId } from "../../../lib/position-protection-version";
import { reductionAccountingPnl } from "../../../lib/live-reduction-settlement";
import { accountDailyUnrealizedPnlChange } from "../../../lib/account-daily-loss-limit";
import { calculateTradingStrategyDailyPnl } from "../../../lib/strategy-daily-pnl";
import { readNexusPositionMemory } from "../../../lib/nexus-position-memory";
import {
  ROLE_PERMISSIONS,
  resolveStoredAccess,
  type ControlDataScope,
  type ControlRole,
  type PermissionTag,
} from "../../../lib/control-access-policy";

export { ROLE_PERMISSIONS, resolveStoredAccess };
export type { PermissionTag };

export type ControlUser = { email: string; accountId: string };
export type AuthorizedUser = ControlUser & { role: ControlRole; dataScope: ControlDataScope; permissions: PermissionTag[]; mustChangePassword: boolean };

export async function requireControlUser(request: Request): Promise<ControlUser | Response> {
  const email = await resolveRequestEmail(request);
  if (!email) return Response.json({ error: "需要登录后访问交易控制接口" }, { status: 401 });
  const db = getDb();
  const [access] = await db.select().from(userAccess).where(eq(userAccess.email, email)).limit(1);
  if (!access) {
    const existing = await db.select({ id: userAccess.id }).from(userAccess).limit(1);
    if (existing.length) return Response.json({ error: "账号尚未由管理员开通", code: "ACCOUNT_NOT_PROVISIONED" }, { status: 403 });
    return { email, accountId: "bys-main" };
  }
  if (!access.isActive) return Response.json({ error: "账号已停用，请联系管理员", code: "ACCOUNT_DISABLED" }, { status: 403 });
  if (access.passwordHash && !await getSession(request, email)) return Response.json({ error: "请输入应用密码", code: "APP_LOGIN_REQUIRED" }, { status: 401 });
  return { email, accountId: "bys-main" };
}

export function isResponse(value: ControlUser | Response): value is Response {
  return value instanceof Response;
}

export async function ensureUserAccess(user: ControlUser): Promise<AuthorizedUser> {
  const db = getDb();
  const [existing] = await db.select().from(userAccess).where(eq(userAccess.email, user.email)).limit(1);
  if (existing) {
    return {
      ...user,
      ...resolveStoredAccess(existing),
      mustChangePassword: existing.mustChangePassword,
    };
  }
  const role: AuthorizedUser["role"] = "ADMIN";
  const dataScope: AuthorizedUser["dataScope"] = "ALL";
  const permissions = ROLE_PERMISSIONS.ADMIN;
  const now = new Date();
  await db.insert(userAccess).values({ email: user.email, role, dataScope, permissionsJson: JSON.stringify(permissions), createdAt: now, updatedAt: now }).onConflictDoNothing();
  return { ...user, role, dataScope, permissions, mustChangePassword: false };
}

export async function requirePermission(request: Request, tag: PermissionTag): Promise<AuthorizedUser | Response> {
  const user = await requireControlUser(request);
  if (isResponse(user)) return user;
  const authorized = await ensureUserAccess(user);
  if (authorized.mustChangePassword) return Response.json({ error: "首次登录必须修改临时密码", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 428 });
  if (!authorized.permissions.includes(tag)) {
    return Response.json(
      { error: "当前账号没有执行该操作的权限", code: "PERMISSION_DENIED" },
      { status: 403 },
    );
  }
  return authorized;
}

export async function ensureSeedData() {
  const db = getDb();
  const existing = await db.select({ id: contractSymbols.id }).from(contractSymbols).limit(1);
  if (existing.length) return;
  const now = new Date();
  await db.insert(contractSymbols).values([
    { symbol: "BTCUSDT", instrumentId: buildInstrumentId({ symbol: "BTCUSDT" }), displayName: "Bitcoin", source: "MANUAL_PROTECT", minOrderQty: 0.001, isProtected: true, updatedAt: now },
    { symbol: "ETHUSDT", instrumentId: buildInstrumentId({ symbol: "ETHUSDT" }), displayName: "Ethereum", source: "MANUAL_PROTECT", minOrderQty: 0.001, isProtected: true, updatedAt: now },
    { symbol: "SOLUSDT", instrumentId: buildInstrumentId({ symbol: "SOLUSDT" }), displayName: "Solana", source: "AUTO_FILTER", minOrderQty: 0.01, updatedAt: now },
    { symbol: "ZECUSDT", instrumentId: buildInstrumentId({ symbol: "ZECUSDT" }), displayName: "Zcash", source: "AUTO_FILTER", minOrderQty: 0.01, updatedAt: now },
    { symbol: "OPUSDT", instrumentId: buildInstrumentId({ symbol: "OPUSDT" }), displayName: "Optimism", source: "AUTO_FILTER", minOrderQty: 0.1, updatedAt: now },
  ]);
}

export async function ensureAccountState(user: ControlUser) {
  const db = getDb();
  const now = new Date();
  await db.insert(rateLimitBuckets).values({ ownerEmail: user.email, accountId: user.accountId, exchange: "BINANCE", windowStartedAt: now, updatedAt: now }).onConflictDoNothing();
  await db.insert(riskStates).values({ ownerEmail: user.email, accountId: user.accountId, tradingEnabled: true, circuitBreakerStatus: "ARMED", updatedAt: now }).onConflictDoNothing();
}

export async function ensureMainTradingAccount(user: ControlUser) {
  const now = new Date();
  await getDb().insert(tradingAccounts).values({ ownerEmail: user.email, accountId: "bys-main", name: "主交易账户", accountType: "MAIN", executionMode: "LIVE", equityLimit: 100_000, maxLeverage: 10, createdAt: now, updatedAt: now }).onConflictDoNothing();
}

export async function writeAudit(user: ControlUser, action: string, resourceType: string, resourceId: string, detail: unknown) {
  // 审计流水已按运营提效要求关闭：保留函数签名，避免交易链路到处写库。
  void user;
  void action;
  void resourceType;
  void resourceId;
  void detail;
}

export async function readTradingAccountDailyPnl(
  user: ControlUser,
  account: typeof tradingAccounts.$inferSelect,
) {
  const db = getDb();
  const { startedAt: dayStartedAt, nextStartedAt: nextResetAt } =
    chinaTradingDayWindow();
  const [positions, reductionsToday, dailyStateRows] = await Promise.all([
    db.select().from(livePositions).where(and(
      eq(livePositions.ownerEmail, user.email),
      eq(livePositions.accountId, account.accountId),
      or(
        eq(livePositions.status, "OPEN"),
        and(
          eq(livePositions.status, "CLOSED"),
          gte(livePositions.closedAt, dayStartedAt),
        ),
      ),
    )),
    db.select().from(livePositionReductions).where(and(eq(livePositionReductions.ownerEmail, user.email), eq(livePositionReductions.accountId, account.accountId), gte(livePositionReductions.createdAt, dayStartedAt))),
    db.select().from(portfolioRiskStates).where(and(eq(portfolioRiskStates.ownerEmail, user.email), eq(portfolioRiskStates.accountId, account.accountId))).limit(1),
  ]);
  const openPositions = positions.filter((position) => position.status === "OPEN");
  const unrealizedPnl = openPositions.reduce((sum, position) => sum + (position.markPrice - position.entryPrice) * position.quantity * (position.positionSide === "LONG" ? 1 : -1), 0);
  const reducedPositionIds = new Set(reductionsToday.map((reduction) => reduction.positionId));
  const standaloneClosedToday = positions.filter((position) =>
    position.status === "CLOSED" &&
    position.closedAt &&
    position.closedAt >= dayStartedAt &&
    !reducedPositionIds.has(position.id)
  );
  const dailyRealizedPnl =
    reductionsToday.reduce((sum, reduction) => sum + reductionAccountingPnl(reduction).pnl, 0) +
    standaloneClosedToday.reduce((sum, position) => sum + position.realizedPnl, 0);
  const existingState = dailyStateRows[0];
  const hasCurrentBaseline =
    existingState?.dailyWindowStartedAt?.getTime() === dayStartedAt.getTime() &&
    Number.isFinite(existingState.dailyStartUnrealizedPnl);
  const dayStartUnrealizedPnl = hasCurrentBaseline
    ? existingState!.dailyStartUnrealizedPnl!
    : unrealizedPnl;
  if (!hasCurrentBaseline) {
    const now = new Date();
    await db.insert(portfolioRiskStates).values({
      ownerEmail: user.email,
      accountId: account.accountId,
      peakAccountEquityUsdt: existingState?.peakAccountEquityUsdt ?? 0,
      lastAccountEquityUsdt: existingState?.lastAccountEquityUsdt ?? 0,
      lastDrawdownPercent: existingState?.lastDrawdownPercent ?? 0,
      dailyWindowStartedAt: dayStartedAt,
      dailyStartUnrealizedPnl: unrealizedPnl,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [portfolioRiskStates.ownerEmail, portfolioRiskStates.accountId],
      set: {
        dailyWindowStartedAt: dayStartedAt,
        dailyStartUnrealizedPnl: unrealizedPnl,
        updatedAt: now,
      },
    });
  }
  const dailyUnrealizedPnlChange = accountDailyUnrealizedPnlChange(
    unrealizedPnl,
    dayStartUnrealizedPnl,
  );
  return {
    dayStartedAt,
    nextResetAt,
    openPositions,
    unrealizedPnl,
    dayStartUnrealizedPnl,
    dailyUnrealizedPnlChange,
    dailyRealizedPnl,
    dailyPnl: dailyRealizedPnl + dailyUnrealizedPnlChange,
  };
}

export async function readTradingStrategyDailyPnl(
  user: ControlUser,
  account: typeof tradingAccounts.$inferSelect,
  strategyId: number,
) {
  const db = getDb();
  const { startedAt: dayStartedAt, nextStartedAt: nextResetAt } =
    chinaTradingDayWindow();
  const [positions, reductionsToday] = await Promise.all([
    db
      .select()
      .from(livePositions)
      .where(
        and(
          eq(livePositions.ownerEmail, user.email),
          eq(livePositions.accountId, account.accountId),
          or(
            eq(livePositions.status, "OPEN"),
            and(
              eq(livePositions.status, "CLOSED"),
              gte(livePositions.closedAt, dayStartedAt),
            ),
          ),
        ),
      ),
    db
      .select()
      .from(livePositionReductions)
      .where(
        and(
          eq(livePositionReductions.ownerEmail, user.email),
          eq(livePositionReductions.accountId, account.accountId),
          gte(livePositionReductions.createdAt, dayStartedAt),
        ),
      ),
  ]);
  const unresolvedTraceIds = [
    ...new Set(
      positions
        .filter((position) =>
          position.lifecycleId &&
          readNexusPositionMemory(position.riskPlanJson, {
            lifecycleId: position.lifecycleId,
            entryDecisionHandoffJson: position.entryDecisionHandoffJson,
          }).strategyId === null
        )
        .map((position) => position.lifecycleId!),
    ),
  ];
  const strategyTraceIds = unresolvedTraceIds.length
    ? await db
        .select({ traceId: strategyExecutionTraces.traceId })
        .from(strategyExecutionTraces)
        .where(
          and(
            eq(strategyExecutionTraces.ownerEmail, user.email),
            eq(strategyExecutionTraces.accountId, account.accountId),
            eq(strategyExecutionTraces.strategyId, strategyId),
            inArray(strategyExecutionTraces.traceId, unresolvedTraceIds),
          ),
        )
        .then((rows) => rows.map((row) => row.traceId))
    : [];
  return {
    ...calculateTradingStrategyDailyPnl({
      strategyId,
      dayStartedAt,
      positions,
      reductionsToday,
      strategyTraceIds,
    }),
    dayStartedAt,
    nextResetAt,
  };
}
