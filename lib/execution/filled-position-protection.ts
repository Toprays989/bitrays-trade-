import {
  activateProtectionPlan,
  type PositionProtectionState,
} from "../position-protection-version.ts";

export const FILLED_POSITION_PROTECTION_CONTRACT_VERSION =
  "filled-position-protection-v1" as const;

export function buildFilledPositionProtection(input: {
  plan: Record<string, unknown>;
  activatedAt: Date;
  trailingActivationPercent: number;
  trailingStopPercent: number;
  positionVersion?: number;
  protectionVersion?: number;
}) {
  const protectionState: PositionProtectionState = "ACTIVE";
  return {
    contractVersion: FILLED_POSITION_PROTECTION_CONTRACT_VERSION,
    riskPlanJson: JSON.stringify(activateProtectionPlan({
      plan: input.plan,
      positionVersion: input.positionVersion,
      protectionVersion: input.protectionVersion,
      nowMs: input.activatedAt.getTime(),
      source: "ENTRY",
      state: protectionState,
    })),
    protectionState,
    protectionUpdatedAt: new Date(input.activatedAt.getTime()),
    trailingActivationPercent: input.trailingActivationPercent,
    trailingStopPercent: input.trailingStopPercent,
  };
}
