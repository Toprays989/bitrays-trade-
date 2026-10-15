import {
  resolveNexusDirectionCapability,
  selectNexusDirectionDecision,
  type NexusConfiguredDirection,
  type NexusDirectionDecisionIdentity,
  type NexusDirectionDecisionPolicy,
  type NexusTradeDirection,
} from "../nexus-direction-decision.ts";
import type {
  NexusDirectionPathContext,
  StrategyDirectionPathAdapter,
} from "./contract.ts";

/**
 * Runs every configured side through one strategy path using the exact same
 * prepared facts object, then hands all results to the shared brain selector.
 */
export function evaluateNexusStrategyDirections<TFacts, TConfig>(
  input: Readonly<{
    adapter: StrategyDirectionPathAdapter<TFacts, TConfig>;
    facts: Readonly<TFacts>;
    config: Readonly<TConfig>;
    context: NexusDirectionPathContext;
    identity: NexusDirectionDecisionIdentity;
    configuredDirection: NexusConfiguredDirection;
    executionDirectionMode?: "FOLLOW_BRAIN" | "INVERSE_BRAIN";
    policy: NexusDirectionDecisionPolicy;
    decisionAt: number;
  }>,
) {
  const capability = resolveNexusDirectionCapability({
    configuredDirection: input.configuredDirection,
    marketProfileMode:
      input.adapter.capability === "COORDINATED_PAIR"
        ? "RELATIVE_STRENGTH"
        : null,
    decisionMode:
      input.adapter.capability === "COMPETING_DIRECTIONS"
        ? "COMPETING_DIRECTIONS"
        : "TRIGGER_DIRECTED",
  });
  const requestedDirections = configuredDirections(input.configuredDirection);
  const supported = new Set(input.adapter.supportedDirections);
  const branches = requestedDirections
    .filter((direction) => supported.has(direction))
    .map((direction) => input.adapter.evaluate({
      direction,
      facts: input.facts,
      config: input.config,
      context: input.context,
    }));

  return selectNexusDirectionDecision({
    identity: input.identity,
    capability,
    configuredDirection: input.configuredDirection,
    executionDirectionMode: input.executionDirectionMode,
    decisionAt: input.decisionAt,
    policy: input.policy,
    branches,
  });
}

function configuredDirections(
  configuredDirection: NexusConfiguredDirection,
): NexusTradeDirection[] {
  if (configuredDirection === "LONG_ONLY") return ["LONG"];
  if (configuredDirection === "SHORT_ONLY") return ["SHORT"];
  return ["LONG", "SHORT"];
}
