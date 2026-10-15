import { positionRoePercent } from "./position-roe.ts";

export const SHORT_DOWNTREND_STRATEGY_VERSION =
  "short-downtrend-continuation-v2-entry-timing" as const;
export const SHORT_INTERNAL_LIQUIDATION_MIN_COVERAGE_MS = 10 * 60_000;
export const SHORT_INTERNAL_LIQUIDATION_MIN_EVENTS = 20;

export function resolveShortLiquidationMarketContext(input: {
  webOneHourLongLiquidatedUsd?: number | null;
  webOneHourShortLiquidatedUsd?: number | null;
  internal?: {
    windowMs?: number | null;
    eventCount?: number | null;
    coverageMs?: number | null;
    sellNotional?: number | null;
    buyNotional?: number | null;
  } | null;
}) {
  const webLong = Number(input.webOneHourLongLiquidatedUsd);
  const webShort = Number(input.webOneHourShortLiquidatedUsd);
  if (
    Number.isFinite(webLong) &&
    webLong >= 0 &&
    Number.isFinite(webShort) &&
    webShort >= 0 &&
    webLong + webShort > 0
  )
    return {
      status: "AVAILABLE" as const,
      source: "COINGLASS_WEB_1H" as const,
      longLiquidationSharePercent: rounded(
        webLong / (webLong + webShort) * 100,
      ),
      observedEventCount: null,
      coverageMs: 60 * 60_000,
    };

  const internal = input.internal;
  const eventCount = Number(internal?.eventCount);
  const coverageMs = Number(internal?.coverageMs);
  const sellNotional = Number(internal?.sellNotional);
  const buyNotional = Number(internal?.buyNotional);
  if (
    Number.isFinite(eventCount) &&
    eventCount >= SHORT_INTERNAL_LIQUIDATION_MIN_EVENTS &&
    Number.isFinite(coverageMs) &&
    coverageMs >= SHORT_INTERNAL_LIQUIDATION_MIN_COVERAGE_MS &&
    Number.isFinite(sellNotional) &&
    sellNotional >= 0 &&
    Number.isFinite(buyNotional) &&
    buyNotional >= 0 &&
    sellNotional + buyNotional > 0
  )
    return {
      status: "AVAILABLE" as const,
      source: "BINANCE_WEBSOCKET_ROLLING_WINDOW" as const,
      // Binance force-order SELL events liquidate long positions; BUY events
      // liquidate short positions.
      longLiquidationSharePercent: rounded(
        sellNotional / (sellNotional + buyNotional) * 100,
      ),
      observedEventCount: Math.trunc(eventCount),
      coverageMs,
    };

  return {
    status: "UNAVAILABLE" as const,
    source: "UNAVAILABLE" as const,
    longLiquidationSharePercent: null,
    observedEventCount:
      Number.isFinite(eventCount) && eventCount >= 0
        ? Math.trunc(eventCount)
        : null,
    coverageMs:
      Number.isFinite(coverageMs) && coverageMs >= 0 ? coverageMs : null,
  };
}

export type ShortContinuationConfig = {
  minimumLongLiquidationSharePercent: number;
  minimumVolumeRatio3m: number;
  maximumChaseDistanceAtr: number;
  maximumMarketDataAgeMs: number;
};

export type ShortContinuationDecision = {
  strategyVersion: typeof SHORT_DOWNTREND_STRATEGY_VERSION;
  strategyFamily: "LIQUIDATION_SHORT";
  positionSide: "SHORT";
  status:
    | "READY_FOR_SHORT_ENTRY"
    | "WAIT_GLOBAL_LONG_FLUSH"
    | "WAIT_MARKET_DOWNTREND"
    | "WAIT_SUPPORT_BREAK"
    | "WAIT_FAILED_RETEST"
    | "WAIT_VOLUME_CONFIRMATION"
    | "SKIP_CHASE_TOO_FAR"
    | "DATA_STALE";
  /**
   * This evaluator is retained as branch-local compatibility evidence. The
   * unified NEXUS market eye and execution coordinator own live authority.
   */
  authorityRole: "COMPATIBILITY_EVIDENCE";
  observationOnly: true;
  orderAffecting: false;
  liveOrderAuthorized: false;
  evidenceCodes: string[];
  reason: string;
};

export const DEFAULT_SHORT_CONTINUATION_CONFIG: ShortContinuationConfig = {
  minimumLongLiquidationSharePercent: 80,
  minimumVolumeRatio3m: 1,
  maximumChaseDistanceAtr: 0.8,
  maximumMarketDataAgeMs: 2_000,
};

/**
 * 统一爆仓策略里的下跌延续做空判断。
 *
 * 不复用“爆仓低位反弹”做多策略的低位、回收、补仓或学习结论。
 * 条件按固定顺序逐项验证，不打分；结果仅保留为兼容证据。统一 NEXUS
 * 眼睛与中央执行协调器独立完成正式下单授权，避免旧分支与主链双重裁决。
 */
export function evaluateShortDowntrendContinuation(input: {
  completedObservationSamples?: number;
  globalLongLiquidationSharePercent: number | null;
  market60mState: "DOWNTREND" | "RANGE" | "UPTREND" | "UNAVAILABLE";
  supportBreakConfirmed: boolean;
  failedRetestConfirmed: boolean;
  executionVolumeRatio1m: number | null;
  distanceBelowBrokenSupportAtr: number | null;
  marketDataAgeMs: number;
  config?: Partial<ShortContinuationConfig>;
}): ShortContinuationDecision {
  const config = normalizeConfig(input.config);
  const common = {
    strategyVersion: SHORT_DOWNTREND_STRATEGY_VERSION,
    strategyFamily: "LIQUIDATION_SHORT" as const,
    positionSide: "SHORT" as const,
    authorityRole: "COMPATIBILITY_EVIDENCE" as const,
    observationOnly: true as const,
    orderAffecting: false as const,
    liveOrderAuthorized: false as const,
  };
  const evidenceCodes = [
    finiteAtLeast(
      input.globalLongLiquidationSharePercent,
      config.minimumLongLiquidationSharePercent,
    )
      ? "GLOBAL_LONG_LIQUIDATION_DOMINANT"
      : null,
    input.market60mState === "DOWNTREND" ? "MARKET_60M_DOWNTREND" : null,
    input.supportBreakConfirmed ? "SUPPORT_BREAK_CONFIRMED" : null,
    input.failedRetestConfirmed ? "FAILED_RETEST_CONFIRMED" : null,
    finiteAtLeast(
      input.executionVolumeRatio1m,
      config.minimumVolumeRatio3m,
    )
      ? "VOLUME_CONFIRMED"
      : null,
  ].filter((code): code is string => Boolean(code));

  if (
    !Number.isFinite(input.marketDataAgeMs) ||
    input.marketDataAgeMs < 0 ||
    input.marketDataAgeMs > config.maximumMarketDataAgeMs
  )
    return {
      ...common,
      status: "DATA_STALE",
      evidenceCodes,
      reason: "统一行情数据过期，本轮不建立做空信号。",
    };
  if (!input.supportBreakConfirmed)
    return {
      ...common,
      status: "WAIT_SUPPORT_BREAK",
      evidenceCodes,
      reason: "单合约支撑尚未被闭合K线确认跌破。",
    };
  if (!input.failedRetestConfirmed)
    return {
      ...common,
      status: "WAIT_FAILED_RETEST",
      evidenceCodes,
      reason:
        "跌破后尚未出现反抽失败；等待原支撑转为阻力，避免在杀跌尾段直接追空。",
    };
  if (
    !finiteAtLeast(
      input.executionVolumeRatio1m,
      config.minimumVolumeRatio3m,
    )
  )
    return {
      ...common,
      status: "WAIT_VOLUME_CONFIRMATION",
      evidenceCodes,
      reason:
        `1分钟执行成交量比未达到 ${config.minimumVolumeRatio3m.toFixed(2)}，` +
        "下跌延续缺少量能确认。",
    };
  if (
    input.distanceBelowBrokenSupportAtr === null ||
    !Number.isFinite(input.distanceBelowBrokenSupportAtr) ||
    input.distanceBelowBrokenSupportAtr < 0 ||
    input.distanceBelowBrokenSupportAtr > config.maximumChaseDistanceAtr
  )
    return {
      ...common,
      status: "SKIP_CHASE_TOO_FAR",
      evidenceCodes,
      reason:
        `价格距离破位支撑超过 ${config.maximumChaseDistanceAtr.toFixed(2)} ATR，` +
        "本轮放弃追空，等待下一次反抽。",
    };

  return {
    ...common,
    status: "READY_FOR_SHORT_ENTRY",
    evidenceCodes,
    reason:
      "单合约支撑破位、反抽失败和量能延续成立；形成做空入场信号。全市场爆仓与60分钟背景仅作为入场后仓位管理证据。",
  };
}

export type ShortPathReviewSample = {
  minuteOffset: number;
  markPrice: number;
};

export type ShortStructureCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export function analyzeShortMarket60m(
  candles: ShortStructureCandle[],
  minimumDropPercent = 0.2,
) {
  const valid = validCandles(candles).slice(-13);
  if (valid.length < 13)
    return {
      state: "UNAVAILABLE" as const,
      changePercent: null,
      lowerHigh: false,
      lowerLow: false,
    };
  const first = valid[0].close;
  const latest = valid.at(-1)!.close;
  const changePercent = (latest - first) / first * 100;
  const previous = valid.slice(-7, -3);
  const recent = valid.slice(-3);
  const lowerHigh =
    Math.max(...recent.map((row) => row.high)) <
    Math.max(...previous.map((row) => row.high));
  const lowerLow =
    Math.min(...recent.map((row) => row.low)) <
    Math.min(...previous.map((row) => row.low));
  const downtrend =
    changePercent <= -Math.abs(minimumDropPercent) &&
    lowerHigh &&
    lowerLow;
  const uptrend =
    changePercent >= Math.abs(minimumDropPercent) &&
    !lowerHigh &&
    !lowerLow;
  return {
    state: downtrend
      ? ("DOWNTREND" as const)
      : uptrend
        ? ("UPTREND" as const)
        : ("RANGE" as const),
    changePercent: rounded(changePercent),
    lowerHigh,
    lowerLow,
  };
}

export function analyzeShortBreakRetest(
  candles: ShortStructureCandle[],
  resistanceRetestToleranceAtr = 0.2,
) {
  const valid = validCandles(candles).slice(-30);
  if (valid.length < 20)
    return {
      supportBreakConfirmed: false,
      failedRetestConfirmed: false,
      brokenSupport: null,
      atr: null,
      distanceBelowBrokenSupportAtr: null,
    };
  const tailSize = 5;
  const baseline = valid.slice(0, -tailSize);
  const tail = valid.slice(-tailSize);
  const brokenSupport = Math.min(...baseline.map((row) => row.low));
  const atr = averageTrueRange(valid.slice(-15));
  if (!positive(atr))
    return {
      supportBreakConfirmed: false,
      failedRetestConfirmed: false,
      brokenSupport,
      atr: null,
      distanceBelowBrokenSupportAtr: null,
    };
  const breakIndex = tail.findIndex((row) => row.close < brokenSupport);
  const latest = tail.at(-1)!;
  const supportBreakConfirmed =
    breakIndex >= 0 &&
    latest.close < brokenSupport &&
    tail.filter((row) => row.close < brokenSupport).length >= 2;
  const normalizedRetestToleranceAtr = Number.isFinite(
    resistanceRetestToleranceAtr,
  )
    ? Math.min(2, Math.max(0, resistanceRetestToleranceAtr))
    : 0.2;
  const retestTolerance = atr * normalizedRetestToleranceAtr;
  const failedRetestConfirmed =
    supportBreakConfirmed &&
    breakIndex >= 0 &&
    tail.slice(breakIndex + 1).some(
      (row) =>
        row.high >= brokenSupport - retestTolerance &&
        row.close < brokenSupport,
    );
  return {
    supportBreakConfirmed,
    failedRetestConfirmed,
    // Price anchors and ATR must retain exchange-price precision. Rounding
    // them to three decimals turns valid low-priced contract ATR values into
    // zero, so an approved short can never pass final revalidation.
    brokenSupport,
    atr,
    resistanceRetestToleranceAtr: normalizedRetestToleranceAtr,
    distanceBelowBrokenSupportAtr: rounded(
      Math.max(0, (brokenSupport - latest.close) / atr),
    ),
  };
}

export function latestVolumeRatio(candles: ShortStructureCandle[]) {
  const valid = validCandles(candles).filter(
    (row) => Number.isFinite(row.volume) && Number(row.volume) >= 0,
  );
  if (valid.length < 11) return null;
  const latest = Number(valid.at(-1)!.volume);
  const baseline = valid.slice(-11, -1);
  const average =
    baseline.reduce((sum, row) => sum + Number(row.volume), 0) /
    baseline.length;
  return average > 0 ? rounded(latest / average) : null;
}

export type ShortPathReviewResult = {
  strategyVersion: typeof SHORT_DOWNTREND_STRATEGY_VERSION;
  positionSide: "SHORT";
  entryPrice: number;
  leverage: number;
  roe5mPercent: number | null;
  roe30mPercent: number | null;
  roe60mPercent: number | null;
  bestRoePercent: number | null;
  worstRoePercent: number | null;
  result:
    | "PROFIT_CONTINUED"
    | "EARLY_PROFIT_GIVEBACK"
    | "WRONG_DIRECTION"
    | "INCOMPLETE";
  reason: string;
};

export type ShortRiskReview = {
  positionSide: "SHORT";
  takeProfitIndexes: number[];
  trailingArmedAtMinute: number | null;
  exitAtMinute: number | null;
  exitReason: "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | null;
  exitRoePercent: number | null;
  bestRoePercent: number;
  worstRoePercent: number;
};

/**
 * 做空策略自己的风险路径复核。只计算复盘结果，不创建订单。
 * 价格下跌产生正ROE，价格上涨产生负ROE；止盈、止损与移动止损均以ROE判断。
 */
export function evaluateShortRiskReview(input: {
  entryPrice: number;
  leverage: number;
  samples: ShortPathReviewSample[];
  takeProfits: Array<{ triggerRoePercent: number; closePercent: number }>;
  stopLossRoePercent: number;
  trailingActivationRoePercent: number;
  trailingGivebackRoePoints: number;
}): ShortRiskReview {
  const samples = input.samples
    .filter(
      (sample) =>
        Number.isFinite(sample.minuteOffset) &&
        sample.minuteOffset >= 0 &&
        Number.isFinite(sample.markPrice) &&
        sample.markPrice > 0,
    )
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
  let bestRoePercent = 0;
  let worstRoePercent = 0;
  let trailingArmedAtMinute: number | null = null;
  const takeProfitIndexes: number[] = [];
  let closedPercent = 0;

  for (const sample of samples) {
    const roe = positionRoePercent(
      input.entryPrice,
      sample.markPrice,
      input.leverage,
      "SHORT",
    );
    if (!Number.isFinite(roe)) continue;
    bestRoePercent = Math.max(bestRoePercent, roe);
    worstRoePercent = Math.min(worstRoePercent, roe);
    if (
      trailingArmedAtMinute === null &&
      positive(input.trailingActivationRoePercent) &&
      bestRoePercent >= input.trailingActivationRoePercent
    )
      trailingArmedAtMinute = sample.minuteOffset;

    if (
      positive(input.stopLossRoePercent) &&
      roe <= -input.stopLossRoePercent
    )
      return {
        positionSide: "SHORT",
        takeProfitIndexes,
        trailingArmedAtMinute,
        exitAtMinute: sample.minuteOffset,
        exitReason: "STOP_LOSS",
        exitRoePercent: rounded(roe),
        bestRoePercent: rounded(bestRoePercent),
        worstRoePercent: rounded(worstRoePercent),
      };

    input.takeProfits.forEach((level, index) => {
      if (
        !takeProfitIndexes.includes(index) &&
        positive(level.triggerRoePercent) &&
        positive(level.closePercent) &&
        roe >= level.triggerRoePercent
      ) {
        takeProfitIndexes.push(index);
        closedPercent = Math.min(100, closedPercent + level.closePercent);
      }
    });
    if (closedPercent >= 100)
      return {
        positionSide: "SHORT",
        takeProfitIndexes,
        trailingArmedAtMinute,
        exitAtMinute: sample.minuteOffset,
        exitReason: "TAKE_PROFIT",
        exitRoePercent: rounded(roe),
        bestRoePercent: rounded(bestRoePercent),
        worstRoePercent: rounded(worstRoePercent),
      };

    if (
      trailingArmedAtMinute !== null &&
      positive(input.trailingGivebackRoePoints) &&
      roe <= bestRoePercent - input.trailingGivebackRoePoints
    )
      return {
        positionSide: "SHORT",
        takeProfitIndexes,
        trailingArmedAtMinute,
        exitAtMinute: sample.minuteOffset,
        exitReason: "TRAILING_STOP",
        exitRoePercent: rounded(roe),
        bestRoePercent: rounded(bestRoePercent),
        worstRoePercent: rounded(worstRoePercent),
      };
  }

  return {
    positionSide: "SHORT",
    takeProfitIndexes,
    trailingArmedAtMinute,
    exitAtMinute: null,
    exitReason: null,
    exitRoePercent: null,
    bestRoePercent: rounded(bestRoePercent),
    worstRoePercent: rounded(worstRoePercent),
  };
}

export function evaluateShortPathReview(input: {
  entryPrice: number;
  leverage: number;
  samples: ShortPathReviewSample[];
}): ShortPathReviewResult {
  const valid = input.samples
    .filter(
      (sample) =>
        [5, 30, 60].includes(sample.minuteOffset) &&
        Number.isFinite(sample.markPrice) &&
        sample.markPrice > 0,
    )
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
  const roeAt = (minute: number) => {
    const sample = valid.find((item) => item.minuteOffset === minute);
    return sample
      ? rounded(
          positionRoePercent(
            input.entryPrice,
            sample.markPrice,
            input.leverage,
            "SHORT",
          ),
        )
      : null;
  };
  const roe5mPercent = roeAt(5);
  const roe30mPercent = roeAt(30);
  const roe60mPercent = roeAt(60);
  const values = [roe5mPercent, roe30mPercent, roe60mPercent].filter(
    (value): value is number => value !== null,
  );
  const common = {
    strategyVersion: SHORT_DOWNTREND_STRATEGY_VERSION,
    positionSide: "SHORT" as const,
    entryPrice: input.entryPrice,
    leverage: input.leverage,
    roe5mPercent,
    roe30mPercent,
    roe60mPercent,
    bestRoePercent: values.length ? Math.max(...values) : null,
    worstRoePercent: values.length ? Math.min(...values) : null,
  };
  if (
    !positive(input.entryPrice) ||
    !positive(input.leverage) ||
    roe5mPercent === null ||
    roe30mPercent === null ||
    roe60mPercent === null
  )
    return {
      ...common,
      result: "INCOMPLETE",
      reason: "尚未形成完整5/30/60分钟做空复盘周期。",
    };
  if (roe60mPercent > 0 && roe30mPercent > 0)
    return {
      ...common,
      result: "PROFIT_CONTINUED",
      reason: "做空方向在30和60分钟保持正ROE，下跌延续得到观察支持。",
    };
  if (Math.max(roe5mPercent, roe30mPercent) > 0 && roe60mPercent <= 0)
    return {
      ...common,
      result: "EARLY_PROFIT_GIVEBACK",
      reason: "做空早期曾盈利但60分钟回吐，需复核利润保护而非方向触发。",
    };
  return {
    ...common,
    result: "WRONG_DIRECTION",
    reason: "5/30/60分钟未证明下跌延续，本笔作为做空方向反证。",
  };
}

function normalizeConfig(
  value: Partial<ShortContinuationConfig> | undefined,
): ShortContinuationConfig {
  return {
    minimumLongLiquidationSharePercent: positiveOr(
      value?.minimumLongLiquidationSharePercent,
      DEFAULT_SHORT_CONTINUATION_CONFIG.minimumLongLiquidationSharePercent,
    ),
    minimumVolumeRatio3m: positiveOr(
      value?.minimumVolumeRatio3m,
      DEFAULT_SHORT_CONTINUATION_CONFIG.minimumVolumeRatio3m,
    ),
    maximumChaseDistanceAtr: positiveOr(
      value?.maximumChaseDistanceAtr,
      DEFAULT_SHORT_CONTINUATION_CONFIG.maximumChaseDistanceAtr,
    ),
    maximumMarketDataAgeMs: integerOr(
      value?.maximumMarketDataAgeMs,
      DEFAULT_SHORT_CONTINUATION_CONFIG.maximumMarketDataAgeMs,
    ),
  };
}

function finiteAtLeast(value: number | null, minimum: number) {
  return value !== null && Number.isFinite(value) && value >= minimum;
}

function positive(value: unknown): value is number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function positiveOr(value: unknown, fallback: number) {
  return positive(value) ? Number(value) : fallback;
}

function integerOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function validCandles(candles: ShortStructureCandle[]) {
  return candles
    .filter(
      (row) =>
        Number.isFinite(row.openTime) &&
        positive(row.open) &&
        positive(row.high) &&
        positive(row.low) &&
        positive(row.close) &&
        row.high >= row.low,
    )
    .sort((left, right) => left.openTime - right.openTime);
}

function averageTrueRange(candles: ShortStructureCandle[]) {
  if (candles.length < 2) return null;
  const ranges = candles.slice(1).map((row, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose),
    );
  });
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}
