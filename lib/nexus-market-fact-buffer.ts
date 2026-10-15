import type {
  NexusMarketFact,
  NexusMarketFactKind,
} from "./nexus-market-facts";

export class NexusMarketFactBuffer {
  private readonly facts = new Map<string, NexusMarketFact>();
  private readonly factIdsBySymbol = new Map<string, Set<string>>();
  private readonly ageHeap: Array<{ id: string; eventAt: number }> = [];
  private readonly maximumSize: number;
  private readonly retentionMs: number;

  constructor(maximumSize = 2_000, retentionMs = 30 * 60_000) {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 1)
      throw new Error("market fact buffer maximumSize must be positive");
    if (!Number.isFinite(retentionMs) || retentionMs < 1)
      throw new Error("market fact buffer retentionMs must be positive");
    this.maximumSize = maximumSize;
    this.retentionMs = retentionMs;
  }

  add(fact: NexusMarketFact, now = Date.now()) {
    this.prune(now);
    const added = this.upsert(fact);
    this.trim();
    return added;
  }

  addMany(facts: NexusMarketFact[], now = Date.now()) {
    this.prune(now);
    let added = 0;
    for (const fact of facts) {
      if (this.upsert(fact)) added += 1;
    }
    this.trim();
    return added;
  }

  private upsert(fact: NexusMarketFact) {
    const existing = this.facts.get(fact.id);
    const duplicate = Boolean(existing);
    if (!existing) {
      this.facts.set(fact.id, fact);
      this.indexFact(fact);
      this.pushAge({ id: fact.id, eventAt: fact.eventAt });
    } else if (
      fact.receivedAt > existing.receivedAt ||
      fact.expiresAt > existing.expiresAt
    ) {
      // A closed candle keeps the same identity when the unified market
      // cache serves it again before the next candle closes. Refresh the
      // receipt/expiry metadata instead of leaving the first, now-expired
      // copy in the process buffer. Otherwise every timeframe can
      // incorrectly disappear from the decision snapshot after a quiet
      // period even though it was just read successfully.
      const refreshed = {
        ...fact,
        receivedAt: Math.max(existing.receivedAt, fact.receivedAt),
        expiresAt: Math.max(existing.expiresAt, fact.expiresAt),
      };
      this.facts.set(fact.id, refreshed);
      if (existing.symbol !== refreshed.symbol) {
        this.unindexFact(existing);
        this.indexFact(refreshed);
      }
      if (existing.eventAt !== refreshed.eventAt)
        this.pushAge({ id: refreshed.id, eventAt: refreshed.eventAt });
    }
    return !duplicate;
  }

  query(input: {
    symbol?: string;
    kinds?: NexusMarketFactKind[];
    freshOnly?: boolean;
    now?: number;
    limit?: number;
    /**
     * Reserve one slot for the newest fact of every kind/interval identity
     * before filling the remaining window with the newest events.
     *
     * Without this option, frequent 1m/3m and mark-price facts can evict the
     * latest 15m/30m/1h facts from a bounded decision window even though those
     * slower facts are still fresh.
     */
    preserveLatestByKindInterval?: boolean;
  } = {}) {
    const now = input.now ?? Date.now();
    this.prune(now);
    const symbol = input.symbol?.trim().toUpperCase();
    const kinds = input.kinds ? new Set(input.kinds) : null;
    const limit = Math.max(
      1,
      Math.trunc(input.limit ?? this.maximumSize),
    );
    const candidateIds = symbol
      ? this.factIdsBySymbol.get(symbol) ?? []
      : this.facts.keys();
    const matches: NexusMarketFact[] = [];
    for (const id of candidateIds) {
      const fact = this.facts.get(id);
      if (!fact || (symbol && fact.symbol !== symbol)) continue;
      if (kinds && !kinds.has(fact.kind)) continue;
      if (
        input.freshOnly &&
        !(
          fact.eventAt <= now &&
          fact.receivedAt <= now &&
          fact.expiresAt > now
        )
      ) continue;
      matches.push(fact);
    }
    matches.sort(
      (left, right) =>
        right.eventAt - left.eventAt || right.id.localeCompare(left.id),
    );
    if (!input.preserveLatestByKindInterval) return matches.slice(0, limit);

    const reserved: NexusMarketFact[] = [];
    const reservedIds = new Set<string>();
    const identities = new Set<string>();
    for (const fact of matches) {
      const identity = `${fact.kind}:${fact.interval ?? ""}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      reserved.push(fact);
      reservedIds.add(fact.id);
    }
    const selected = [
      ...reserved,
      ...matches.filter((fact) => !reservedIds.has(fact.id)),
    ]
      .slice(0, limit)
      .sort(
        (left, right) =>
          right.eventAt - left.eventAt || right.id.localeCompare(left.id),
      );
    return selected;
  }

  size(now = Date.now()) {
    this.prune(now);
    return this.facts.size;
  }

  prune(now = Date.now()) {
    const oldest = now - this.retentionMs;
    while (this.ageHeap.length > 0) {
      const next = this.ageHeap[0];
      if (next.eventAt >= oldest) break;
      const expired = this.popAge();
      if (expired) this.deleteIfCurrent(expired.id, expired.eventAt);
    }
  }

  private trim() {
    while (this.facts.size > this.maximumSize) {
      const oldest = this.popAge();
      if (!oldest) break;
      this.deleteIfCurrent(oldest.id, oldest.eventAt);
    }
  }

  private indexFact(fact: NexusMarketFact) {
    const ids = this.factIdsBySymbol.get(fact.symbol) ?? new Set<string>();
    ids.add(fact.id);
    this.factIdsBySymbol.set(fact.symbol, ids);
  }

  private unindexFact(fact: NexusMarketFact) {
    const ids = this.factIdsBySymbol.get(fact.symbol);
    if (!ids) return;
    ids.delete(fact.id);
    if (ids.size === 0) this.factIdsBySymbol.delete(fact.symbol);
  }

  private deleteIfCurrent(id: string, eventAt: number) {
    const current = this.facts.get(id);
    if (!current || current.eventAt !== eventAt) return false;
    this.facts.delete(id);
    this.unindexFact(current);
    return true;
  }

  private pushAge(entry: { id: string; eventAt: number }) {
    this.ageHeap.push(entry);
    let index = this.ageHeap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareAge(this.ageHeap[parent], entry) <= 0) break;
      this.ageHeap[index] = this.ageHeap[parent];
      index = parent;
    }
    this.ageHeap[index] = entry;
  }

  private popAge() {
    const root = this.ageHeap[0];
    const tail = this.ageHeap.pop();
    if (!root || !tail || this.ageHeap.length === 0) return root ?? null;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.ageHeap.length) break;
      const child =
        right < this.ageHeap.length &&
          compareAge(this.ageHeap[right], this.ageHeap[left]) < 0
          ? right
          : left;
      if (compareAge(tail, this.ageHeap[child]) <= 0) break;
      this.ageHeap[index] = this.ageHeap[child];
      index = child;
    }
    this.ageHeap[index] = tail;
    return root;
  }
}

function compareAge(
  left: { id: string; eventAt: number },
  right: { id: string; eventAt: number },
) {
  return left.eventAt - right.eventAt || left.id.localeCompare(right.id);
}

// Multi-timeframe decisions include 1h/4h closed candles. A 30-minute
// retention window silently discarded those facts between candle closes and
// made otherwise complete snapshots oscillate back to DATA_STALE.
export const nexusMarketFactBuffer = new NexusMarketFactBuffer(
  2_000,
  12 * 60 * 60_000,
);
