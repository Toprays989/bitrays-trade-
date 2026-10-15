import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { exchangeCredentials } from "../../../../db/schema";
import {
  ensureFreshBinanceContractPool,
  synchronizeBinanceContractMaximumLeverages,
} from "../../../../lib/contract-pool-sync";
import {
  credentialContext,
  decryptCredential,
} from "../../../../lib/credential-vault";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const configured = (
    env as unknown as { NQ_INTERNAL_LIQUIDATION_TOKEN?: string }
  ).NQ_INTERNAL_LIQUIDATION_TOKEN ?? "";
  return (
    configured.length >= 32 &&
    request.headers.get("authorization") === `Bearer ${configured}`
  );
}

/**
 * Independent contract metadata refresh entrypoint.
 * Strategy, order and protection routes must only read the completed cache.
 */
export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "内部合约数据凭据无效" }, { status: 401 });
  try {
    const result = await ensureFreshBinanceContractPool();
    const credentialRows = await getDb()
      .select()
      .from(exchangeCredentials)
      .where(and(
        eq(exchangeCredentials.connectionStatus, "VERIFIED"),
        eq(exchangeCredentials.liveTradingEnabled, true),
      ))
      .orderBy(desc(exchangeCredentials.updatedAt));
    const credentials = await Promise.all(
      credentialRows.map(async (row) => ({
        apiKey: await decryptCredential(
          row.apiKeyCiphertext,
          row.apiKeyIv,
          credentialContext(row.ownerEmail, row.accountId, "api-key"),
        ),
        secretKey: await decryptCredential(
          row.secretKeyCiphertext,
          row.secretKeyIv,
          credentialContext(row.ownerEmail, row.accountId, "secret-key"),
        ),
      })),
    );
    const leverage = await synchronizeBinanceContractMaximumLeverages(credentials);
    return Response.json({
      ok: true,
      plane: "CONTRACT_DATA",
      ...result,
      leverage,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        plane: "CONTRACT_DATA",
        error: error instanceof Error ? error.message : "合约数据同步失败",
      },
      { status: 503 },
    );
  }
}
