import type { StrategyTriggerAdapter } from "./contract.ts";

export const SCHEDULED_SCAN_TRIGGER_VERSION =
  "scheduled-scan-trigger-v1" as const;

export type ScheduledScanFact = Readonly<{
  symbol: string;
  previousClose: number;
  latestClose: number;
  eventAt: number;
  receivedAt: number;
  scheduleWindowStartedAt: number;
  scheduleWindowEndsAt: number;
  factSnapshotId: string;
}>;

export type ScheduledScanTriggerCandidate = Readonly<{
  kind: "SCHEDULED_SCAN";
  symbol: string;
  direction: "LONG" | "SHORT";
  referencePrice: number;
  changeBps: number;
  scheduleWindowStartedAt: number;
  scheduleWindowEndsAt: number;
  eventAt: number;
  receivedAt: number;
  factSnapshotId: string;
}>;

export const scheduledScanTriggerAdapter: StrategyTriggerAdapter<
  Readonly<{ rows: readonly ScheduledScanFact[]; processedAt: number }>,
  Readonly<{
    maxFactAgeMs: number;
    direction: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  }>,
  ScheduledScanTriggerCandidate
> = Object.freeze({
  kind: "SCHEDULED_SCAN",
  version: SCHEDULED_SCAN_TRIGGER_VERSION,
  requiredFacts: Object.freeze([
    "SCHEDULE_WINDOW" as const,
    "MARK_PRICE_MULTI_INTERVAL_CLOSED_CANDLES" as const,
  ]),
  evaluate(input) {
    if (
      !Number.isFinite(input.facts.processedAt) ||
      !Number.isFinite(input.config.maxFactAgeMs) ||
      input.config.maxFactAgeMs <= 0
    ) return [];
    return input.facts.rows
      .flatMap((fact): ScheduledScanTriggerCandidate[] => {
        const symbol = fact.symbol.trim().toUpperCase();
        if (
          !/^[A-Z0-9]{3,30}$/.test(symbol) ||
          ![fact.previousClose, fact.latestClose, fact.eventAt, fact.receivedAt,
            fact.scheduleWindowStartedAt, fact.scheduleWindowEndsAt]
            .every(Number.isFinite) ||
          fact.previousClose <= 0 ||
          fact.latestClose <= 0 ||
          fact.scheduleWindowStartedAt <= 0 ||
          fact.scheduleWindowEndsAt <= fact.scheduleWindowStartedAt ||
          input.facts.processedAt < fact.scheduleWindowStartedAt ||
          input.facts.processedAt >= fact.scheduleWindowEndsAt ||
          fact.eventAt <= 0 ||
          fact.receivedAt < fact.eventAt ||
          fact.receivedAt > input.facts.processedAt + 1_000 ||
          input.facts.processedAt - fact.receivedAt > input.config.maxFactAgeMs ||
          !fact.factSnapshotId.trim()
        ) return [];
        const changeBps = (fact.latestClose / fact.previousClose - 1) * 10_000;
        const directions = input.config.direction === "LONG_ONLY"
          ? ["LONG" as const]
          : input.config.direction === "SHORT_ONLY"
            ? ["SHORT" as const]
            : ["LONG" as const, "SHORT" as const];
        return directions.map((direction) => ({
          kind: "SCHEDULED_SCAN" as const,
          symbol,
          direction,
          referencePrice: fact.latestClose,
          changeBps,
          scheduleWindowStartedAt: fact.scheduleWindowStartedAt,
          scheduleWindowEndsAt: fact.scheduleWindowEndsAt,
          eventAt: fact.eventAt,
          receivedAt: fact.receivedAt,
          factSnapshotId: fact.factSnapshotId,
        }));
      })
      .sort((left, right) =>
        Math.abs(right.changeBps) - Math.abs(left.changeBps) ||
        left.symbol.localeCompare(right.symbol) ||
        left.direction.localeCompare(right.direction)
      );
  },
});
