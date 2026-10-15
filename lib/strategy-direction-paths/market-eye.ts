import type { NexusMarketEyeDecision } from "../nexus-market-eye-decision.ts";
import type {
  NexusDirectionBranchEvaluation,
  NexusTradeDirection,
} from "../nexus-direction-decision.ts";
import type { StrategyDirectionPathAdapter } from "./contract.ts";

export const NEXUS_MARKET_EYE_DIRECTION_PATH_VERSION =
  "nexus-market-eye-direction-path-v1" as const;

export type NexusMarketEyeDirectionFacts = Readonly<{
  factSnapshotId: string;
  decisions: Readonly<Record<NexusTradeDirection, NexusMarketEyeDecision>>;
  /** Current price → ATR structural invalidation distance, expressed as ROE. */
  structuralRiskRoePercent: Readonly<
    Record<NexusTradeDirection, number | null>
  >;
  uncertaintyRoePercent: Readonly<Record<NexusTradeDirection, number>>;
}>;

export type NexusMarketEyeDirectionConfig = Readonly<{
  expectedProfitRoePercent: number;
  estimatedCostRoePercent: number;
}>;

/**
 * Converts the two market-eye paths into comparable, order-neutral branches.
 * Both paths receive the exact same prepared facts object from the caller.
 */
export const nexusMarketEyeDirectionPathAdapter: StrategyDirectionPathAdapter<
  NexusMarketEyeDirectionFacts,
  NexusMarketEyeDirectionConfig
> = Object.freeze({
  kind: "NEXUS_MARKET_EYE",
  version: NEXUS_MARKET_EYE_DIRECTION_PATH_VERSION,
  capability: "COMPETING_DIRECTIONS",
  supportedDirections: Object.freeze(["LONG", "SHORT"] as const),
  evaluate(input): NexusDirectionBranchEvaluation {
    const eye = input.facts.decisions[input.direction];
    const expectedProfit = nonNegative(
      input.config.expectedProfitRoePercent,
    );
    const expectedLoss = positiveOrNull(
      input.facts.structuralRiskRoePercent[input.direction],
    );
    const estimatedCost = nonNegative(input.config.estimatedCostRoePercent);
    const uncertainty = nonNegative(
      input.facts.uncertaintyRoePercent[input.direction],
    );
    // This is a current-fact payoff margin, not a historical win-rate
    // prediction. The branch cannot be compared until it has a concrete
    // structure boundary for this exact snapshot.
    const netExpectancy = expectedLoss === null
      ? null
      : expectedProfit - expectedLoss - estimatedCost;
    const status = expectedLoss === null
      ? "WAIT" as const
      : eye.verdict === "CONFIRMED"
      ? "ELIGIBLE" as const
      : eye.verdict === "BLOCKED"
        ? "REJECTED" as const
        : "WAIT" as const;

    return Object.freeze({
      direction: input.direction,
      factSnapshotId: input.context.factSnapshotId,
      evaluatedAt: input.context.evaluatedAt,
      expiresAt: input.context.expiresAt,
      status,
      evidenceComplete:
        eye.verdict !== "INSUFFICIENT" &&
        eye.code !== "EYE_DECISION_SNAPSHOT_INCOMPLETE" &&
        expectedLoss !== null,
      structureValid:
        eye.verdict === "CONFIRMED" &&
        Boolean(eye.selectedPath) &&
        expectedLoss !== null,
      netExpectancyRoePercent:
        netExpectancy === null ? null : round(netExpectancy),
      expectedUpsideRoePercent: round(expectedProfit),
      expectedDownsideRoePercent:
        expectedLoss === null ? null : round(expectedLoss),
      uncertaintyRoePercent: round(uncertainty),
      reasonCodes: Object.freeze([
        eye.code,
        ...(expectedLoss === null ? ["STRUCTURAL_RISK_UNAVAILABLE"] : []),
      ]),
    });
  },
});

/**
 * Uncertainty is derived from explicit 1/2/3/4-hour disagreement rather than
 * an opaque score. Missing or opposing horizons consume part of the configured
 * loss budget, so an unclear background cannot win merely on nominal payoff.
 */
export function directionalStructureUncertaintyRoePercent(input: Readonly<{
  direction: NexusTradeDirection;
  structuralRiskRoePercent: number;
  horizons: readonly ("UP" | "DOWN" | "RANGE" | "INSUFFICIENT")[];
}>) {
  const lossBudget = nonNegative(input.structuralRiskRoePercent);
  if (!input.horizons.length) return lossBudget;
  const aligned = input.direction === "LONG" ? "UP" : "DOWN";
  const opposed = input.direction === "LONG" ? "DOWN" : "UP";
  let uncertaintyUnits = 0;
  for (const horizon of input.horizons) {
    if (horizon === aligned) continue;
    uncertaintyUnits += horizon === opposed ? 1 : 0.5;
  }
  return round(lossBudget * uncertaintyUnits / input.horizons.length);
}

export function configuredExpectedProfitRoePercent(
  steps: readonly Readonly<{ profitPercent: number; closePercent: number }>[],
) {
  const usable = steps.filter((step) =>
    Number.isFinite(step.profitPercent) &&
    step.profitPercent > 0 &&
    Number.isFinite(step.closePercent) &&
    step.closePercent > 0
  );
  if (!usable.length) return 0;
  const totalClose = usable.reduce((sum, step) => sum + step.closePercent, 0);
  if (totalClose <= 0) return 0;
  return round(
    usable.reduce(
      (sum, step) => sum + step.profitPercent * step.closePercent,
      0,
    ) / totalClose,
  );
}

function nonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function positiveOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
