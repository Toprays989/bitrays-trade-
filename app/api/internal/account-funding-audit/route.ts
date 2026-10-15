import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { exchangeCredentials } from "../../../../db/schema";
import { refreshLiveCredentialBalances } from "../../../../lib/account-balance-sync";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const configured = (
    env as unknown as { NQ_INTERNAL_RISK_TOKEN?: string }
  ).NQ_INTERNAL_RISK_TOKEN ?? "";
  return (
    configured.length >= 32 &&
    request.headers.get("authorization") === `Bearer ${configured}`
  );
}

/**
 * Signed Binance account reads are isolated from the five-second position
 * protection route. A slow or failed funding refresh may make this audit
 * runner unhealthy, but it can never delay stop/profit protection.
 */
export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "内部账户核对凭据无效" }, { status: 401 });
  if (
    (env as unknown as { NQ_LIVE_RISK_ALLOWED?: string })
      .NQ_LIVE_RISK_ALLOWED !== "true"
  )
    return Response.json(
      { error: "服务器实盘账户核对进程未开放" },
      { status: 423 },
    );

  const startedAt = Date.now();
  let phase = "select-credentials";
  try {
    const credentials = await getDb()
      .select()
      .from(exchangeCredentials)
      .where(
        and(
          eq(exchangeCredentials.environment, "LIVE"),
          eq(exchangeCredentials.connectionStatus, "VERIFIED"),
          eq(exchangeCredentials.liveTradingEnabled, true),
        ),
      );
    phase = "refresh-balances";
    const balanceRefresh = await refreshLiveCredentialBalances(credentials, 1);
    const durationMs = Date.now() - startedAt;
    const result = {
      ok: balanceRefresh.failed === 0,
      plane: "ACCOUNT_FUNDING_AUDIT",
      phase: "completed",
      balanceRefresh: {
        ...balanceRefresh,
        oldestSyncedAt: balanceRefresh.oldestSyncedAt?.toISOString() ?? null,
        latestSyncedAt: balanceRefresh.latestSyncedAt?.toISOString() ?? null,
      },
      durationMs,
      checkedAt: new Date().toISOString(),
    };
    if (balanceRefresh.failed > 0 || durationMs > 5_000)
      console.warn(JSON.stringify({
        service: "account-funding-audit",
        phase: "completed",
        attempted: balanceRefresh.attempted,
        completed: balanceRefresh.completed,
        failed: balanceRefresh.failed,
        durationMs,
      }));
    return Response.json(result, {
      status: balanceRefresh.failed > 0 ? 503 : 200,
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message.slice(0, 180)
      : "账户资金同步失败";
    console.error(JSON.stringify({
      service: "account-funding-audit",
      phase,
      durationMs: Date.now() - startedAt,
      message,
    }));
    return Response.json({
      ok: false,
      plane: "ACCOUNT_FUNDING_AUDIT",
      phase,
      error: message,
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    }, { status: 503 });
  }
}
