/**
 * 按账户权益比例计算策略保证金容量。
 * availableBalance 是交易所当前可用保证金；committedMargin 是现有仓位和挂单占用。
 * 两者相加用于近似还原下单前账户权益，避免持仓越多时容量基数被重复压缩。
 *
 * @param {{
 *   availableBalance: number,
 *   committedMargin: number,
 *   equityCommittedMargin?: number,
 *   requiredMargin: number,
 *   maxUsagePercent: number,
 * }} input
 */
export function calculateStrategyMarginCapacity(input) {
  const availableBalance = Math.max(Number(input.availableBalance) || 0, 0);
  const committedMargin = Math.max(Number(input.committedMargin) || 0, 0);
  const equityCommittedMargin = Math.max(
    Number(input.equityCommittedMargin ?? input.committedMargin) || 0,
    0,
  );
  const requiredMargin = Math.max(Number(input.requiredMargin) || 0, 0);
  const maxUsagePercent = Math.min(
    Math.max(Number(input.maxUsagePercent) || 0, 0),
    100,
  );
  const estimatedAccountEquityUsdt =
    availableBalance + equityCommittedMargin;
  const strategyMarginLimitUsdt =
    estimatedAccountEquityUsdt * maxUsagePercent / 100;
  const projectedMarginUsdt = committedMargin + requiredMargin;
  const projectedMarginUsagePercent =
    estimatedAccountEquityUsdt > 0
      ? projectedMarginUsdt / estimatedAccountEquityUsdt * 100
      : Number.POSITIVE_INFINITY;

  return {
    estimatedAccountEquityUsdt,
    equityCommittedMargin,
    strategyMarginLimitUsdt,
    projectedMarginUsdt,
    projectedMarginUsagePercent,
    allowed:
      estimatedAccountEquityUsdt > 0 &&
      projectedMarginUsdt <= strategyMarginLimitUsdt + 1e-8,
  };
}
