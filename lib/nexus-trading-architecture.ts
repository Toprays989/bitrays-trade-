import type { LiquidationTrendConfig } from "./liquidation-trend-config.ts";
import {
  NEXUS_MAINLINE_BOUNDARIES,
  NEXUS_MAINLINE_HANDOFFS,
} from "./nexus-mainline-contract.ts";
import {
  NEXUS_DIRECTION_DECISION_VERSION,
  resolveNexusDirectionCapability,
} from "./nexus-direction-decision.ts";
import { resolveStrategyEntryTimingProfile } from "./strategy-entry-timing.ts";

/**
 * Stable architecture contract for every automated NEXUS strategy.
 *
 * A strategy may adapt a market and decide when to ask the shared brain for a
 * decision. It must not create its own post-fill position-management path.
 */
export const NEXUS_TRADING_ARCHITECTURE_VERSION =
  "nexus-trading-architecture-v2" as const;

export const NEXUS_UNIFIED_POSITION_LIFECYCLE_VERSION =
  "nexus-unified-position-lifecycle-v1" as const;

export function unifiedPositionLifecycleMetadata() {
  return {
    version: NEXUS_UNIFIED_POSITION_LIFECYCLE_VERSION,
    authority: NEXUS_MAINLINE_BOUNDARIES.POSITION_PROTECTION.authority,
    startsAt: "FILLED_POSITION" as const,
    strategyAgnostic: true,
    sourcePolicy: NEXUS_MAINLINE_BOUNDARIES.POSITION_PROTECTION.sourcePolicy,
    mechanisms: [
      "CONFIGURED_TAKE_PROFIT_GRID",
      "CONFIGURED_STOP_LOSS",
      "DYNAMIC_PROFIT_REDUCTION",
      "TRAILING_PROTECTION",
      "INTELLIGENT_POSITION_REVIEW",
      "ADD_ON_REVIEW",
      "STRUCTURE_INVALIDATION_REVIEW",
      "LIQUIDATION_DISTANCE_GUARD",
    ] as const,
  };
}

export function resolveNexusTradingArchitecture(input: {
  config: LiquidationTrendConfig;
  strategyType: string;
}) {
  const tradfi = input.config.marketProfile?.mode === "TRADFI";
  const relativeStrength =
    input.config.marketProfile?.mode === "RELATIVE_STRENGTH";
  const specialisedMarketProfile = input.config.marketProfile?.mode;
  const sentinel = input.strategyType === "SENTINEL";
  const entryTiming = resolveStrategyEntryTimingProfile(input);
  const directionMode =
    input.config.execution.directionMode === "INVERSE_BRAIN"
      ? "INVERSE_BRAIN"
      : "FOLLOW_BRAIN";
  const directionCapability = resolveNexusDirectionCapability({
    configuredDirection: input.config.direction,
    marketProfileMode: specialisedMarketProfile,
    decisionMode: input.config.directionDecision?.mode,
  });

  return {
    version: NEXUS_TRADING_ARCHITECTURE_VERSION,
    invariant: "STRATEGY_ENTRY_ONLY_POST_FILL_UNIFIED" as const,
    eyePlane: {
      authority: NEXUS_MAINLINE_BOUNDARIES.MARKET_FACTS.authority,
      scope: NEXUS_MAINLINE_BOUNDARIES.MARKET_FACTS.scope,
      canAuthorizeOrder:
        NEXUS_MAINLINE_BOUNDARIES.MARKET_FACTS.canAuthorizeOrder,
    },
    brainPlane: {
      authority: NEXUS_MAINLINE_BOUNDARIES.BRAIN_DECISION.authority,
      engine: NEXUS_MAINLINE_BOUNDARIES.BRAIN_DECISION.owner,
      consumesStrategyContext:
        NEXUS_MAINLINE_BOUNDARIES.BRAIN_DECISION.consumesStrategyContext,
      directionDecision: {
        version: NEXUS_DIRECTION_DECISION_VERSION,
        capability: directionCapability,
        mode: input.config.directionDecision?.mode ?? "TRIGGER_DIRECTED",
        sameFactSnapshotRequired: true,
        waitIsValidOutcome: true,
        postDecisionDirectionTransformAllowed: false,
        singleRealIntentPerDecisionGroup:
          directionCapability !== "COORDINATED_PAIR",
        canAuthorizeOrder: false,
      },
    },
    strategyPlane: {
      responsibility: "MARKET_ADAPTER_AND_ENTRY_TIMING" as const,
      decisionPolicyMode:
        input.config.probabilityPolicy?.mode === "NET_EXPECTANCY"
          ? "NET_EXPECTANCY"
          : "STANDARD",
      decisionPolicyRole: "PARAMETERISED_BRAIN_WORK_MODE" as const,
      marketAdapter: entryTiming.wakeAdapter,
      marketProfile: specialisedMarketProfile ??
        (relativeStrength ? "RELATIVE_STRENGTH" : tradfi ? "TRADFI" : "UNIFIED"),
      contractType: input.config.marketProfile?.contractType ??
        (tradfi ? "TRADIFI_PERPETUAL" : "PERPETUAL"),
      triggerPolicy: input.config.marketProfile?.triggerPolicy ??
        (tradfi ? "PRICE_VOLUME_STRUCTURE" : "LIQUIDATION_ONLY"),
      directionMode,
      directionCapability,
      observationOnly: sentinel,
      canOwnPostFillLifecycle: false,
      entryTiming,
    },
    handoff: NEXUS_MAINLINE_HANDOFFS.ENTRY_TO_POSITION,
    positionPlane: unifiedPositionLifecycleMetadata(),
  };
}
