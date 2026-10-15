import type { StrategyTriggerAdapter } from "./contract.ts";

export const LOW_POSITION_WINDOW_TRIGGER_VERSION =
  "low-position-window-trigger-v1" as const;

export type LowPositionWindowFact = Readonly<{
  symbol: string;
  markPrice: number;
  high72h: number;
  low72h: number;
  eventAt: number;
  receivedAt: number;
  factSnapshotId: string;
}>;

export type LowPositionWindowTriggerFacts = Readonly<{
  rows: readonly LowPositionWindowFact[];
  processedAt: number;
}>;

export type LowPositionWindowTriggerConfig = Readonly<{
  maxPosition72hPercent: number;
  maxFactAgeMs: number;
}>;

export type LowPositionWindowTriggerCandidate = Readonly<{
  kind: "LOW_POSITION_WINDOW";
  symbol: string;
  direction: "LONG";
  markPrice: number;
  high72h: number;
  low72h: number;
  position72hPercent: number;
  eventAt: number;
  receivedAt: number;
  factSnapshotId: string;
}>;

const MAX_FUTURE_SKEW_MS = 1_000;

export const lowPositionWindowTriggerAdapter: StrategyTriggerAdapter<
  LowPositionWindowTriggerFacts,
  LowPositionWindowTriggerConfig,
  LowPositionWindowTriggerCandidate
> = Object.freeze({
  kind: "LOW_POSITION_WINDOW",
  version: LOW_POSITION_WINDOW_TRIGGER_VERSION,
  requiredFacts: Object.freeze(["MARK_PRICE_72H_RANGE" as const]),
  evaluate(input) {
    const { maxPosition72hPercent, maxFactAgeMs } = input.config;
    const processedAt = input.facts.processedAt;
    if (
      !Number.isFinite(maxPosition72hPercent) ||
      maxPosition72hPercent <= 0 ||
      maxPosition72hPercent > 100 ||
      !Number.isFinite(maxFactAgeMs) ||
      maxFactAgeMs <= 0 ||
      !Number.isFinite(processedAt) ||
      processedAt <= 0
    ) return [];

    const latestBySymbol = new Map<string, LowPositionWindowFact>();
    for (const row of input.facts.rows) {
      const normalized = normalizedFact(row, processedAt, maxFactAgeMs);
      if (!normalized) continue;
      const previous = latestBySymbol.get(normalized.symbol);
      if (
        !previous ||
        normalized.eventAt > previous.eventAt ||
        (normalized.eventAt === previous.eventAt &&
          normalized.receivedAt > previous.receivedAt)
      ) latestBySymbol.set(normalized.symbol, normalized);
    }

    return [...latestBySymbol.values()]
      .map((row) => {
        const position72hPercent =
          ((row.markPrice - row.low72h) / (row.high72h - row.low72h)) * 100;
        if (position72hPercent >= maxPosition72hPercent) return null;
        return {
          kind: "LOW_POSITION_WINDOW" as const,
          symbol: row.symbol,
          direction: "LONG" as const,
          markPrice: row.markPrice,
          high72h: row.high72h,
          low72h: row.low72h,
          position72hPercent,
          eventAt: row.eventAt,
          receivedAt: row.receivedAt,
          factSnapshotId: row.factSnapshotId,
        };
      })
      .filter((candidate): candidate is LowPositionWindowTriggerCandidate =>
        candidate !== null
      )
      .sort((left, right) =>
        right.eventAt - left.eventAt ||
        left.position72hPercent - right.position72hPercent ||
        left.symbol.localeCompare(right.symbol)
      );
  },
});

function normalizedFact(
  row: LowPositionWindowFact,
  processedAt: number,
  maxFactAgeMs: number,
): LowPositionWindowFact | null {
  const symbol = row.symbol.trim().toUpperCase();
  if (
    !symbol ||
    ![row.markPrice, row.high72h, row.low72h, row.eventAt, row.receivedAt]
      .every(Number.isFinite) ||
    row.markPrice <= 0 ||
    row.low72h <= 0 ||
    row.high72h <= row.low72h ||
    row.markPrice < row.low72h ||
    row.markPrice > row.high72h ||
    row.eventAt <= 0 ||
    row.receivedAt <= 0 ||
    typeof row.factSnapshotId !== "string" ||
    !row.factSnapshotId.trim() ||
    row.eventAt > row.receivedAt + MAX_FUTURE_SKEW_MS ||
    row.eventAt > processedAt + MAX_FUTURE_SKEW_MS ||
    row.receivedAt > processedAt + MAX_FUTURE_SKEW_MS ||
    processedAt - row.eventAt >= maxFactAgeMs ||
    processedAt - row.receivedAt >= maxFactAgeMs
  ) return null;
  return { ...row, symbol };
}
