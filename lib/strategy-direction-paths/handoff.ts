import {
  type NexusDirectionDecision,
  type NexusDirectionBranchEvaluation,
  type NexusTradeDirection,
} from "../nexus-direction-decision.ts";

export const NEXUS_DIRECTION_HANDOFF_VERSION =
  "nexus-direction-handoff-v1" as const;

export type NexusDirectionEntryCandidate = Readonly<{
  direction: NexusTradeDirection;
  factSnapshotId: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type NexusDirectionHandoffReason =
  | NexusDirectionDecision["reasonCode"]
  | "SELECTED_CANDIDATE_MISSING"
  | "SELECTED_CANDIDATE_DUPLICATED"
  | "SELECTED_CANDIDATE_SNAPSHOT_MISMATCH";

export type NexusDirectionEntryHandoff<
  TCandidate extends NexusDirectionEntryCandidate,
> = Readonly<{
  version: typeof NEXUS_DIRECTION_HANDOFF_VERSION;
  decisionGroupId: string;
  outcome: "READY_FOR_ENTRY_AUTHORIZATION" | "WAIT";
  selectedCandidate: TCandidate | null;
  reasonCode: NexusDirectionHandoffReason;
  reason: string;
  counterfactualBranches: readonly NexusDirectionBranchEvaluation[];
  canAuthorizeOrder: false;
}>;

/**
 * Converts a completed direction decision into exactly one candidate for the
 * existing entry-authorization chain. It neither authorizes nor executes an
 * order. The losing branch remains attached as counterfactual learning data.
 */
export function handoffNexusDirectionDecision<
  TCandidate extends NexusDirectionEntryCandidate,
>(input: Readonly<{
  decision: NexusDirectionDecision;
  candidates: readonly TCandidate[];
}>): NexusDirectionEntryHandoff<TCandidate> {
  const counterfactualBranches = Object.freeze(
    input.decision.branches
      .filter((branch) =>
        branch.direction !== input.decision.selectedDirection
      )
      .map(copyBranch),
  );
  const base = {
    version: NEXUS_DIRECTION_HANDOFF_VERSION,
    decisionGroupId: input.decision.decisionGroupId,
    counterfactualBranches,
    canAuthorizeOrder: false as const,
  };

  if (
    input.decision.outcome !== "SELECTED" ||
    !input.decision.selectedDirection
  ) {
    return Object.freeze({
      ...base,
      outcome: "WAIT" as const,
      selectedCandidate: null,
      reasonCode: input.decision.reasonCode,
      reason: input.decision.reason,
    });
  }

  const selected = input.candidates.filter((candidate) =>
    candidate.direction === input.decision.selectedDirection
  );
  if (selected.length === 0) {
    return wait(
      base,
      "SELECTED_CANDIDATE_MISSING",
      "方向裁决胜者没有对应的执行候选，保持等待",
    );
  }
  if (selected.length > 1) {
    return wait(
      base,
      "SELECTED_CANDIDATE_DUPLICATED",
      "方向裁决胜者存在重复执行候选，保持等待",
    );
  }
  const candidate = selected[0];
  if (
    candidate.factSnapshotId !== input.decision.factSnapshotId ||
    !candidate.factSnapshotId
  ) {
    return wait(
      base,
      "SELECTED_CANDIDATE_SNAPSHOT_MISMATCH",
      "执行候选与方向裁决未使用同一事实快照，保持等待",
    );
  }

  const selectedCandidate = Object.freeze({
    ...candidate,
    evidence: Object.freeze({
      ...candidate.evidence,
      nexusDirectionDecision: input.decision,
    }),
  }) as TCandidate;
  return Object.freeze({
    ...base,
    outcome: "READY_FOR_ENTRY_AUTHORIZATION" as const,
    selectedCandidate,
    reasonCode: input.decision.reasonCode,
    reason: "胜出方向已进入统一入场授权，尚未获得下单权",
  });
}

function wait<TCandidate extends NexusDirectionEntryCandidate>(
  base: Pick<
    NexusDirectionEntryHandoff<TCandidate>,
    | "version"
    | "decisionGroupId"
    | "counterfactualBranches"
    | "canAuthorizeOrder"
  >,
  reasonCode: NexusDirectionHandoffReason,
  reason: string,
): NexusDirectionEntryHandoff<TCandidate> {
  return Object.freeze({
    ...base,
    outcome: "WAIT" as const,
    selectedCandidate: null,
    reasonCode,
    reason,
  });
}

function copyBranch(
  branch: NexusDirectionBranchEvaluation,
): NexusDirectionBranchEvaluation {
  return Object.freeze({
    ...branch,
    reasonCodes: Object.freeze([...branch.reasonCodes]),
  });
}
