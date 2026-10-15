export const NEXUS_MARKET_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
] as const;

export type NexusMarketInterval = (typeof NEXUS_MARKET_INTERVALS)[number];
export type NexusCandleSource = "TRADE" | "MARK_PRICE";
export type NexusUnifiedCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
};

export type NexusUnifiedMarketSnapshot = {
  source: NexusCandleSource;
  symbol: string;
  interval: NexusMarketInterval;
  receivedAt: number;
  expiresAt: number;
  rows: NexusUnifiedCandle[];
};

type CandleLoader = (
  symbol: string,
  interval: NexusMarketInterval,
  limit: number,
) => Promise<NexusUnifiedCandle[]>;

type CacheEntry = {
  rows: NexusUnifiedCandle[];
  requestedLimit: number;
  estimatedBytes: number;
  receivedAt: number;
  expiresAt: number;
  lastAccessedAt: number;
};

export type NexusUnifiedMarketDataMetrics = {
  version: "nexus-unified-market-data-v1";
  cacheEntries: number;
  upstreamLoads: number;
  cacheHits: number;
  cacheOnlyHits: number;
  cacheOnlyMisses: number;
  inFlightJoins: number;
  expiryPruneScans: number;
  expiredInFlightLoads: number;
  staleRejected: number;
  expiredEntriesPruned: number;
  capacityEvictions: number;
  cacheCandleRows: number;
  cacheUpgrades: number;
  upstreamRequestedCandleRows: number;
  cacheEstimatedBytes: number;
  maximumCacheEntries: number;
  maximumCacheBytes: number;
  memoryCapacityEvictions: number;
  latestReceivedAt: number | null;
};

// Binance USD-M K-line requests move to the next request-weight tier at 100
// rows. Keep 99 as the maximum supported analysis window, but load only the
// number of rows the caller actually needs. A later wider request upgrades the
// same cache entry without reducing any strategy's evidence window.
const CANONICAL_CANDLE_LIMIT = 99;
const DEFAULT_MAXIMUM_CACHE_ENTRIES = 1_200;
const DEFAULT_MAXIMUM_CACHE_BYTES = 32 * 1024 * 1024;
const INTERVAL_MS: Record<NexusMarketInterval, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export class NexusUnifiedMarketData {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly loaders: Record<NexusCandleSource, CandleLoader>;
  private readonly canonicalLimit: number;
  private readonly maximumCacheEntries: number;
  private readonly maximumCacheBytes: number;
  private cacheEstimatedBytes = 0;
  private nextExpiryAt = Number.POSITIVE_INFINITY;
  private upstreamLoads = 0;
  private cacheHits = 0;
  private cacheOnlyHits = 0;
  private cacheOnlyMisses = 0;
  private inFlightJoins = 0;
  private expiryPruneScans = 0;
  private staleRejected = 0;
  private expiredEntriesPruned = 0;
  private capacityEvictions = 0;
  private cacheUpgrades = 0;
  private upstreamRequestedCandleRows = 0;
  private memoryCapacityEvictions = 0;

  constructor(
    loaders: Record<NexusCandleSource, CandleLoader>,
    canonicalLimit = CANONICAL_CANDLE_LIMIT,
    _maximumLoadMs = 15_000,
    maximumCacheEntries = DEFAULT_MAXIMUM_CACHE_ENTRIES,
    maximumCacheBytes = DEFAULT_MAXIMUM_CACHE_BYTES,
  ) {
    if (!Number.isSafeInteger(canonicalLimit) || canonicalLimit < 1)
      throw new Error("统一行情固定窗口必须为正整数");
    if (!Number.isFinite(_maximumLoadMs) || _maximumLoadMs < 1)
      throw new Error("统一行情加载超时必须为正数");
    if (!Number.isSafeInteger(maximumCacheEntries) || maximumCacheEntries < 1)
      throw new Error("统一行情缓存上限必须为正整数");
    if (!Number.isSafeInteger(maximumCacheBytes) || maximumCacheBytes < 1)
      throw new Error("统一行情缓存字节上限必须为正整数");
    this.loaders = loaders;
    this.canonicalLimit = canonicalLimit;
    this.maximumCacheEntries = maximumCacheEntries;
    this.maximumCacheBytes = maximumCacheBytes;
  }

  async closedCandles(input: {
    symbol: string;
    interval: NexusMarketInterval;
    source?: NexusCandleSource;
    limit: number;
    now?: number;
  }) {
    const symbol = normalizeSymbol(input.symbol);
    const source = input.source ?? "TRADE";
    const requestedLimit = Math.max(
      1,
      Math.min(this.canonicalLimit, Math.trunc(input.limit)),
    );
    const now = input.now ?? Date.now();
    this.pruneExpiredEntries(now);
    const key = `${source}:${symbol}:${input.interval}`;
    let entry = this.cache.get(key);
    if (
      entry &&
      entry.expiresAt > now &&
      entry.requestedLimit >= requestedLimit
    ) {
      this.cacheHits += 1;
      this.touchCacheEntry(key, entry, now);
      return snapshot(entry, requestedLimit, source, symbol, input.interval);
    }
    if (entry && entry.expiresAt <= now) {
      this.deleteEntry(key, entry);
      this.staleRejected += 1;
      entry = undefined;
    } else if (entry) {
      this.cacheUpgrades += 1;
    }

    // Never retain a loader Promise across Worker requests. The concrete
    // Binance loaders own cancellation; the shared cache stores resolved
    // plain candle rows only.
    entry = await this.load({
      key,
      source,
      symbol,
      interval: input.interval,
      requestedLimit,
    });
    return snapshot(entry, requestedLimit, source, symbol, input.interval);
  }

  /**
   * Read an already-valid shared candle snapshot without starting an upstream
   * request. Observation triggers use this boundary so broader discovery can
   * never multiply Binance REST weight.
   */
  cachedClosedCandles(input: {
    symbol: string;
    interval: NexusMarketInterval;
    source?: NexusCandleSource;
    limit: number;
    now?: number;
  }): NexusUnifiedMarketSnapshot | null {
    const symbol = normalizeSymbol(input.symbol);
    const source = input.source ?? "TRADE";
    const requestedLimit = Math.max(
      1,
      Math.min(this.canonicalLimit, Math.trunc(input.limit)),
    );
    const now = input.now ?? Date.now();
    this.pruneExpiredEntries(now);
    const entry = this.cache.get(`${source}:${symbol}:${input.interval}`);
    if (
      !entry ||
      entry.expiresAt <= now ||
      entry.requestedLimit < requestedLimit
    ) {
      this.cacheOnlyMisses += 1;
      return null;
    }
    this.cacheOnlyHits += 1;
    this.cacheHits += 1;
    this.touchCacheEntry(
      `${source}:${symbol}:${input.interval}`,
      entry,
      now,
    );
    return snapshot(entry, requestedLimit, source, symbol, input.interval);
  }

  metrics(): NexusUnifiedMarketDataMetrics {
    this.pruneExpiredEntries(Date.now());
    let cacheCandleRows = 0;
    let latestReceivedAt: number | null = null;
    for (const entry of this.cache.values()) {
      cacheCandleRows += entry.rows.length;
      latestReceivedAt = latestReceivedAt === null
        ? entry.receivedAt
        : Math.max(latestReceivedAt, entry.receivedAt);
    }
    return {
      version: "nexus-unified-market-data-v1",
      cacheEntries: this.cache.size,
      upstreamLoads: this.upstreamLoads,
      cacheHits: this.cacheHits,
      cacheOnlyHits: this.cacheOnlyHits,
      cacheOnlyMisses: this.cacheOnlyMisses,
      inFlightJoins: this.inFlightJoins,
      expiryPruneScans: this.expiryPruneScans,
      expiredInFlightLoads: 0,
      staleRejected: this.staleRejected,
      expiredEntriesPruned: this.expiredEntriesPruned,
      capacityEvictions: this.capacityEvictions,
      cacheCandleRows,
      cacheUpgrades: this.cacheUpgrades,
      upstreamRequestedCandleRows: this.upstreamRequestedCandleRows,
      cacheEstimatedBytes: this.cacheEstimatedBytes,
      maximumCacheEntries: this.maximumCacheEntries,
      maximumCacheBytes: this.maximumCacheBytes,
      memoryCapacityEvictions: this.memoryCapacityEvictions,
      latestReceivedAt,
    };
  }

  clear() {
    this.cache.clear();
    this.cacheEstimatedBytes = 0;
    this.nextExpiryAt = Number.POSITIVE_INFINITY;
  }

  private async load(input: {
    key: string;
    source: NexusCandleSource;
    symbol: string;
    interval: NexusMarketInterval;
    requestedLimit: number;
  }) {
    this.upstreamLoads += 1;
    this.upstreamRequestedCandleRows += input.requestedLimit;
    const rows = await this.loaders[input.source](
      input.symbol,
      input.interval,
      input.requestedLimit,
    );
    const receivedAt = Date.now();
    const closedRows = rows
      .filter(validCandle)
      .filter(
        (row) =>
          row.openTime + INTERVAL_MS[input.interval] <= receivedAt,
      )
      .sort((left, right) => left.openTime - right.openTime)
      .slice(-input.requestedLimit);
    if (!closedRows.length)
      throw new Error(`${input.symbol} ${input.interval} 统一行情没有已收盘K线`);
    const entry = {
      rows: closedRows,
      requestedLimit: input.requestedLimit,
      estimatedBytes: estimatedCacheEntryBytes(input.key, closedRows),
      receivedAt,
      expiresAt: nextCandleRefreshAt(input.interval, receivedAt),
      lastAccessedAt: receivedAt,
    };
    const current = this.cache.get(input.key);
    if (
      current &&
      current.expiresAt > receivedAt &&
      current.requestedLimit >= entry.requestedLimit
    ) {
      this.touchCacheEntry(input.key, current, receivedAt);
      return current;
    }
    if (current) this.deleteEntry(input.key, current);
    this.cache.set(input.key, entry);
    this.cacheEstimatedBytes += entry.estimatedBytes;
    this.nextExpiryAt = Math.min(this.nextExpiryAt, entry.expiresAt);
    this.enforceCacheCapacity();
    return entry;
  }

  private pruneExpiredEntries(now: number) {
    if (now < this.nextExpiryAt) return;
    this.expiryPruneScans += 1;
    let nextExpiryAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.deleteEntry(key, entry);
        this.expiredEntriesPruned += 1;
        this.staleRejected += 1;
        continue;
      }
      nextExpiryAt = Math.min(nextExpiryAt, entry.expiresAt);
    }
    this.nextExpiryAt = nextExpiryAt;
  }

  private enforceCacheCapacity() {
    while (
      this.cache.size > this.maximumCacheEntries ||
      this.cacheEstimatedBytes > this.maximumCacheBytes
    ) {
      const key = this.cache.keys().next().value as string | undefined;
      if (!key) break;
      const entry = this.cache.get(key);
      if (!entry) break;
      const memoryPressure = this.cacheEstimatedBytes > this.maximumCacheBytes;
      this.deleteEntry(key, entry);
      this.capacityEvictions += 1;
      if (memoryPressure) this.memoryCapacityEvictions += 1;
    }
  }

  private touchCacheEntry(key: string, entry: CacheEntry, now: number) {
    entry.lastAccessedAt = now;
    // Map insertion order is the LRU order. Refreshing a hit lets capacity
    // eviction remove the oldest key directly instead of allocating and
    // sorting the entire cache on every full-market insertion.
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private deleteEntry(key: string, entry: CacheEntry) {
    this.cache.delete(key);
    this.cacheEstimatedBytes = Math.max(
      0,
      this.cacheEstimatedBytes - entry.estimatedBytes,
    );
  }
}

function estimatedCacheEntryBytes(
  key: string,
  rows: NexusUnifiedCandle[],
) {
  // Eight numeric fields plus object/array/key overhead. This intentionally
  // overestimates so the byte ceiling remains a conservative memory boundary.
  return key.length * 2 + rows.length * 128 + 256;
}

function snapshot(
  entry: CacheEntry,
  limit: number,
  source: NexusCandleSource,
  symbol: string,
  interval: NexusMarketInterval,
): NexusUnifiedMarketSnapshot {
  return {
    source,
    symbol,
    interval,
    receivedAt: entry.receivedAt,
    expiresAt: entry.expiresAt,
    rows: entry.rows.slice(-limit),
  };
}

function nextCandleRefreshAt(interval: NexusMarketInterval, now: number) {
  const intervalMs = INTERVAL_MS[interval];
  return (Math.floor(now / intervalMs) + 1) * intervalMs + 2_000;
}

function normalizeSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(normalized))
    throw new Error("统一行情合约代码无效");
  return normalized;
}

function validCandle(row: NexusUnifiedCandle) {
  return (
    Number.isFinite(row.openTime) &&
    [row.open, row.high, row.low, row.close].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    Number.isFinite(row.volume) &&
    row.volume >= 0
  );
}
