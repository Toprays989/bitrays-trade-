import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { exchangeCredentials } from "../db/schema";
import { getBinanceLiveAccountBalance } from "./binance-usdm-live";
import {
  credentialContext,
  decryptCredential,
} from "./credential-vault";

type CredentialRow = typeof exchangeCredentials.$inferSelect;

export type LiveCredentialBalanceRefreshBatch = {
  attempted: number;
  completed: number;
  failed: number;
  oldestSyncedAt: Date | null;
  latestSyncedAt: Date | null;
  failures: Array<{
    credentialId: number;
    accountId: string;
    message: string;
  }>;
};

async function executeLiveCredentialBalanceRefresh(credential: CredentialRow) {
  const [apiKey, secretKey] = await Promise.all([
    decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(
        credential.ownerEmail,
        credential.accountId,
        "api-key",
      ),
    ),
    decryptCredential(
      credential.secretKeyCiphertext,
      credential.secretKeyIv,
      credentialContext(
        credential.ownerEmail,
        credential.accountId,
        "secret-key",
      ),
    ),
  ]);
  const result = await getBinanceLiveAccountBalance({
    apiKey,
    secretKey,
  });
  if (
    !Number.isFinite(result.totalWalletBalance) ||
    !Number.isFinite(result.totalUnrealizedProfit) ||
    !Number.isFinite(result.totalMarginBalance) ||
    !Number.isFinite(result.totalPositionInitialMargin) ||
    !Number.isFinite(result.totalOpenOrderInitialMargin) ||
    !Number.isFinite(result.availableBalance)
  )
    throw new Error("Binance 返回的账户余额无效");
  const syncedAt = new Date();
  await getDb()
    .update(exchangeCredentials)
    .set({
      totalWalletBalance: result.totalWalletBalance,
      totalUnrealizedProfit: result.totalUnrealizedProfit,
      totalMarginBalance: result.totalMarginBalance,
      totalPositionInitialMargin: result.totalPositionInitialMargin,
      totalOpenOrderInitialMargin: result.totalOpenOrderInitialMargin,
      availableBalance: result.availableBalance,
      balanceSyncedAt: syncedAt,
      updatedAt: syncedAt,
    })
    .where(eq(exchangeCredentials.id, credential.id));
  return {
    totalWalletBalance: result.totalWalletBalance,
    totalUnrealizedProfit: result.totalUnrealizedProfit,
    totalMarginBalance: result.totalMarginBalance,
    totalPositionInitialMargin: result.totalPositionInitialMargin,
    totalOpenOrderInitialMargin: result.totalOpenOrderInitialMargin,
    availableBalance: result.availableBalance,
    syncedAt,
  };
}

async function refreshLiveCredentialBalanceForAudit(
  credential: CredentialRow,
) {
  // The account-audit runner already serializes this route. Do not retain a
  // signed-request Promise globally across Worker request contexts.
  return executeLiveCredentialBalanceRefresh(credential);
}

/**
 * Account audit must only report success after every Binance account snapshot
 * has been validated and committed. Keep the concurrency deliberately small:
 * account state is correctness data, not a high-frequency market-data path.
 */
export async function refreshLiveCredentialBalances(
  credentials: CredentialRow[],
  concurrency = 2,
): Promise<LiveCredentialBalanceRefreshBatch> {
  const results: Array<{
    credential: CredentialRow;
    syncedAt?: Date;
    error?: unknown;
  }> = new Array(credentials.length);
  let cursor = 0;
  const workerCount = Math.min(
    credentials.length,
    Math.max(1, Math.trunc(concurrency) || 1),
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < credentials.length) {
      const index = cursor;
      cursor += 1;
      const credential = credentials[index];
      try {
        const refreshed = await refreshLiveCredentialBalanceForAudit(credential);
        results[index] = { credential, syncedAt: refreshed.syncedAt };
      } catch (error) {
        results[index] = { credential, error };
      }
    }
  });
  await Promise.all(workers);

  const syncedAtValues = results
    .map((result) => result?.syncedAt)
    .filter((value): value is Date => value instanceof Date);
  const failures = results
    .filter((result) => result?.error)
    .map((result) => ({
      credentialId: result.credential.id,
      accountId: result.credential.accountId,
      message: result.error instanceof Error
        ? result.error.message.slice(0, 180)
        : "Binance 账户资产同步失败",
    }));
  return {
    attempted: credentials.length,
    completed: syncedAtValues.length,
    failed: failures.length,
    oldestSyncedAt: syncedAtValues.length
      ? new Date(Math.min(...syncedAtValues.map((value) => value.getTime())))
      : null,
    latestSyncedAt: syncedAtValues.length
      ? new Date(Math.max(...syncedAtValues.map((value) => value.getTime())))
      : null,
    failures,
  };
}
