export const LIVE_ACCOUNT_FUNDING_MAX_AGE_MS = 90_000;

export type AccountFundingInput = {
  totalWalletBalance?: number | null;
  totalUnrealizedProfit?: number | null;
  totalMarginBalance?: number | null;
  totalPositionInitialMargin?: number | null;
  totalOpenOrderInitialMargin?: number | null;
  availableBalance?: number | null;
  balanceSyncedAt?: Date | string | number | null;
};

export type AccountFundingSnapshot = {
  source: "BINANCE_USDM_ACCOUNT";
  status: "FRESH" | "STALE" | "INCOMPLETE";
  complete: boolean;
  fresh: boolean;
  syncedAt: string | null;
  ageMs: number | null;
  walletBalanceUsdt: number | null;
  unrealizedPnlUsdt: number | null;
  marginEquityUsdt: number | null;
  positionInitialMarginUsdt: number | null;
  openOrderInitialMarginUsdt: number | null;
  availableToOpenUsdt: number | null;
};

/**
 * Automated position sizing is defined as a percentage of account equity.
 * Available balance is a separate execution-capacity boundary and must not be
 * reused as the sizing base, otherwise every open position geometrically
 * shrinks the next approved order before the exchange-capacity check runs.
 */
export function automatedEntryEquitySizingCapitalUsdt(
  snapshot: Pick<
    AccountFundingSnapshot,
    "marginEquityUsdt" | "availableToOpenUsdt"
  >,
) {
  const capital =
    finite(snapshot.marginEquityUsdt) ??
    finite(snapshot.availableToOpenUsdt) ??
    0;
  return Math.max(0, capital);
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestamp(value: AccountFundingInput["balanceSyncedAt"]) {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Binance USDⓈ-M 账户资金的唯一解释口径。
 *
 * 本地策略保证金额度（tradingAccounts.equityLimit）绝不能传入这里：
 * 它是自动交易预算，不是交易所钱包余额、权益或可用余额。
 */
export function accountFundingSnapshot(
  input: AccountFundingInput,
  nowMs = Date.now(),
  maxAgeMs = LIVE_ACCOUNT_FUNDING_MAX_AGE_MS,
): AccountFundingSnapshot {
  const walletBalanceUsdt = finite(input.totalWalletBalance);
  const unrealizedPnlUsdt = finite(input.totalUnrealizedProfit);
  const marginEquityUsdt = finite(input.totalMarginBalance);
  const positionInitialMarginUsdt = finite(input.totalPositionInitialMargin);
  const openOrderInitialMarginUsdt = finite(input.totalOpenOrderInitialMargin);
  const availableToOpenUsdt = finite(input.availableBalance);
  const syncedAtMs = timestamp(input.balanceSyncedAt);
  const complete = [
    walletBalanceUsdt,
    unrealizedPnlUsdt,
    marginEquityUsdt,
    positionInitialMarginUsdt,
    openOrderInitialMarginUsdt,
    availableToOpenUsdt,
  ].every((value) => value !== null);
  const ageMs = syncedAtMs === null ? null : Math.max(0, nowMs - syncedAtMs);
  const fresh = complete && ageMs !== null && ageMs < maxAgeMs;

  return {
    source: "BINANCE_USDM_ACCOUNT",
    status: !complete ? "INCOMPLETE" : fresh ? "FRESH" : "STALE",
    complete,
    fresh,
    syncedAt: syncedAtMs === null ? null : new Date(syncedAtMs).toISOString(),
    ageMs,
    walletBalanceUsdt,
    unrealizedPnlUsdt,
    marginEquityUsdt,
    positionInitialMarginUsdt,
    openOrderInitialMarginUsdt,
    availableToOpenUsdt,
  };
}
