import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  challengeInstances,
  challengeOrders,
  challengeRiskSnapshots,
  paperAccounts,
  spotWhitelistSymbols,
  spotWhitelistVersions,
  exchangeCredentials,
  tradingAccounts,
} from "../../../../db/schema";
import { isResponse, requirePermission } from "../shared";
import { decryptCredential, credentialContext } from "../../../../lib/credential-vault";
import { cancelBinanceSpotOrder, getBinanceSpotAccount, getBinanceSpotOpenOrders } from "../../../../lib/binance-spot-live";
import { readSpotAvailableUsdt } from "../../../../lib/spot-account-capital";
import {
  SPOT_CHALLENGE_CAPITALS,
  SPOT_CHALLENGE_DEFAULTS,
  challengeRiskConfig,
  challengeThresholds,
} from "../../../../lib/spot-challenge-config";

export const dynamic = "force-dynamic";

function objectBody(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const db = getDb();
  const [challenges, versions, accounts, credentials] = await Promise.all([
    db.select().from(challengeInstances)
      .where(eq(challengeInstances.ownerEmail, user.email))
      .orderBy(desc(challengeInstances.updatedAt))
      .limit(100),
    db.select().from(spotWhitelistVersions)
      .where(eq(spotWhitelistVersions.ownerEmail, user.email))
      .orderBy(desc(spotWhitelistVersions.updatedAt))
      .limit(50),
    db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.isActive, true))),
    db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.exchange, "BINANCE_SPOT"), eq(exchangeCredentials.connectionStatus, "VERIFIED"))),
  ]);
  const versionIds = versions.map((version) => version.id);
  const symbols = versionIds.length
    ? await db.select().from(spotWhitelistSymbols).where(inArray(spotWhitelistSymbols.versionId, versionIds))
    : [];
  const challengeIds = challenges.map((challenge) => challenge.id);
  const snapshots = challengeIds.length
    ? await db.select().from(challengeRiskSnapshots).where(inArray(challengeRiskSnapshots.challengeId, challengeIds)).orderBy(desc(challengeRiskSnapshots.createdAt))
    : [];
  const latestSnapshot = new Map<number, typeof snapshots[number]>();
  for (const snapshot of snapshots) if (!latestSnapshot.has(snapshot.challengeId)) latestSnapshot.set(snapshot.challengeId, snapshot);
  const enrichedChallenges = challenges.map((challenge) => {
    const snapshot = latestSnapshot.get(challenge.id);
    let strategyDiagnostics: unknown[] = [];
    if (snapshot?.metricsJson) {
      try {
        const metrics = JSON.parse(snapshot.metricsJson) as { strategyDiagnostics?: unknown };
        if (Array.isArray(metrics.strategyDiagnostics)) strategyDiagnostics = metrics.strategyDiagnostics;
      } catch {
        strategyDiagnostics = [];
      }
    }
    return { ...challenge, strategyDiagnostics, lastRiskSnapshotAt: snapshot?.createdAt ?? null };
  });
  return Response.json({
    challenges: enrichedChallenges,
    whitelistVersions: versions.map((version) => ({
      ...version,
      symbols: symbols.filter((symbol) => symbol.versionId === version.id),
    })),
    capitals: SPOT_CHALLENGE_CAPITALS,
    defaults: SPOT_CHALLENGE_DEFAULTS,
    spotAccounts: accounts.map((account) => {
      const credential = credentials.find((item) => item.accountId === account.accountId);
      return credential ? { accountId: account.accountId, name: account.name, credentialId: credential.id, label: credential.label, apiKeyMask: credential.apiKeyMask, lastVerifiedAt: credential.lastVerifiedAt, totalWalletBalance: credential.totalWalletBalance, availableBalance: credential.availableBalance } : null;
  }).filter((account): account is { accountId: string; name: string; credentialId: number; label: string; apiKeyMask: string; lastVerifiedAt: Date | null; totalWalletBalance: number | null; availableBalance: number | null } => account !== null),
  });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const body = objectBody(await request.json().catch(() => null));
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const credentialId = Number(body.credentialId);
  const whitelistVersionId = Number(body.whitelistVersionId);
  const capitalUsdt = Number(body.capitalUsdt);
  if (!accountId || !Number.isInteger(credentialId) || !Number.isInteger(whitelistVersionId) || !SPOT_CHALLENGE_CAPITALS.includes(capitalUsdt as never)) {
    return Response.json({ error: "账户、现货密钥、白名单版本或本金档位无效" }, { status: 400 });
  }
  const db = getDb();
  if (/^PAPER-[A-Z0-9_-]{1,20}$/.test(accountId)) {
    const [[paper], [version]] = await Promise.all([
      db.select().from(paperAccounts).where(and(eq(paperAccounts.ownerEmail, user.email), eq(paperAccounts.accountId, accountId))).limit(1),
      db.select().from(spotWhitelistVersions).where(and(eq(spotWhitelistVersions.ownerEmail, user.email), eq(spotWhitelistVersions.id, whitelistVersionId))).limit(1),
    ]);
    if (!paper) return Response.json({ error: "PAPER 虚拟账户不存在" }, { status: 404 });
    if (paper.status !== "ACTIVE") return Response.json({ error: "PAPER 虚拟账户当前不可用" }, { status: 409 });
    if (!version || version.status !== "PUBLISHED") return Response.json({ error: "只能使用已发布的白名单版本" }, { status: 409 });
    const active = await db.select({ id: challengeInstances.id }).from(challengeInstances).where(and(eq(challengeInstances.ownerEmail, user.email), eq(challengeInstances.accountId, accountId), inArray(challengeInstances.status, ["DRAFT", "RUNNING", "CAUTION", "PROTECT", "REDUCE_ONLY", "CLEARING", "SUCCESS_PENDING_CLEAR", "FAILURE_PENDING_CLEAR"]))).limit(1);
    if (active.length) return Response.json({ error: "该 PAPER 账户已有未结束的挑战实例" }, { status: 409 });
    const now = new Date();
    const config = { ...challengeRiskConfig(), thresholds: challengeThresholds(capitalUsdt) };
    const [challenge] = await db.insert(challengeInstances).values({ ownerEmail: user.email, accountId, credentialId: 0, whitelistVersionId, capitalUsdt, feeRateBps: SPOT_CHALLENGE_DEFAULTS.feeRateBps, status: "DRAFT", riskConfigJson: JSON.stringify(config), modelVersion: `${SPOT_CHALLENGE_DEFAULTS.modelVersion}-paper`, createdAt: now, updatedAt: now }).returning();
    return Response.json({ challenge, environment: "PAPER", thresholds: config.thresholds }, { status: 201 });
  }
  const [[account], [credential], [version]] = await Promise.all([
    db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, accountId))).limit(1),
    db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.id, credentialId), eq(exchangeCredentials.accountId, accountId))).limit(1),
    db.select().from(spotWhitelistVersions).where(and(eq(spotWhitelistVersions.ownerEmail, user.email), eq(spotWhitelistVersions.id, whitelistVersionId))).limit(1),
  ]);
  if (!account || !credential || !version) return Response.json({ error: "账户、密钥或白名单版本不存在" }, { status: 404 });
  if (credential.exchange !== "BINANCE_SPOT") return Response.json({ error: "挑战赛必须绑定 Binance Spot 密钥" }, { status: 409 });
  if (version.status !== "PUBLISHED") return Response.json({ error: "只能使用已发布的白名单版本" }, { status: 409 });
  try {
    const liveAccount = await getBinanceSpotAccount({
      apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(user.email, accountId, "api-key")),
      secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(user.email, accountId, "secret-key")),
    });
    const capital = readSpotAvailableUsdt(liveAccount);
    if (!capital.isSpot) return Response.json({ error: "绑定的 Binance 账户不是 Spot 账户" }, { status: 409 });
    if (capital.availableUsdt < capitalUsdt) return Response.json({ error: `现货账户可用 USDT 不足：需要 ${capitalUsdt.toFixed(2)}，当前 ${capital.availableUsdt.toFixed(2)}。请降低挑战本金或补充现货余额` }, { status: 409 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "现货账户余额校验失败" }, { status: 502 });
  }
  const active = await db.select({ id: challengeInstances.id }).from(challengeInstances).where(and(
    eq(challengeInstances.ownerEmail, user.email),
    eq(challengeInstances.accountId, accountId),
    inArray(challengeInstances.status, ["DRAFT", "RUNNING", "CAUTION", "PROTECT", "REDUCE_ONLY", "CLEARING", "SUCCESS_PENDING_CLEAR", "FAILURE_PENDING_CLEAR"]),
  )).limit(1);
  if (active.length) return Response.json({ error: "该账户已有未结束的挑战实例" }, { status: 409 });
  const now = new Date();
  const config = { ...challengeRiskConfig(), thresholds: challengeThresholds(capitalUsdt) };
  const [challenge] = await db.insert(challengeInstances).values({
    ownerEmail: user.email,
    accountId,
    credentialId,
    whitelistVersionId,
    capitalUsdt,
    feeRateBps: SPOT_CHALLENGE_DEFAULTS.feeRateBps,
    status: "DRAFT",
    riskConfigJson: JSON.stringify(config),
    modelVersion: SPOT_CHALLENGE_DEFAULTS.modelVersion,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return Response.json({ challenge, thresholds: config.thresholds }, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const body = objectBody(await request.json().catch(() => null));
  const id = Number(body?.id);
  const action = body?.action;
  if (!Number.isInteger(id) || id <= 0 || !["START", "REDUCE_ONLY", "CANCEL", "EDIT"].includes(String(action))) {
    return Response.json({ error: "挑战操作无效" }, { status: 400 });
  }
  const current = await getDb().select().from(challengeInstances).where(and(eq(challengeInstances.id, id), eq(challengeInstances.ownerEmail, user.email))).limit(1);
  if (!current.length) return Response.json({ error: "挑战实例不存在" }, { status: 404 });
  const challenge = current[0];
  const now = new Date();
  if (action === "EDIT") {
    if (challenge.status !== "DRAFT") return Response.json({ error: "只有草稿挑战可以编辑" }, { status: 409 });
    const capitalUsdt = Number(body?.capitalUsdt);
    if (!Number.isInteger(capitalUsdt) || !SPOT_CHALLENGE_CAPITALS.includes(capitalUsdt as never)) return Response.json({ error: "挑战本金档位无效" }, { status: 400 });
    const config = { ...challengeRiskConfig(), thresholds: challengeThresholds(capitalUsdt) };
    const [updated] = await getDb().update(challengeInstances).set({ capitalUsdt, equityUsdt: null, netPnlUsdt: null, riskConfigJson: JSON.stringify(config), updatedAt: now }).where(eq(challengeInstances.id, id)).returning();
    return Response.json({ challenge: updated });
  }
  if (action === "START" && challenge.status !== "DRAFT") return Response.json({ error: "只有草稿挑战可以启动" }, { status: 409 });
  if (action === "START" && !challenge.accountId.startsWith("PAPER-")) {
    const [credential] = await getDb().select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, challenge.credentialId), eq(exchangeCredentials.ownerEmail, user.email))).limit(1);
    if (!credential || credential.exchange !== "BINANCE_SPOT") return Response.json({ error: "挑战必须绑定已验证的 Binance Spot 密钥" }, { status: 409 });
    try {
      const account = await getBinanceSpotAccount({
        apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(user.email, challenge.accountId, "api-key")),
        secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(user.email, challenge.accountId, "secret-key")),
      });
      const capital = readSpotAvailableUsdt(account);
      if (!capital.isSpot) return Response.json({ error: "绑定的 Binance 账户不是 Spot 账户" }, { status: 409 });
      if (capital.availableUsdt < challenge.capitalUsdt) return Response.json({ error: `现货账户可用 USDT 不足：需要 ${challenge.capitalUsdt.toFixed(2)}，当前 ${capital.availableUsdt.toFixed(2)}` }, { status: 409 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "现货账户校验失败" }, { status: 502 });
    }
  }
  const nextStatus = action === "START" ? "RUNNING" : action === "REDUCE_ONLY" ? "REDUCE_ONLY" : "FAILED";
  const [updated] = await getDb().update(challengeInstances).set({
    status: nextStatus,
    equityUsdt: action === "START" ? challenge.capitalUsdt : challenge.equityUsdt,
    netPnlUsdt: action === "START" ? 0 : challenge.netPnlUsdt,
    startedAt: action === "START" ? now : challenge.startedAt,
    terminalAt: action === "CANCEL" ? now : challenge.terminalAt,
    terminalReason: action === "CANCEL" ? "OPERATOR_CANCELLED" : challenge.terminalReason,
    updatedAt: now,
  }).where(eq(challengeInstances.id, id)).returning();
  return Response.json({ challenge: updated });
}

export async function DELETE(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const body = objectBody(await request.json().catch(() => null));
  const id = Number(body?.id);
  const requestedAccountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if ((!Number.isInteger(id) || id <= 0) && !requestedAccountId) return Response.json({ error: "挑战实例编号无效" }, { status: 400 });
  const db = getDb();
  const [challenge] = await db.select().from(challengeInstances).where(and(eq(challengeInstances.id, id), eq(challengeInstances.ownerEmail, user.email))).limit(1);
  if (!challenge) {
    const accountId = requestedAccountId;
    if (!accountId || accountId.startsWith("PAPER-")) return Response.json({ error: "挑战实例不存在" }, { status: 404 });
    const [credential] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.ownerEmail, user.email), eq(exchangeCredentials.accountId, accountId), eq(exchangeCredentials.exchange, "BINANCE_SPOT"))).limit(1);
    if (!credential) return Response.json({ error: "该账户没有已验证的 Binance Spot 密钥" }, { status: 404 });
    try {
      const keys = { apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(user.email, accountId, "api-key")), secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(user.email, accountId, "secret-key")) };
      const openOrders = await getBinanceSpotOpenOrders(keys);
      const orphaned = openOrders.filter((order) => order.clientOrderId.startsWith("challenge-"));
      for (const order of orphaned) await cancelBinanceSpotOrder(keys, order.symbol, order.clientOrderId);
      const account = await getBinanceSpotAccount(keys);
      const nonZeroAssets = (account.balances || []).map((balance) => ({ asset: balance.asset, free: Number(balance.free), locked: Number(balance.locked) })).filter((balance) => balance.free > 0 || balance.locked > 0);
      const usdt = nonZeroAssets.find((balance) => balance.asset.toUpperCase() === "USDT") || { asset: "USDT", free: 0, locked: 0 };
      return Response.json({ ok: true, released: orphaned.length, accountId, scope: "challenge-client-orders", openOrders: openOrders.length, usdt, nonZeroAssets });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "清理挑战遗留委托失败" }, { status: 502 });
    }
  }
  if (["RUNNING", "CAUTION", "PROTECT", "REDUCE_ONLY", "CLEARING"].includes(challenge.status)) return Response.json({ error: "运行中的挑战必须先结束或完成清算后才能删除" }, { status: 409 });
  if (!challenge.accountId.startsWith("PAPER-")) {
    const [credential] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, challenge.credentialId), eq(exchangeCredentials.ownerEmail, user.email))).limit(1);
    if (!credential || credential.exchange !== "BINANCE_SPOT") return Response.json({ error: "挑战绑定的 Spot 密钥不存在，无法安全释放交易所委托" }, { status: 409 });
    try {
      const keys = { apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(user.email, challenge.accountId, "api-key")), secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(user.email, challenge.accountId, "secret-key")) };
      const orders = await db.select().from(challengeOrders).where(and(eq(challengeOrders.challengeId, id), inArray(challengeOrders.status, ["PENDING", "NEW", "PARTIALLY_FILLED"])));
      for (const order of orders) await cancelBinanceSpotOrder(keys, order.symbol, order.clientOrderId);
      // A deleted challenge can leave an exchange order without a local row only
      // after a previous interrupted cleanup; cancel only our own client-id prefix.
      const openOrders = await getBinanceSpotOpenOrders(keys);
      for (const order of openOrders.filter((order) => order.clientOrderId.startsWith(`challenge-${id}-`))) await cancelBinanceSpotOrder(keys, order.symbol, order.clientOrderId);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? `删除前撤销 Binance 委托失败：${error.message}` : "删除前撤销 Binance 委托失败" }, { status: 502 });
    }
  }
  await db.delete(challengeOrders).where(eq(challengeOrders.challengeId, id));
  await db.delete(challengeRiskSnapshots).where(eq(challengeRiskSnapshots.challengeId, id));
  await db.delete(challengeInstances).where(eq(challengeInstances.id, id));
  return Response.json({ ok: true, id });
}
