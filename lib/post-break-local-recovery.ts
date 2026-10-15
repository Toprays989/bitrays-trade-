export type OneMinuteTradeCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type PostBreakLocalRecoveryShadow = {
  version: 1;
  status: "QUALIFIED" | "REJECTED" | "INCOMPLETE";
  reason: string;
  firstFullMinuteOpenTime: number;
  reversalMinute: number | null;
  volumeRatio3m: number | null;
  volumeRatio5m: number | null;
  entryAt: number | null;
  entryPrice: number | null;
  mfeRoePercent: number | null;
  maeRoePercent: number | null;
  finalRoePercent: number | null;
  takeProfitMinute: number | null;
  stopLossMinute: number | null;
  estimatedGrossRoePercent: number | null;
  estimatedObservedCloseGrossRoePercent: number | null;
  estimatedExitMinute: number | null;
  estimatedExitReason: "TAKE_PROFIT" | "TRAILING_STOP" | "STOP_LOSS" | "OPEN" | null;
  outcome: "TAKE_PROFIT_FIRST" | "STOP_LOSS_FIRST" | "AMBIGUOUS" | "NO_TRIGGER" | "NO_ENTRY";
};

const MINUTE = 60_000;

export function evaluatePostBreakLocalRecoveryShadow(input: {
  decisionAtMs: number;
  candles1m: OneMinuteTradeCandle[];
  leverage: number;
  minimumVolumeRatio: number;
  firstTakeProfitPercent: number;
  stopLossPercent: number;
  takeProfitSteps: Array<{ profitPercent: number; closePercent: number }>;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
}): PostBreakLocalRecoveryShadow {
  const firstFullMinuteOpenTime = Math.ceil(input.decisionAtMs / MINUTE) * MINUTE;
  const decisionMinuteOpenTime = firstFullMinuteOpenTime - MINUTE;
  const candles = input.candles1m
    .filter(validCandle)
    .sort((left, right) => left.openTime - right.openTime);
  const history = candles.filter((candle) => candle.openTime < decisionMinuteOpenTime).slice(-20);
  const shock = candles.find((candle) => candle.openTime === decisionMinuteOpenTime);
  const post = candles.filter((candle) => candle.openTime >= firstFullMinuteOpenTime);
  const base = {
    version: 1 as const,
    firstFullMinuteOpenTime,
    reversalMinute: null,
    volumeRatio3m: null,
    volumeRatio5m: null,
    entryAt: null,
    entryPrice: null,
    mfeRoePercent: null,
    maeRoePercent: null,
    finalRoePercent: null,
    takeProfitMinute: null,
    stopLossMinute: null,
    estimatedGrossRoePercent: null,
    estimatedObservedCloseGrossRoePercent: null,
    estimatedExitMinute: null,
    estimatedExitReason: null,
    outcome: "NO_ENTRY" as const,
  };
  if (
    !Number.isFinite(input.decisionAtMs) ||
    input.decisionAtMs <= 0 ||
    !positive(input.leverage) ||
    !positive(input.minimumVolumeRatio) ||
    !positive(input.firstTakeProfitPercent) ||
    !positive(input.stopLossPercent) ||
    !Array.isArray(input.takeProfitSteps) ||
    !input.takeProfitSteps.length ||
    input.takeProfitSteps.some((step) =>
      !positive(step.profitPercent) || !positive(step.closePercent)
    ) ||
    !positive(input.trailingActivationPercent) ||
    !positive(input.trailingDrawdownPercent) ||
    history.length < 20 ||
    !shock ||
    post.length < 15
  ) return { ...base, status: "INCOMPLETE", reason: "决策前历史或决策后15根完整1分钟K线不足" };

  const averageHistoryVolume = history.reduce((sum, candle) => sum + candle.volume, 0) /
    history.length;
  if (!positive(averageHistoryVolume))
    return { ...base, status: "INCOMPLETE", reason: "决策前1分钟平均成交量无效" };

  const firstFive = post.slice(0, 5);
  const recoverySequence = [shock, ...firstFive];
  let reversalMinute: number | null = null;
  for (let index = 1; index < recoverySequence.length; index += 1) {
    const candle = recoverySequence[index];
    const previous = recoverySequence[index - 1];
    const range = candle.high - candle.low;
    const closePosition = range > 0 ? (candle.close - candle.low) / range : 0;
    if (
      candle.close > candle.open &&
      candle.close > previous.high &&
      closePosition >= 0.65
    ) {
      reversalMinute = index;
      break;
    }
  }
  const firstThree = aggregate(firstFive.slice(0, 3));
  const fiveMinute = aggregate(firstFive);
  const shockMidpoint = (shock.high + shock.low) / 2;
  const volumeRatio3m = firstThree.volume / (averageHistoryVolume * 3);
  const volumeRatio5m = fiveMinute.volume / (averageHistoryVolume * 5);
  const threeMinuteConfirmed =
    firstThree.close > shockMidpoint &&
    firstThree.close > firstThree.open &&
    volumeRatio3m >= input.minimumVolumeRatio;
  const fiveMinuteConfirmed =
    fiveMinute.close > shockMidpoint &&
    fiveMinute.close > fiveMinute.open &&
    volumeRatio5m >= input.minimumVolumeRatio;
  const detail = {
    ...base,
    reversalMinute,
    volumeRatio3m: round(volumeRatio3m),
    volumeRatio5m: round(volumeRatio5m),
  };
  if (reversalMinute === null)
    return { ...detail, status: "REJECTED", reason: "决策后5分钟内没有1分钟局部反转" };
  if (!threeMinuteConfirmed)
    return { ...detail, status: "REJECTED", reason: "决策后3分钟价格或成交量未确认" };
  if (!fiveMinuteConfirmed)
    return { ...detail, status: "REJECTED", reason: "决策后5分钟价格或成交量未确认" };

  const entryPrice = fiveMinute.close;
  const afterEntry = post.slice(5, 15);
  let mfe = Number.NEGATIVE_INFINITY;
  let mae = Number.POSITIVE_INFINITY;
  let takeProfitMinute: number | null = null;
  let stopLossMinute: number | null = null;
  for (const [index, candle] of afterEntry.entries()) {
    const highRoe = roe(entryPrice, candle.high, input.leverage);
    const lowRoe = roe(entryPrice, candle.low, input.leverage);
    mfe = Math.max(mfe, highRoe);
    mae = Math.min(mae, lowRoe);
    if (takeProfitMinute === null && highRoe >= input.firstTakeProfitPercent)
      takeProfitMinute = index + 1;
    if (stopLossMinute === null && lowRoe <= -input.stopLossPercent)
      stopLossMinute = index + 1;
  }
  const outcome = takeProfitMinute !== null && stopLossMinute !== null
    ? takeProfitMinute < stopLossMinute
      ? "TAKE_PROFIT_FIRST" as const
      : stopLossMinute < takeProfitMinute
        ? "STOP_LOSS_FIRST" as const
        : "AMBIGUOUS" as const
    : takeProfitMinute !== null
      ? "TAKE_PROFIT_FIRST" as const
      : stopLossMinute !== null
        ? "STOP_LOSS_FIRST" as const
        : "NO_TRIGGER" as const;
  const estimatedExit = estimateCloseOnlyExit({
    entryPrice,
    candles: afterEntry,
    leverage: input.leverage,
    takeProfitSteps: input.takeProfitSteps,
    stopLossPercent: input.stopLossPercent,
    trailingActivationPercent: input.trailingActivationPercent,
    trailingDrawdownPercent: input.trailingDrawdownPercent,
  });
  return {
    ...detail,
    status: "QUALIFIED",
    reason: "1分钟反转、3分钟量价和5分钟局部收回均已确认（仅影子验证）",
    entryAt: firstFullMinuteOpenTime + 5 * MINUTE,
    entryPrice,
    mfeRoePercent: round(mfe),
    maeRoePercent: round(mae),
    finalRoePercent: round(roe(entryPrice, afterEntry.at(-1)!.close, input.leverage)),
    takeProfitMinute,
    stopLossMinute,
    estimatedGrossRoePercent: estimatedExit.grossRoePercent,
    estimatedObservedCloseGrossRoePercent: estimatedExit.observedCloseGrossRoePercent,
    estimatedExitMinute: estimatedExit.exitMinute,
    estimatedExitReason: estimatedExit.exitReason,
    outcome,
  };
}

export function hasPostBreakLocalRecoveryShadow(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const shadow = parsed.postBreakLocalRecoveryShadow as Record<string, unknown> | undefined;
    return shadow?.version === 1;
  } catch {
    return false;
  }
}

function aggregate(candles: OneMinuteTradeCandle[]) {
  return {
    open: candles[0].open,
    high: Math.max(...candles.map((candle) => candle.high)),
    low: Math.min(...candles.map((candle) => candle.low)),
    close: candles.at(-1)!.close,
    volume: candles.reduce((sum, candle) => sum + candle.volume, 0),
  };
}

function validCandle(candle: OneMinuteTradeCandle) {
  return Number.isFinite(candle.openTime) &&
    [candle.open, candle.high, candle.low, candle.close].every(positive) &&
    Number.isFinite(candle.volume) && candle.volume >= 0 &&
    candle.high >= Math.max(candle.open, candle.close, candle.low) &&
    candle.low <= Math.min(candle.open, candle.close, candle.high);
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function roe(entry: number, price: number, leverage: number) {
  return ((price - entry) / entry) * leverage * 100;
}

function estimateCloseOnlyExit(input: {
  entryPrice: number;
  candles: OneMinuteTradeCandle[];
  leverage: number;
  takeProfitSteps: Array<{ profitPercent: number; closePercent: number }>;
  stopLossPercent: number;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
}) {
  let remaining = 1;
  let grossRoePercent = 0;
  let observedCloseGrossRoePercent = 0;
  let peakCloseRoe = Number.NEGATIVE_INFINITY;
  const executed = new Set<number>();
  for (const [index, candle] of input.candles.entries()) {
    const currentRoe = roe(input.entryPrice, candle.close, input.leverage);
    peakCloseRoe = Math.max(peakCloseRoe, currentRoe);
    for (const [stepIndex, step] of input.takeProfitSteps.entries()) {
      if (executed.has(stepIndex) || currentRoe < step.profitPercent || remaining <= 0)
        continue;
      const fraction = Math.min(remaining, step.closePercent / 100);
      grossRoePercent += fraction * step.profitPercent;
      observedCloseGrossRoePercent += fraction * currentRoe;
      remaining -= fraction;
      executed.add(stepIndex);
    }
    if (remaining <= 1e-9)
      return {
        grossRoePercent: round(grossRoePercent),
        observedCloseGrossRoePercent: round(observedCloseGrossRoePercent),
        exitMinute: index + 1,
        exitReason: "TAKE_PROFIT" as const,
      };
    const trailingTrigger = peakCloseRoe >= input.trailingActivationPercent
      ? peakCloseRoe - input.trailingDrawdownPercent
      : null;
    if (trailingTrigger !== null && currentRoe <= trailingTrigger) {
      grossRoePercent += remaining * trailingTrigger;
      observedCloseGrossRoePercent += remaining * currentRoe;
      return {
        grossRoePercent: round(grossRoePercent),
        observedCloseGrossRoePercent: round(observedCloseGrossRoePercent),
        exitMinute: index + 1,
        exitReason: "TRAILING_STOP" as const,
      };
    }
    if (currentRoe <= -input.stopLossPercent) {
      grossRoePercent -= remaining * input.stopLossPercent;
      observedCloseGrossRoePercent += remaining * currentRoe;
      return {
        grossRoePercent: round(grossRoePercent),
        observedCloseGrossRoePercent: round(observedCloseGrossRoePercent),
        exitMinute: index + 1,
        exitReason: "STOP_LOSS" as const,
      };
    }
  }
  const finalRoe = roe(
    input.entryPrice,
    input.candles.at(-1)!.close,
    input.leverage,
  );
  return {
    grossRoePercent: round(grossRoePercent + remaining * finalRoe),
    observedCloseGrossRoePercent: round(
      observedCloseGrossRoePercent + remaining * finalRoe,
    ),
    exitMinute: input.candles.length,
    exitReason: "OPEN" as const,
  };
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
