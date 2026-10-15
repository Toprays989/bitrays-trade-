import type {
  NexusDirectionBranchEvaluation,
  NexusDirectionCapability,
  NexusTradeDirection,
} from "../nexus-direction-decision.ts";

export const NEXUS_DIRECTION_PATH_CONTRACT_VERSION =
  "nexus-direction-path-contract-v1" as const;

export type NexusDirectionPathContext = Readonly<{
  factSnapshotId: string;
  evaluatedAt: number;
  expiresAt: number;
}>;

/**
 * A direction path evaluates one side from already-prepared facts. It cannot
 * query a second snapshot, authorize an order or own post-fill management.
 */
export type StrategyDirectionPathAdapter<TFacts, TConfig> = Readonly<{
  kind: string;
  version: string;
  capability: NexusDirectionCapability;
  supportedDirections: readonly NexusTradeDirection[];
  evaluate: (input: Readonly<{
    direction: NexusTradeDirection;
    facts: Readonly<TFacts>;
    config: Readonly<TConfig>;
    context: NexusDirectionPathContext;
  }>) => NexusDirectionBranchEvaluation;
}>;
