import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  challengeInstances,
  paperAccounts,
  spotWhitelistSymbols,
  spotWhitelistVersions,
  exchangeCredentials,
  tradingAccounts,
} from "../../../../db/schema";
import { isResponse, requirePermission } from "../shared";
import { decryptCredential, credentialContext } from "../../../../lib/credential-vault";
import { getBinanceSpotAccount } from "../../../../lib/binance-spot-live";
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
  return Response.json({
    challenges,
    whitelistVersions: versions.map((version) => ({
      ...version,
      symbols: symbols.filter((symbol) => symbol.versionId === version.id),
    })),
    capitals: SPOT_CHALLENGE_CAPITALS,
    defaults: SPOT_CHALLENGE_DEFAULTS,
    spotAccounts: accounts.map((account) => {
      const credential = credentials.find((item) => item.accountId === account.accountId);
      return credential ? { accountId: account.accountId, name: account.name, credentialId: credential.id, label: credential.label, apiKeyMask: credential.apiKeyMask, lastVerifiedAt: credential.lastVerifiedAt } : null;
    }).filter((account): account is { accountId: string; name: string; credentialId: number; label: string; apiKeyMask: string; lastVerifiedAt: Date | null } => account !== null),
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
  if (!Number.isInteger(id) || id <= 0 || !["START", "REDUCE_ONLY", "CANCEL"].includes(String(action))) {
    return Response.json({ error: "挑战操作无效" }, { status: 400 });
  }
  const current = await getDb().select().from(challengeInstances).where(and(eq(challengeInstances.id, id), eq(challengeInstances.ownerEmail, user.email))).limit(1);
  if (!current.length) return Response.json({ error: "挑战实例不存在" }, { status: 404 });
  const challenge = current[0];
  const now = new Date();
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
