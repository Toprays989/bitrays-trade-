import type { StrategyTriggerKind } from "./strategy-trigger-catalog.ts";

export type StrategyTriggerRuntimeOwner =
  | "LIQUIDATION_MONITOR"
  | "SHORT_CONTINUATION_MONITOR"
  | "RELATIVE_STRENGTH_MONITOR"
  | "SIMPLE_REBOUND_RUNNER";

export type StrategyTriggerRuntimeOwnership = Readonly<{
  owner: StrategyTriggerRuntimeOwner;
  adapterMode: "PURE_REGISTRY" | "SPECIALIZED_RUNTIME";
}>;

const OWNERSHIP: Readonly<
  Record<StrategyTriggerKind, StrategyTriggerRuntimeOwnership>
> = Object.freeze({
  LIQUIDATION_WINDOW: {
    owner: "LIQUIDATION_MONITOR",
    adapterMode: "PURE_REGISTRY",
  },
  PRICE_VOLUME_STRUCTURE: {
    owner: "SHORT_CONTINUATION_MONITOR",
    adapterMode: "SPECIALIZED_RUNTIME",
  },
  RELATIVE_STRENGTH_CONTINUATION: {
    owner: "RELATIVE_STRENGTH_MONITOR",
    adapterMode: "SPECIALIZED_RUNTIME",
  },
  LIQUIDATION_OR_PRICE_MOMENTUM_WAKE: {
    owner: "SHORT_CONTINUATION_MONITOR",
    adapterMode: "SPECIALIZED_RUNTIME",
  },
  HIGH_POSITION_PRICE_VOLUME_STRUCTURE: {
    owner: "SHORT_CONTINUATION_MONITOR",
    adapterMode: "SPECIALIZED_RUNTIME",
  },
  LOW_POSITION_WINDOW: {
    owner: "LIQUIDATION_MONITOR",
    adapterMode: "PURE_REGISTRY",
  },
  THREE_MINUTE_PROBABILITY: {
    owner: "LIQUIDATION_MONITOR",
    adapterMode: "PURE_REGISTRY",
  },
  SIMPLE_REBOUND: {
    owner: "SIMPLE_REBOUND_RUNNER",
    adapterMode: "SPECIALIZED_RUNTIME",
  },
  GRID_PRICE_LEVEL: {
    owner: "LIQUIDATION_MONITOR",
    adapterMode: "PURE_REGISTRY",
  },
  SCHEDULED_SCAN: {
    owner: "LIQUIDATION_MONITOR",
    adapterMode: "PURE_REGISTRY",
  },
  BREAKOUT_RETEST: {
    owner: "LIQUIDATION_MONITOR",
    adapterMode: "PURE_REGISTRY",
  },
});

export function strategyTriggerRuntimeOwnership(
  kind: StrategyTriggerKind,
): StrategyTriggerRuntimeOwnership {
  return OWNERSHIP[kind];
}

export function strategyTriggerRuntimeOwnershipEntries() {
  return Object.entries(OWNERSHIP) as Array<
    [StrategyTriggerKind, StrategyTriggerRuntimeOwnership]
  >;
}
