import { strategyBranchFamily } from "./contrarian-probe-lifecycle.ts";
import { decisionEngineVersionFromEvidence } from
  "./liquidation-decision-engine.ts";
import {
  isStrategyTriggerKind,
  type StrategyTriggerKind,
} from "./strategy-trigger-catalog.ts";

export const STRATEGY_TERMINAL_LEARNING_SCOPE_VERSION =
  "strategy-terminal-learning-scope-v1" as const;

export type StrategyTerminalLearningScope = Readonly<{
  triggerKind: StrategyTriggerKind;
  triggerVersion: string;
  evidenceVersion: string;
  branchFamily: ReturnType<typeof strategyBranchFamily>;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve the immutable learning scope owned by one strategy lifecycle.
 *
 * Trigger identity is authoritative.  The liquidation engine version remains
 * a compatibility boundary when it exists, but it is not a prerequisite for
 * non-liquidation triggers such as relative strength, grid or scheduled scan.
 */
export function resolveStrategyTerminalLearningScope(input: {
  triggerKind: unknown;
  triggerVersion: unknown;
  entryEvidence: unknown;
}): StrategyTerminalLearningScope | null {
  if (!isStrategyTriggerKind(input.triggerKind)) return null;
  const entryEvidence = record(input.entryEvidence);
  const triggerIdentity = record(entryEvidence.triggerIdentity);
  const evidenceTriggerKind = triggerIdentity.triggerKind;
  if (
    evidenceTriggerKind !== undefined &&
    evidenceTriggerKind !== null &&
    evidenceTriggerKind !== "" &&
    evidenceTriggerKind !== input.triggerKind
  ) return null;
  const triggerVersion = nonEmptyString(input.triggerVersion) ??
    nonEmptyString(triggerIdentity.triggerVersion) ??
    `${input.triggerKind.toLowerCase()}-legacy`;
  const engineVersion = decisionEngineVersionFromEvidence(entryEvidence);
  return {
    triggerKind: input.triggerKind,
    triggerVersion,
    evidenceVersion: engineVersion ?? triggerVersion,
    branchFamily: strategyBranchFamily(entryEvidence),
  };
}

export function sameStrategyTerminalLearningScope(
  left: StrategyTerminalLearningScope,
  right: StrategyTerminalLearningScope,
) {
  return left.triggerKind === right.triggerKind &&
    left.triggerVersion === right.triggerVersion &&
    left.evidenceVersion === right.evidenceVersion &&
    left.branchFamily === right.branchFamily;
}
