export type CredentialHealth = "MISSING" | "UNVERIFIED" | "HEALTHY" | "FAILED" | "STALE";

export type TradeReadiness = {
  mode: "LIVE";
  liveReady: boolean;
  credentialState: CredentialHealth;
  blockers: string[];
  lastCheckedAt: Date | null;
};

type AccountReadinessInput = {
  accountType: "MAIN" | "STRATEGY";
  isActive: boolean;
};

type CredentialReadinessInput = {
  connectionStatus: "UNVERIFIED" | "VERIFIED" | "FAILED";
  liveTradingEnabled: boolean;
  positionMode?: "ONE_WAY" | "HEDGE" | null;
  lastVerifiedAt?: Date | string | number | null;
  lastError?: string | null;
} | null | undefined;

// “陈旧”只用于提示。真实下单使用账户管理最近一次校验保存的持仓模式，
// 避免在价格敏感路径重复发送账户查询和测试订单。
export const CREDENTIAL_HEALTH_STALE_MS = 24 * 60 * 60 * 1000;

export function getTradeReadiness(account: AccountReadinessInput, credential: CredentialReadinessInput, serverLiveTradingAllowed: boolean, now = Date.now()): TradeReadiness {
  const lastCheckedAt = credential?.lastVerifiedAt ? new Date(credential.lastVerifiedAt) : null;
  const stale = Boolean(lastCheckedAt && now - lastCheckedAt.getTime() > CREDENTIAL_HEALTH_STALE_MS);
  const credentialState: CredentialHealth = !credential
    ? "MISSING"
    : credential.connectionStatus === "FAILED" || Boolean(credential.lastError)
      ? "FAILED"
      : credential.connectionStatus !== "VERIFIED"
        ? "UNVERIFIED"
        : stale ? "STALE" : "HEALTHY";

  const commonBlockers = [
    ...(!account.isActive ? ["账户已停用"] : []),
    ...(account.accountType === "MAIN" ? ["主账户禁止下单"] : []),
  ];
  const liveBlockers = [
    ...commonBlockers,
    ...(!credential ? ["未配置 Binance API Key"] : []),
    ...(credentialState === "UNVERIFIED" ? ["Binance API Key 尚未校验"] : []),
    ...(credentialState === "FAILED" ? [credential?.lastError || "Binance API Key 校验失败"] : []),
    ...(credential?.connectionStatus === "VERIFIED" && !credential.positionMode ? ["Binance 持仓模式尚未同步，请重新校验账户"] : []),
    ...(!credential?.liveTradingEnabled ? ["账户实盘授权未启用"] : []),
    ...(!serverLiveTradingAllowed ? ["服务器实盘总开关未启用"] : []),
  ];

  return {
    mode: "LIVE",
    liveReady: liveBlockers.length === 0,
    credentialState,
    blockers: liveBlockers,
    lastCheckedAt,
  };
}
