import { positionRoePercent } from "./position-roe.ts";

export type DeeperLimitCounterfactual = {
  status: "FILLED" | "NOT_FILLED" | "INSUFFICIENT";
  extraOffsetPercent: number;
  fillDeadlineMinute: number;
  candidateEntryPrice: number | null;
  fillMinute: number | null;
  evaluationMinute: number | null;
  actualRoePercent: number | null;
  candidateRoePercent: number | null;
  advantageRoePercent: number | null;
  summary: string;
};

export function evaluateDeeperLimitCounterfactual(input: {
  positionSide: "LONG" | "SHORT";
  actualEntryPrice: number | null;
  leverage: number;
  extraOffsetPercent: number;
  samples: Array<{
    minuteOffset: number;
    markPrice?: number | null;
  }>;
  fillDeadlineMinute?: number;
  latestEvaluationMinute?: number;
}): DeeperLimitCounterfactual {
  const extraOffsetPercent = finitePositive(input.extraOffsetPercent) ?? 0;
  const actualEntryPrice = finitePositive(input.actualEntryPrice);
  const leverage = finitePositive(input.leverage);
  const fillDeadlineMinute = input.fillDeadlineMinute === undefined
    ? 1
    : Math.max(0, Math.trunc(Number(input.fillDeadlineMinute) || 0));
  const samples = input.samples
    .map((sample) => ({
      minuteOffset: Number(sample.minuteOffset),
      markPrice: finitePositive(sample.markPrice),
    }))
    .filter(
      (sample) =>
        Number.isFinite(sample.minuteOffset) &&
        sample.minuteOffset >= 1 &&
        sample.markPrice !== null,
    )
    .sort((a, b) => a.minuteOffset - b.minuteOffset);
  if (
    actualEntryPrice === null ||
    leverage === null ||
    extraOffsetPercent <= 0 ||
    fillDeadlineMinute < 1 ||
    samples.length < 3
  ) {
    return {
      status: "INSUFFICIENT",
      extraOffsetPercent,
      fillDeadlineMinute,
      candidateEntryPrice: null,
      fillMinute: null,
      evaluationMinute: null,
      actualRoePercent: null,
      candidateRoePercent: null,
      advantageRoePercent: null,
      summary: "分钟收盘标记价不足，暂不能验证更深限价是否真实可成交。",
    };
  }
  const direction = input.positionSide === "LONG" ? -1 : 1;
  const candidateEntryPrice =
    actualEntryPrice * (1 + direction * extraOffsetPercent / 100);
  const evaluationLimit = input.latestEvaluationMinute ?? 10;
  const horizonEvaluation = samples
    .filter((sample) => sample.minuteOffset <= evaluationLimit)
    .at(-1);
  const fill = samples.find((sample) =>
    sample.minuteOffset <= fillDeadlineMinute &&
    (
      input.positionSide === "LONG"
        ? sample.markPrice! <= candidateEntryPrice
        : sample.markPrice! >= candidateEntryPrice
    )
  );
  if (!fill) {
    return {
      status: "NOT_FILLED",
      extraOffsetPercent,
      fillDeadlineMinute,
      candidateEntryPrice,
      fillMinute: null,
      evaluationMinute: horizonEvaluation?.minuteOffset ?? null,
      actualRoePercent: horizonEvaluation
        ? positionRoePercent(
            actualEntryPrice,
            horizonEvaluation.markPrice!,
            leverage,
            input.positionSide,
          )
        : null,
      candidateRoePercent: null,
      advantageRoePercent: null,
      summary:
        `额外偏移 ${extraOffsetPercent.toFixed(3)}% 的限价在第 ${fillDeadlineMinute} 分钟委托截止前没有分钟收盘可确认成交；更深价格会错失本次机会。`,
    };
  }
  const evaluation =
    samples
      .filter(
        (sample) =>
          sample.minuteOffset >= fill.minuteOffset &&
          sample.minuteOffset <= evaluationLimit,
      )
      .at(-1) ??
    samples.filter((sample) => sample.minuteOffset >= fill.minuteOffset).at(-1);
  if (!evaluation) {
    return {
      status: "INSUFFICIENT",
      extraOffsetPercent,
      fillDeadlineMinute,
      candidateEntryPrice,
      fillMinute: fill.minuteOffset,
      evaluationMinute: null,
      actualRoePercent: null,
      candidateRoePercent: null,
      advantageRoePercent: null,
      summary: "更深限价虽可成交，但成交后没有后续分钟收盘用于比较。",
    };
  }
  const actualRoePercent = positionRoePercent(
    actualEntryPrice,
    evaluation.markPrice!,
    leverage,
    input.positionSide,
  );
  const candidateRoePercent = positionRoePercent(
    candidateEntryPrice,
    evaluation.markPrice!,
    leverage,
    input.positionSide,
  );
  const advantageRoePercent = candidateRoePercent - actualRoePercent;
  return {
    status: "FILLED",
    extraOffsetPercent,
    fillDeadlineMinute,
    candidateEntryPrice,
    fillMinute: fill.minuteOffset,
    evaluationMinute: evaluation.minuteOffset,
    actualRoePercent,
    candidateRoePercent,
    advantageRoePercent,
    summary:
      `额外偏移 ${extraOffsetPercent.toFixed(3)}% 的限价在第 ${fill.minuteOffset} 分钟收盘可确认成交；` +
      `到第 ${evaluation.minuteOffset} 分钟，影子ROE ${candidateRoePercent.toFixed(2)}%，比实际入场改善 ${advantageRoePercent.toFixed(2)} 个百分点。`,
  };
}

function finitePositive(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
