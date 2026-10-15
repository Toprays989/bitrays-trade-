import {
  buildNexusOpportunityLifecycle,
  type NexusOpportunityDecisionLane,
  type NexusOpportunityLifecycleResult,
} from "./nexus-opportunity-lifecycle.ts";
import {
  buildNexusLearningAttribution,
  type NexusLearningAttribution,
} from "./nexus-learning-attribution.ts";
import {
  EXIT_COUNTERFACTUAL_VERSION,
  type ExitCounterfactualClassification,
  type ExitCounterfactualExecutionTiming,
  type ExitCounterfactualExitReason,
  type ExitCounterfactualPathOutcome,
} from "./exit-counterfactual.ts";

export const NEXUS_LIFECYCLE_RETROSPECTIVE_VERSION =
  "nexus-lifecycle-retrospective-v2" as const;

type NexusExitCounterfactualCheckpoint = {
  version: string;
  reductionId: number | null;
  positionId: number | null;
  exitReason: ExitCounterfactualExitReason | null;
  exitAtMs: number | null;
  labelAvailableAtMs: number | null;
  horizonMinutes: number;
  classification: ExitCounterfactualClassification;
  pathOutcome: ExitCounterfactualPathOutcome;
  executionTiming: ExitCounterfactualExecutionTiming;
  directionReturnPercent: number | null;
  postExitMfePercent: number | null;
  postExitMaePercent: number | null;
  materialMovePercent: number | null;
  postExitVolumeRatio: number | null;
  favorableBeforeAdverse: boolean | null;
  tailWaveReasonCode: string | null;
  historicalLabelOnly: true;
};

export type NexusLifecycleRetrospective = {
  version: typeof NEXUS_LIFECYCLE_RETROSPECTIVE_VERSION;
  status: "OPEN" | "COMPLETE" | "OBSERVATION_ONLY";
  finalOutcome: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN" | "UNKNOWN";
  exactNetPnlUsdt: number | null;
  causalAttributionReady: boolean;
  backwardTimeline: Array<{
    stage: "TERMINAL" | "CHECKPOINT";
    minuteOffset: number | null;
    roePercent: number | null;
    mfeRoePercent: number | null;
    maeRoePercent: number | null;
  }>;
  hypotheses: {
    waveDirection:
      | "SUPPORTED"
      | "CONTRADICTED"
      | "UNRESOLVED"
      | "INSUFFICIENT";
    entryTiming:
      | "SUPPORTED"
      | "TOO_EARLY"
      | "CHASED"
      | "UNRESOLVED";
    positionManagement:
      | "SUPPORTED"
      | "CONTRADICTED"
      | "INCONCLUSIVE"
      | "UNRESOLVED";
    fundingVolume:
      | "SUPPORTED"
      | "RISK_WARNED"
      | "MIXED"
      | "INSUFFICIENT";
    entryVolumeTiming:
      | "SUPPORTED"
      | "UNCONFIRMED"
      | "INSUFFICIENT";
  };
  summaries: string[];
  opportunityLifecycle: NexusOpportunityLifecycleResult;
  causalAttribution: NexusLearningAttribution;
  exitCounterfactual?: {
    version: typeof EXIT_COUNTERFACTUAL_VERSION;
    checkpoints: NexusExitCounterfactualCheckpoint[];
    latestClassification: ExitCounterfactualClassification | null;
    latestExitReason: ExitCounterfactualExitReason | null;
    latestPathOutcome: ExitCounterfactualPathOutcome | null;
    latestExecutionTiming: ExitCounterfactualExecutionTiming | null;
    historicalLabelOnly: true;
    summary: string;
    orderAffecting: false;
    liveConfigMutationAllowed: false;
  };
  singleCycleParameterMutationAllowed: false;
};

export function buildNexusLifecycleRetrospective(input: {
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED";
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  finalOutcome: NexusLifecycleRetrospective["finalOutcome"];
  causalAttributionReady: boolean;
  checkpoints: Array<{
    minuteOffset: number;
    roePercent?: number | null;
    mfeRoePercent?: number | null;
    maeRoePercent?: number | null;
  }>;
  waveDirectionVerdict?: string | null;
  waveEntryTimingVerdict?: string | null;
  waveSummary?: string | null;
  positionManagementStatus?: string | null;
  positionManagementSummary?: string | null;
  fundingVolumeObservations?: Array<{
    minuteOffset: number;
    status?: string | null;
    summary?: string | null;
  }>;
  entryVolumeTimingState?: string | null;
  entryVolumeTimingSummary?: string | null;
  decisionLane?: NexusOpportunityDecisionLane;
  holdingDurationMinutes?: number | null;
  finalExitReason?: string | null;
  entrySlippagePercent?: number | null;
  plannedRiskUsdt?: number | null;
  actualRiskLossUsdt?: number | null;
  exitCounterfactual?: Array<{
    version?: string;
    reductionId?: number | null;
    positionId?: number | null;
    exitReason?: ExitCounterfactualExitReason | null;
    exitAtMs?: number | null;
    labelAvailableAtMs?: number | null;
    horizonMinutes: number;
    classification: ExitCounterfactualClassification;
    pathOutcome?: ExitCounterfactualPathOutcome;
    executionTiming?: ExitCounterfactualExecutionTiming;
    directionReturnPercent?: number | null;
    postExitMfePercent?: number | null;
    postExitMaePercent?: number | null;
    materialMovePercent?: number | null;
    postExitVolumeRatio?: number | null;
    favorableBeforeAdverse?: boolean | null;
    tailWaveReasonCode?: string | null;
    historicalLabelOnly?: boolean;
  }>;
}) {
  const exactNetPnlUsdt =
    input.exactNetAvailable && Number.isFinite(input.exactNetPnlUsdt)
      ? Number(input.exactNetPnlUsdt)
      : null;
  const checkpoints = input.checkpoints
    .filter(
      (checkpoint) =>
        Number.isFinite(checkpoint.minuteOffset) &&
        checkpoint.minuteOffset > 0,
    )
    .sort((left, right) => right.minuteOffset - left.minuteOffset)
    .map((checkpoint) => ({
      stage: "CHECKPOINT" as const,
      minuteOffset: Math.trunc(checkpoint.minuteOffset),
      roePercent: finiteOrNull(checkpoint.roePercent),
      mfeRoePercent: finiteOrNull(checkpoint.mfeRoePercent),
      maeRoePercent: finiteOrNull(checkpoint.maeRoePercent),
    }));
  const backwardTimeline = [
    {
      stage: "TERMINAL" as const,
      minuteOffset: null,
      roePercent: null,
      mfeRoePercent: null,
      maeRoePercent: null,
    },
    ...checkpoints,
  ];
  const waveDirection = normalizeWaveDirection(
    input.waveDirectionVerdict,
  );
  const entryTiming = normalizeEntryTiming(
    input.waveEntryTimingVerdict,
  );
  const positionManagement = normalizePositionManagement(
    input.positionManagementStatus,
  );
  const fundingVolume = normalizeFundingVolume(
    input.fundingVolumeObservations,
  );
  const fundingVolumeSummary = latestFundingVolumeSummary(
    input.fundingVolumeObservations,
  );
  const entryVolumeTiming = normalizeEntryVolumeTiming(
    input.entryVolumeTimingState,
  );
  const entryVolumeTimingSummary = clean(input.entryVolumeTimingSummary)
    ? `入场量价时序：${clean(input.entryVolumeTimingSummary)}`
    : input.entryVolumeTimingState
      ? `入场量价时序：${clean(input.entryVolumeTimingState)}`
      : "";
  const opportunityLifecycle = buildNexusOpportunityLifecycle({
    decisionLane:
      input.decisionLane ??
      (input.terminalStatus === "REJECTED"
        ? "SHADOW_SKIP"
        : "CONFIRMED_ENTRY"),
    terminalStatus: input.terminalStatus,
    exactNetAvailable: input.exactNetAvailable,
    exactNetPnlUsdt,
    causalAttributionReady: input.causalAttributionReady,
    checkpoints: input.checkpoints,
    holdingDurationMinutes: input.holdingDurationMinutes,
    waveDirectionVerdict: input.waveDirectionVerdict,
    waveEntryTimingVerdict: input.waveEntryTimingVerdict,
    positionManagementStatus: input.positionManagementStatus,
    finalExitReason: input.finalExitReason,
  });
  const causalAttribution = buildNexusLearningAttribution({
    terminalStatus: input.terminalStatus,
    causalAttributionReady: input.causalAttributionReady,
    exactNetAvailable: input.exactNetAvailable,
    exactNetPnlUsdt,
    hypotheses: {
      waveDirection,
      entryTiming,
      positionManagement,
    },
    entrySlippagePercent: input.entrySlippagePercent,
    plannedRiskUsdt: input.plannedRiskUsdt,
    actualRiskLossUsdt: input.actualRiskLossUsdt,
    finalExitReason: input.finalExitReason,
  });
  const exitCounterfactualCheckpoints = [...(input.exitCounterfactual ?? [])]
    .filter(
      (item) =>
        Number.isInteger(item.horizonMinutes) && item.horizonMinutes > 0,
    )
    .sort((left, right) =>
      (finiteOrNull(left.exitAtMs) ?? 0) -
        (finiteOrNull(right.exitAtMs) ?? 0) ||
      left.horizonMinutes - right.horizonMinutes
    )
    .map((item) => ({
      version: clean(item.version) || EXIT_COUNTERFACTUAL_VERSION,
      reductionId: positiveIntegerOrNull(item.reductionId),
      positionId: positiveIntegerOrNull(item.positionId),
      exitReason: normalizeExitReason(item.exitReason),
      exitAtMs: finiteOrNull(item.exitAtMs),
      labelAvailableAtMs: finiteOrNull(item.labelAvailableAtMs),
      horizonMinutes: item.horizonMinutes,
      classification: item.classification,
      pathOutcome: normalizePathOutcome(
        item.pathOutcome,
        item.classification,
      ),
      executionTiming: normalizeExecutionTiming(
        item.executionTiming,
        item.classification,
      ),
      directionReturnPercent: finiteOrNull(item.directionReturnPercent),
      postExitMfePercent: finiteOrNull(item.postExitMfePercent),
      postExitMaePercent: finiteOrNull(item.postExitMaePercent),
      materialMovePercent: finiteOrNull(item.materialMovePercent),
      postExitVolumeRatio: finiteOrNull(item.postExitVolumeRatio),
      favorableBeforeAdverse:
        typeof item.favorableBeforeAdverse === "boolean"
          ? item.favorableBeforeAdverse
          : null,
      tailWaveReasonCode: clean(item.tailWaveReasonCode) || null,
      historicalLabelOnly: true as const,
    }));
  const latestExitCounterfactual = exitCounterfactualCheckpoints.at(-1) ?? null;
  const exitCounterfactual = exitCounterfactualCheckpoints.length
    ? {
        version: EXIT_COUNTERFACTUAL_VERSION,
        checkpoints: exitCounterfactualCheckpoints,
        latestClassification: latestExitCounterfactual?.classification ?? null,
        latestExitReason: latestExitCounterfactual?.exitReason ?? null,
        latestPathOutcome: latestExitCounterfactual?.pathOutcome ?? null,
        latestExecutionTiming:
          latestExitCounterfactual?.executionTiming ?? null,
        historicalLabelOnly: true as const,
        summary:
          `已对 ${new Set(exitCounterfactualCheckpoints.map((item) =>
            item.reductionId ?? `legacy-${item.positionId ?? "unknown"}`
          )).size} 次退出完成 ${exitCounterfactualCheckpoints.length} 个` +
          `后验路径标签；最新 ${latestExitCounterfactual?.exitReason ?? "退出"}` +
          `结论 ${latestExitCounterfactual?.pathOutcome ?? "INCONCLUSIVE"}。` +
          "未来价格只作历史标签，不参与原订单判断。",
        orderAffecting: false as const,
        liveConfigMutationAllowed: false as const,
      }
    : null;
  const summaries = [
    clean(input.waveSummary),
    clean(input.positionManagementSummary),
    fundingVolumeSummary,
    entryVolumeTimingSummary,
    exactNetPnlUsdt === null
      ? "终局精确净收益尚未完成，不允许形成因果调参结论。"
      : `完整周期精确净收益 ${signed(exactNetPnlUsdt)} USDT。`,
    input.causalAttributionReady
      ? "入场事实与持仓检查点具备因果归因条件。"
      : "证据尚不完整，本周期只形成观察记忆，不把结果倒灌成原因。",
    opportunityLifecycle.summary,
    causalAttribution.summary,
    exitCounterfactual?.summary ?? "",
  ].filter(Boolean);
  return {
    version: NEXUS_LIFECYCLE_RETROSPECTIVE_VERSION,
    status:
      input.terminalStatus === "OPEN"
        ? "OPEN" as const
        : exactNetPnlUsdt !== null && input.causalAttributionReady
          ? "COMPLETE" as const
          : "OBSERVATION_ONLY" as const,
    finalOutcome: input.finalOutcome,
    exactNetPnlUsdt,
    causalAttributionReady: input.causalAttributionReady,
    backwardTimeline,
    hypotheses: {
      waveDirection,
      entryTiming,
      positionManagement,
      fundingVolume,
      entryVolumeTiming,
    },
    summaries,
    opportunityLifecycle,
    causalAttribution,
    ...(exitCounterfactual ? { exitCounterfactual } : {}),
    singleCycleParameterMutationAllowed: false as const,
  } satisfies NexusLifecycleRetrospective;
}

function normalizeEntryVolumeTiming(
  value: string | null | undefined,
): NexusLifecycleRetrospective["hypotheses"]["entryVolumeTiming"] {
  if (value === "CURRENT_EXECUTION_CONFIRMED") return "SUPPORTED";
  if (
    value === "POST_TRIGGER_EXECUTION_PENDING" ||
    value === "BACKGROUND_WITHOUT_EXECUTION" ||
    value === "IMPULSE_DECAYED" ||
    value === "CURRENT_QUIET"
  )
    return "UNCONFIRMED";
  return "INSUFFICIENT";
}

function normalizeFundingVolume(
  observations:
    | Array<{ status?: string | null }>
    | null
    | undefined,
): NexusLifecycleRetrospective["hypotheses"]["fundingVolume"] {
  const statuses = (observations ?? [])
    .map((observation) => clean(observation.status))
    .filter(Boolean);
  if (!statuses.length || statuses.every((status) => status === "UNAVAILABLE"))
    return "INSUFFICIENT";
  const favorable = statuses.some((status) =>
    status === "SQUEEZE_CONTINUATION" ||
    status === "POSITION_CONTINUATION"
  );
  const risk = statuses.includes("CROWDING_REVERSAL_RISK");
  if (favorable && risk) return "MIXED";
  if (risk) return "RISK_WARNED";
  if (favorable) return "SUPPORTED";
  return "MIXED";
}

function latestFundingVolumeSummary(
  observations:
    | Array<{
        minuteOffset: number;
        status?: string | null;
        summary?: string | null;
      }>
    | null
    | undefined,
) {
  const latest = [...(observations ?? [])]
    .filter((observation) => clean(observation.summary))
    .sort((left, right) => right.minuteOffset - left.minuteOffset)[0];
  return latest
    ? `资金费率与成交额路径（第${latest.minuteOffset}分钟）：${clean(latest.summary)}`
    : "";
}

function normalizeWaveDirection(
  value: string | null | undefined,
): NexusLifecycleRetrospective["hypotheses"]["waveDirection"] {
  if (value === "VALIDATED_EARLY" || value === "VALIDATED_LATE")
    return "SUPPORTED";
  if (value === "INVALIDATED") return "CONTRADICTED";
  if (value === "INSUFFICIENT") return "INSUFFICIENT";
  return "UNRESOLVED";
}

function normalizeEntryTiming(
  value: string | null | undefined,
): NexusLifecycleRetrospective["hypotheses"]["entryTiming"] {
  if (value === "TIMELY") return "SUPPORTED";
  if (value === "TOO_EARLY") return "TOO_EARLY";
  if (value === "CHASED") return "CHASED";
  return "UNRESOLVED";
}

function normalizePositionManagement(
  value: string | null | undefined,
): NexusLifecycleRetrospective["hypotheses"]["positionManagement"] {
  if (value === "SUPPORTED") return "SUPPORTED";
  if (value === "CONTRADICTED") return "CONTRADICTED";
  if (value === "INCONCLUSIVE") return "INCONCLUSIVE";
  return "UNRESOLVED";
}

function finiteOrNull(value: unknown) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function positiveIntegerOrNull(value: unknown) {
  const numeric = finiteOrNull(value);
  return numeric !== null && Number.isInteger(numeric) && numeric > 0
    ? numeric
    : null;
}

function normalizeExitReason(
  value: unknown,
): ExitCounterfactualExitReason | null {
  return value === "STOP_LOSS" ||
      value === "TAKE_PROFIT" ||
      value === "TRAILING_STOP" ||
      value === "TIME_EXIT"
    ? value
    : null;
}

function normalizePathOutcome(
  value: unknown,
  legacy: ExitCounterfactualClassification,
): ExitCounterfactualPathOutcome {
  if (
    value === "EXIT_CONFIRMED" ||
    value === "EXIT_EARLY" ||
    value === "INCONCLUSIVE"
  ) return value;
  return legacy === "EXIT_CONFIRMED" || legacy === "EXIT_EARLY"
    ? legacy
    : "INCONCLUSIVE";
}

function normalizeExecutionTiming(
  value: unknown,
  legacy: ExitCounterfactualClassification,
): ExitCounterfactualExecutionTiming {
  if (value === "ON_TIME" || value === "LATE" || value === "UNAVAILABLE")
    return value;
  return legacy === "EXIT_LATE" ? "LATE" : "UNAVAILABLE";
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
}
