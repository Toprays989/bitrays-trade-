export const NEXUS_LEARNING_ATTRIBUTION_VERSION =
  "nexus-learning-attribution-v1" as const;

export type NexusLearningCauseTag =
  | "DIRECTION_ERROR"
  | "ENTRY_TOO_EARLY"
  | "ENTRY_CHASED"
  | "SIZE_EXCEEDED_PLAN"
  | "EXECUTION_DEGRADED"
  | "PROTECTION_PREMATURE"
  | "PROTECTION_NEGATIVE_EXIT"
  | "VALID_PROCESS_LOSS"
  | "POSITIVE_PROCESS_VALIDATION"
  | "INCONCLUSIVE";

export type NexusLearningDimension =
  | "DIRECTION"
  | "ENTRY_TIMING"
  | "SIZING"
  | "EXECUTION"
  | "PROTECTION";

export type NexusLearningDimensionVerdict =
  | "SUPPORTED"
  | "CORRECTIVE"
  | "NEUTRAL"
  | "INSUFFICIENT";

export type NexusLearningAttribution = {
  version: typeof NEXUS_LEARNING_ATTRIBUTION_VERSION;
  status: "READY" | "OBSERVATION_ONLY" | "INCOMPLETE";
  primaryCause: NexusLearningCauseTag;
  causeTags: NexusLearningCauseTag[];
  dimensions: Record<
    NexusLearningDimension,
    {
      verdict: NexusLearningDimensionVerdict;
      learningEligible: boolean;
      evidence: string[];
    }
  >;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

type Hypotheses = {
  waveDirection?: string | null;
  entryTiming?: string | null;
  positionManagement?: string | null;
};

/**
 * 把完整周期结果拆成互不混淆的归因维度。亏损本身不是方向错误，
 * 盈利本身也不是全部证据正确；缺少计划风险或执行证据时明确保留
 * INSUFFICIENT，避免把结果倒灌成原因。
 */
export function buildNexusLearningAttribution(input: {
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED";
  causalAttributionReady: boolean;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  hypotheses?: Hypotheses | null;
  entrySlippagePercent?: number | null;
  adverseSlippageThresholdPercent?: number | null;
  plannedRiskUsdt?: number | null;
  actualRiskLossUsdt?: number | null;
  finalExitReason?: string | null;
}): NexusLearningAttribution {
  const hypotheses = input.hypotheses ?? {};
  const exactNetPnlUsdt = finiteOrNull(input.exactNetPnlUsdt);
  const exactNetReady = input.exactNetAvailable && exactNetPnlUsdt !== null;
  const causalReady =
    input.terminalStatus !== "OPEN" && input.causalAttributionReady;
  const ready = causalReady && exactNetReady;
  const slippage = finiteOrNull(input.entrySlippagePercent);
  const slippageThreshold = Math.max(
    0.01,
    finiteOrNull(input.adverseSlippageThresholdPercent) ?? 0.15,
  );
  const plannedRisk = positiveOrNull(input.plannedRiskUsdt);
  const actualRiskLoss = nonNegativeOrNull(input.actualRiskLossUsdt);
  const exitReason = clean(input.finalExitReason).toUpperCase();

  const dimensions: NexusLearningAttribution["dimensions"] = {
    DIRECTION: dimension(
      !causalReady
        ? "INSUFFICIENT"
        : hypotheses.waveDirection === "SUPPORTED"
          ? "SUPPORTED"
          : hypotheses.waveDirection === "CONTRADICTED"
            ? "CORRECTIVE"
            : "NEUTRAL",
      causalReady && ["SUPPORTED", "CONTRADICTED"].includes(
        String(hypotheses.waveDirection),
      ),
      [
        hypotheses.waveDirection
          ? `WAVE_DIRECTION:${hypotheses.waveDirection}`
          : "WAVE_DIRECTION:UNAVAILABLE",
      ],
    ),
    ENTRY_TIMING: dimension(
      !causalReady
        ? "INSUFFICIENT"
        : hypotheses.entryTiming === "SUPPORTED"
          ? "SUPPORTED"
          : ["TOO_EARLY", "CHASED"].includes(
                String(hypotheses.entryTiming),
              )
            ? "CORRECTIVE"
            : "NEUTRAL",
      causalReady &&
        ["SUPPORTED", "TOO_EARLY", "CHASED"].includes(
          String(hypotheses.entryTiming),
        ),
      [
        hypotheses.entryTiming
          ? `ENTRY_TIMING:${hypotheses.entryTiming}`
          : "ENTRY_TIMING:UNAVAILABLE",
      ],
    ),
    SIZING: dimension(
      plannedRisk === null || actualRiskLoss === null
        ? "INSUFFICIENT"
        : actualRiskLoss > plannedRisk * 1.05
          ? "CORRECTIVE"
          : "SUPPORTED",
      ready && plannedRisk !== null && actualRiskLoss !== null,
      plannedRisk === null || actualRiskLoss === null
        ? ["RISK_PLAN_OR_ACTUAL_LOSS:UNAVAILABLE"]
        : [
            `PLANNED_RISK_USDT:${plannedRisk}`,
            `ACTUAL_RISK_LOSS_USDT:${actualRiskLoss}`,
          ],
    ),
    EXECUTION: dimension(
      slippage === null
        ? "INSUFFICIENT"
        : slippage > slippageThreshold
          ? "CORRECTIVE"
          : "SUPPORTED",
      ready && slippage !== null,
      slippage === null
        ? ["ENTRY_SLIPPAGE:UNAVAILABLE"]
        : [
            `ENTRY_SLIPPAGE_PERCENT:${slippage}`,
            `ADVERSE_THRESHOLD_PERCENT:${slippageThreshold}`,
          ],
    ),
    PROTECTION: dimension(
      !causalReady || !exitReason
        ? "INSUFFICIENT"
        : (exactNetReady &&
              exactNetPnlUsdt! < 0 &&
              exitReason === "TAKE_PROFIT") ||
            hypotheses.positionManagement === "CONTRADICTED"
            ? "CORRECTIVE"
            : hypotheses.positionManagement === "SUPPORTED"
              ? "SUPPORTED"
            : "NEUTRAL",
      ready &&
        Boolean(exitReason) &&
        (["SUPPORTED", "CONTRADICTED"].includes(
          String(hypotheses.positionManagement),
        ) || exitReason === "TAKE_PROFIT"),
      [
        exitReason ? `EXIT_REASON:${exitReason}` : "EXIT_REASON:UNAVAILABLE",
        hypotheses.positionManagement
          ? `POSITION_MANAGEMENT:${hypotheses.positionManagement}`
          : "POSITION_MANAGEMENT:UNAVAILABLE",
      ],
    ),
  };

  const causeTags: NexusLearningCauseTag[] = [];
  if (!ready) causeTags.push("INCONCLUSIVE");
  if (dimensions.DIRECTION.verdict === "CORRECTIVE")
    causeTags.push("DIRECTION_ERROR");
  if (hypotheses.entryTiming === "TOO_EARLY")
    causeTags.push("ENTRY_TOO_EARLY");
  if (hypotheses.entryTiming === "CHASED") causeTags.push("ENTRY_CHASED");
  if (dimensions.SIZING.verdict === "CORRECTIVE")
    causeTags.push("SIZE_EXCEEDED_PLAN");
  if (dimensions.EXECUTION.verdict === "CORRECTIVE")
    causeTags.push("EXECUTION_DEGRADED");
  if (
    exactNetReady &&
    exactNetPnlUsdt! < 0 &&
    exitReason === "TAKE_PROFIT"
  ) causeTags.push("PROTECTION_NEGATIVE_EXIT");
  else if (dimensions.PROTECTION.verdict === "CORRECTIVE")
    causeTags.push("PROTECTION_PREMATURE");

  const correctiveDimensions = Object.values(dimensions).filter(
    (item) => item.verdict === "CORRECTIVE",
  ).length;
  if (ready && exactNetPnlUsdt! < 0 && correctiveDimensions === 0)
    causeTags.push("VALID_PROCESS_LOSS");
  if (ready && exactNetPnlUsdt! > 0 && correctiveDimensions === 0)
    causeTags.push("POSITIVE_PROCESS_VALIDATION");
  const uniqueTags = [...new Set(causeTags)];
  const primaryCause = selectPrimaryCause(uniqueTags);

  return {
    version: NEXUS_LEARNING_ATTRIBUTION_VERSION,
    status: ready
      ? "READY"
      : input.terminalStatus === "OPEN"
        ? "INCOMPLETE"
        : "OBSERVATION_ONLY",
    primaryCause,
    causeTags: uniqueTags,
    dimensions,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    summary: attributionSummary(primaryCause, dimensions),
  };
}

function dimension(
  verdict: NexusLearningDimensionVerdict,
  learningEligible: boolean,
  evidence: string[],
) {
  return { verdict, learningEligible, evidence };
}

function selectPrimaryCause(tags: NexusLearningCauseTag[]) {
  const precedence: NexusLearningCauseTag[] = [
    "PROTECTION_NEGATIVE_EXIT",
    "DIRECTION_ERROR",
    "ENTRY_CHASED",
    "ENTRY_TOO_EARLY",
    "EXECUTION_DEGRADED",
    "SIZE_EXCEEDED_PLAN",
    "PROTECTION_PREMATURE",
    "VALID_PROCESS_LOSS",
    "POSITIVE_PROCESS_VALIDATION",
    "INCONCLUSIVE",
  ];
  return precedence.find((tag) => tags.includes(tag)) ?? "INCONCLUSIVE";
}

function attributionSummary(
  primaryCause: NexusLearningCauseTag,
  dimensions: NexusLearningAttribution["dimensions"],
) {
  const labels: Record<NexusLearningCauseTag, string> = {
    DIRECTION_ERROR: "方向判断被后续路径反证",
    ENTRY_TOO_EARLY: "方向可能成立，但入场偏早",
    ENTRY_CHASED: "入场发生在追价阶段",
    SIZE_EXCEEDED_PLAN: "实际风险损失超过计划",
    EXECUTION_DEGRADED: "成交滑点超过执行阈值",
    PROTECTION_PREMATURE: "退出保护被后续路径反证",
    PROTECTION_NEGATIVE_EXIT: "止盈名义退出产生了负净收益",
    VALID_PROCESS_LOSS: "流程证据成立但本周期仍亏损",
    POSITIVE_PROCESS_VALIDATION: "净盈利且已验证维度未发现反证",
    INCONCLUSIVE: "证据不足，只保留观察",
  };
  const eligible = Object.entries(dimensions)
    .filter(([, value]) => value.learningEligible)
    .map(([key]) => key)
    .join("/");
  return `主归因：${labels[primaryCause]}；可学习维度 ${eligible || "暂无"}。`;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveOrNull(value: unknown) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function nonNegativeOrNull(value: unknown) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}
