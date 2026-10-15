import {
  POSITION_ROTATION_MODEL_VERSION,
  type PositionManagementDecision,
} from "./post-entry-position-management.ts";

export const POSITION_MANAGEMENT_EVIDENCE_GATE_VERSION =
  "position-management-evidence-gate-v1" as const;

export type PositionManagementEvidenceGate = {
  version: typeof POSITION_MANAGEMENT_EVIDENCE_GATE_VERSION;
  effective: boolean;
  liveDecisionEligible: boolean;
  causalEvidenceComplete: boolean;
  proposedState: PositionManagementDecision["state"];
  proposedAction: PositionManagementDecision["action"];
  missingDimensions: string[];
  summary: string;
};

/**
 * 仓位大脑只有在行情新鲜且因果证据完整时，才允许把候选判断交给状态机和执行器。
 * 原始候选仍保留用于审计和复盘，但不允许用缺失数据触发补仓、退出或收紧保护。
 */
export function gatePositionManagementDecision<
  T extends PositionManagementDecision,
>(input: {
  proposed: T;
  liveDecisionEligible: boolean;
  causalEvidenceComplete: boolean;
  missingDimensions?: string[];
}): T & { evidenceGate: PositionManagementEvidenceGate } {
  const missingDimensions = uniqueStrings(input.missingDimensions ?? []);
  const effective =
    input.liveDecisionEligible && input.causalEvidenceComplete;
  const evidenceGate: PositionManagementEvidenceGate = {
    version: POSITION_MANAGEMENT_EVIDENCE_GATE_VERSION,
    effective,
    liveDecisionEligible: input.liveDecisionEligible,
    causalEvidenceComplete: input.causalEvidenceComplete,
    proposedState: input.proposed.state,
    proposedAction: input.proposed.action,
    missingDimensions,
    summary: effective
      ? "行情新鲜且因果证据完整；候选判断可进入仓位状态机和动作绑定。"
      : "眼睛数据尚未对齐；候选判断仅保留复盘，本轮不补仓、不减仓、不收紧保护，也不改写既有风险参数。",
  };

  if (effective)
    return {
      ...input.proposed,
      evidenceGate,
    };

  const blockedReasons = uniqueStrings([
    ...input.proposed.rotationPlan.blockedReasons,
    ...missingDimensions,
    !input.liveDecisionEligible ? "LIVE_MARK_OR_CAUSAL_WINDOW_STALE" : "",
  ]);
  const missingEvidence = uniqueStrings([
    ...input.proposed.missingEvidence,
    ...missingDimensions,
  ]);

  return {
    ...input.proposed,
    state: "NEUTRAL",
    action: "HOLD_AND_OBSERVE",
    label: "数据未对齐·仅观察",
    continuationEvidence: false,
    bottomReboundEvidence: false,
    missingEvidence,
    structureExitAuthorized: false,
    evidenceRiskReductionAuthorized: false,
    evidenceRiskExitAuthorized: false,
    rotationPlan: {
      modelVersion: POSITION_ROTATION_MODEL_VERSION,
      primaryAction: "HOLD_PRIMARY_LEG",
      hedgeAction: "NO_HEDGE",
      capitalAction: "KEEP_CAPITAL_ASSIGNED",
      label: "等待新鲜完整事实",
      reason:
        "行情时效或因果证据尚未完整；保持已有仓位和用户风险参数，不创建新的仓位动作。",
      evidenceCodes: input.proposed.evidenceCodes,
      blockedReasons,
    },
    reason:
      "当前行情时效或因果证据不完整；原始候选判断只用于复盘，不得冒充有效的大脑结论。",
    evidenceGate,
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
