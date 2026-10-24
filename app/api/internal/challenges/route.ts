import { env } from "cloudflare:workers";
import { and, eq, inArray, lte } from "drizzle-orm";
import { getDb } from "../../../../db";
import { challengeInstances, challengeOrders, challengeRiskSnapshots, exchangeCredentials, paperAccounts, spotWhitelistSymbols } from "../../../../db/schema";
import { decryptCredential, credentialContext } from "../../../../lib/credential-vault";
import { cancelBinanceSpotOrder, getBinanceSpotAccount, getBinanceSpotOpenOrders, getBinanceSpotTickerPrice } from "../../../../lib/binance-spot-live";
import { evaluateSpotChallengeRisk } from "../../../../lib/spot-challenge-risk";
import { readSpotAvailableUsdt } from "../../../../lib/spot-account-capital";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = (env as unknown as { NQ_INTERNAL_RISK_TOKEN?: string }).NQ_INTERNAL_RISK_TOKEN ?? "";
  return expected.length >= 32 && request.headers.get("authorization") === `Bearer ${expected}`;
}

async function keysFor(credential: typeof exchangeCredentials.$inferSelect, ownerEmail: string, accountId: string) {
  return {
    apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(ownerEmail, accountId, "api-key")),
    secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(ownerEmail, accountId, "secret-key")),
  };
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "内部挑战 runner 未授权" }, { status: 401 });
  const db = getDb();
  const challenges = await db.select().from(challengeInstances).where(inArray(challengeInstances.status, ["RUNNING", "CAUTION", "PROTECT", "REDUCE_ONLY"])).limit(100);
  const results: Array<Record<string, unknown>> = [];
  for (const challenge of challenges) {
    try {
      if (challenge.accountId.startsWith("PAPER-")) {
        const [paper] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.ownerEmail, challenge.ownerEmail), eq(paperAccounts.accountId, challenge.accountId))).limit(1);
        if (!paper) throw new Error("PAPER 虚拟账户不存在");
        const now = new Date();
        const equityUsdt = paper.balanceUsdt;
        const netPnlUsdt = equityUsdt - challenge.capitalUsdt;
        const status = equityUsdt >= challenge.capitalUsdt * 1.12 ? "SUCCESS_PENDING_CLEAR" : equityUsdt <= challenge.capitalUsdt * 0.97 ? "FAILURE_PENDING_CLEAR" : challenge.status;
        await db.insert(challengeRiskSnapshots).values({ challengeId: challenge.id, equityUsdt, netPnlUsdt, riskState: status, metricsJson: JSON.stringify({ environment: "PAPER", source: "paper_accounts" }), createdAt: now });
        await db.update(challengeInstances).set({ status, equityUsdt, netPnlUsdt, updatedAt: now }).where(eq(challengeInstances.id, challenge.id));
        results.push({ challengeId: challenge.id, environment: "PAPER", status, equityUsdt });
        continue;
      }
      const [credential] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, challenge.credentialId), eq(exchangeCredentials.ownerEmail, challenge.ownerEmail))).limit(1);
      if (!credential || credential.exchange !== "BINANCE_SPOT") throw new Error("挑战凭据不是 Binance Spot");
      const keys = await keysFor(credential, challenge.ownerEmail, challenge.accountId);
      const account = await getBinanceSpotAccount(keys);
      const capital = readSpotAvailableUsdt(account);
      if (!capital.isSpot) throw new Error("挑战凭据返回的账户不是 Spot 账户");
      const now = new Date();
      const expiredOrders = await db.select().from(challengeOrders).where(and(
        eq(challengeOrders.challengeId, challenge.id),
        inArray(challengeOrders.status, ["NEW", "PARTIALLY_FILLED"]),
        lte(challengeOrders.expiresAt, now),
      )).limit(100);
      for (const order of expiredOrders) {
        try {
          await cancelBinanceSpotOrder(keys, order.symbol, order.clientOrderId);
          await db.update(challengeOrders).set({ status: "CANCELED", updatedAt: new Date() }).where(eq(challengeOrders.id, order.id));
        } catch (error) {
          // Keep the order open when cancellation is unknown; the next cycle
          // will reconcile it rather than submitting a duplicate order.
          if (error instanceof Error && error.message) {
            await db.update(challengeOrders).set({ responseJson: JSON.stringify({ cancellationError: error.message }), updatedAt: new Date() }).where(eq(challengeOrders.id, order.id));
          }
        }
      }
      const whitelist = await db.select().from(spotWhitelistSymbols).where(and(eq(spotWhitelistSymbols.versionId, challenge.whitelistVersionId), eq(spotWhitelistSymbols.eligible, true), eq(spotWhitelistSymbols.operatorSelected, true)));
      const allowedSymbols = new Set(whitelist.map((row) => row.symbol));
      const balances = (account.balances || []).map((row) => ({ asset: row.asset.toUpperCase(), quantity: Number(row.free || 0) + Number(row.locked || 0) })).filter((row) => Number.isFinite(row.quantity) && row.quantity > 0);
      const usdt = balances.find((row) => row.asset === "USDT")?.quantity || 0;
      const positions: Array<{ symbol: string; notionalUsdt: number; pressureLossPercent: number; correlationGroup: string }> = [];
      let equityUsdt = usdt;
      for (const balance of balances.filter((row) => row.asset !== "USDT")) {
        const symbol = `${balance.asset}USDT`;
        if (!allowedSymbols.has(symbol)) continue;
        const price = await getBinanceSpotTickerPrice(symbol);
        const notionalUsdt = balance.quantity * price;
        equityUsdt += notionalUsdt;
        positions.push({ symbol, notionalUsdt, pressureLossPercent: 10, correlationGroup: balance.asset === "BTC" || balance.asset === "ETH" ? "majors" : balance.asset });
      }
      const openOrders = await getBinanceSpotOpenOrders(keys);
      const pendingOrders = openOrders.filter((order) => allowedSymbols.has(order.symbol)).map((order) => ({ symbol: order.symbol, reservedNotionalUsdt: Number(order.origQty) * Number(order.price), pressureLossPercent: 10, correlationGroup: order.symbol.startsWith("BTC") || order.symbol.startsWith("ETH") ? "majors" : order.symbol.replace(/USDT$/, "") }));
      const risk = evaluateSpotChallengeRisk({ capitalUsdt: challenge.capitalUsdt, equityUsdt, positions, pendingOrders, websocketAgeMs: 0 });
      const status = challenge.status === "REDUCE_ONLY" && !["SUCCESS_PENDING_CLEAR", "FAILURE_PENDING_CLEAR"].includes(risk.status) ? "REDUCE_ONLY" : risk.status;
      await db.insert(challengeRiskSnapshots).values({ challengeId: challenge.id, equityUsdt, netPnlUsdt: risk.netPnlUsdt, successProbability: risk.successProbability, failureProbability: risk.failureProbability, stressFailureProbability: risk.stressFailureProbability, pressureLossUsdt: risk.pressureLossUsdt, var95Usdt: risk.pressureLossUsdt, riskState: status, metricsJson: JSON.stringify({ positions, pendingOrders, reasons: risk.reasons }), createdAt: now });
      await db.update(challengeInstances).set({ status, equityUsdt, netPnlUsdt: risk.netPnlUsdt, riskUsedPercent: risk.riskUsedPercent, successProbability: risk.successProbability, failureProbability: risk.failureProbability, stressFailureProbability: risk.stressFailureProbability, updatedAt: now }).where(eq(challengeInstances.id, challenge.id));
      results.push({ challengeId: challenge.id, status, equityUsdt, riskUsedPercent: risk.riskUsedPercent });
    } catch (error) {
      results.push({ challengeId: challenge.id, status: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return Response.json({ ok: true, processed: results.length, results });
}
