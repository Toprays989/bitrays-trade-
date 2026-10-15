export const LIQUIDATION_FACTOR_LEARNING_VERSION =
  "liquidation-factor-learning-v1" as const;

export type LiquidationFactorLearningObservation = {
  traceId: string;
  verdict: string;
  observedAtMs: number;
};

export type LiquidationFactorLearningCycle = {
  traceId: string;
  terminalStatus: string;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  eligibility: string;
  manualIntervention: boolean;
  updatedAtMs: number;
};

export type LiquidationFactorLearningSummary = ReturnType<
  typeof evaluateLiquidationFactorLearning
>;

export function evaluateLiquidationFactorLearning(input: {
  mode: "SHADOW" | "LIVE";
  automaticModeSwitch: boolean;
  configVersion: number;
  targetEpisodes: number;
  minimumExactCycles: number;
  observations: LiquidationFactorLearningObservation[];
  cycles: LiquidationFactorLearningCycle[];
  hasUnpublishedDraft?: boolean;
  validationStatus?: string | null;
}) {
  const latestObservationByTrace = new Map<
    string,
    LiquidationFactorLearningObservation
  >();
  for (const observation of input.observations) {
    if (!observation.traceId) continue;
    const current = latestObservationByTrace.get(observation.traceId);
    if (!current || observation.observedAtMs >= current.observedAtMs)
      latestObservationByTrace.set(observation.traceId, observation);
  }
  const observations = [...latestObservationByTrace.values()];
  const mature = observations.filter(
    (item) => item.verdict !== "WAIT_SERIES",
  );
  const supported = mature.filter(
    (item) => item.verdict === "SUPPORTS_DIRECTION",
  );
  const blocked = mature.filter(
    (item) => item.verdict !== "SUPPORTS_DIRECTION",
  );
  const verdictByTrace = new Map(
    mature.map((item) => [item.traceId, item.verdict]),
  );
  const exactCycles = input.cycles
    .filter(
      (cycle) =>
        verdictByTrace.has(cycle.traceId) &&
        cycle.terminalStatus === "CLOSED" &&
        cycle.exactNetAvailable &&
        Number.isFinite(cycle.exactNetPnlUsdt) &&
        cycle.eligibility === "ELIGIBLE" &&
        !cycle.manualIntervention,
    )
    .sort((left, right) => left.updatedAtMs - right.updatedAtMs);
  const supportedCycles = exactCycles.filter(
    (cycle) => verdictByTrace.get(cycle.traceId) === "SUPPORTS_DIRECTION",
  );
  const requiredExactCycles = Math.max(6, input.minimumExactCycles);
  const holdoutSize = Math.max(2, Math.ceil(requiredExactCycles * 0.3));
  const evaluationWindow = supportedCycles.slice(-requiredExactCycles);
  const training = metrics(evaluationWindow.slice(0, -holdoutSize));
  const holdout = metrics(evaluationWindow.slice(-holdoutSize));
  const candidate = metrics(evaluationWindow);
  const missing: string[] = [];
  if (mature.length < input.targetEpisodes)
    missing.push(`成熟事件段 ${mature.length}/${input.targetEpisodes}`);
  if (supported.length < 5) missing.push(`支持样本 ${supported.length}/5`);
  if (blocked.length < 5) missing.push(`拦截样本 ${blocked.length}/5`);
  if (supportedCycles.length < requiredExactCycles)
    missing.push(`精确闭环 ${supportedCycles.length}/${requiredExactCycles}`);
  if (evaluationWindow.length >= requiredExactCycles) {
    if (!(training.netPnlUsdt > 0)) missing.push("训练样本费用后净收益未转正");
    if (!(holdout.netPnlUsdt > 0)) missing.push("样本外验证费用后净收益未转正");
    if (!(candidate.profitFactor !== null && candidate.profitFactor >= 1.15))
      missing.push("利润因子低于 1.15");
    if (candidate.wins < candidate.losses) missing.push("盈利次数少于亏损次数");
    if (
      candidate.largestWinSharePercent !== null &&
      candidate.largestWinSharePercent > 70
    ) missing.push("单笔盈利占比超过 70%");
  }
  if (input.hasUnpublishedDraft) missing.push("存在尚未发布的人工草稿");

  const readyForLive = input.mode === "SHADOW" && missing.length === 0;
  const validationStatus = input.validationStatus ?? null;
  const phase = input.mode === "SHADOW"
    ? readyForLive
      ? "SHADOW_READY"
      : validationStatus === "ROLLED_BACK" || validationStatus === "RELEARNING"
        ? "RELEARNING"
        : "SHADOW_COLLECTING"
    : validationStatus === "COLLECTING"
      ? "LIVE_VALIDATING"
      : validationStatus === "PROMOTION_READY"
        ? "LIVE_PROMOTION_READY"
        : validationStatus === "ROLLBACK_REQUIRED"
          ? "LIVE_ROLLBACK_REQUIRED"
          : "LIVE_STABLE";
  return {
    version: LIQUIDATION_FACTOR_LEARNING_VERSION,
    configVersion: input.configVersion,
    mode: input.mode,
    automaticModeSwitch: input.automaticModeSwitch,
    phase,
    readyForLive,
    attentionRequired:
      readyForLive ||
      phase === "LIVE_PROMOTION_READY" ||
      phase === "LIVE_ROLLBACK_REQUIRED",
    candidateProposalPending:
      readyForLive && input.automaticModeSwitch && !input.hasUnpublishedDraft,
    targetEpisodes: input.targetEpisodes,
    matureEpisodes: mature.length,
    supportedEpisodes: supported.length,
    blockedEpisodes: blocked.length,
    minimumExactCycles: requiredExactCycles,
    exactSupportedCycles: supportedCycles.length,
    candidate,
    training,
    holdout,
    missing,
  } as const;
}

function metrics(cycles: LiquidationFactorLearningCycle[]) {
  const pnl = cycles.map((cycle) => Number(cycle.exactNetPnlUsdt));
  const gains = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const grossProfit = gains.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    sampleCount: pnl.length,
    wins: gains.length,
    losses: losses.length,
    netPnlUsdt: round(pnl.reduce((sum, value) => sum + value, 0)),
    profitFactor: grossLoss > 0
      ? round(grossProfit / grossLoss)
      : gains.length
        ? Number.POSITIVE_INFINITY
        : null,
    largestWinSharePercent: grossProfit > 0
      ? round(Math.max(...gains) / grossProfit * 100)
      : null,
  };
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}
