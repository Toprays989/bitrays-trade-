import { NEXUS_EVIDENCE_CONFIDENCE_DECAY_VERSION } from "./nexus-evidence-confidence-decay.ts";

export type NexusEvidenceConfidenceDecayCapabilityState =
  | "ACTIVE"
  | "PAUSED_WAITING"
  | "COLLECTING_CURRENT_VERSION"
  | "WAITING_CURRENT_VERSION";

type CapabilitySuggestion = {
  configVersion: number;
  sampleCount: number;
  status: string;
  createdAt: Date | number | string;
  currentValue: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function timestamp(value: Date | number | string) {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

export function buildNexusEvidenceConfidenceDecayCapabilityStatus(input: {
  strategyStatus: string;
  currentConfigVersion: number;
  suggestions: CapabilitySuggestion[];
}) {
  const suggestions = [...input.suggestions].sort(
    (left, right) => timestamp(right.createdAt) - timestamp(left.createdAt),
  );
  const currentSuggestion = suggestions.find(
    (item) => item.configVersion === input.currentConfigVersion,
  );
  const sourceSuggestion = currentSuggestion ?? suggestions[0] ?? null;
  const currentValue = asRecord(sourceSuggestion?.currentValue);
  const latestSummary =
    typeof currentValue.summary === "string" ? currentValue.summary : null;
  const latestStatus =
    typeof currentValue.status === "string" ? currentValue.status : null;

  let state: NexusEvidenceConfidenceDecayCapabilityState;
  let message: string;
  if (currentSuggestion) {
    state = "ACTIVE";
    message = `当前 V${input.currentConfigVersion} 已形成近期证据可信度结论；只参与复盘与建议，不影响订单、仓位或实盘参数。`;
  } else if (sourceSuggestion) {
    state = "WAITING_CURRENT_VERSION";
    message = `能力已加载，但最新结论属于 V${sourceSuggestion.configVersion}；当前 V${input.currentConfigVersion} 需等待新的完整学习周期。`;
  } else if (input.strategyStatus === "RUNNING") {
    state = "COLLECTING_CURRENT_VERSION";
    message = `能力已加载，当前 V${input.currentConfigVersion} 正在等待完整结算样本生成首个结论。`;
  } else {
    state = "PAUSED_WAITING";
    message = `能力已加载；策略当前为${input.strategyStatus || "非运行"}状态，恢复运行并形成完整结算样本后生成首个结论。`;
  }

  return {
    version: NEXUS_EVIDENCE_CONFIDENCE_DECAY_VERSION,
    state,
    configVersion: input.currentConfigVersion,
    sourceConfigVersion: sourceSuggestion?.configVersion ?? null,
    sampleCount: sourceSuggestion?.sampleCount ?? 0,
    latestStatus,
    latestSummary,
    updatedAt: sourceSuggestion ? timestamp(sourceSuggestion.createdAt) : null,
    message,
    orderAffecting: false as const,
    positionAffecting: false as const,
    liveConfigMutationAllowed: false as const,
  };
}
