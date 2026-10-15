import type { StrategyTriggerAdapter } from "./contract.ts";
import type { SimpleReboundCandidate } from "../simple-rebound-scanner.ts";

export const SIMPLE_REBOUND_TRIGGER_VERSION = "simple-rebound-trigger-v1" as const;

export type SimpleReboundTriggerFact = Readonly<{
  candidate: SimpleReboundCandidate;
  eventAt: number;
  receivedAt: number;
}>;

export type SimpleReboundTriggerCandidate = Readonly<{
  kind: "SIMPLE_REBOUND";
  symbol: string;
  direction: "LONG";
  eventAt: number;
  receivedAt: number;
  referencePrice: number;
  phase: "READY";
}>;

export const simpleReboundTriggerAdapter: StrategyTriggerAdapter<
  Readonly<{ rows: readonly SimpleReboundTriggerFact[]; processedAt: number }>,
  Readonly<{ maxFactAgeMs: number; maximumCandidates: number }>,
  SimpleReboundTriggerCandidate
> = Object.freeze({
  kind: "SIMPLE_REBOUND",
  version: SIMPLE_REBOUND_TRIGGER_VERSION,
  requiredFacts: Object.freeze(["MARK_PRICE_SNAPSHOT"] as const),
  evaluate(input) {
    return input.facts.rows
      .filter((row) =>
        row.candidate.entry.eligible &&
        row.receivedAt <= input.facts.processedAt &&
        input.facts.processedAt - row.receivedAt <= input.config.maxFactAgeMs,
      )
      .map((row) => ({
        kind: "SIMPLE_REBOUND" as const,
        symbol: row.candidate.symbol,
        direction: "LONG" as const,
        eventAt: row.eventAt,
        receivedAt: row.receivedAt,
        referencePrice: row.candidate.referencePrice,
        phase: "READY" as const,
      }))
      .slice(0, Math.max(0, Math.trunc(input.config.maximumCandidates)));
  },
});
