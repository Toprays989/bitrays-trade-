import type { StrategyTriggerAdapter } from "./contract.ts";

export const THREE_MINUTE_PROBABILITY_TRIGGER_VERSION =
  "three-minute-probability-trigger-v3" as const;

export type ThreeMinuteProbabilityFact = Readonly<{
  symbol: string;
  roundId: string;
  roundStartedAt: number;
  roundEndsAt: number;
  eventAt: number;
  receivedAt: number;
  referencePrice: number;
  factSnapshotId: string;
  modelVersion: string;
  pLongPercent: number;
  pShortPercent: number;
  grossEdgeBps: number;
  estimatedCostBps: number;
  netEdgeBps: number;
  breakEvenProbabilityPercent: number;
  configuredMinimumProbabilityPercent: number;
  admissionMinimumProbabilityPercent: number;
  candidateRole: "DIRECT_PROBABILITY";
  eligibilityMode: "DIRECT_PROBABILITY";
  sampleCount: number;
  dataQuality: "READY" | "STALE" | "INSUFFICIENT";
  featureVector: Readonly<Record<string, number | string>>;
  learningMode: "CALIBRATING" | "ACTIVE" | "OBSERVE_ONLY" | "MINIMUM_ORDER";
}>;

export type ThreeMinuteProbabilityCandidate = Readonly<{
  kind: "THREE_MINUTE_PROBABILITY";
  symbol: string;
  direction: "LONG" | "SHORT";
  roundId: string;
  roundStartedAt: number;
  roundEndsAt: number;
  eventAt: number;
  receivedAt: number;
  referencePrice: number;
  factSnapshotId: string;
  modelVersion: string;
  pLongPercent: number;
  pShortPercent: number;
  grossEdgeBps: number;
  estimatedCostBps: number;
  netEdgeBps: number;
  breakEvenProbabilityPercent: number;
  configuredMinimumProbabilityPercent: number;
  admissionMinimumProbabilityPercent: number;
  candidateRole: "DIRECT_PROBABILITY";
  eligibilityMode: "DIRECT_PROBABILITY";
  sampleCount: number;
  dataQuality: "READY";
  featureVector: Readonly<Record<string, number | string>>;
  learningMode: "CALIBRATING" | "ACTIVE" | "OBSERVE_ONLY" | "MINIMUM_ORDER";
}>;

export const threeMinuteProbabilityTriggerAdapter: StrategyTriggerAdapter<
  Readonly<{ rows: readonly ThreeMinuteProbabilityFact[]; processedAt: number }>,
  Readonly<{
    maxFactAgeMs: number;
    maximumCandidates: number;
    minimumProbabilityPercent?: number;
    minimumNetEdgeBps?: number;
  }>,
  ThreeMinuteProbabilityCandidate
> = Object.freeze({
  kind: "THREE_MINUTE_PROBABILITY",
  version: THREE_MINUTE_PROBABILITY_TRIGGER_VERSION,
  requiredFacts: Object.freeze([
    "MARK_PRICE_MULTI_INTERVAL_CLOSED_CANDLES" as const,
  ]),
  evaluate(input) {
    const latest = new Map<string, ThreeMinuteProbabilityFact>();
    for (const fact of input.facts.rows) {
      if (!validFact(fact, input.facts.processedAt, input.config.maxFactAgeMs))
        continue;
      const key = `${fact.symbol.trim().toUpperCase()}:${fact.roundId}`;
      const previous = latest.get(key);
      if (!previous || fact.receivedAt > previous.receivedAt) latest.set(key, fact);
    }
    return [...latest.values()]
      .map((fact): ThreeMinuteProbabilityCandidate | null => {
        const direction: "LONG" | "SHORT" =
          fact.pLongPercent >= fact.pShortPercent ? "LONG" : "SHORT";
        const probability = Math.max(fact.pLongPercent, fact.pShortPercent);
        const minimumProbabilityPercent = Math.max(
          0,
          Number(input.config.minimumProbabilityPercent) || 0,
        );
        if (
          fact.dataQuality !== "READY" ||
          probability < minimumProbabilityPercent
        ) return null;
        return {
          kind: "THREE_MINUTE_PROBABILITY" as const,
          symbol: fact.symbol.trim().toUpperCase(),
          direction,
          roundId: fact.roundId,
          roundStartedAt: fact.roundStartedAt,
          roundEndsAt: fact.roundEndsAt,
          eventAt: fact.eventAt,
          receivedAt: fact.receivedAt,
          referencePrice: fact.referencePrice,
          factSnapshotId: fact.factSnapshotId,
          modelVersion: fact.modelVersion,
          pLongPercent: fact.pLongPercent,
          pShortPercent: fact.pShortPercent,
          grossEdgeBps: fact.grossEdgeBps,
          estimatedCostBps: fact.estimatedCostBps,
          netEdgeBps: fact.netEdgeBps,
          breakEvenProbabilityPercent: fact.breakEvenProbabilityPercent,
          configuredMinimumProbabilityPercent:
            fact.configuredMinimumProbabilityPercent,
          admissionMinimumProbabilityPercent:
            fact.admissionMinimumProbabilityPercent,
          candidateRole: fact.candidateRole,
          eligibilityMode: fact.eligibilityMode,
          sampleCount: fact.sampleCount,
          dataQuality: "READY" as const,
          featureVector: fact.featureVector,
          learningMode: fact.learningMode,
        };
      })
      .filter((row): row is ThreeMinuteProbabilityCandidate => row !== null)
      .sort((left, right) =>
        Math.max(right.pLongPercent, right.pShortPercent) -
          Math.max(left.pLongPercent, left.pShortPercent) ||
        right.netEdgeBps - left.netEdgeBps ||
        left.symbol.localeCompare(right.symbol)
      )
      .slice(0, Math.max(0, Math.trunc(input.config.maximumCandidates)));
  },
});

function validFact(
  fact: ThreeMinuteProbabilityFact,
  processedAt: number,
  maxFactAgeMs: number,
) {
  return /^3m-\d+$/.test(fact.roundId) &&
    fact.roundEndsAt - fact.roundStartedAt === 180_000 &&
    fact.eventAt >= fact.roundStartedAt &&
    fact.eventAt < fact.roundEndsAt &&
    fact.receivedAt >= fact.eventAt &&
    processedAt >= fact.receivedAt &&
    processedAt - fact.receivedAt <= maxFactAgeMs &&
    fact.referencePrice > 0 &&
    Boolean(fact.factSnapshotId) &&
    Number.isFinite(fact.pLongPercent) &&
    Number.isFinite(fact.pShortPercent) &&
    Math.abs(fact.pLongPercent + fact.pShortPercent - 100) < 0.001;
}
