import type { NexusLearningLane } from "./nexus-learning-cycle.ts";
import type {
  NexusEvidenceDimension,
  NexusEvidenceReliabilityMemory,
} from "./nexus-evidence-reliability-memory.ts";
import type {
  NexusEvidenceTemporalDrift,
  NexusEvidenceTemporalDriftItem,
} from "./nexus-evidence-temporal-drift.ts";

export const NEXUS_EVIDENCE_CONFIDENCE_DECAY_VERSION =
  "nexus-evidence-confidence-decay-v1" as const;

export type NexusEvidenceConfidenceDecayItem = {
  evidenceDimension: NexusEvidenceDimension;
  historicalSignal: NexusEvidenceReliabilityMemory["signal"] | "UNAVAILABLE";
  temporalStatus: NexusEvidenceTemporalDriftItem["status"];
  resolvedCycles: number;
  sampleCoverage: number;
  historicalClarity: number;
  historicalConfidence: number;
  recencyMultiplier: number;
  effectiveConfidence: number;
  reviewPriority:
    | "REVIEW_NOW"
    | "WATCH_RECOVERY"
    | "STABLE_REFERENCE"
    | "COLLECT_MORE";
  summary: string;
};

export type NexusEvidenceConfidenceDecay = {
  version: typeof NEXUS_EVIDENCE_CONFIDENCE_DECAY_VERSION;
  brainKey: string;
  configVersion: number;
  direction: "LONG" | "SHORT";
  learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
  marketContextKey: string;
  status:
    | "HISTORICAL_EVIDENCE_DECAYED"
    | "RECOVERY_PENDING_CONFIRMATION"
    | "STABLE_REFERENCE"
    | "MIXED_OR_INSUFFICIENT";
  reviewNowDimensions: number;
  recoveryWatchDimensions: number;
  stableReferenceDimensions: number;
  collectMoreDimensions: number;
  items: NexusEvidenceConfidenceDecayItem[];
  displayValue: string;
  orderAffecting: false;
  positionAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

type ConfidenceDecayTarget = {
  brainKey: string;
  configVersion: number;
  direction: "LONG" | "SHORT";
  learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
  marketContextKey: string;
};

/**
 * 把同环境历史可靠性与近期漂移合成为“当前还能多大程度复用这段记忆”。
 *
 * 复查紧急度与有效可信度严格分开：近期明显减弱会提高复查优先级，
 * 但会降低这项旧证据的当前可复用可信度，绝不能被误当成下单高分。
 */
export function buildNexusEvidenceConfidenceDecay(input: {
  target: ConfidenceDecayTarget;
  memories: NexusEvidenceReliabilityMemory[];
  temporalDrift: NexusEvidenceTemporalDrift;
}): NexusEvidenceConfidenceDecay {
  const driftMatchesTarget = sameTarget(input.target, input.temporalDrift);
  const memories = new Map(
    input.memories
      .filter((memory) => sameTarget(input.target, memory))
      .map((memory) => [memory.evidenceDimension, memory] as const),
  );
  const items = (driftMatchesTarget ? input.temporalDrift.items : [])
    .map((drift) => confidenceItem(drift, memories.get(drift.evidenceDimension)))
    .sort(compareItems);
  const reviewNowDimensions = countPriority(items, "REVIEW_NOW");
  const recoveryWatchDimensions = countPriority(items, "WATCH_RECOVERY");
  const stableReferenceDimensions = countPriority(items, "STABLE_REFERENCE");
  const collectMoreDimensions = countPriority(items, "COLLECT_MORE") +
    (driftMatchesTarget ? 0 : 5);
  const status = reviewNowDimensions > 0
    ? "HISTORICAL_EVIDENCE_DECAYED" as const
    : recoveryWatchDimensions > 0
      ? "RECOVERY_PENDING_CONFIRMATION" as const
      : stableReferenceDimensions > 0
        ? "STABLE_REFERENCE" as const
        : "MIXED_OR_INSUFFICIENT" as const;
  const urgent = items
    .filter((item) => item.reviewPriority === "REVIEW_NOW")
    .map((item) => evidenceLabel(item.evidenceDimension));
  const recovering = items
    .filter((item) => item.reviewPriority === "WATCH_RECOVERY")
    .map((item) => evidenceLabel(item.evidenceDimension));

  return {
    version: NEXUS_EVIDENCE_CONFIDENCE_DECAY_VERSION,
    ...input.target,
    status,
    reviewNowDimensions,
    recoveryWatchDimensions,
    stableReferenceDimensions,
    collectMoreDimensions,
    items,
    displayValue:
      `立即复查 ${reviewNowDimensions} / 恢复观察 ${recoveryWatchDimensions} / ` +
      `稳定参考 ${stableReferenceDimensions}`,
    orderAffecting: false,
    positionAffecting: false,
    liveConfigMutationAllowed: false,
    summary: !driftMatchesTarget
      ? "近期漂移与当前大脑、版本、方向、学习通道或市场环境不一致，不能生成置信度衰减；继续采集当前环境完整周期。"
      : reviewNowDimensions > 0
        ? `旧证据中有 ${reviewNowDimensions} 类近期减弱，优先复查：${urgent.join("、")}。` +
          "已降低其当前可复用可信度；复查优先级不是下单分数，不直接影响订单、仓位或实盘参数。"
        : recoveryWatchDimensions > 0
          ? `有 ${recoveryWatchDimensions} 类证据近期恢复：${recovering.join("、")}。` +
            "恢复期仍需更多独立完整周期确认，不直接恢复为订单依据。"
          : stableReferenceDimensions > 0
            ? `当前有 ${stableReferenceDimensions} 类证据可作为稳定复盘参考；` +
              "只用于学习建议排序，不参与下单、平仓、加仓或自动改参。"
            : "当前环境的可判定历史或近期窗口不足，继续采集，不生成实盘动作。",
  };
}

function confidenceItem(
  drift: NexusEvidenceTemporalDriftItem,
  memory: NexusEvidenceReliabilityMemory | undefined,
): NexusEvidenceConfidenceDecayItem {
  const resolvedCycles = memory?.resolvedCycles ?? 0;
  const sampleThreshold = Math.max(1, memory?.independentSampleThreshold ?? 5);
  const sampleCoverage = clamp01(resolvedCycles / sampleThreshold);
  const historicalClarity = resolvedCycles > 0 && memory
    ? Math.abs(memory.supportedCycles - memory.contradictedCycles) /
      resolvedCycles
    : 0;
  const historicalConfidence = round(sampleCoverage * historicalClarity);
  const recencyMultiplier = driftMultiplier(drift.status);
  const effectiveConfidence = round(
    historicalConfidence * recencyMultiplier,
  );
  const reviewPriority = priority(drift.status, memory);
  return {
    evidenceDimension: drift.evidenceDimension,
    historicalSignal: memory?.signal ?? "UNAVAILABLE",
    temporalStatus: drift.status,
    resolvedCycles,
    sampleCoverage: round(sampleCoverage),
    historicalClarity: round(historicalClarity),
    historicalConfidence,
    recencyMultiplier,
    effectiveConfidence,
    reviewPriority,
    summary:
      `${evidenceLabel(drift.evidenceDimension)}：历史可判定 ${resolvedCycles} 个周期，` +
      `历史置信度 ${percent(historicalConfidence)}；${temporalLabel(drift.status)}，` +
      `近期系数 ${recencyMultiplier.toFixed(2)}，当前可复用可信度 ` +
      `${percent(effectiveConfidence)}；${priorityLabel(reviewPriority)}。`,
  };
}

function priority(
  temporalStatus: NexusEvidenceTemporalDriftItem["status"],
  memory: NexusEvidenceReliabilityMemory | undefined,
): NexusEvidenceConfidenceDecayItem["reviewPriority"] {
  if (temporalStatus === "RECENTLY_WEAKENED" ||
    (temporalStatus === "STABLE_CONTRADICTED" &&
      memory?.signal === "CONTRADICTED_BY_HISTORY")) return "REVIEW_NOW";
  if (temporalStatus === "RECENTLY_RECOVERED" ||
    temporalStatus === "RECENTLY_MIXED") return "WATCH_RECOVERY";
  if (temporalStatus === "STABLE_SUPPORTED" ||
    temporalStatus === "STABLE_CONTRADICTED") return "STABLE_REFERENCE";
  return "COLLECT_MORE";
}

function driftMultiplier(status: NexusEvidenceTemporalDriftItem["status"]) {
  if (status === "RECENTLY_WEAKENED") return 0.35;
  if (status === "RECENTLY_RECOVERED") return 0.65;
  if (status === "RECENTLY_MIXED") return 0.5;
  if (status === "INSUFFICIENT_HISTORY") return 0.4;
  return 1;
}

function sameTarget(
  target: ConfidenceDecayTarget,
  candidate: ConfidenceDecayTarget,
) {
  return candidate.brainKey === target.brainKey &&
    candidate.configVersion === target.configVersion &&
    candidate.direction === target.direction &&
    candidate.learningLane === target.learningLane &&
    candidate.marketContextKey === target.marketContextKey;
}

function compareItems(
  left: NexusEvidenceConfidenceDecayItem,
  right: NexusEvidenceConfidenceDecayItem,
) {
  return priorityOrder(left.reviewPriority) - priorityOrder(right.reviewPriority) ||
    right.effectiveConfidence - left.effectiveConfidence ||
    left.evidenceDimension.localeCompare(right.evidenceDimension);
}

function priorityOrder(value: NexusEvidenceConfidenceDecayItem["reviewPriority"]) {
  if (value === "REVIEW_NOW") return 0;
  if (value === "WATCH_RECOVERY") return 1;
  if (value === "STABLE_REFERENCE") return 2;
  return 3;
}

function countPriority(
  items: NexusEvidenceConfidenceDecayItem[],
  value: NexusEvidenceConfidenceDecayItem["reviewPriority"],
) {
  return items.filter((item) => item.reviewPriority === value).length;
}

function evidenceLabel(value: NexusEvidenceDimension) {
  if (value === "WAVE_DIRECTION") return "波段方向证据";
  if (value === "ENTRY_TIMING") return "入场时机证据";
  if (value === "POSITION_MANAGEMENT") return "持仓管理证据";
  if (value === "FUNDING_VOLUME") return "费率与成交量证据";
  return "入场量价时序证据";
}

function temporalLabel(value: NexusEvidenceTemporalDriftItem["status"]) {
  if (value === "RECENTLY_WEAKENED") return "近期明显减弱";
  if (value === "RECENTLY_RECOVERED") return "近期正在恢复";
  if (value === "STABLE_SUPPORTED") return "早期与近期持续支持";
  if (value === "STABLE_CONTRADICTED") return "早期与近期持续反证";
  if (value === "RECENTLY_MIXED") return "近期结果混合";
  return "近期窗口不足";
}

function priorityLabel(value: NexusEvidenceConfidenceDecayItem["reviewPriority"]) {
  if (value === "REVIEW_NOW") return "优先复查旧结论";
  if (value === "WATCH_RECOVERY") return "观察恢复是否持续";
  if (value === "STABLE_REFERENCE") return "可作为稳定复盘参考";
  return "继续采集完整周期";
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function percent(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}
