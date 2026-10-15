export type CapitalExitShadowStatus =
  | "NO_SIGNAL"
  | "INCOMPLETE"
  | "PROTECTIVE"
  | "MISSED_RECOVERY"
  | "NEUTRAL";

export type CapitalExitShadow = {
  status: CapitalExitShadowStatus;
  observationOnly: true;
  signalMinute: number | null;
  signalRoePercent: number | null;
  latestComparisonMinute: number | null;
  latestComparisonRoePercent: number | null;
  advantageVsLatestRoePercent: number | null;
  bestRecoveryAfterSignalRoePercent: number | null;
  missedRecoveryRoePercent: number | null;
  requiredEdgeRoePercent: number;
  summary: string;
};

export function evaluateCapitalWithdrawalExitShadow(input: {
  samples: Array<{
    minuteOffset: number;
    roePercent: number | null;
    largeTraderStatus: string | null;
  }>;
  requiredEdgeRoePercent: number;
}): CapitalExitShadow {
  const requiredEdgeRoePercent = Math.max(
    0.1,
    Number.isFinite(input.requiredEdgeRoePercent)
      ? input.requiredEdgeRoePercent
      : 0.5,
  );
  const valid = input.samples
    .filter(
      (sample) =>
        Number.isFinite(sample.minuteOffset) &&
        sample.minuteOffset > 0 &&
        sample.minuteOffset <= 30 &&
        sample.roePercent !== null &&
        Number.isFinite(sample.roePercent),
    )
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
  const signal = valid.find(
    (sample) => sample.largeTraderStatus === "CAPITAL_WITHDRAWAL",
  );
  const common = {
    observationOnly: true as const,
    signalMinute: signal?.minuteOffset ?? null,
    signalRoePercent: signal?.roePercent ?? null,
    latestComparisonMinute: null,
    latestComparisonRoePercent: null,
    advantageVsLatestRoePercent: null,
    bestRecoveryAfterSignalRoePercent: null,
    missedRecoveryRoePercent: null,
    requiredEdgeRoePercent,
  };
  if (!signal)
    return {
      ...common,
      status: "NO_SIGNAL",
      summary: "观察窗口内没有承接资金撤退信号。",
    };
  const later = valid.filter(
    (sample) => sample.minuteOffset > signal.minuteOffset,
  );
  if (!later.length)
    return {
      ...common,
      status: "INCOMPLETE",
      summary: `第${signal.minuteOffset}分钟出现资金撤退，但尚无更晚价格样本，不能评价提前退出。`,
    };
  const latest = later.at(-1)!;
  const bestRecoveryAfterSignalRoePercent = Math.max(
    ...later.map((sample) => sample.roePercent!),
  );
  const advantageVsLatestRoePercent =
    signal.roePercent! - latest.roePercent!;
  const missedRecoveryRoePercent =
    bestRecoveryAfterSignalRoePercent - signal.roePercent!;
  const detail = {
    ...common,
    latestComparisonMinute: latest.minuteOffset,
    latestComparisonRoePercent: latest.roePercent,
    advantageVsLatestRoePercent,
    bestRecoveryAfterSignalRoePercent,
    missedRecoveryRoePercent,
  };
  if (
    advantageVsLatestRoePercent >= requiredEdgeRoePercent &&
    advantageVsLatestRoePercent >= missedRecoveryRoePercent
  )
    return {
      ...detail,
      status: "PROTECTIVE",
      summary:
        `若第${signal.minuteOffset}分钟按撤退信号退出，相对第${latest.minuteOffset}分钟可多保留 ` +
        `${advantageVsLatestRoePercent.toFixed(2)}% ROE，超过 ${requiredEdgeRoePercent.toFixed(2)}% 执行缓冲。`,
    };
  if (
    missedRecoveryRoePercent >= requiredEdgeRoePercent &&
    missedRecoveryRoePercent > advantageVsLatestRoePercent
  )
    return {
      ...detail,
      status: "MISSED_RECOVERY",
      summary:
        `撤退信号后价格最多恢复 ${missedRecoveryRoePercent.toFixed(2)}% ROE；立即退出可能错失恢复，不宜直接接入实盘。`,
    };
  return {
    ...detail,
    status: "NEUTRAL",
    summary:
      `撤退退出相对后续ROE差异未超过 ${requiredEdgeRoePercent.toFixed(2)}% 执行缓冲，暂不具备退出价值。`,
  };
}
