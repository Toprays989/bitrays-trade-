export type PostEntryLongHoldStatus =
  | "NOT_DUE"
  | "RECOVERED"
  | "PROFIT_EXTENDING"
  | "GIVEBACK"
  | "WEAKENING"
  | "HOLDING_RANGE";

export type PostEntryLongHoldAnalysis = {
  status: PostEntryLongHoldStatus;
  sampleCount: number;
  latestMinute: number | null;
  latestRoePercent: number | null;
  roe60mPercent: number | null;
  recoveryFrom60mRoePercent: number | null;
  bestPost60mRoePercent: number | null;
  summary: string;
};

type LongHoldSample = {
  minuteOffset: number;
  roePercent?: number | null;
  mfeRoePercent?: number | null;
};

function finiteOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function rounded(value: number | null) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

export function analyzePostEntryLongHold(input: {
  samples: LongHoldSample[];
  firstTakeProfitRoePercent: number;
  trailingActivationRoePercent: number;
  trailingDrawdownRoePercent: number;
}): PostEntryLongHoldAnalysis {
  const ordered = input.samples
    .filter((sample) =>
      Number.isFinite(sample.minuteOffset) &&
      finiteOrNull(sample.roePercent) !== null
    )
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
  const sample60 = ordered.find((sample) => sample.minuteOffset === 60);
  const roe60m = finiteOrNull(sample60?.roePercent);
  const longHoldSamples = ordered.filter((sample) => sample.minuteOffset > 60);
  const latest = longHoldSamples.at(-1);
  const latestRoe = finiteOrNull(latest?.roePercent);
  if (!latest || latestRoe === null) {
    return {
      status: "NOT_DUE",
      sampleCount: 0,
      latestMinute: null,
      latestRoePercent: null,
      roe60mPercent: rounded(roe60m),
      recoveryFrom60mRoePercent: null,
      bestPost60mRoePercent: null,
      summary: "尚未到达 120 分钟长持检查点，继续按原风控计划观察。",
    };
  }

  const bestPost60m = Math.max(
    ...longHoldSamples.map((sample) =>
      finiteOrNull(sample.mfeRoePercent) ?? finiteOrNull(sample.roePercent) ?? 0
    ),
  );
  const recoveryFrom60m = roe60m === null ? null : latestRoe - roe60m;
  const meaningfulProfit = Math.max(
    0.5,
    Math.min(
      input.firstTakeProfitRoePercent > 0
        ? input.firstTakeProfitRoePercent * 0.6
        : Number.POSITIVE_INFINITY,
      input.trailingActivationRoePercent > 0
        ? input.trailingActivationRoePercent * 0.75
        : Number.POSITIVE_INFINITY,
    ),
  );
  const drawdown = Math.max(0.1, input.trailingDrawdownRoePercent);
  let status: PostEntryLongHoldStatus = "HOLDING_RANGE";
  if (
    Number.isFinite(meaningfulProfit) &&
    bestPost60m >= meaningfulProfit &&
    bestPost60m - latestRoe >= drawdown
  ) {
    status = "GIVEBACK";
  } else if (roe60m !== null && roe60m <= 0 && latestRoe > 0) {
    status = "RECOVERED";
  } else if (
    latestRoe > 0 &&
    (roe60m === null || latestRoe - roe60m >= 0.5)
  ) {
    status = "PROFIT_EXTENDING";
  } else if (roe60m !== null && latestRoe - roe60m <= -0.5) {
    status = "WEAKENING";
  }

  const changeText = recoveryFrom60m === null
    ? "缺少 60 分钟基准"
    : `较 60 分钟${recoveryFrom60m >= 0 ? "改善" : "回落"} ${Math.abs(recoveryFrom60m).toFixed(2)} 个 ROE 百分点`;
  const statusText = status === "RECOVERED"
    ? "首小时承压后已经转正"
    : status === "PROFIT_EXTENDING"
      ? "长持阶段利润继续扩展"
      : status === "GIVEBACK"
        ? "长持阶段出现有效盈利回吐"
        : status === "WEAKENING"
          ? "60 分钟后走势继续弱化"
          : "仍在正常波动区间";
  return {
    status,
    sampleCount: longHoldSamples.length,
    latestMinute: latest.minuteOffset,
    latestRoePercent: rounded(latestRoe),
    roe60mPercent: rounded(roe60m),
    recoveryFrom60mRoePercent: rounded(recoveryFrom60m),
    bestPost60mRoePercent: rounded(bestPost60m),
    summary:
      `第 ${latest.minuteOffset} 分钟 ROE ${latestRoe.toFixed(2)}%，${changeText}；${statusText}。` +
      "该结论用于持仓退出模型，与 5/30/60 分钟入场质量模型分开统计。",
  };
}
