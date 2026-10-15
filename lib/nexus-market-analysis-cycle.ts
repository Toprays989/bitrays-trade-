import type {
  NexusCandleSource,
  NexusMarketInterval,
  NexusUnifiedCandle,
  NexusUnifiedMarketData,
  NexusUnifiedMarketSnapshot,
} from "./nexus-unified-market-data.ts";

/**
 * Request-scoped candle views for one analysis cycle.
 *
 * The shared market cache remains the only cross-request cache. This object
 * only prevents one monitor POST from repeatedly projecting the same closed
 * candle rows for its own independent features.
 */
export class NexusMarketAnalysisCycle {
  private readonly series = new Map<string, NexusUnifiedMarketSnapshot>();
  private readonly views = new Map<string, NexusUnifiedCandle[]>();
  private readonly snapshots = new Map<string, NexusUnifiedMarketSnapshot>();
  private readonly inFlight = new Map<
    string,
    Promise<NexusUnifiedMarketSnapshot>
  >();
  private readonly marketData: NexusUnifiedMarketData;
  private readonly now: number;

  constructor(marketData: NexusUnifiedMarketData, now: number) {
    this.marketData = marketData;
    this.now = now;
  }

  async load(input: {
    symbol: string;
    interval: NexusMarketInterval;
    source: NexusCandleSource;
    limit: number;
  }) {
    return (await this.closedSnapshot(input)).rows;
  }

  closedSnapshot(input: {
    symbol: string;
    interval: NexusMarketInterval;
    source: NexusCandleSource;
    limit: number;
  }) {
    const limit = normalizedLimit(input.limit);
    const seriesKey = keyOf(input);
    const existing = this.series.get(seriesKey);
    if (existing && existing.rows.length >= limit)
      return Promise.resolve(this.projectSnapshot(seriesKey, existing, limit));

    const requestKey = `${seriesKey}:${limit}`;
    const pending = this.inFlight.get(requestKey);
    if (pending) return pending;

    const request = this.loadSnapshot(input, seriesKey, limit).finally(() => {
      if (this.inFlight.get(requestKey) === request)
        this.inFlight.delete(requestKey);
    });
    this.inFlight.set(requestKey, request);
    return request;
  }

  private async loadSnapshot(
    input: {
      symbol: string;
      interval: NexusMarketInterval;
      source: NexusCandleSource;
      limit: number;
    },
    seriesKey: string,
    limit: number,
  ) {
    const snapshot = await this.marketData.closedCandles({
      ...input,
      limit,
      now: this.now,
    });
    const previous = this.series.get(seriesKey);
    const retained =
      previous && previous.rows.length >= snapshot.rows.length
        ? previous
        : snapshot;
    this.series.set(seriesKey, retained);
    return this.projectSnapshot(seriesKey, retained, limit);
  }

  cached(input: {
    symbol: string;
    interval: NexusMarketInterval;
    source: NexusCandleSource;
    limit: number;
  }) {
    const limit = normalizedLimit(input.limit);
    const seriesKey = keyOf(input);
    const snapshot = this.series.get(seriesKey);
    return snapshot && snapshot.rows.length >= limit
      ? this.project(seriesKey, snapshot.rows, limit)
      : null;
  }

  clear() {
    this.series.clear();
    this.views.clear();
    this.snapshots.clear();
    this.inFlight.clear();
  }

  private project(seriesKey: string, rows: NexusUnifiedCandle[], limit: number) {
    const viewKey = `${seriesKey}:${limit}`;
    const existing = this.views.get(viewKey);
    if (existing) return existing;
    const view = rows.length === limit ? rows : rows.slice(-limit);
    this.views.set(viewKey, view);
    return view;
  }

  private projectSnapshot(
    seriesKey: string,
    snapshot: NexusUnifiedMarketSnapshot,
    limit: number,
  ) {
    const viewKey = `${seriesKey}:${limit}`;
    const existing = this.snapshots.get(viewKey);
    if (existing) return existing;
    const projected = {
      ...snapshot,
      rows: this.project(seriesKey, snapshot.rows, limit),
    };
    this.snapshots.set(viewKey, projected);
    return projected;
  }
}

function keyOf(input: {
  symbol: string;
  interval: NexusMarketInterval;
  source: NexusCandleSource;
}) {
  return `${input.source}:${input.symbol.trim().toUpperCase()}:${input.interval}`;
}

function normalizedLimit(value: number) {
  return Math.max(1, Math.trunc(value));
}
