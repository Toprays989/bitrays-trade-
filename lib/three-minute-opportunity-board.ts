import type { StrategyTriggerWake } from "./strategy-trigger-wake";

export const THREE_MINUTE_OPPORTUNITY_BOARD_CAPACITY = 128;
export const THREE_MINUTE_OPPORTUNITY_BOARD_TTL_MS = 45_000;
export const THREE_MINUTE_OPPORTUNITY_PREEMPTION_MARGIN = 5;

export type ThreeMinuteOpportunityBoardEntry = Readonly<{
  wake: StrategyTriggerWake;
  priority: number;
  observedAtMs: number;
  expiresAtMs: number;
}>;

/**
 * Keeps only the latest coarse opportunity for each symbol. This is a bounded
 * current-state board, not a FIFO and not a historical event log: a fresh
 * market fact replaces the prior fact so bursty markets cannot create an
 * ever-growing queue of stale three-minute decisions.
 */
export class ThreeMinuteOpportunityBoard {
  readonly #entries = new Map<string, ThreeMinuteOpportunityBoardEntry>();

  refresh(wakes: readonly StrategyTriggerWake[], nowMs: number) {
    this.prune(nowMs);
    for (const wake of wakes) {
      const symbol = normalizedSymbol(wake.symbol);
      if (!symbol) continue;
      const canonicalWake = wake.symbol === symbol ? wake : { ...wake, symbol };
      const observedAtMs = finiteTimestamp(wake.receivedAt, nowMs);
      const expiresAtMs = Math.min(
        finiteTimestamp(wake.expiresAt, nowMs + THREE_MINUTE_OPPORTUNITY_BOARD_TTL_MS),
        observedAtMs + THREE_MINUTE_OPPORTUNITY_BOARD_TTL_MS,
      );
      if (expiresAtMs <= nowMs) continue;
      const previous = this.#entries.get(symbol);
      if (previous && previous.observedAtMs > observedAtMs) continue;
      this.#entries.delete(symbol);
      this.#entries.set(symbol, Object.freeze({
        wake: canonicalWake,
        priority: threeMinuteOpportunityPriority(canonicalWake),
        observedAtMs,
        expiresAtMs,
      }));
    }
    this.#trim();
    return this.snapshot(nowMs);
  }

  snapshot(nowMs: number) {
    this.prune(nowMs);
    return [...this.#entries.values()].sort(compareEntries);
  }

  remove(symbol: string) {
    this.#entries.delete(symbol.trim().toUpperCase());
  }

  prune(nowMs: number) {
    for (const [symbol, entry] of this.#entries)
      if (entry.expiresAtMs <= nowMs) this.#entries.delete(symbol);
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    return this.#entries.size;
  }

  #trim() {
    const ranked = [...this.#entries.values()].sort(compareEntries);
    for (const entry of ranked.slice(THREE_MINUTE_OPPORTUNITY_BOARD_CAPACITY))
      this.#entries.delete(normalizedSymbol(entry.wake.symbol));
  }
}

function normalizedSymbol(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function threeMinuteOpportunityPriority(wake: StrategyTriggerWake) {
  const evidence = record(wake.evidence);
  const longProbability = finite(evidence.pLongPercent);
  const shortProbability = finite(evidence.pShortPercent);
  const selectedProbability = wake.direction === "LONG"
    ? longProbability
    : shortProbability;
  return round(selectedProbability ?? 0, 6);
}

export function threeMinuteOpportunityShouldPreempt(input: {
  incomingPriority: number;
  weakestPriority: number;
}) {
  return input.incomingPriority >=
    input.weakestPriority + THREE_MINUTE_OPPORTUNITY_PREEMPTION_MARGIN;
}

function compareEntries(
  left: ThreeMinuteOpportunityBoardEntry,
  right: ThreeMinuteOpportunityBoardEntry,
) {
  return right.priority - left.priority ||
    right.observedAtMs - left.observedAtMs ||
    left.wake.symbol.localeCompare(right.wake.symbol);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteTimestamp(value: unknown, fallback: number) {
  const number = finite(value);
  return number !== null && number > 0 ? number : fallback;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
