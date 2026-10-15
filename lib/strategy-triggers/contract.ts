export const NEXUS_STRATEGY_TRIGGER_CONTRACT_VERSION =
  "nexus-strategy-trigger-contract-v1" as const;

export type StrategyTriggerFactRequirement =
  | "BINANCE_LIQUIDATION_AGGREGATES"
  | "MARK_PRICE_SNAPSHOT"
  | "MARK_PRICE_72H_RANGE"
  | "MARK_PRICE_MULTI_INTERVAL_CLOSED_CANDLES"
  | "SCHEDULE_WINDOW"
  | "ORDER_FLOW_SNAPSHOT";

/**
 * A trigger may only turn prepared market facts into analysis candidates.
 * It cannot authorize orders or own the post-fill position lifecycle.
 */
export type StrategyTriggerAdapter<TFacts, TConfig, TCandidate> = Readonly<{
  kind: string;
  version: string;
  requiredFacts: readonly StrategyTriggerFactRequirement[];
  evaluate: (input: Readonly<{
    facts: TFacts;
    config: TConfig;
  }>) => TCandidate[];
}>;
