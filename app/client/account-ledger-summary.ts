import type {
  ExchangeCredential,
  TradingAccount,
} from "./workspace-model.ts";
import { accountFundingSnapshot } from "../../lib/account-funding-snapshot.ts";

export type AccountLedgerSummary = {
  accountLabel: string;
  accountCount: number;
  syncedAccountCount: number;
  walletBalance: number;
  marginBalance: number;
  availableBalance: number;
  hasBalanceData: boolean;
  balanceComplete: boolean;
  positionInitialMargin: number;
  openOrderInitialMargin: number;
  unrealizedPnl: number;
  openPositions: number;
  oldestBalanceSyncedAt: string | number | null;
};

export function buildAccountLedgerSummary(
  accounts: TradingAccount[],
  credentials: ExchangeCredential[],
  accountFilter: string,
  nowMs = Date.now(),
): AccountLedgerSummary {
  const selected = accounts.filter(
    (account) =>
      account.accountType === "STRATEGY" &&
      account.executionMode === "LIVE" &&
      (accountFilter === "ALL" || account.accountId === accountFilter),
  );
  const selectedAccountIds = new Set(
    selected.map((account) => account.accountId),
  );
  const latestCredentialByAccount = new Map<
    string,
    ExchangeCredential
  >();
  for (const credential of credentials) {
    if (!selectedAccountIds.has(credential.accountId)) continue;
    const current = latestCredentialByAccount.get(credential.accountId);
    const currentTime = current?.balanceSyncedAt
      ? new Date(current.balanceSyncedAt).getTime()
      : 0;
    const candidateTime = credential.balanceSyncedAt
      ? new Date(credential.balanceSyncedAt).getTime()
      : 0;
    if (!current || candidateTime >= currentTime) {
      latestCredentialByAccount.set(credential.accountId, credential);
    }
  }

  const balances = selected
    .map((account) => latestCredentialByAccount.get(account.accountId))
    .filter(
      (
        credential,
      ): credential is ExchangeCredential =>
        Boolean(credential && accountFundingSnapshot(credential, nowMs).fresh),
    );
  const syncTimes = balances
    .map((credential) =>
      credential.balanceSyncedAt
        ? new Date(credential.balanceSyncedAt).getTime()
        : Number.NaN,
    )
    .filter(Number.isFinite);

  return {
    accountLabel:
      accountFilter === "ALL"
        ? "全部实盘交易账户"
        : selected[0]?.name
          ? `${selected[0].accountId} · ${selected[0].name}`
          : accountFilter,
    accountCount: selected.length,
    syncedAccountCount: balances.length,
    hasBalanceData: balances.length > 0,
    walletBalance: balances.reduce(
      (sum, item) => sum + accountFundingSnapshot(item, nowMs).walletBalanceUsdt!,
      0,
    ),
    marginBalance: balances.reduce(
      (sum, item) => sum + accountFundingSnapshot(item, nowMs).marginEquityUsdt!,
      0,
    ),
    availableBalance: balances.reduce(
      (sum, item) => sum + accountFundingSnapshot(item, nowMs).availableToOpenUsdt!,
      0,
    ),
    balanceComplete:
      selected.length > 0 && balances.length === selected.length,
    positionInitialMargin: balances.reduce(
      (sum, item) => sum + accountFundingSnapshot(item, nowMs).positionInitialMarginUsdt!,
      0,
    ),
    openOrderInitialMargin: balances.reduce(
      (sum, item) => sum + accountFundingSnapshot(item, nowMs).openOrderInitialMarginUsdt!,
      0,
    ),
    unrealizedPnl: balances.reduce(
      (sum, item) => sum + accountFundingSnapshot(item, nowMs).unrealizedPnlUsdt!,
      0,
    ),
    openPositions: selected.reduce(
      (sum, account) => sum + account.stats.openPositions,
      0,
    ),
    oldestBalanceSyncedAt:
      syncTimes.length === selected.length && syncTimes.length > 0
        ? Math.min(...syncTimes)
        : null,
  };
}
