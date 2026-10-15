import { analyzeDownsideLiquiditySweep } from "./liquidity-sweep-cycle.ts";
import { analyzeMarkPricePosition } from "./nexus-market-position-observation.ts";
export { analyzeMarkPricePosition } from "./nexus-market-position-observation.ts";

export type AnalysisCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type LiquidationTrendAnalysisInput = {
  eventTime: number;
  markPrice: number;
  liquidationPrice: number;
  maxPosition72hPercent: number;
  volumeRatio3m: number;
  atrPeriod5m: number;
  maxEntryDistanceAtr: number;
  maxPriorRangeAtr?: number;
  trend1hBreakHandling?: "REJECT" | "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
  structure30mBreakHandling?: "REJECT" | "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
  atrStopBuffer: number;
  markPrice1h: AnalysisCandle[];
  trade1h: AnalysisCandle[];
  trade30m: AnalysisCandle[];
  trade5m: AnalysisCandle[];
  trade3m: AnalysisCandle[];
};

export type AnalysisStep = {
  stage:
    | "POSITION"
    | "TREND_1H"
    | "STRUCTURE_30M"
    | "LIQUIDITY_SWEEP_5M"
    | "RECLAIM_5M"
    | "ENTRY_3M";
  outcome: "PASSED" | "PENDING" | "REJECTED";
  code: string;
  message: string;
  detail: Record<string, unknown>;
};

export type LiquidationTrendAnalysis = {
  status: "READY" | "PENDING" | "REJECTED" | "DATA_STALE";
  code: string;
  message: string;
  steps: AnalysisStep[];
  evidence: Record<string, unknown>;
};

const MINUTE = 60_000;

export function analyzeLiquidationLongEntry(
  input: LiquidationTrendAnalysisInput,
): LiquidationTrendAnalysis {
  const steps: AnalysisStep[] = [];
  if (
    !finitePositive(input.eventTime) ||
    !finitePositive(input.markPrice) ||
    !finitePositive(input.liquidationPrice) ||
    !validCandles(input.markPrice1h, 72) ||
    !validCandles(input.trade1h, 8) ||
    !validCandles(input.trade30m, 8) ||
    !validCandles(input.trade5m, Math.max(input.atrPeriod5m + 1, 15)) ||
    !validCandles(input.trade3m, 21)
  )
    return result(
      "DATA_STALE",
      "ANALYSIS_DATA_INCOMPLETE",
      "四周期或标记价格K线数据不足",
      steps,
      {},
    );

  const markPosition = analyzeMarkPricePosition(
    input.markPrice,
    input.markPrice1h,
  );
  const {
    position24hPercent,
    position72hPercent,
  } = markPosition;
  const positionDetail = {
    ...markPosition,
    maxPosition72hPercent: input.maxPosition72hPercent,
  };
  if (position72hPercent === null || position72hPercent >= input.maxPosition72hPercent) {
    steps.push({
      stage: "POSITION",
      outcome: "REJECTED",
      code: "POSITION_72H_ABOVE_LIMIT",
      message: position72hPercent === null
        ? "72小时标记价格区间无效"
        : `72小时位置 ${position72hPercent.toFixed(2)}%，未低于 ${input.maxPosition72hPercent}%`,
      detail: positionDetail,
    });
    return result(
      "REJECTED",
      "POSITION_72H_ABOVE_LIMIT",
      "72小时价格位置不满足长周期低位试多条件",
      steps,
      positionDetail,
    );
  }
  steps.push({
    stage: "POSITION",
    outcome: "PASSED",
    code: "POSITION_LOW_CONFIRMED",
    message: `72小时位置 ${position72hPercent.toFixed(2)}%，进入低位候选区；24小时位置${position24hPercent === null ? "不可用" : ` ${position24hPercent.toFixed(2)}%`}仅作观察`,
    detail: positionDetail,
  });

  const oneHour = input.trade1h.slice(-8);
  const [oneA, oneB, oneC] = oneHour.slice(-3);
  const oneHourPriorSupport = Math.min(...oneHour.slice(0, -1).map((item) => item.low));
  const oneHourClearDowntrend =
    oneC.close < oneB.close &&
    oneB.close < oneA.close &&
    oneC.low < oneB.low &&
    oneB.low < oneA.low &&
    oneC.close < oneHourPriorSupport;
  const oneHourDetail = {
    lastCloses: [oneA.close, oneB.close, oneC.close],
    lastLows: [oneA.low, oneB.low, oneC.low],
    priorSupport: oneHourPriorSupport,
    clearDowntrend: oneHourClearDowntrend,
  };
  const waitForOneHourRecovery = (input.trend1hBreakHandling ??
    "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM") ===
    "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
  if (oneHourClearDowntrend && !waitForOneHourRecovery) {
    steps.push({
      stage: "TREND_1H",
      outcome: "REJECTED",
      code: "TREND_1H_REJECTED",
      message: "1小时收盘价和低点连续下移且跌破前支撑",
      detail: oneHourDetail,
    });
    return result(
      "REJECTED",
      "TREND_1H_REJECTED",
      "1小时仍为明确下跌背景",
      steps,
      { ...positionDetail, oneHour: oneHourDetail },
    );
  }
  steps.push({
    stage: "TREND_1H",
    outcome: "PASSED",
    code: oneHourClearDowntrend
      ? "TREND_1H_RECOVERY_REQUIRED"
      : "TREND_1H_ALLOWED",
    message: oneHourClearDowntrend
      ? "1小时仍在连续破位；参数允许继续观察，但必须通过后续5分钟收回和3分钟量价确认"
      : "1小时未形成明确的连续破位下跌",
    detail: oneHourDetail,
  });

  const thirty = input.trade30m.slice(-8);
  const [thirtyA, thirtyB, thirtyC] = thirty.slice(-3);
  const thirtyPriorSupport = Math.min(...thirty.slice(0, -1).map((item) => item.low));
  const thirtyLowerStructure =
    thirtyC.close < thirtyB.close &&
    thirtyB.close < thirtyA.close &&
    thirtyC.low < thirtyB.low &&
    thirtyB.low < thirtyA.low;
  const thirtySupportBroken = thirtyC.close < thirtyPriorSupport;
  const thirtyDetail = {
    lastCloses: [thirtyA.close, thirtyB.close, thirtyC.close],
    lastLows: [thirtyA.low, thirtyB.low, thirtyC.low],
    priorSupport: thirtyPriorSupport,
    lowerStructure: thirtyLowerStructure,
    supportBroken: thirtySupportBroken,
  };
  const thirtyMinuteBroken = thirtyLowerStructure || thirtySupportBroken;
  const waitForThirtyMinuteRecovery = (input.structure30mBreakHandling ??
    "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM") ===
    "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM";
  if (thirtyMinuteBroken && !waitForThirtyMinuteRecovery) {
    steps.push({
      stage: "STRUCTURE_30M",
      outcome: "REJECTED",
      code: "STRUCTURE_30M_REJECTED",
      message: thirtySupportBroken
        ? "30分钟收盘跌破前支撑"
        : "30分钟高低结构仍在连续下移",
      detail: thirtyDetail,
    });
    return result(
      "REJECTED",
      "STRUCTURE_30M_REJECTED",
      "30分钟波段结构不允许试多",
      steps,
      { ...positionDetail, oneHour: oneHourDetail, thirtyMinute: thirtyDetail },
    );
  }
  steps.push({
    stage: "STRUCTURE_30M",
    outcome: "PASSED",
    code: thirtyMinuteBroken
      ? "STRUCTURE_30M_RECOVERY_REQUIRED"
      : "STRUCTURE_30M_ALLOWED",
    message: thirtyMinuteBroken
      ? "30分钟结构仍在破位；参数允许继续观察，但不允许直接入场"
      : "30分钟结构未继续破位",
    detail: thirtyDetail,
  });

  const atr5m = averageTrueRange(input.trade5m, input.atrPeriod5m);
  if (!finitePositive(atr5m))
    return result(
      "DATA_STALE",
      "ATR_INVALID",
      "5分钟ATR计算失败",
      steps,
      { ...positionDetail, atr5m },
    );
  // Entry execution, pending-order cancellation and portfolio sizing must all
  // use the same structural anchors, including the controlled exploration
  // path that may continue before the full reclaim confirmation is complete.
  // Persist them before any early return so downstream execution never falls
  // back to a removed legacy `fiveMinute` evidence object.
  const event5mOpen = Math.floor(input.eventTime / (5 * MINUTE)) * 5 * MINUTE;
  const postEvent5m = input.trade5m.filter((item) => item.openTime >= event5mOpen);
  const confirmationLevel = thirtyMinuteBroken && waitForThirtyMinuteRecovery
    ? input.liquidationPrice
    : Math.max(input.liquidationPrice, thirtyPriorSupport);
  const invalidBoundary =
    Math.min(input.liquidationPrice, thirtyPriorSupport) -
    atr5m * input.atrStopBuffer;
  const entryStructure = {
    atr5m,
    confirmationLevel,
    invalidBoundary,
    event5mOpen,
  };
  const liquiditySweep = analyzeDownsideLiquiditySweep({
    eventTime: input.eventTime,
    liquidationPrice: input.liquidationPrice,
    atr5m,
    maxPriorRangeAtr: input.maxPriorRangeAtr,
    trade5m: input.trade5m,
  });
  if (liquiditySweep.status !== "RECLAIMED") {
    steps.push({
      stage: "LIQUIDITY_SWEEP_5M",
      outcome: liquiditySweep.status === "DATA_STALE" ? "REJECTED" : "PENDING",
      code: liquiditySweep.code,
      message: liquiditySweep.message,
      detail: liquiditySweep.detail,
    });
    return result(
      liquiditySweep.status === "DATA_STALE" ? "DATA_STALE" : "PENDING",
      liquiditySweep.code,
      liquiditySweep.message,
      steps,
      { ...positionDetail, ...entryStructure, liquiditySweep },
    );
  }
  steps.push({
    stage: "LIQUIDITY_SWEEP_5M",
    outcome: "PASSED",
    code: liquiditySweep.code,
    message: liquiditySweep.message,
    detail: liquiditySweep.detail,
  });
  let confirming5m: AnalysisCandle | null = null;
  for (let index = 0; index < postEvent5m.length; index += 1) {
    const candle = postEvent5m[index];
    const sourceIndex = input.trade5m.findIndex(
      (item) => item.openTime === candle.openTime,
    );
    const previous = input.trade5m[sourceIndex - 1];
    const previousTwo = input.trade5m[sourceIndex - 2];
    const candleRange = candle.high - candle.low;
    const closePosition = candleRange > 0
      ? (candle.close - candle.low) / candleRange
      : 0;
    const continuouslyLower = Boolean(
      previous &&
      previousTwo &&
      candle.close < previous.close &&
      previous.close < previousTwo.close,
    );
    if (
      candle.close >= confirmationLevel &&
      candle.low >= invalidBoundary &&
      closePosition >= 0.5 &&
      !continuouslyLower
    ) {
      confirming5m = candle;
      break;
    }
  }
  const latest5m = input.trade5m.at(-1)!;
  if (latest5m.close < invalidBoundary) {
    const detail = { atr5m, confirmationLevel, invalidBoundary, latest5m };
    steps.push({
      stage: "RECLAIM_5M",
      outcome: "REJECTED",
      code: "RECLAIM_5M_INVALIDATED",
      message: "5分钟收盘跌破结构失效边界",
      detail,
    });
    return result(
      "REJECTED",
      "RECLAIM_5M_INVALIDATED",
      "爆仓后价格仍在继续破位",
      steps,
      { ...positionDetail, ...detail },
    );
  }
  if (!confirming5m) {
    const detail = { atr5m, confirmationLevel, invalidBoundary, event5mOpen };
    steps.push({
      stage: "RECLAIM_5M",
      outcome: "PENDING",
      code: "RECLAIM_5M_PENDING",
      message: "等待爆仓后的5分钟K线重新站回确认位",
      detail,
    });
    return result(
      "PENDING",
      "RECLAIM_5M_PENDING",
      "5分钟重新站回尚未确认",
      steps,
      { ...positionDetail, ...detail },
    );
  }
  const fiveDetail = {
    atr5m,
    confirmationLevel,
    invalidBoundary,
    confirmingCandle: confirming5m,
  };
  steps.push({
    stage: "RECLAIM_5M",
    outcome: "PASSED",
    code: "RECLAIM_5M_CONFIRMED",
    message: "5分钟收盘重新站回爆仓价和关键支撑",
    detail: fiveDetail,
  });

  const confirmationClosedAt = confirming5m.openTime + 5 * MINUTE;
  const afterConfirmation3m = input.trade3m.filter(
    (item) => item.openTime + 3 * MINUTE > confirmationClosedAt,
  );
  const latest3m = afterConfirmation3m.at(-1);
  const previous3m = afterConfirmation3m.at(-2);
  const volumeHistory = input.trade3m.slice(-21, -1);
  const averageVolume3m =
    volumeHistory.reduce((sum, item) => sum + item.volume, 0) /
    volumeHistory.length;
  const volumeRatio3m = latest3m && averageVolume3m > 0
    ? latest3m.volume / averageVolume3m
    : 0;
  const retestTolerance = atr5m * 0.15;
  const retest = afterConfirmation3m
    .slice(0, -1)
    .find(
      (item) =>
        item.low <= confirmationLevel + retestTolerance &&
        item.close >= confirmationLevel,
    );
  const entryDistanceAtr =
    atr5m > 0 ? (input.markPrice - confirmationLevel) / atr5m : Number.POSITIVE_INFINITY;
  const threeDetail = {
    confirmationClosedAt,
    confirmationLevel,
    latest3m,
    previous3m,
    retest,
    averageVolume3m,
    volumeRatio3m,
    requiredVolumeRatio3m: input.volumeRatio3m,
    entryDistanceAtr,
    maxEntryDistanceAtr: input.maxEntryDistanceAtr,
  };
  if (latest3m && latest3m.close < invalidBoundary) {
    steps.push({
      stage: "ENTRY_3M",
      outcome: "REJECTED",
      code: "ENTRY_3M_INVALIDATED",
      message: "3分钟收盘重新跌破结构失效位",
      detail: threeDetail,
    });
    return result(
      "REJECTED",
      "ENTRY_3M_INVALIDATED",
      "3分钟入场结构已经失效",
      steps,
      { ...positionDetail, ...fiveDetail, ...threeDetail },
    );
  }
  const threeConfirmed = Boolean(
    latest3m &&
    previous3m &&
    retest &&
    latest3m.close >= confirmationLevel &&
    latest3m.close > latest3m.open &&
    latest3m.close > previous3m.close &&
    volumeRatio3m >= input.volumeRatio3m &&
    entryDistanceAtr >= 0 &&
    entryDistanceAtr <= input.maxEntryDistanceAtr,
  );
  if (!threeConfirmed) {
    const code = entryDistanceAtr > input.maxEntryDistanceAtr
      ? "PRICE_RETEST_PENDING"
      : "ENTRY_3M_PENDING";
    const message = entryDistanceAtr > input.maxEntryDistanceAtr
      ? "标记价格已远离确认位，禁止追价并等待有效期内回踩"
      : "等待3分钟回踩、收盘和成交量同时确认";
    steps.push({
      stage: "ENTRY_3M",
      outcome: "PENDING",
      code,
      message,
      detail: threeDetail,
    });
    return result(
      "PENDING",
      code,
      message,
      steps,
      { ...positionDetail, ...fiveDetail, ...threeDetail },
    );
  }
  steps.push({
    stage: "ENTRY_3M",
    outcome: "PASSED",
    code: "ENTRY_3M_CONFIRMED",
    message: "3分钟回踩、收盘和成交量确认完成",
    detail: threeDetail,
  });
  return result(
    "READY",
    "ENTRY_READY",
    "四周期硬条件判断全部通过",
    steps,
    {
      ...positionDetail,
      oneHour: oneHourDetail,
      thirtyMinute: thirtyDetail,
      liquiditySweep,
      fiveMinute: fiveDetail,
      threeMinute: threeDetail,
      suggestedEntryPrice: input.markPrice,
      structuralStopPrice: invalidBoundary,
    },
  );
}

function result(
  status: LiquidationTrendAnalysis["status"],
  code: string,
  message: string,
  steps: AnalysisStep[],
  evidence: Record<string, unknown>,
): LiquidationTrendAnalysis {
  return { status, code, message, steps, evidence };
}

function validCandles(candles: AnalysisCandle[], minimum: number) {
  return (
    Array.isArray(candles) &&
    candles.length >= minimum &&
    candles.every(
      (item) =>
        finitePositive(item.openTime) &&
        finitePositive(item.open) &&
        finitePositive(item.high) &&
        finitePositive(item.low) &&
        finitePositive(item.close) &&
        Number.isFinite(item.volume) &&
        item.volume >= 0 &&
        item.high >= item.low,
    )
  );
}

function averageTrueRange(candles: AnalysisCandle[], period: number) {
  const source = candles.slice(-(period + 1));
  if (source.length < period + 1) return Number.NaN;
  const ranges = source.slice(1).map((item, index) => {
    const previousClose = source[index].close;
    return Math.max(
      item.high - item.low,
      Math.abs(item.high - previousClose),
      Math.abs(item.low - previousClose),
    );
  });
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
