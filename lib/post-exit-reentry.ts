import type { ExitCounterfactualClassification } from "./exit-counterfactual.ts";

export const POST_EXIT_REENTRY_VERSION =
  "nexus-post-exit-reentry-v1" as const;

export type PostExitReentryCandle = Readonly<{
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}>;

export type PostExitReentryEvaluation = Readonly<{
  version: typeof POST_EXIT_REENTRY_VERSION;
  candidateId: string;
  eligible: boolean;
  code:
    | "READY"
    | "EXIT_NOT_EARLY"
    | "CLOSED_CANDLES_INCOMPLETE"
    | "EXTREME_NOT_CONFIRMED"
    | "EXIT_LEVEL_NOT_RECLAIMED"
    | "RECOVERY_INSUFFICIENT"
    | "TRADE_VOLUME_UNAVAILABLE"
    | "TRADE_VOLUME_NOT_CONFIRMED";
  positionSide: "LONG" | "SHORT";
  exitReason: "STOP_LOSS" | "TRAILING_STOP";
  sourcePositionId: number;
  sourceTraceId: string;
  horizonMinutes: number;
  exitPrice: number;
  extremePrice: number | null;
  confirmationPrice: number | null;
  confirmationAtMs: number | null;
  recoveryRoePoints: number | null;
  requiredRecoveryRoePoints: number;
  exitLevelReclaimed: boolean;
  consecutiveClosedConfirmation: boolean;
  confirmationVolumeRatio: number | null;
  requiredVolumeRatio: number;
  minimumQuantityOnly: true;
  createsIndependentLifecycle: true;
  summary: string;
}>;

/**
 * A protective exit can create a new analysis candidate, never a direct order.
 * The old position stays terminal; any later fill receives a new trace,
 * execution intent and position lifecycle.
 */
export function evaluatePostExitReentry(input: {
  sourcePositionId: number;
  sourceTraceId: string;
  positionSide: "LONG" | "SHORT";
  exitReason: "STOP_LOSS" | "TRAILING_STOP";
  classification: ExitCounterfactualClassification;
  exitPrice: number;
  leverage: number;
  closedAtMs: number;
  evaluatedAtMs: number;
  horizonMinutes: number;
  markPriceCandles: readonly PostExitReentryCandle[];
  tradeCandles: readonly PostExitReentryCandle[];
  minimumRecoveryRoePoints?: number;
  minimumVolumeRatio?: number;
}): PostExitReentryEvaluation {
  const requiredRecoveryRoePoints = positiveOr(
    input.minimumRecoveryRoePoints,
    2,
  );
  const requiredVolumeRatio = positiveOr(input.minimumVolumeRatio, 1);
  const candidateId = `post-exit-reentry:${input.sourcePositionId}`;
  const base = {
    version: POST_EXIT_REENTRY_VERSION,
    candidateId,
    positionSide: input.positionSide,
    exitReason: input.exitReason,
    sourcePositionId: input.sourcePositionId,
    sourceTraceId: input.sourceTraceId,
    horizonMinutes: input.horizonMinutes,
    exitPrice: input.exitPrice,
    requiredRecoveryRoePoints,
    requiredVolumeRatio,
    minimumQuantityOnly: true as const,
    createsIndependentLifecycle: true as const,
  };
  const reject = (
    code: Exclude<PostExitReentryEvaluation["code"], "READY">,
    summary: string,
    detail: Partial<PostExitReentryEvaluation> = {},
  ): PostExitReentryEvaluation => ({
    ...base,
    eligible: false,
    code,
    extremePrice: null,
    confirmationPrice: null,
    confirmationAtMs: null,
    recoveryRoePoints: null,
    exitLevelReclaimed: false,
    consecutiveClosedConfirmation: false,
    confirmationVolumeRatio: null,
    ...detail,
    summary,
  });

  if (input.classification !== "EXIT_EARLY")
    return reject(
      "EXIT_NOT_EARLY",
      "退出后的原方向走势尚未证明本次退出过早；只保留复盘，不重新入场。",
    );

  const marks = normalizedCandles(
    input.markPriceCandles,
    input.closedAtMs,
    input.evaluatedAtMs,
  );
  const trades = normalizedCandles(
    input.tradeCandles,
    input.closedAtMs,
    input.evaluatedAtMs,
  );
  if (marks.length < 4)
    return reject(
      "CLOSED_CANDLES_INCOMPLETE",
      "退出后闭合1分钟结构不足四根，继续等待，不用未闭合波动重进。",
    );

  const extremeIndex = marks.reduce((selected, candle, index) => {
    if (input.positionSide === "LONG")
      return candle.low < marks[selected].low ? index : selected;
    return candle.high > marks[selected].high ? index : selected;
  }, 0);
  const extreme = marks[extremeIndex];
  const confirmations = marks.slice(-2);
  if (
    extremeIndex > marks.length - 3 ||
    confirmations.some((candle) => candle.openTime <= extreme.openTime)
  )
    return reject(
      "EXTREME_NOT_CONFIRMED",
      "最新极值之后还没有两根完整1分钟K线确认反弹，禁止猜底。",
      {
        extremePrice: input.positionSide === "LONG"
          ? extreme.low
          : extreme.high,
      },
    );

  const [previous, latest] = confirmations;
  const exitLevelReclaimed = input.positionSide === "LONG"
    ? previous.close >= input.exitPrice && latest.close >= input.exitPrice
    : previous.close <= input.exitPrice && latest.close <= input.exitPrice;
  const consecutiveClosedConfirmation = input.positionSide === "LONG"
    ? latest.close >= previous.close
    : latest.close <= previous.close;
  const extremePrice = input.positionSide === "LONG"
    ? extreme.low
    : extreme.high;
  const rawRecoveryPercent = input.positionSide === "LONG"
    ? (latest.close / extremePrice - 1) * 100
    : (extremePrice / latest.close - 1) * 100;
  const recoveryRoePoints = rawRecoveryPercent * Math.max(input.leverage, 1);
  if (!exitLevelReclaimed || !consecutiveClosedConfirmation)
    return reject(
      "EXIT_LEVEL_NOT_RECLAIMED",
      "价格尚未用连续两根闭合1分钟K线收回退出价；旧亏损不能成为追单理由。",
      {
        extremePrice,
        confirmationPrice: latest.close,
        confirmationAtMs: latest.closeTime,
        recoveryRoePoints: rounded(recoveryRoePoints),
        exitLevelReclaimed,
        consecutiveClosedConfirmation,
      },
    );
  if (recoveryRoePoints < requiredRecoveryRoePoints)
    return reject(
      "RECOVERY_INSUFFICIENT",
      `极值后仅修复 ${recoveryRoePoints.toFixed(2)} 个ROE点，尚未达到独立再入场阈值。`,
      {
        extremePrice,
        confirmationPrice: latest.close,
        confirmationAtMs: latest.closeTime,
        recoveryRoePoints: rounded(recoveryRoePoints),
        exitLevelReclaimed,
        consecutiveClosedConfirmation,
      },
    );

  const volumeByOpenTime = new Map(
    trades
      .filter((candle) => candle.volume > 0)
      .map((candle) => [candle.openTime, candle.volume]),
  );
  const confirmationVolumes = confirmations.flatMap((candle) => {
    const volume = volumeByOpenTime.get(candle.openTime);
    return volume === undefined ? [] : [volume];
  });
  const baselineVolumes = marks.slice(0, -2).flatMap((candle) => {
    const volume = volumeByOpenTime.get(candle.openTime);
    return volume === undefined ? [] : [volume];
  });
  if (confirmationVolumes.length < 2 || baselineVolumes.length < 1)
    return reject(
      "TRADE_VOLUME_UNAVAILABLE",
      "实际成交K线尚未与价格确认窗口对齐；禁止用标记价格成交量替代真实资金证据。",
      {
        extremePrice,
        confirmationPrice: latest.close,
        confirmationAtMs: latest.closeTime,
        recoveryRoePoints: rounded(recoveryRoePoints),
        exitLevelReclaimed,
        consecutiveClosedConfirmation,
      },
    );
  const confirmationVolumeRatio = average(confirmationVolumes) /
    average(baselineVolumes);
  if (
    !Number.isFinite(confirmationVolumeRatio) ||
    confirmationVolumeRatio < requiredVolumeRatio
  )
    return reject(
      "TRADE_VOLUME_NOT_CONFIRMED",
      "价格已经修复，但真实成交量没有达到退出前后的基线；继续观察，不把无量反弹当作新机会。",
      {
        extremePrice,
        confirmationPrice: latest.close,
        confirmationAtMs: latest.closeTime,
        recoveryRoePoints: rounded(recoveryRoePoints),
        exitLevelReclaimed,
        consecutiveClosedConfirmation,
        confirmationVolumeRatio: rounded(confirmationVolumeRatio),
      },
    );

  return {
    ...base,
    eligible: true,
    code: "READY",
    extremePrice,
    confirmationPrice: latest.close,
    confirmationAtMs: latest.closeTime,
    recoveryRoePoints: rounded(recoveryRoePoints),
    exitLevelReclaimed,
    consecutiveClosedConfirmation,
    confirmationVolumeRatio: rounded(confirmationVolumeRatio),
    summary:
      "退出过早、极值修复、连续闭合收回和真实成交量已同时成立；仅创建最小量再入场候选，交由统一大脑重新裁决。",
  };
}

function normalizedCandles(
  candles: readonly PostExitReentryCandle[],
  closedAtMs: number,
  evaluatedAtMs: number,
) {
  const latestByOpenTime = new Map<number, PostExitReentryCandle>();
  for (const candle of candles) {
    if (
      ![
        candle.openTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.closeTime,
      ].every(Number.isFinite) ||
      candle.openTime < 0 ||
      candle.closeTime <= closedAtMs ||
      candle.closeTime > evaluatedAtMs ||
      candle.open <= 0 ||
      candle.high <= 0 ||
      candle.low <= 0 ||
      candle.close <= 0 ||
      candle.high < candle.low
    ) continue;
    latestByOpenTime.set(candle.openTime, candle);
  }
  return [...latestByOpenTime.values()].sort(
    (left, right) => left.openTime - right.openTime,
  );
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function positiveOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
