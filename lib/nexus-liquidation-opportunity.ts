import type {
  NexusPureMachineDirection,
  NexusPureMachineKind,
} from "./nexus-brain-state-machines";

export type NexusLiquidationSide = "BUY" | "SELL";

export type NexusLiquidationOpportunity = {
  direction: NexusPureMachineDirection;
  liquidationSide: NexusLiquidationSide;
  primaryMachine: NexusPureMachineKind;
  secondaryMachine: NexusPureMachineKind;
  thesis: "REVERSAL" | "CONTINUATION";
};

/**
 * A liquidation is a market fact, not an order direction.
 *
 * SELL means long positions were force-sold during a downward impulse.
 * BUY means short positions were force-bought during an upward impulse.
 * Each execution direction receives a continuation and/or reversal path;
 * the market-eye state machine must still close structure and volume facts
 * before it may own an execution intent.
 */
export function nexusLiquidationOpportunity(input: {
  liquidationSide: NexusLiquidationSide;
  direction: NexusPureMachineDirection;
}): NexusLiquidationOpportunity {
  if (input.liquidationSide === "SELL") {
    if (input.direction === "LONG")
      return {
        ...input,
        primaryMachine: "SUPPORT_REVERSAL",
        secondaryMachine: "TREND_BREAKOUT",
        thesis: "REVERSAL",
      };
    return {
      ...input,
      primaryMachine: "DOWNTREND_CONTINUATION",
      secondaryMachine: "TREND_BREAKOUT",
      thesis: "CONTINUATION",
    };
  }

  if (input.direction === "SHORT")
    return {
      ...input,
      primaryMachine: "SUPPORT_REVERSAL",
      secondaryMachine: "TREND_BREAKOUT",
      thesis: "REVERSAL",
    };
  return {
    ...input,
    primaryMachine: "TREND_BREAKOUT",
    secondaryMachine: "SUPPORT_REVERSAL",
    thesis: "CONTINUATION",
  };
}

export function buildBothLiquidationSideCandidates<T>(
  build: (side: NexusLiquidationSide) => T[],
) {
  return (["SELL", "BUY"] as const).flatMap(build);
}

export function mayOwnNexusExplorationProbe(
  opportunity: NexusLiquidationOpportunity,
  reasonCode?: string | null,
) {
  if (opportunity.thesis === "REVERSAL") return true;
  // Weak or ambiguous evidence keeps exactly one execution owner: the
  // reversal branch. A strategy-qualified strong single liquidation or
  // rolling aggregate is no longer ambiguous, so its continuation branch may
  // own the minimum learning probe as well. Hard eye rejection and direction
  // conflicts never reach either of these allowed reason codes.
  return (
    reasonCode === "STRONG_SINGLE_LIQUIDATION_PROBE" ||
    reasonCode === "AGGREGATE_LIQUIDATION_PROBE"
  );
}
