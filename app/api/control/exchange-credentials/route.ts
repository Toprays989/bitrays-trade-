import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  exchangeCredentials,
  liveOrderEvents,
  livePositions,
  strategies,
  tradingAccounts,
} from "../../../../db/schema";
import { BinanceLiveError, changeLivePositionMode, verifyLiveAccount } from "../../../../lib/binance-usdm-live";
import { credentialContext, decryptCredential, encryptCredential, insecureHttpLiveAllowed, isSecureCredentialRequest, liveTradingAllowedByServer } from "../../../../lib/credential-vault";
import { isResponse, requirePermission, writeAudit } from "../shared";

export const dynamic = "force-dynamic";

function publicCredential(row: typeof exchangeCredentials.$inferSelect) {
  return {
    id: row.id,
    accountId: row.accountId,
    exchange: row.exchange,
    environment: row.environment,
    label: row.label,
    apiKeyMask: row.apiKeyMask,
    secretConfigured: true,
    allowedSymbols: [] as string[],
    maxOrderNotionalUsdt: row.maxOrderNotionalUsdt,
    maxDailyNotionalUsdt: row.maxDailyNotionalUsdt,
    maxLeverage: row.maxLeverage,
    liveTradingEnabled: row.liveTradingEnabled,
    connectionStatus: row.connectionStatus,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    totalWalletBalance: row.totalWalletBalance,
    totalUnrealizedProfit: row.totalUnrealizedProfit,
    totalMarginBalance: row.totalMarginBalance,
    totalPositionInitialMargin: row.totalPositionInitialMargin,
    totalOpenOrderInitialMargin: row.totalOpenOrderInitialMargin,
    availableBalance: row.availableBalance,
    balanceSyncedAt: row.balanceSyncedAt,
    positionMode: row.positionMode,
    updatedAt: row.updatedAt,
  };
}

function maskKey(value: string) { return value.length <= 10 ? `${value.slice(0, 2)}••••${value.slice(-2)}` : `${value.slice(0, 6)}••••••${value.slice(-4)}`; }
function validate(body: { accountId?: string; label?: string; apiKey?: string; secretKey?: string }) {
  if (!body.accountId) return "请选择站内主账户或子账户";
  if (!body.label?.trim() || body.label.trim().length > 40) return "密钥备注需为 1–40 个字符";
  if (!body.apiKey?.trim() || body.apiKey.trim().length < 20 || body.apiKey.trim().length > 128) return "API Key 格式不正确";
  if (!body.secretKey?.trim() || body.secretKey.trim().length < 20 || body.secretKey.trim().length > 128) return "Secret Key 格式不正确";
  return "";
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "sys:account:view");
  if (isResponse(user)) return user;
  const rows = await getDb().select().from(exchangeCredentials).where(eq(exchangeCredentials.ownerEmail, user.email)).orderBy(desc(exchangeCredentials.updatedAt));
  return Response.json({ credentials: rows.map(publicCredential), secureTransport: isSecureCredentialRequest(request), insecureHttpOverride: insecureHttpLiveAllowed() && new URL(request.url).protocol !== "https:", serverLiveTradingAllowed: await liveTradingAllowedByServer() });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "sys:exchange:manage");
  if (isResponse(user)) return user;
  if (!isSecureCredentialRequest(request)) return Response.json({ error: "当前连接不是可信 HTTPS，禁止提交真实 API 密钥", code: "HTTPS_REQUIRED_FOR_CREDENTIALS" }, { status: 426 });
  const body = await request.json() as { accountId?: string; label?: string; apiKey?: string; secretKey?: string };
  const validation = validate(body);
  if (validation) return Response.json({ error: validation }, { status: 400 });
  const db = getDb();
  const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, body.accountId!))).limit(1);
  if (!account || !account.isActive) return Response.json({ error: "站内账户不存在或已停用" }, { status: 404 });
  const apiKey = body.apiKey!.trim();
  const secretKey = body.secretKey!.trim();
  const [encryptedApiKey, encryptedSecret] = await Promise.all([
    encryptCredential(apiKey, credentialContext(user.email, account.accountId, "api-key")),
    encryptCredential(secretKey, credentialContext(user.email, account.accountId, "secret-key")),
  ]);
  const now = new Date();
  const [existing] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.accountId, account.accountId))).limit(1);
  const values = { ownerEmail: user.email, accountId: account.accountId, label: body.label!.trim(), apiKeyCiphertext: encryptedApiKey.ciphertext, apiKeyIv: encryptedApiKey.iv, secretKeyCiphertext: encryptedSecret.ciphertext, secretKeyIv: encryptedSecret.iv, apiKeyMask: maskKey(apiKey), allowedSymbolsJson: "[]", maxOrderNotionalUsdt: existing?.maxOrderNotionalUsdt ?? 20, maxDailyNotionalUsdt: existing?.maxDailyNotionalUsdt ?? 100, maxLeverage: existing?.maxLeverage ?? 5, liveTradingEnabled: false, connectionStatus: "UNVERIFIED" as const, lastVerifiedAt: null, lastError: null, totalWalletBalance: null, totalUnrealizedProfit: null, totalMarginBalance: null, totalPositionInitialMargin: null, totalOpenOrderInitialMargin: null, availableBalance: null, balanceSyncedAt: null, positionMode: null, updatedAt: now };
  const [saved] = existing
    ? await db.update(exchangeCredentials).set(values).where(eq(exchangeCredentials.id, existing.id)).returning()
    : await db.insert(exchangeCredentials).values({ ...values, createdAt: now }).returning();
  await writeAudit(user, existing ? "REPLACE_LIVE_EXCHANGE_CREDENTIAL" : "CREATE_LIVE_EXCHANGE_CREDENTIAL", "exchange_credential", account.accountId, { label: saved.label, apiKeyMask: saved.apiKeyMask });
  return Response.json({ credential: publicCredential(saved) }, { status: existing ? 200 : 201 });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "sys:exchange:manage");
  if (isResponse(user)) return user;
  const body = await request.json() as { id?: number; action?: "VERIFY" | "ENABLE_LIVE" | "DISABLE_LIVE" | "SET_HEDGE" | "SET_ONE_WAY"; confirmation?: string };
  if (!Number.isInteger(body.id) || !body.action) return Response.json({ error: "实盘账户操作参数不完整" }, { status: 400 });
  const db = getDb();
  const [row] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, body.id!), eq(exchangeCredentials.ownerEmail, user.email))).limit(1);
  if (!row) return Response.json({ error: "实盘账户密钥不存在" }, { status: 404 });
  if (body.action === "VERIFY") {
    try {
      const credentials = { apiKey: await decryptCredential(row.apiKeyCiphertext, row.apiKeyIv, credentialContext(user.email, row.accountId, "api-key")), secretKey: await decryptCredential(row.secretKeyCiphertext, row.secretKeyIv, credentialContext(user.email, row.accountId, "secret-key")) };
      const result = await verifyLiveAccount(credentials);
      const now = new Date();
      const readyForLive = result.canTrade && result.tradeTestAccepted;
      const verificationError = !readyForLive ? "密钥未通过 Binance 合约下单权限校验" : null;
      const totalWalletBalance = Number(result.totalWalletBalance);
      const totalUnrealizedProfit = Number(result.totalUnrealizedProfit);
      const totalMarginBalance = Number(result.totalMarginBalance);
      const totalPositionInitialMargin = Number(result.totalPositionInitialMargin);
      const totalOpenOrderInitialMargin = Number(result.totalOpenOrderInitialMargin);
      const availableBalance = Number(result.availableBalance);
      await db.update(exchangeCredentials).set({ connectionStatus: readyForLive ? "VERIFIED" : "FAILED", lastVerifiedAt: now, lastError: verificationError, liveTradingEnabled: readyForLive ? row.liveTradingEnabled : false, totalWalletBalance: Number.isFinite(totalWalletBalance) ? totalWalletBalance : null, totalUnrealizedProfit: Number.isFinite(totalUnrealizedProfit) ? totalUnrealizedProfit : null, totalMarginBalance: Number.isFinite(totalMarginBalance) ? totalMarginBalance : null, totalPositionInitialMargin: Number.isFinite(totalPositionInitialMargin) ? totalPositionInitialMargin : null, totalOpenOrderInitialMargin: Number.isFinite(totalOpenOrderInitialMargin) ? totalOpenOrderInitialMargin : null, availableBalance: Number.isFinite(availableBalance) ? availableBalance : null, balanceSyncedAt: now, positionMode: result.hedgeMode ? "HEDGE" : "ONE_WAY", updatedAt: now }).where(eq(exchangeCredentials.id, row.id));
      await writeAudit(user, "VERIFY_LIVE_EXCHANGE_CREDENTIAL", "exchange_credential", row.accountId, { canTrade: result.canTrade, accountCanTradeReported: result.accountCanTradeReported, tradeTestAccepted: result.tradeTestAccepted, hedgeMode: result.hedgeMode, latencyMs: result.latencyMs, usedWeight: result.usedWeight });
      if (!readyForLive) return Response.json({ error: verificationError, verified: false, ...result }, { status: 409 });
      return Response.json({ verified: true, ...result });
    } catch (error) {
      const message = error instanceof BinanceLiveError ? error.message : "密钥解密或 Binance 校验失败";
      await db.update(exchangeCredentials).set({ connectionStatus: "FAILED", liveTradingEnabled: false, lastError: message, totalWalletBalance: null, totalUnrealizedProfit: null, totalMarginBalance: null, totalPositionInitialMargin: null, totalOpenOrderInitialMargin: null, availableBalance: null, balanceSyncedAt: null, positionMode: null, updatedAt: new Date() }).where(eq(exchangeCredentials.id, row.id));
      return Response.json({ error: message }, { status: error instanceof BinanceLiveError ? Math.min(Math.max(error.status, 400), 599) : 500 });
    }
  }
  if (body.action === "DISABLE_LIVE") {
    await db.update(exchangeCredentials).set({ liveTradingEnabled: false, updatedAt: new Date() }).where(eq(exchangeCredentials.id, row.id));
    await writeAudit(user, "DISABLE_LIVE_TRADING", "exchange_credential", row.accountId, {});
    return Response.json({ ok: true, liveTradingEnabled: false });
  }
  if (body.action === "SET_HEDGE" || body.action === "SET_ONE_WAY") {
    const targetMode = body.action === "SET_HEDGE" ? "HEDGE" : "ONE_WAY";
    const expected = `${targetMode === "HEDGE" ? "HEDGE" : "ONE WAY"} ${row.accountId}`;
    if (body.confirmation !== expected)
      return Response.json({ error: `请输入 ${expected} 确认` }, { status: 400 });
    const [activePosition, unresolvedOrder, runningStrategy] = await Promise.all([
      db.select({ id: livePositions.id }).from(livePositions).where(and(
        eq(livePositions.ownerEmail, user.email),
        eq(livePositions.credentialId, row.id),
        inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
      )).limit(1).then((rows) => rows[0]),
      db.select({ id: liveOrderEvents.id }).from(liveOrderEvents).where(and(
        eq(liveOrderEvents.ownerEmail, user.email),
        eq(liveOrderEvents.credentialId, row.id),
        inArray(liveOrderEvents.status, ["PENDING", "NEW", "PARTIALLY_FILLED", "CANCEL_PENDING", "EXECUTION_UNKNOWN"]),
      )).limit(1).then((rows) => rows[0]),
      db.select({ id: strategies.id }).from(strategies).where(and(
        eq(strategies.ownerEmail, user.email),
        eq(strategies.accountId, row.accountId),
        eq(strategies.status, "RUNNING"),
      )).limit(1).then((rows) => rows[0]),
    ]);
    if (activePosition || unresolvedOrder || runningStrategy)
      return Response.json({
        error: "切换持仓模式前必须暂停该账户策略，并确认没有实盘仓位或未决委托；系统不会为切换模式自动平仓",
        code: "POSITION_MODE_IN_USE",
      }, { status: 409 });
    try {
      const credentials = {
        apiKey: await decryptCredential(row.apiKeyCiphertext, row.apiKeyIv, credentialContext(user.email, row.accountId, "api-key")),
        secretKey: await decryptCredential(row.secretKeyCiphertext, row.secretKeyIv, credentialContext(user.email, row.accountId, "secret-key")),
      };
      const result = await changeLivePositionMode(credentials, targetMode);
      const updatedAt = new Date();
      await db.update(exchangeCredentials).set({
        positionMode: targetMode,
        updatedAt,
      }).where(eq(exchangeCredentials.id, row.id));
      await writeAudit(user, "CHANGE_LIVE_POSITION_MODE", "exchange_credential", row.accountId, {
        previousMode: row.positionMode,
        positionMode: targetMode,
        changed: result.changed,
      });
      return Response.json({
        ok: true,
        ...result,
        positionMode: targetMode,
        credential: publicCredential({
          ...row,
          positionMode: targetMode,
          updatedAt,
        }),
      });
    } catch (error) {
      const message = error instanceof BinanceLiveError ? error.message : "Binance 持仓模式切换失败";
      return Response.json({ error: message }, { status: error instanceof BinanceLiveError ? error.status : 500 });
    }
  }
  if (!isSecureCredentialRequest(request)) return Response.json({ error: "实盘开关只能通过可信 HTTPS 启用" }, { status: 426 });
  if (!await liveTradingAllowedByServer()) return Response.json({ error: "服务器总实盘开关尚未启用，请先在账户管理页开启", code: "SERVER_LIVE_TRADING_DISABLED" }, { status: 423 });
  if (body.confirmation !== `ENABLE LIVE ${row.accountId}`) return Response.json({ error: `请输入 ENABLE LIVE ${row.accountId} 确认` }, { status: 400 });
  if (row.connectionStatus !== "VERIFIED" || row.lastError || !row.lastVerifiedAt) return Response.json({ error: "请先校验密钥，确认 Binance 合约下单权限正常" }, { status: 409 });
  await db.update(exchangeCredentials).set({ liveTradingEnabled: true, updatedAt: new Date() }).where(eq(exchangeCredentials.id, row.id));
  await writeAudit(user, "ENABLE_LIVE_TRADING", "exchange_credential", row.accountId, { availabilityOnly: true });
  return Response.json({ ok: true, liveTradingEnabled: true });
}

export async function DELETE(request: Request) {
  const user = await requirePermission(request, "sys:exchange:manage");
  if (isResponse(user)) return user;
  const body = await request.json() as { id?: number; confirmation?: string };
  const db = getDb();
  const [row] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, body.id ?? -1), eq(exchangeCredentials.ownerEmail, user.email))).limit(1);
  if (!row) return Response.json({ error: "实盘账户密钥不存在" }, { status: 404 });
  if (body.confirmation !== `DELETE ${row.accountId}`) return Response.json({ error: `请输入 DELETE ${row.accountId} 确认` }, { status: 400 });
  const [activePosition, unresolvedOrder, runningStrategy] = await Promise.all([
    db
      .select({ id: livePositions.id })
      .from(livePositions)
      .where(and(
        eq(livePositions.ownerEmail, user.email),
        eq(livePositions.credentialId, row.id),
        inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
      ))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({ id: liveOrderEvents.id })
      .from(liveOrderEvents)
      .where(and(
        eq(liveOrderEvents.ownerEmail, user.email),
        eq(liveOrderEvents.credentialId, row.id),
        inArray(liveOrderEvents.status, ["PENDING", "NEW", "PARTIALLY_FILLED", "CANCEL_PENDING", "EXECUTION_UNKNOWN"]),
      ))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({ id: strategies.id })
      .from(strategies)
      .where(and(
        eq(strategies.ownerEmail, user.email),
        eq(strategies.accountId, row.accountId),
        eq(strategies.status, "RUNNING"),
      ))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (activePosition || unresolvedOrder || runningStrategy)
    return Response.json(
      {
        error:
          "该密钥仍关联运行中策略、未决委托或实盘仓位；请先暂停策略并完成委托、仓位处理，避免删除后无法平仓或对账",
        code: "EXCHANGE_CREDENTIAL_IN_USE",
      },
      { status: 409 },
    );
  await db.delete(exchangeCredentials).where(eq(exchangeCredentials.id, row.id));
  await writeAudit(user, "DELETE_LIVE_EXCHANGE_CREDENTIAL", "exchange_credential", row.accountId, { apiKeyMask: row.apiKeyMask });
  return Response.json({ ok: true });
}
