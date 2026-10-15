import type { BinanceLiquidationAggregate } from "../binance-usdm-live.ts";
import {
  buildLiquidationMarketTriggerCandidates,
  type LiquidationMarketTriggerCandidate,
} from "../liquidation-market-trigger.ts";
import { buildBothLiquidationSideCandidates } from "../nexus-liquidation-opportunity.ts";
import type { StrategyTriggerAdapter } from "./contract.ts";

export const LIQUIDATION_WINDOW_TRIGGER_VERSION =
  "liquidation-window-trigger-v1" as const;

export type LiquidationWindowTriggerFacts = Readonly<{
  rows: readonly BinanceLiquidationAggregate[];
}>;

export type LiquidationWindowTriggerConfig = Readonly<{
  minNotionalUsdt: number;
  minSingleEventNotionalUsdt?: number;
  minEventCount: number;
  maxSpanMs: number;
  maxInterEventGapMs: number;
  minLiquidationPrice?: number;
  maxLiquidationPrice?: number;
}>;

export const liquidationWindowTriggerAdapter: StrategyTriggerAdapter<
  LiquidationWindowTriggerFacts,
  LiquidationWindowTriggerConfig,
  LiquidationMarketTriggerCandidate
> = Object.freeze({
  kind: "LIQUIDATION_WINDOW",
  version: LIQUIDATION_WINDOW_TRIGGER_VERSION,
  requiredFacts: Object.freeze([
    "BINANCE_LIQUIDATION_AGGREGATES" as const,
  ]),
  evaluate(input) {
    return buildBothLiquidationSideCandidates((side) =>
      buildLiquidationMarketTriggerCandidates([...input.facts.rows], {
        side,
        ...input.config,
      })
    );
  },
});
