import type { WaveThesisOutcome } from "./liquidation-wave-thesis.ts";

export type WaveDirectionVerdict =
  | "VALIDATED_EARLY"
  | "VALIDATED_LATE"
  | "INVALIDATED"
  | "UNRESOLVED"
  | "INSUFFICIENT";

export type WaveEntryTimingVerdict =
  | "TIMELY"
  | "TOO_EARLY"
  | "CHASED"
  | "NOT_APPLICABLE"
  | "UNRESOLVED";

export type WaveEntryAttribution = {
  directionVerdict: WaveDirectionVerdict;
  timingVerdict: WaveEntryTimingVerdict;
  meaningfulMoveRoePercent: number;
  adverseMoveRoePercent: number;
  summary: string;
};

export function attributeWaveDirectionAndEntryTiming(input: {
  sampleCount: number;
  bestEarlyRoePercent: number | null;
  worstEarlyRoePercent: number | null;
  positiveEarlyMinuteRatio: number | null;
  roe30mPercent: number | null;
  waveThesisOutcome: WaveThesisOutcome | null;
  firstTakeProfitRoePercent: number;
  stopLossRoePercent: number;
  entryDistanceAtr: number | null;
  maxEntryDistanceAtr: number;
}): WaveEntryAttribution {
  const meaningfulMoveRoePercent = Math.max(
    0.5,
    Math.max(0, input.firstTakeProfitRoePercent) * 0.6,
  );
  const adverseMoveRoePercent = Math.max(
    0.5,
    Math.max(0, input.stopLossRoePercent) * 0.25,
  );
  if (input.sampleCount < 3) {
    return {
      directionVerdict: "INSUFFICIENT",
      timingVerdict: "NOT_APPLICABLE",
      meaningfulMoveRoePercent,
      adverseMoveRoePercent,
      summary: "有效分钟样本不足，暂不区分波段方向与入场时机。",
    };
  }

  const earlyValidated =
    (input.bestEarlyRoePercent ?? Number.NEGATIVE_INFINITY) >=
      meaningfulMoveRoePercent ||
    (
      (input.positiveEarlyMinuteRatio ?? 0) >= 2 / 3 &&
      (input.bestEarlyRoePercent ?? 0) > 0
    );
  const lateValidated =
    !earlyValidated &&
    input.roe30mPercent !== null &&
    input.roe30mPercent >= meaningfulMoveRoePercent;
  const earlyAdverse =
    (input.worstEarlyRoePercent ?? 0) <= -adverseMoveRoePercent;
  const nearDistanceLimit =
    input.entryDistanceAtr !== null &&
    input.maxEntryDistanceAtr > 0 &&
    input.entryDistanceAtr >= input.maxEntryDistanceAtr * 0.7;
  const invalidated =
    input.waveThesisOutcome === "FAILED_STRUCTURE" ||
    (
      !earlyValidated &&
      input.roe30mPercent !== null &&
      input.roe30mPercent <= -meaningfulMoveRoePercent
    );

  if (earlyValidated) {
    return {
      directionVerdict: "VALIDATED_EARLY",
      timingVerdict: "TIMELY",
      meaningfulMoveRoePercent,
      adverseMoveRoePercent,
      summary:
        input.waveThesisOutcome === "PROFIT_GIVEBACK"
          ? "主力波段方向在前10分钟得到验证，后续问题属于利润保护，不应误判为入场方向错误。"
          : "主力波段方向在前10分钟得到验证，本次入场时机具备及时性。",
    };
  }
  if (lateValidated) {
    return {
      directionVerdict: "VALIDATED_LATE",
      timingVerdict: earlyAdverse ? "TOO_EARLY" : "UNRESOLVED",
      meaningfulMoveRoePercent,
      adverseMoveRoePercent,
      summary: earlyAdverse
        ? `方向到30分钟才得到验证，但前10分钟先承受至少 ${adverseMoveRoePercent.toFixed(2)}% ROE逆向波动；方向可能正确，入场偏早。`
        : "方向到30分钟才得到验证，早期路径未显示足够逆向波动，继续积累后再判断入场偏早。",
    };
  }
  if (invalidated) {
    return {
      directionVerdict: "INVALIDATED",
      timingVerdict: nearDistanceLimit ? "CHASED" : "NOT_APPLICABLE",
      meaningfulMoveRoePercent,
      adverseMoveRoePercent,
      summary: nearDistanceLimit
        ? "波段方向未获验证且入场接近最大允许距离，本次更接近追价失败。"
        : "价格结构或30分钟方向结果否定了原波段假设，本次优先归因为方向判断失败。",
    };
  }
  return {
    directionVerdict: "UNRESOLVED",
    timingVerdict: nearDistanceLimit && earlyAdverse
      ? "CHASED"
      : "UNRESOLVED",
    meaningfulMoveRoePercent,
    adverseMoveRoePercent,
    summary:
      nearDistanceLimit && earlyAdverse
        ? "方向尚未被市场确认，但入场接近距离上限且早期逆向波动明显，记录为追价风险。"
        : "方向与入场时机均未形成可验证结论，继续观察而不修改参数。",
  };
}
