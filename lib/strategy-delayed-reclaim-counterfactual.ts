import { positionRoePercent } from "./position-roe.ts";

export type DelayedReclaimCounterfactual = {
  status:
    | "ENTERED"
    | "NO_CONFIRMATION"
    | "NOT_APPLICABLE"
    | "INSUFFICIENT";
  adverseTriggerRoePercent: number;
  requiredRecoveryFraction: number;
  adverseMinute: number | null;
  confirmationMinute: number | null;
  candidateEntryPrice: number | null;
  evaluationMinute: number | null;
  actualRoePercent: number | null;
  candidateRoePercent: number | null;
  advantageRoePercent: number | null;
  summary: string;
};

export function evaluateDelayedReclaimCounterfactual(input: {
  positionSide: "LONG" | "SHORT";
  actualEntryPrice: number | null;
  leverage: number;
  stopLossRoePercent: number;
  samples: Array<{
    minuteOffset: number;
    markPrice?: number | null;
  }>;
  confirmationDeadlineMinute?: number;
  evaluationMinute?: number;
  requiredRecoveryFraction?: number;
}): DelayedReclaimCounterfactual {
  const actualEntryPrice = finitePositive(input.actualEntryPrice);
  const leverage = finitePositive(input.leverage);
  const adverseTriggerRoePercent = Math.max(
    0.5,
    Math.max(0, Number(input.stopLossRoePercent) || 0) * 0.25,
  );
  const requiredRecoveryFraction = clamp(
    Number(input.requiredRecoveryFraction) || 0.35,
    0.1,
    0.9,
  );
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
  const base = {
    adverseTriggerRoePercent,
    requiredRecoveryFraction,
  };
  if (actualEntryPrice === null || leverage === null || samples.length < 3) {
    return {
      status: "INSUFFICIENT",
      ...base,
      adverseMinute: null,
      confirmationMinute: null,
      candidateEntryPrice: null,
      evaluationMinute: null,
      actualRoePercent: null,
      candidateRoePercent: null,
      advantageRoePercent: null,
      summary: "分钟收盘样本不足，无法建立延迟收回入场对照。",
    };
  }
  const deadline = input.confirmationDeadlineMinute ?? 5;
  const candidates = samples.filter(
    (sample) => sample.minuteOffset <= deadline,
  );
  let extremePrice = actualEntryPrice;
  let extremeMinute: number | null = null;
  let adverseReached = false;
  let confirmation:
    | { minuteOffset: number; markPrice: number }
    | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const sample = candidates[index]!;
    const price = sample.markPrice!;
    const isMoreAdverse = input.positionSide === "LONG"
      ? price < extremePrice
      : price > extremePrice;
    if (isMoreAdverse) {
      extremePrice = price;
      extremeMinute = sample.minuteOffset;
    }
    const adverseRoe = positionRoePercent(
      actualEntryPrice,
      extremePrice,
      leverage,
      input.positionSide,
    );
    if (adverseRoe <= -adverseTriggerRoePercent) adverseReached = true;
    if (!adverseReached || extremeMinute === null || index < 2) continue;
    const previous = candidates[index - 1]!;
    const beforePrevious = candidates[index - 2]!;
    const consecutiveRecovery = input.positionSide === "LONG"
      ? price > previous.markPrice! &&
        previous.markPrice! > beforePrevious.markPrice!
      : price < previous.markPrice! &&
        previous.markPrice! < beforePrevious.markPrice!;
    if (!consecutiveRecovery) continue;
    const totalAdverseDistance = Math.abs(actualEntryPrice - extremePrice);
    const recoveredDistance = input.positionSide === "LONG"
      ? price - extremePrice
      : extremePrice - price;
    const recoveryFraction = totalAdverseDistance > 0
      ? recoveredDistance / totalAdverseDistance
      : 0;
    if (recoveryFraction >= requiredRecoveryFraction) {
      confirmation = {
        minuteOffset: sample.minuteOffset,
        markPrice: price,
      };
      break;
    }
  }

  const evaluationTarget = input.evaluationMinute ?? 10;
  const evaluation =
    samples.filter((sample) => sample.minuteOffset <= evaluationTarget).at(-1);
  const actualRoePercent = evaluation
    ? positionRoePercent(
        actualEntryPrice,
        evaluation.markPrice!,
        leverage,
        input.positionSide,
      )
    : null;
  if (!adverseReached) {
    return {
      status: "NO_CONFIRMATION",
      ...base,
      adverseMinute: null,
      confirmationMinute: null,
      candidateEntryPrice: null,
      evaluationMinute: evaluation?.minuteOffset ?? null,
      actualRoePercent,
      candidateRoePercent: null,
      advantageRoePercent: null,
      summary: `前${deadline}分钟未先出现 -${adverseTriggerRoePercent.toFixed(2)}% ROE逆向波动，因此没有形成“下探后收回”入场；延迟方案会错失本次机会。`,
    };
  }
  if (!confirmation || !evaluation) {
    return {
      status: "NO_CONFIRMATION",
      ...base,
      adverseMinute: extremeMinute,
      confirmationMinute: null,
      candidateEntryPrice: null,
      evaluationMinute: evaluation?.minuteOffset ?? null,
      actualRoePercent,
      candidateRoePercent: null,
      advantageRoePercent: null,
      summary:
        `第 ${extremeMinute} 分钟出现明显逆向波动，但截至第 ${deadline} 分钟没有连续收盘收回；延迟规则会跳过本次订单。`,
    };
  }
  const candidateRoePercent = positionRoePercent(
    confirmation.markPrice,
    evaluation.markPrice!,
    leverage,
    input.positionSide,
  );
  const advantageRoePercent =
    actualRoePercent === null ? null : candidateRoePercent - actualRoePercent;
  return {
    status: "ENTERED",
    ...base,
    adverseMinute: extremeMinute,
    confirmationMinute: confirmation.minuteOffset,
    candidateEntryPrice: confirmation.markPrice,
    evaluationMinute: evaluation.minuteOffset,
    actualRoePercent,
    candidateRoePercent,
    advantageRoePercent,
    summary:
      `第 ${extremeMinute} 分钟出现明显逆向波动，第 ${confirmation.minuteOffset} 分钟连续收盘收回后影子入场；` +
      `到第 ${evaluation.minuteOffset} 分钟ROE ${candidateRoePercent.toFixed(2)}%，相对实际入场 ${advantageRoePercent! >= 0 ? "改善" : "减少"} ${Math.abs(advantageRoePercent!).toFixed(2)} 个百分点。`,
  };
}

function finitePositive(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
