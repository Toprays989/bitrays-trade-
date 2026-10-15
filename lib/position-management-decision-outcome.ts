import type {
  PositionManagementAction,
} from "./post-entry-position-management.ts";

export type PositionManagementDecisionOutcome = {
  status:
    | "NO_SIGNAL"
    | "INCOMPLETE"
    | "SUPPORTED"
    | "CONTRADICTED"
    | "INCONCLUSIVE";
  observationOnly: true;
  signalCausalEvidenceReady: boolean;
  signalAction: PositionManagementAction | null;
  signalMinute: number | null;
  signalRoePercent: number | null;
  comparisonMinute: number | null;
  comparisonRoePercent: number | null;
  bestRoeAfterSignal: number | null;
  worstRoeAfterSignal: number | null;
  requiredEdgeRoePercent: number;
  summary: string;
};

export type PositionManagementDecisionOutcomeSummary = {
  sampleCount: number;
  supportedCount: number;
  contradictedCount: number;
  inconclusiveCount: number;
  contradictionRate: number;
  verdict: "KEEP_OBSERVATION_ONLY" | "REVIEW_DECISION_THRESHOLDS";
};

type DecisionSample = {
  minuteOffset: number;
  roePercent: number | null;
  causalEvidenceComplete?: boolean;
  decision?: {
    action?: string | null;
    currentRoePercent?: number | null;
    bestRoePercent?: number | null;
  } | null;
};

const ACTIONS = new Set<PositionManagementAction>([
  "HOLD_FOR_EXTENSION",
  "HOLD_AND_OBSERVE",
  "TIGHTEN_PROFIT_PROTECTION",
  "WAIT_NO_ADD",
  "ADD_ELIGIBLE",
  "SCALE_IN_ELIGIBLE",
  "REDUCE_RISK_BY_EVIDENCE",
  "EXIT_OR_REDUCE_BY_RISK_PLAN",
]);

/**
 * 用判断发生之后的价格路径验证判断，不改变任何真实订单。
 *
 * 每个独立仓位只贡献一个后验结果，避免用同一仓位反复放大样本量；
 * 但应选择最近一次已有更晚样本的方向判断，避免后续管理判断被第一次
 * 判断永久遮蔽。新仓位使用5→30/60分钟，已持有较久的仓位也能使用
 * 120→180/240分钟验证管理判断；后者不能反向证明入场时机。
 * HOLD_AND_OBSERVE 没有可证伪方向，因此不作为信号。
 */
export function evaluatePositionManagementDecisionOutcome(input: {
  samples: DecisionSample[];
  requiredEdgeRoePercent: number;
}): PositionManagementDecisionOutcome {
  const edge = Math.max(
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
        sample.roePercent !== null &&
        Number.isFinite(sample.roePercent),
    )
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
  const directional = (sample: DecisionSample) => {
    const action = normalizedAction(sample.decision?.action);
    return action !== null && action !== "HOLD_AND_OBSERVE";
  };
  const directionalSamples = valid.filter(directional);
  const signal = directionalSamples
    .filter((sample) =>
      valid.some((later) => later.minuteOffset > sample.minuteOffset)
    )
    .at(-1) ?? directionalSamples.at(-1);
  const action = normalizedAction(signal?.decision?.action);
  const signalRoe = signal
    ? finiteOr(
        signal.decision?.currentRoePercent,
        signal.roePercent!,
      )
    : null;
  const common = {
    observationOnly: true as const,
    signalCausalEvidenceReady:
      signal?.causalEvidenceComplete === true,
    signalAction: action,
    signalMinute: signal?.minuteOffset ?? null,
    signalRoePercent: signalRoe,
    comparisonMinute: null,
    comparisonRoePercent: null,
    bestRoeAfterSignal: null,
    worstRoeAfterSignal: null,
    requiredEdgeRoePercent: edge,
  };
  if (!signal || !action || signalRoe === null)
    return {
      ...common,
      status: "NO_SIGNAL",
      summary: "完整周期内没有可做后验验证的持仓方向判断。",
    };
  if (!common.signalCausalEvidenceReady)
    return {
      ...common,
      status: "INCOMPLETE",
      summary:
        `第${signal.minuteOffset}分钟产生 ${actionLabel(action)}，` +
        "但当时的市场事实或持仓证据不完整；本次只保留为历史观察，不评价判断对错，也不进入参数学习。",
    };
  const later = valid.filter(
    (sample) => sample.minuteOffset > signal.minuteOffset,
  );
  if (!later.length)
    return {
      ...common,
      status: "INCOMPLETE",
      summary:
        `第${signal.minuteOffset}分钟产生 ${actionLabel(action)}，` +
        "尚无更晚独立样本，不能验证判断。",
    };

  const latest = later.at(-1)!;
  const bestAfter = Math.max(...later.map((sample) => sample.roePercent!));
  const worstAfter = Math.min(...later.map((sample) => sample.roePercent!));
  const signalBest = finiteOr(
    signal.decision?.bestRoePercent,
    signalRoe,
  );
  const detail = {
    ...common,
    comparisonMinute: latest.minuteOffset,
    comparisonRoePercent: latest.roePercent,
    bestRoeAfterSignal: bestAfter,
    worstRoeAfterSignal: worstAfter,
  };
  const result = classify({
    action,
    signalRoe,
    signalBest,
    latestRoe: latest.roePercent!,
    bestAfter,
    worstAfter,
    edge,
  });
  return {
    ...detail,
    status: result,
    summary:
      `第${signal.minuteOffset}分钟 ${actionLabel(action)}；至第${latest.minuteOffset}分钟 ` +
      `ROE ${signed(latest.roePercent!)}%，后续最好 ${signed(bestAfter)}%、最差 ${signed(worstAfter)}%。` +
      (result === "SUPPORTED"
        ? " 后续路径支持当时判断。"
        : result === "CONTRADICTED"
          ? " 后续路径与当时判断相反，进入阈值复核样本。"
          : ` 差异未超过 ${edge.toFixed(2)} 个ROE百分点，继续观察。`),
  };
}

export function summarizePositionManagementDecisionOutcomes(
  outcomes: Array<
    PositionManagementDecisionOutcome | null | undefined
  >,
  minimumEvaluatedSamples: number,
): PositionManagementDecisionOutcomeSummary {
  const comparable = outcomes.filter(
    (outcome): outcome is PositionManagementDecisionOutcome =>
      Boolean(outcome) &&
      outcome!.signalCausalEvidenceReady === true &&
      ["SUPPORTED", "CONTRADICTED", "INCONCLUSIVE"].includes(
        outcome!.status,
      ),
  );
  const supportedCount = comparable.filter(
    (outcome) => outcome.status === "SUPPORTED",
  ).length;
  const contradictedCount = comparable.filter(
    (outcome) => outcome.status === "CONTRADICTED",
  ).length;
  const inconclusiveCount = comparable.filter(
    (outcome) => outcome.status === "INCONCLUSIVE",
  ).length;
  const evaluatedCount = supportedCount + contradictedCount;
  const contradictionRate = evaluatedCount
    ? contradictedCount / evaluatedCount
    : 0;
  const enough = evaluatedCount >= Math.max(1, minimumEvaluatedSamples);
  return {
    sampleCount: comparable.length,
    supportedCount,
    contradictedCount,
    inconclusiveCount,
    contradictionRate,
    verdict:
      enough &&
        contradictedCount > supportedCount &&
        contradictionRate >= 0.45
        ? "REVIEW_DECISION_THRESHOLDS"
        : "KEEP_OBSERVATION_ONLY",
  };
}

function classify(input: {
  action: PositionManagementAction;
  signalRoe: number;
  signalBest: number;
  latestRoe: number;
  bestAfter: number;
  worstAfter: number;
  edge: number;
}) {
  if (input.action === "HOLD_FOR_EXTENSION") {
    if (input.bestAfter >= input.signalBest + input.edge)
      return "SUPPORTED" as const;
    if (
      input.latestRoe <= input.signalRoe - input.edge &&
      input.bestAfter < input.signalBest + input.edge
    )
      return "CONTRADICTED" as const;
  } else if (input.action === "TIGHTEN_PROFIT_PROTECTION") {
    if (
      input.worstAfter <= input.signalRoe - input.edge &&
      input.bestAfter < input.signalBest + input.edge
    )
      return "SUPPORTED" as const;
    if (
      input.bestAfter >= input.signalBest + input.edge &&
      input.latestRoe >= input.signalRoe
    )
      return "CONTRADICTED" as const;
  } else if (input.action === "WAIT_NO_ADD") {
    if (input.bestAfter <= input.signalRoe + input.edge)
      return "SUPPORTED" as const;
    if (input.bestAfter >= input.signalRoe + input.edge * 2)
      return "CONTRADICTED" as const;
  } else if (
    input.action === "ADD_ELIGIBLE" ||
    input.action === "SCALE_IN_ELIGIBLE"
  ) {
    if (
      input.latestRoe >= input.signalRoe + input.edge &&
      input.worstAfter >= input.signalRoe - input.edge
    )
      return "SUPPORTED" as const;
    if (
      input.worstAfter <= input.signalRoe - input.edge &&
      input.latestRoe < input.signalRoe + input.edge
    )
      return "CONTRADICTED" as const;
  } else if (
    input.action === "REDUCE_RISK_BY_EVIDENCE" ||
    input.action === "EXIT_OR_REDUCE_BY_RISK_PLAN"
  ) {
    if (
      input.latestRoe <= input.signalRoe - input.edge &&
      input.bestAfter < input.signalRoe + input.edge
    )
      return "SUPPORTED" as const;
    if (
      input.bestAfter >= input.signalRoe + input.edge &&
      input.latestRoe > input.signalRoe
    )
      return "CONTRADICTED" as const;
  }
  return "INCONCLUSIVE" as const;
}

function normalizedAction(value: unknown): PositionManagementAction | null {
  return typeof value === "string" &&
      ACTIONS.has(value as PositionManagementAction)
    ? value as PositionManagementAction
    : null;
}

function finiteOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function actionLabel(action: PositionManagementAction) {
  if (action === "HOLD_FOR_EXTENSION") return "继续持有等待延续";
  if (action === "TIGHTEN_PROFIT_PROTECTION") return "收紧利润保护";
  if (action === "WAIT_NO_ADD") return "等待触底、不补仓";
  if (action === "ADD_ELIGIBLE") return "触底反弹补仓候选";
  if (action === "SCALE_IN_ELIGIBLE") return "盈利延续奖励加仓候选";
  if (action === "REDUCE_RISK_BY_EVIDENCE") return "证据恶化、先部分减险";
  if (action === "EXIT_OR_REDUCE_BY_RISK_PLAN") return "趋势失效、交由风险计划";
  return "继续观察";
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}
