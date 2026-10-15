const EPSILON = 1e-10;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(number, 0) : 0;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * 自动策略的当日保证金活动统计。
 *
 * 该结果只用于运营展示和历史兼容，不再参与拒单、缩量或加仓授权。
 * 正式执行只受单笔策略参数和 Binance 当前可用保证金约束。
 */
export function calculateAutomatedDailyMarginQuota(input) {
  const usedMarginUsdt = positive(input.usedMarginUsdt);
  const configuredLimitMarginUsdt = positive(input.limitMarginUsdt);
  const unrealizedPnlUsdt = finite(input.unrealizedPnlUsdt);
  const dynamicLimitMarginUsdt = Math.max(
    configuredLimitMarginUsdt + unrealizedPnlUsdt,
    0,
  );
  const remainingMarginUsdt = Math.max(
    dynamicLimitMarginUsdt - usedMarginUsdt,
    0,
  );
  return {
    usedMarginUsdt,
    configuredLimitMarginUsdt,
    unrealizedPnlUsdt,
    dynamicLimitMarginUsdt,
    // Compatibility name: all execution callers must use the effective,
    // dynamic boundary rather than silently falling back to the configured
    // amount.
    limitMarginUsdt: dynamicLimitMarginUsdt,
    remainingMarginUsdt,
    exhausted: remainingMarginUsdt <= EPSILON,
    enforced: false,
  };
}

/**
 * 在大脑判断通过、即将提交订单时生成唯一容量快照。
 *
 * - 当日累计保证金只记录，不参与执行；
 * - Binance availableBalance：决定交易所当前是否能执行；
 * - 组合/方向风险不进入此函数，只能在上游给出缩量建议。
 */
export function calculateAutomatedOrderCapacity(input) {
  const quota = calculateAutomatedDailyMarginQuota({
    usedMarginUsdt: input.usedMarginUsdt,
    limitMarginUsdt: input.limitMarginUsdt,
    unrealizedPnlUsdt: input.unrealizedPnlUsdt,
  });
  const requiredMarginUsdt = positive(input.requiredMarginUsdt);
  const binanceAvailableMarginUsdt = positive(
    input.binanceAvailableMarginUsdt,
  );
  const localQuotaShortfallUsdt = 0;
  const binanceShortfallUsdt = Math.max(
    requiredMarginUsdt - binanceAvailableMarginUsdt,
    0,
  );

  let blockerCode = "READY";
  if (binanceShortfallUsdt > EPSILON)
    blockerCode = "BINANCE_AVAILABLE_MARGIN_INSUFFICIENT";

  return {
    ...quota,
    requiredMarginUsdt,
    binanceAvailableMarginUsdt,
    localQuotaShortfallUsdt,
    binanceShortfallUsdt,
    localQuotaAllowed: true,
    dailyMarginAdvisoryOnly: true,
    exchangeExecutable: binanceShortfallUsdt <= EPSILON,
    canSubmit: blockerCode === "READY",
    blockerCode,
  };
}

export function automatedOrderCapacityMessage(snapshot, subject = "大脑判断已经通过") {
  const pnlSign = snapshot.unrealizedPnlUsdt >= 0 ? "+" : "";
  const base =
    `${subject}；本单需保证金 ${snapshot.requiredMarginUsdt.toFixed(2)} USDT；` +
    `策略今日开仓保证金仅统计：参考值 ${snapshot.configuredLimitMarginUsdt.toFixed(2)} USDT，` +
    `策略未实现盈亏 ${pnlSign}${snapshot.unrealizedPnlUsdt.toFixed(2)} USDT，` +
    `今日已用 ${snapshot.usedMarginUsdt.toFixed(2)} USDT，` +
    `累计值不参与拒单或缩量；` +
    `Binance 当前可再开仓 ${snapshot.binanceAvailableMarginUsdt.toFixed(2)} USDT`;
  if (snapshot.blockerCode === "BINANCE_AVAILABLE_MARGIN_INSUFFICIENT")
    return `${base}；交易所可用保证金缺口 ${snapshot.binanceShortfallUsdt.toFixed(2)} USDT，本次暂不提交；已批准判断仅在有界执行窗口内等待余额恢复，恢复后只复核交易安全条件`;
  return `${base}；交易所资金边界已通过`;
}
