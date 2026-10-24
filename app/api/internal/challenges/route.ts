import { env } from "cloudflare:workers";
import { and, eq, inArray, lte } from "drizzle-orm";
import { getDb } from "../../../../db";
import { challengeInstances, challengeOrders, challengeRiskSnapshots, exchangeCredentials, paperAccounts, spotWhitelistSymbols } from "../../../../db/schema";
import { decryptCredential, credentialContext } from "../../../../lib/credential-vault";
import { cancelBinanceSpotOrder, getBinanceSpotAccount, getBinanceSpotKlines, getBinanceSpotOpenOrders, getBinanceSpotTicker24h, getBinanceSpotTickerPrice } from "../../../../lib/binance-spot-live";
import { evaluateSpotChallengeRisk } from "../../../../lib/spot-challenge-risk";
import { readSpotAvailableUsdt } from "../../../../lib/spot-account-capital";
import { planSpotChallengeLongEntry } from "../../../../lib/spot-challenge-strategy";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = (env as unknown as { NQ_INTERNAL_RISK_TOKEN?: string }).NQ_INTERNAL_RISK_TOKEN ?? "";
  return expected.length >= 32 && request.headers.get("authorization") === `Bearer ${expected}`;
}

async function submitAutomaticOrder(input: { challengeId: number; symbol: string; side: "BUY" | "SELL"; quantity?: number; quoteOrderQty?: number; clientOrderId: string }) {
  const base = (env as unknown as { NQ_PUBLIC_APP_URL?: string }).NQ_PUBLIC_APP_URL || "http://127.0.0.1:3000";
  const token = (env as unknown as { NQ_INTERNAL_RISK_TOKEN?: string }).NQ_INTERNAL_RISK_TOKEN || "";
  const response = await fetch(`${base.replace(/\/$/, "")}/api/internal/challenges/orders`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
  return { ok: response.ok, payload: await response.json().catch(() => ({})) };
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
      const filledBuys = await db.select().from(challengeOrders).where(and(eq(challengeOrders.challengeId, challenge.id), eq(challengeOrders.side, "BUY"), eq(challengeOrders.status, "FILLED"))).limit(100);
      const automaticExits: Array<Record<string, unknown>> = [];
      for (const order of filledBuys) {
        const entry = Number(order.averagePrice);
        const quantity = Number(order.executedQuantity || order.quantity);
        if (!(entry > 0) || !(quantity > 0)) continue;
        const ticker = await getBinanceSpotTicker24h(order.symbol).catch(() => null);
        const price = ticker?.lastPrice || 0;
        if (!(price > 0)) continue;
        const takeProfit = price >= entry * 1.02;
        const stopLoss = price <= entry * 0.99;
        if (!takeProfit && !stopLoss) continue;
        const result = await submitAutomaticOrder({ challengeId: challenge.id, symbol: order.symbol, side: "SELL", quantity, clientOrderId: `challenge-${challenge.id}-exit-${order.id}-${takeProfit ? "tp" : "sl"}` });
        automaticExits.push({ symbol: order.symbol, reason: takeProfit ? "TAKE_PROFIT" : "STOP_LOSS", result });
      }
      if (challenge.accountId.startsWith("PAPER-")) {
        const [paper] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.ownerEmail, challenge.ownerEmail), eq(paperAccounts.accountId, challenge.accountId))).limit(1);
        if (!paper) throw new Error("PAPER 虚拟账户不存在");
        const now = new Date();
        const equityUsdt = paper.balanceUsdt;
        const netPnlUsdt = equityUsdt - challenge.capitalUsdt;
        const status = equityUsdt >= challenge.capitalUsdt * 1.12 ? "SUCCESS_PENDING_CLEAR" : equityUsdt <= challenge.capitalUsdt * 0.97 ? "FAILURE_PENDING_CLEAR" : challenge.status;
        await db.insert(challengeRiskSnapshots).values({ challengeId: challenge.id, equityUsdt, netPnlUsdt, riskState: status, metricsJson: JSON.stringify({ environment: "PAPER", source: "paper_accounts" }), createdAt: now });
        await db.update(challengeInstances).set({ status, equityUsdt, netPnlUsdt, updatedAt: now }).where(eq(challengeInstances.id, challenge.id));
        const automaticOrders: Array<Record<string, unknown>> = [];
        if (["RUNNING", "CAUTION"].includes(status)) {
          const btc = await getBinanceSpotTicker24h("BTCUSDT").catch(() => null);
          const whitelist = await db.select().from(spotWhitelistSymbols).where(and(eq(spotWhitelistSymbols.versionId, challenge.whitelistVersionId), eq(spotWhitelistSymbols.eligible, true), eq(spotWhitelistSymbols.operatorSelected, true)));
          for (const row of whitelist.slice(0, 20)) {
            const existing = await db.select({ id: challengeOrders.id }).from(challengeOrders).where(and(eq(challengeOrders.challengeId, challenge.id), eq(challengeOrders.symbol, row.symbol), inArray(challengeOrders.status, ["PENDING", "NEW", "PARTIALLY_FILLED", "FILLED"]))).limit(1);
            if (existing.length) continue;
            const ticker = await getBinanceSpotTicker24h(row.symbol).catch(() => null);
            if (!ticker) continue;
            const weekly = await getBinanceSpotKlines(row.symbol, "1w", 52).catch(() => []);
            if (!weekly.length) continue;
            const signal = planSpotChallengeLongEntry({ capitalUsdt: challenge.capitalUsdt, riskUsedPercent: 0, price: ticker.lastPrice, dayHigh: ticker.highPrice, dayLow: ticker.lowPrice, weekHigh: Math.max(...weekly.map((item) => item.high)), weekLow: Math.min(...weekly.map((item) => item.low)), btcChangePercent: btc?.priceChangePercent ?? 0 });
            if (signal.action !== "BUY") continue;
            const result = await submitAutomaticOrder({ challengeId: challenge.id, symbol: row.symbol, side: "BUY", quoteOrderQty: signal.quoteOrderUsdt, clientOrderId: `challenge-${challenge.id}-auto-${Date.now()}-${row.symbol}` });
            automaticOrders.push({ symbol: row.symbol, signal, result });
            if (automaticOrders.length >= 2) break;
          }
        }
        results.push({ challengeId: challenge.id, environment: "PAPER", status, equityUsdt, automaticOrders, automaticExits });
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
      // Challenge equity is ring-fenced to the challenge capital. Never use
      // the whole Spot wallet here: an account can contain unrelated USDT or
      // assets, and counting them would make a 100 USDT challenge instantly
      // pass as soon as the account holds 120 USDT.
      const filledChallengeOrders = await db.select().from(challengeOrders).where(and(eq(challengeOrders.challengeId, challenge.id), inArray(challengeOrders.status, ["FILLED", "PARTIALLY_FILLED"]))).limit(200);
      let challengeCash = challenge.capitalUsdt;
      const challengeQuantities = new Map<string, number>();
      const challengeCost = new Map<string, number>();
      for (const order of filledChallengeOrders) {
        const quantity = Number(order.executedQuantity || order.quantity || 0);
        const price = Number(order.averagePrice || 0);
        if (!(quantity > 0) || !(price > 0)) continue;
        const fee = Number(order.feeUsdt || 0);
        const notional = quantity * price;
        const current = challengeQuantities.get(order.symbol) || 0;
        const currentCost = challengeCost.get(order.symbol) || 0;
        if (order.side === "BUY") {
          challengeCash -= notional + fee;
          challengeQuantities.set(order.symbol, current + quantity);
          challengeCost.set(order.symbol, currentCost + notional + fee);
        } else {
          challengeCash += notional - fee;
          challengeQuantities.set(order.symbol, Math.max(0, current - quantity));
          challengeCost.set(order.symbol, Math.max(0, currentCost - (current > 0 ? (currentCost / current) * quantity : notional) - fee));
        }
      }
      const positions: Array<{ symbol: string; notionalUsdt: number; pressureLossPercent: number; correlationGroup: string }> = [];
      let equityUsdt = challengeCash;
      for (const [symbol, quantity] of challengeQuantities) {
        if (!(quantity > 0)) continue;
        if (!allowedSymbols.has(symbol)) continue;
        const price = await getBinanceSpotTickerPrice(symbol);
        const notionalUsdt = quantity * price;
        equityUsdt += notionalUsdt;
        positions.push({ symbol, notionalUsdt, pressureLossPercent: 10, correlationGroup: symbol.startsWith("BTC") || symbol.startsWith("ETH") ? "majors" : symbol.replace(/USDT$/, "") });
      }
      const pendingOrders = await db.select().from(challengeOrders).where(and(eq(challengeOrders.challengeId, challenge.id), inArray(challengeOrders.status, ["PENDING", "NEW", "PARTIALLY_FILLED"]))).then((orders) => orders.filter((order) => allowedSymbols.has(order.symbol)).map((order) => ({ symbol: order.symbol, reservedNotionalUsdt: Number(order.reservedNotionalUsdt || 0), pressureLossPercent: 10, correlationGroup: order.symbol.startsWith("BTC") || order.symbol.startsWith("ETH") ? "majors" : order.symbol.replace(/USDT$/, "") })));
      const risk = evaluateSpotChallengeRisk({ capitalUsdt: challenge.capitalUsdt, equityUsdt, positions, pendingOrders, websocketAgeMs: 0 });
      const status = challenge.status === "REDUCE_ONLY" && !["SUCCESS_PENDING_CLEAR", "FAILURE_PENDING_CLEAR"].includes(risk.status) ? "REDUCE_ONLY" : risk.status;
      await db.insert(challengeRiskSnapshots).values({ challengeId: challenge.id, equityUsdt, netPnlUsdt: risk.netPnlUsdt, successProbability: risk.successProbability, failureProbability: risk.failureProbability, stressFailureProbability: risk.stressFailureProbability, pressureLossUsdt: risk.pressureLossUsdt, var95Usdt: risk.pressureLossUsdt, riskState: status, metricsJson: JSON.stringify({ positions, pendingOrders, reasons: risk.reasons }), createdAt: now });
      await db.update(challengeInstances).set({ status, equityUsdt, netPnlUsdt: risk.netPnlUsdt, riskUsedPercent: risk.riskUsedPercent, successProbability: risk.successProbability, failureProbability: risk.failureProbability, stressFailureProbability: risk.stressFailureProbability, updatedAt: now }).where(eq(challengeInstances.id, challenge.id));
      const automaticOrders: Array<Record<string, unknown>> = [];
      if (["RUNNING", "CAUTION"].includes(status)) {
        const btc = await getBinanceSpotTicker24h("BTCUSDT").catch(() => null);
        for (const row of whitelist.slice(0, 20)) {
          const existing = await db.select({ id: challengeOrders.id }).from(challengeOrders).where(and(eq(challengeOrders.challengeId, challenge.id), eq(challengeOrders.symbol, row.symbol), inArray(challengeOrders.status, ["PENDING", "NEW", "PARTIALLY_FILLED", "FILLED"]))).limit(1);
          if (existing.length) continue;
          const ticker = await getBinanceSpotTicker24h(row.symbol).catch(() => null);
          if (!ticker) continue;
          const weekly = await getBinanceSpotKlines(row.symbol, "1w", 52).catch(() => []);
          if (!weekly.length) continue;
          const signal = planSpotChallengeLongEntry({ capitalUsdt: challenge.capitalUsdt, riskUsedPercent: risk.riskUsedPercent, price: ticker.lastPrice, dayHigh: ticker.highPrice, dayLow: ticker.lowPrice, weekHigh: Math.max(...weekly.map((item) => item.high)), weekLow: Math.min(...weekly.map((item) => item.low)), btcChangePercent: btc?.priceChangePercent ?? 0 });
          if (signal.action !== "BUY") continue;
          const result = await submitAutomaticOrder({ challengeId: challenge.id, symbol: row.symbol, side: "BUY", quoteOrderQty: signal.quoteOrderUsdt, clientOrderId: `challenge-${challenge.id}-auto-${Date.now()}-${row.symbol}` });
          automaticOrders.push({ symbol: row.symbol, signal, result });
          if (automaticOrders.length >= 2) break;
        }
      }
      results.push({ challengeId: challenge.id, status, equityUsdt, riskUsedPercent: risk.riskUsedPercent, successProbability: risk.successProbability, failureProbability: risk.failureProbability, automaticOrders, automaticExits });
    } catch (error) {
      results.push({ challengeId: challenge.id, status: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return Response.json({ ok: true, processed: results.length, results });
}
