import type {
  NexusExecutionIntentCandidate,
} from "../nexus-execution-coordinator.ts";
import { reserveNexusExecutionIntent } from
  "../nexus-execution-intent-store.ts";

export const POSITION_INCREASE_ENTRY_AUTHORIZATION_VERSION =
  "position-increase-entry-authorization-v1" as const;

type PositionIncreaseCandidate = Omit<
  NexusExecutionIntentCandidate,
  | "intentPurpose"
  | "authoritySource"
  | "livePositionId"
  | "positionHandoffKey"
> & {
  livePositionId: number;
  positionHandoffKey: string;
};

/**
 * Position intelligence may emit a possible increase, but it cannot grant
 * itself permission to add risk. This entry-domain boundary validates the
 * frozen position identity and creates the only executable increase intent.
 */
export async function authorizePositionIncreaseEntry(
  candidate: PositionIncreaseCandidate,
  availableMarginUsdt: number,
) {
  if (!Number.isInteger(candidate.livePositionId) || candidate.livePositionId <= 0)
    throw new Error("加仓候选缺少有效真实仓位编号");
  if (!candidate.positionHandoffKey.trim())
    throw new Error("加仓候选缺少成交后持仓交接身份");
  return reserveNexusExecutionIntent(
    {
      ...candidate,
      intentPurpose: "INCREASE_POSITION",
      authoritySource: "ENTRY_BRAIN",
    },
    availableMarginUsdt,
  );
}
