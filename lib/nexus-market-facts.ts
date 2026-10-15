import type { NexusMarketContextSnapshot } from "./nexus-market-context-snapshot.ts";

export type NexusMarketFactKind =
  | "MARK_PRICE_UPDATED"
  | "TICKER_24H_UPDATED"
  | "BTC_RELATIONSHIP_CLASSIFIED"
  | "TREND_REGIME_CLASSIFIED"
  | "LIQUIDATION_AGGREGATED"
  | "LIQUIDATION_DERIVED_FACTORS"
  | "MARKET_STRUCTURE_WAKE"
  | "MARKET_CONTEXT_POSITION_UPDATED"
  | "PRICE_IMPULSE_UP"
  | "PRICE_IMPULSE_DOWN"
  | "CANDLE_CLOSED"
  | "OPEN_INTEREST_UPDATED"
  | "PRICE_NEW_HIGH"
  | "PRICE_NEW_LOW"
  | "SUPPORT_SWEPT"
  | "SUPPORT_RECLAIMED"
  | "SUPPORT_BROKEN"
  | "FAILED_RETEST_CONFIRMED"
  | "RESISTANCE_REJECTED"
  | "VOLUME_EXPANDED"
  | "DATA_STALE";

export type NexusMarketFactSource =
  | "BINANCE_WEBSOCKET"
  | "BINANCE_REST"
  | "SYSTEM_DERIVED";

export type NexusMarketFact<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  version: 1;
  id: string;
  kind: NexusMarketFactKind;
  symbol: string;
  interval: string | null;
  source: NexusMarketFactSource;
  eventAt: number;
  receivedAt: number;
  expiresAt: number;
  payload: TPayload;
};

export type NexusClosedCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
};

export type NexusOpenTimeCandle = Omit<NexusClosedCandle, "closeTime">;

type FactInput<TPayload extends Record<string, unknown>> = Omit<
  NexusMarketFact<TPayload>,
  "version" | "id" | "symbol"
> & {
  symbol: string;
};

const DEFAULT_FACT_TTL_MS: Record<NexusMarketFactKind, number> = {
  MARK_PRICE_UPDATED: 5_000,
  TICKER_24H_UPDATED: 30_000,
  BTC_RELATIONSHIP_CLASSIFIED: 5 * 60_000,
  TREND_REGIME_CLASSIFIED: 5 * 60_000,
  LIQUIDATION_AGGREGATED: 5 * 60_000,
  LIQUIDATION_DERIVED_FACTORS: 5 * 60_000,
  MARKET_STRUCTURE_WAKE: 5 * 60_000,
  MARKET_CONTEXT_POSITION_UPDATED: 30_000,
  PRICE_IMPULSE_UP: 5 * 60_000,
  PRICE_IMPULSE_DOWN: 5 * 60_000,
  CANDLE_CLOSED: 5 * 60_000,
  OPEN_INTEREST_UPDATED: 10 * 60_000,
  PRICE_NEW_HIGH: 5 * 60_000,
  PRICE_NEW_LOW: 5 * 60_000,
  SUPPORT_SWEPT: 5 * 60_000,
  SUPPORT_RECLAIMED: 5 * 60_000,
  SUPPORT_BROKEN: 5 * 60_000,
  FAILED_RETEST_CONFIRMED: 5 * 60_000,
  RESISTANCE_REJECTED: 5 * 60_000,
  VOLUME_EXPANDED: 5 * 60_000,
  DATA_STALE: 60_000,
};

export function createNexusMarketFact<
  TPayload extends Record<string, unknown>,
>(
  input: Omit<FactInput<TPayload>, "expiresAt"> & { expiresAt?: number },
): NexusMarketFact<TPayload> {
  const symbol = normalizeSymbol(input.symbol);
  const eventAt = finiteTimestamp(input.eventAt, "eventAt");
  const receivedAt = finiteTimestamp(input.receivedAt, "receivedAt");
  const expiresAt =
    input.expiresAt === undefined
      ? eventAt + DEFAULT_FACT_TTL_MS[input.kind]
      : finiteTimestamp(input.expiresAt, "expiresAt");
  const identity = stableSerialize({
    kind: input.kind,
    symbol,
    interval: input.interval,
    source: input.source,
    eventAt,
    payload: input.payload,
  });
  return {
    version: 1,
    id: `nqf-${fnv1a64(identity)}`,
    kind: input.kind,
    symbol,
    interval: input.interval,
    source: input.source,
    eventAt,
    receivedAt,
    expiresAt,
    payload: input.payload,
  };
}

export function isNexusMarketFactFresh(
  fact: NexusMarketFact,
  now = Date.now(),
) {
  return (
    Number.isFinite(now) &&
    fact.eventAt <= now &&
    fact.receivedAt <= now &&
    fact.expiresAt > now
  );
}

export function markPriceMarketFact(input: {
  symbol: string;
  markPrice: number;
  eventAt: number;
  receivedAt?: number;
}) {
  return createNexusMarketFact({
    kind: "MARK_PRICE_UPDATED",
    symbol: input.symbol,
    interval: null,
    source: "BINANCE_WEBSOCKET",
    eventAt: input.eventAt,
    receivedAt: input.receivedAt ?? Date.now(),
    payload: { markPrice: finitePositive(input.markPrice, "markPrice") },
  });
}

export function ticker24hMarketFact(input: {
  symbol: string;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
  priceChangePercent: number;
  eventAt: number;
  receivedAt?: number;
}) {
  return createNexusMarketFact({
    kind: "TICKER_24H_UPDATED",
    symbol: input.symbol,
    interval: "24h",
    source: "BINANCE_WEBSOCKET",
    eventAt: input.eventAt,
    receivedAt: input.receivedAt ?? Date.now(),
    payload: {
      lastPrice: finitePositive(input.lastPrice, "lastPrice"),
      highPrice: finitePositive(input.highPrice, "highPrice"),
      lowPrice: finitePositive(input.lowPrice, "lowPrice"),
      quoteVolume: finiteNonNegative(input.quoteVolume, "quoteVolume"),
      priceChangePercent: finiteNumber(
        input.priceChangePercent,
        "priceChangePercent",
      ),
    },
  });
}

export function openInterestMarketFact(input: {
  symbol: string;
  interval: string;
  openInterestValue: number;
  eventAt: number;
  receivedAt?: number;
}) {
  return createNexusMarketFact({
    kind: "OPEN_INTEREST_UPDATED",
    symbol: input.symbol,
    interval: input.interval,
    source: "BINANCE_REST",
    eventAt: input.eventAt,
    receivedAt: input.receivedAt ?? Date.now(),
    payload: {
      openInterestValue: finiteNonNegative(
        input.openInterestValue,
        "openInterestValue",
      ),
    },
  });
}

export function liquidationDerivedFactorMarketFact(input: {
  symbol: string;
  eventAt: number;
  receivedAt: number;
  expiresAt: number;
  snapshot: {
    version: string;
    liquidationSide: "BUY" | "SELL";
    continuationDirection: "LONG" | "SHORT";
    reversalDirection: "LONG" | "SHORT";
    windowStartedAt: number | null;
    windowEndedAt: number | null;
    observationMs: number;
    totalEventCount: number;
    series: unknown[];
    priceSeries: unknown[];
    factors: Record<string, unknown>;
    confirmations: Record<string, unknown>;
    segmentAmounts: Record<string, unknown>;
    source: string;
  };
}) {
  const { snapshot } = input;
  return createNexusMarketFact({
    kind: "LIQUIDATION_DERIVED_FACTORS",
    symbol: input.symbol,
    interval: "episode",
    source: "SYSTEM_DERIVED",
    eventAt: input.eventAt,
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    payload: {
      version: snapshot.version,
      liquidationSide: snapshot.liquidationSide,
      continuationDirection: snapshot.continuationDirection,
      reversalDirection: snapshot.reversalDirection,
      windowStartedAt: snapshot.windowStartedAt,
      windowEndedAt: snapshot.windowEndedAt,
      observationMs: snapshot.observationMs,
      totalEventCount: snapshot.totalEventCount,
      series: snapshot.series,
      priceSeries: snapshot.priceSeries,
      factors: snapshot.factors,
      confirmations: snapshot.confirmations,
      segmentAmounts: snapshot.segmentAmounts,
      source: snapshot.source,
    },
  });
}

export function btcRelationshipMarketFact(input: {
  symbol: string;
  interval: string;
  eventAt: number;
  receivedAt?: number;
  relationship: {
    version: string;
    state: string;
    observations: number;
    fastCorrelation: number | null;
    slowCorrelation: number | null;
    covariance: number | null;
    beta: number | null;
    rSquared: number | null;
    altVariance: number | null;
    btcVariance: number | null;
    residual: number | null;
    residualZScore: number | null;
    relativeVolume: number | null;
    altReturn: number | null;
    btcReturn: number | null;
    reason: string;
    orderAffecting: false;
  };
}) {
  const receivedAt = input.receivedAt ?? Date.now();
  return createNexusMarketFact({
    kind: "BTC_RELATIONSHIP_CLASSIFIED",
    symbol: input.symbol,
    interval: input.interval,
    source: "SYSTEM_DERIVED",
    eventAt: input.eventAt,
    receivedAt,
    expiresAt: derivedClassificationFactExpiry(
      input.eventAt,
      input.interval,
      receivedAt,
    ),
    payload: { ...input.relationship },
  });
}

export function trendRegimeMarketFact(input: {
  symbol: string;
  interval: string;
  eventAt: number;
  receivedAt?: number;
  regime: {
    regime: string;
    fastEma: number | null;
    slowEma: number | null;
    previousFastEma: number | null;
    previousSlowEma: number | null;
    fastSlope: number | null;
    slowSlope: number | null;
    separationAtr: number | null;
    atr: number | null;
    fastPeriod: number;
    slowPeriod: number;
    atrPeriod: number;
    observations: number;
    reason: string;
    orderAffecting: false;
  };
}) {
  const receivedAt = input.receivedAt ?? Date.now();
  return createNexusMarketFact({
    kind: "TREND_REGIME_CLASSIFIED",
    symbol: input.symbol,
    interval: input.interval,
    source: "SYSTEM_DERIVED",
    eventAt: input.eventAt,
    receivedAt,
    expiresAt: derivedClassificationFactExpiry(
      input.eventAt,
      input.interval,
      receivedAt,
    ),
    payload: { ...input.regime },
  });
}

function derivedClassificationFactExpiry(
  eventAt: number,
  interval: string,
  receivedAt: number,
) {
  return Math.max(
    eventAt + marketFactIntervalMs(interval) * 2,
    receivedAt + 30_000,
  );
}

export function assessNexusMarketFactReadiness(input: {
  facts: NexusMarketFact[];
  requiredIntervals: string[];
  requireOpenInterest?: boolean;
  websocketConnected: boolean;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const fresh = input.facts.filter((fact) =>
    isNexusMarketFactFresh(fact, now),
  );
  const latestByIdentity = new Map<string, NexusMarketFact>();
  for (const fact of fresh) {
    const key = `${fact.kind}:${fact.interval ?? ""}`;
    const current = latestByIdentity.get(key);
    if (!current || fact.eventAt > current.eventAt)
      latestByIdentity.set(key, fact);
  }
  const missing: string[] = [];
  if (!input.websocketConnected) missing.push("WEBSOCKET_DISCONNECTED");
  if (!latestByIdentity.has("MARK_PRICE_UPDATED:"))
    missing.push("MARK_PRICE_UPDATED");
  if (!latestByIdentity.has("TICKER_24H_UPDATED:24h"))
    missing.push("TICKER_24H_UPDATED");
  for (const interval of input.requiredIntervals)
    if (!latestByIdentity.has(`CANDLE_CLOSED:${interval}`))
      missing.push(`CANDLE_CLOSED:${interval}`);
  if (
    input.requireOpenInterest &&
    ![...latestByIdentity.values()].some(
      (fact) => fact.kind === "OPEN_INTEREST_UPDATED",
    )
  )
    missing.push("OPEN_INTEREST_UPDATED");
  return {
    canOpen: missing.length === 0,
    missing,
    factIds: [...latestByIdentity.values()]
      .map((fact) => fact.id)
      .sort(),
    evaluatedAt: now,
  };
}

export function liquidationMarketFact(input: {
  id: string;
  sequence: number;
  symbol: string;
  side: "BUY" | "SELL";
  averagePrice: number;
  filledQuantity: number;
  notional: number;
  eventCount: number;
  firstTradeTime: number;
  lastTradeTime: number;
  lastReceivedAt: number;
  expiresAt?: number;
}) {
  return createNexusMarketFact({
    kind: "LIQUIDATION_AGGREGATED",
    symbol: input.symbol,
    interval: "1s",
    source: "BINANCE_WEBSOCKET",
    eventAt: input.lastTradeTime,
    receivedAt: input.lastReceivedAt,
    expiresAt: input.expiresAt,
    payload: {
      upstreamId: input.id,
      sequence: input.sequence,
      side: input.side,
      averagePrice: finitePositive(input.averagePrice, "averagePrice"),
      filledQuantity: finitePositive(input.filledQuantity, "filledQuantity"),
      notional: finitePositive(input.notional, "notional"),
      eventCount: Math.max(1, Math.trunc(input.eventCount)),
      firstTradeTime: input.firstTradeTime,
      lastTradeTime: input.lastTradeTime,
    },
  });
}

/**
 * A non-liquidation attention trigger for specialised markets such as
 * tokenised equities. It only arms the existing state machines; it never
 * represents order approval and it deliberately carries no fake liquidation
 * amount.
 */
export function marketStructureWakeFact(input: {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  eventAt: number;
  receivedAt?: number;
  referencePrice: number;
  position72hPercent: number;
  relativeVolume5m?: number | null;
  structureCode: string;
  expiresAt?: number;
}) {
  return createNexusMarketFact({
    kind: "MARKET_STRUCTURE_WAKE",
    symbol: input.symbol,
    interval: "5m",
    source: "SYSTEM_DERIVED",
    eventAt: input.eventAt,
    receivedAt: input.receivedAt ?? Date.now(),
    expiresAt: input.expiresAt,
    payload: {
      upstreamId: input.id,
      side: input.side,
      referencePrice: finitePositive(input.referencePrice, "referencePrice"),
      position72hPercent: finiteNumber(
        input.position72hPercent,
        "position72hPercent",
      ),
      relativeVolume5m: finiteOrNull(input.relativeVolume5m),
      structureCode: String(input.structureCode),
      orderAffecting: false,
    },
  });
}

/**
 * A shared long-horizon position fact. It can wake a strategy-owned observer,
 * but cannot approve an order or complete missing current structure facts.
 */
export function marketContextPositionFact(input: {
  context: NexusMarketContextSnapshot;
  eventAt: number;
  receivedAt: number;
  expiresAt?: number;
}) {
  return createNexusMarketFact({
    kind: "MARKET_CONTEXT_POSITION_UPDATED",
    symbol: input.context.symbol,
    interval: "72h",
    source: "SYSTEM_DERIVED",
    eventAt: input.eventAt,
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    payload: {
      marketContextId: input.context.id,
      positions: input.context.positions,
      authority: "WAKE_ONLY",
      orderAffecting: false,
    },
  });
}

export function mergeFrozenNexusMarketFacts(
  frozenFacts: NexusMarketFact[],
  rollingFacts: NexusMarketFact[],
  limit = 32,
) {
  const maximum = Math.max(1, Math.trunc(limit));
  const merged: NexusMarketFact[] = [];
  const seen = new Set<string>();
  for (const fact of [...frozenFacts, ...rollingFacts]) {
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    merged.push(fact);
    if (merged.length >= maximum) break;
  }
  return merged;
}

export const NEXUS_TERMINAL_FACT_ARCHIVE_VERSION =
  "nexus-market-facts-ids-v1" as const;

export function compactTerminalNexusMarketFactsEvidence(
  value: unknown,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { changed: false, evidence: value, factCount: 0 };
  const evidence = value as Record<string, unknown>;
  const facts = evidence.nexusMarketFactsShadow;
  if (!Array.isArray(facts) || !facts.length)
    return { changed: false, evidence, factCount: 0 };
  const factIds: string[] = [];
  let fullFactCount = 0;
  for (const fact of facts) {
    if (typeof fact === "string") {
      if (fact.trim()) factIds.push(fact.trim());
      continue;
    }
    if (!fact || typeof fact !== "object" || Array.isArray(fact))
      return { changed: false, evidence, factCount: facts.length };
    const id = (fact as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim())
      return { changed: false, evidence, factCount: facts.length };
    factIds.push(id.trim());
    fullFactCount += 1;
  }
  if (!fullFactCount)
    return { changed: false, evidence, factCount: facts.length };
  const uniqueFactIds = [...new Set(factIds)];
  return {
    changed: true,
    factCount: uniqueFactIds.length,
    evidence: {
      ...evidence,
      nexusMarketFactsShadow: uniqueFactIds,
      nexusMarketFactsPersistence: {
        version: NEXUS_TERMINAL_FACT_ARCHIVE_VERSION,
        originalFactCount: facts.length,
        retainedFactIdCount: uniqueFactIds.length,
        payloadsRetained: false,
        terminalOnly: true,
      },
    },
  };
}

export function closedCandleMarketFacts(input: {
  symbol: string;
  interval: string;
  candles: NexusClosedCandle[];
  receivedAt?: number;
  structureLookback?: number;
  volumeLookback?: number;
  volumeExpansionRatio?: number;
}) {
  const receivedAt = input.receivedAt ?? Date.now();
  const structureLookback = Math.max(
    2,
    Math.trunc(input.structureLookback ?? 20),
  );
  const volumeLookback = Math.max(2, Math.trunc(input.volumeLookback ?? 20));
  const volumeExpansionRatio = Math.max(1, input.volumeExpansionRatio ?? 1.5);
  const closed = input.candles
    .filter(validClosedCandle)
    .filter((candle) => candle.closeTime <= receivedAt)
    .sort((left, right) => left.openTime - right.openTime);
  const current = closed.at(-1);
  if (!current) return [];
  const prior = closed.filter(
    (candle) =>
      candle.openTime < current.openTime &&
      candle.closeTime < current.openTime,
  );
  const structure = prior.slice(-structureLookback);
  const priorHigh = Math.max(...structure.map((candle) => candle.high));
  const priorLow = Math.min(...structure.map((candle) => candle.low));
  const volumeHistory = prior.slice(-volumeLookback);
  const averageVolume =
    volumeHistory.reduce((total, candle) => total + candle.volume, 0) /
    volumeHistory.length;
  return closedCandleFactsFromSummary({
    symbol: input.symbol,
    interval: input.interval,
    current,
    receivedAt,
    priorCount: prior.length,
    structureCount: structure.length,
    priorHigh,
    priorLow,
    volumeCount: volumeHistory.length,
    averageVolume,
    volumeExpansionRatio,
  });
}

/**
 * Unified market snapshots are already valid, closed and ordered by openTime.
 * Consume them directly so each monitor candidate does not allocate another
 * full candle array merely to attach a derived closeTime.
 */
export function closedUnifiedCandleMarketFacts(input: {
  symbol: string;
  interval: string;
  candles: readonly NexusOpenTimeCandle[];
  receivedAt?: number;
  structureLookback?: number;
  volumeLookback?: number;
  volumeExpansionRatio?: number;
}) {
  const receivedAt = input.receivedAt ?? Date.now();
  const structureLookback = Math.max(
    2,
    Math.trunc(input.structureLookback ?? 20),
  );
  const volumeLookback = Math.max(2, Math.trunc(input.volumeLookback ?? 20));
  const volumeExpansionRatio = Math.max(1, input.volumeExpansionRatio ?? 1.5);
  const intervalMs = marketFactIntervalMs(input.interval);

  let currentIndex = -1;
  let current: NexusClosedCandle | null = null;
  for (let index = input.candles.length - 1; index >= 0; index -= 1) {
    const row = input.candles[index];
    const closeTime = row.openTime + intervalMs - 1;
    if (!validOpenTimeCandle(row, closeTime) || closeTime > receivedAt) continue;
    currentIndex = index;
    current = { ...row, closeTime };
    break;
  }
  if (!current) return [];

  let priorCount = 0;
  let structureCount = 0;
  let priorHigh = Number.NEGATIVE_INFINITY;
  let priorLow = Number.POSITIVE_INFINITY;
  const reverseVolumeHistory: number[] = [];
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const row = input.candles[index];
    const closeTime = row.openTime + intervalMs - 1;
    if (
      !validOpenTimeCandle(row, closeTime) ||
      closeTime > receivedAt ||
      row.openTime >= current.openTime ||
      closeTime >= current.openTime
    ) continue;

    priorCount += 1;
    if (structureCount < structureLookback) {
      structureCount += 1;
      priorHigh = Math.max(priorHigh, row.high);
      priorLow = Math.min(priorLow, row.low);
    }
    if (reverseVolumeHistory.length < volumeLookback)
      reverseVolumeHistory.push(row.volume);
    if (
      priorCount >= 2 &&
      structureCount >= structureLookback &&
      reverseVolumeHistory.length >= volumeLookback
    ) break;
  }

  let volumeTotal = 0;
  for (let index = reverseVolumeHistory.length - 1; index >= 0; index -= 1)
    volumeTotal += reverseVolumeHistory[index];
  const averageVolume = reverseVolumeHistory.length
    ? volumeTotal / reverseVolumeHistory.length
    : Number.NaN;
  return closedCandleFactsFromSummary({
    symbol: input.symbol,
    interval: input.interval,
    current,
    receivedAt,
    priorCount,
    structureCount,
    priorHigh,
    priorLow,
    volumeCount: reverseVolumeHistory.length,
    averageVolume,
    volumeExpansionRatio,
  });
}

export function shortStructureMarketFacts(input: {
  symbol: string;
  eventAt: number;
  receivedAt?: number;
  supportBreakConfirmed: boolean;
  failedRetestConfirmed: boolean;
  brokenSupport?: number | null;
  retestHigh?: number | null;
  distanceBelowBrokenSupportAtr?: number | null;
}) {
  const receivedAt = input.receivedAt ?? Date.now();
  const expiresAt = receivedAt + 5 * 60_000;
  const payload = {
    brokenSupport: finiteOrNull(input.brokenSupport),
    retestHigh: finiteOrNull(input.retestHigh),
    distanceBelowBrokenSupportAtr: finiteOrNull(
      input.distanceBelowBrokenSupportAtr,
    ),
  };
  const facts: NexusMarketFact[] = [];
  if (input.supportBreakConfirmed)
    facts.push(
      createNexusMarketFact({
        kind: "SUPPORT_BROKEN",
        symbol: input.symbol,
        interval: "5m",
        source: "SYSTEM_DERIVED",
        eventAt: input.eventAt,
        receivedAt,
        expiresAt,
        payload,
      }),
    );
  if (input.failedRetestConfirmed)
    facts.push(
      createNexusMarketFact({
        kind: "FAILED_RETEST_CONFIRMED",
        symbol: input.symbol,
        interval: "5m",
        source: "SYSTEM_DERIVED",
        eventAt: input.eventAt,
        receivedAt,
        expiresAt,
        payload,
      }),
    );
  return facts;
}

function closedCandleFactsFromSummary(input: {
  symbol: string;
  interval: string;
  current: NexusClosedCandle;
  receivedAt: number;
  priorCount: number;
  structureCount: number;
  priorHigh: number;
  priorLow: number;
  volumeCount: number;
  averageVolume: number;
  volumeExpansionRatio: number;
}) {
  const factExpiresAt = closedCandleFactExpiry(
    input.current.closeTime,
    input.interval,
    input.receivedAt,
  );
  const facts: NexusMarketFact[] = [
    createNexusMarketFact({
      kind: "CANDLE_CLOSED",
      symbol: input.symbol,
      interval: input.interval,
      source: "BINANCE_REST",
      eventAt: input.current.closeTime,
      receivedAt: input.receivedAt,
      expiresAt: factExpiresAt,
      payload: {
        openTime: input.current.openTime,
        closeTime: input.current.closeTime,
        open: input.current.open,
        high: input.current.high,
        low: input.current.low,
        close: input.current.close,
        volume: input.current.volume,
        quoteVolume: input.current.quoteVolume ?? null,
      },
    }),
  ];
  if (input.priorCount < 2) return facts;

  const structurePayload = {
    candleOpenTime: input.current.openTime,
    candleCloseTime: input.current.closeTime,
    price: input.current.close,
    priorHigh: input.priorHigh,
    priorLow: input.priorLow,
    lookback: input.structureCount,
  };
  if (input.current.high > input.priorHigh)
    facts.push(
      derivedFact(
        "PRICE_NEW_HIGH",
        input,
        input.current,
        input.receivedAt,
        factExpiresAt,
        { ...structurePayload, extreme: input.current.high },
      ),
    );
  if (input.current.low < input.priorLow)
    facts.push(
      derivedFact(
        "PRICE_NEW_LOW",
        input,
        input.current,
        input.receivedAt,
        factExpiresAt,
        { ...structurePayload, extreme: input.current.low },
      ),
    );
  if (input.current.low < input.priorLow && input.current.close > input.priorLow) {
    facts.push(
      derivedFact(
        "SUPPORT_SWEPT",
        input,
        input.current,
        input.receivedAt,
        factExpiresAt,
        { ...structurePayload, sweepLow: input.current.low },
      ),
    );
    facts.push(
      derivedFact(
        "SUPPORT_RECLAIMED",
        input,
        input.current,
        input.receivedAt,
        factExpiresAt,
        { ...structurePayload, reclaimClose: input.current.close },
      ),
    );
  }
  if (input.current.high > input.priorHigh && input.current.close < input.priorHigh)
    facts.push(
      derivedFact(
        "RESISTANCE_REJECTED",
        input,
        input.current,
        input.receivedAt,
        factExpiresAt,
        { ...structurePayload, rejectionHigh: input.current.high },
      ),
    );

  if (
    input.averageVolume > 0 &&
    input.current.volume / input.averageVolume >= input.volumeExpansionRatio
  )
    facts.push(
      derivedFact(
        "VOLUME_EXPANDED",
        input,
        input.current,
        input.receivedAt,
        factExpiresAt,
        {
          candleOpenTime: input.current.openTime,
          candleCloseTime: input.current.closeTime,
          volume: input.current.volume,
          averageVolume: input.averageVolume,
          ratio: input.current.volume / input.averageVolume,
          lookback: input.volumeCount,
        },
      ),
    );
  return facts;
}

function derivedFact(
  kind: NexusMarketFactKind,
  input: { symbol: string; interval: string },
  candle: NexusClosedCandle,
  receivedAt: number,
  expiresAt: number,
  payload: Record<string, unknown>,
) {
  return createNexusMarketFact({
    kind,
    symbol: input.symbol,
    interval: input.interval,
    source: "SYSTEM_DERIVED",
    eventAt: candle.closeTime,
    receivedAt,
    expiresAt,
    payload,
  });
}

function closedCandleFactExpiry(
  closeTime: number,
  interval: string,
  receivedAt: number,
) {
  return Math.max(
    closeTime + marketFactIntervalMs(interval) * 2,
    receivedAt + 30_000,
  );
}

function marketFactIntervalMs(interval: string) {
  return {
    "1m": 60_000,
    "3m": 3 * 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
  }[interval] ?? 5 * 60_000;
}

function validClosedCandle(candle: NexusClosedCandle) {
  return validOpenTimeCandle(candle, candle.closeTime);
}

function validOpenTimeCandle(
  candle: NexusOpenTimeCandle,
  closeTime: number,
) {
  return (
    Number.isFinite(candle.openTime) &&
    Number.isFinite(closeTime) &&
    candle.openTime >= 0 &&
    closeTime > candle.openTime &&
    Number.isFinite(candle.open) &&
    candle.open > 0 &&
    Number.isFinite(candle.high) &&
    candle.high > 0 &&
    Number.isFinite(candle.low) &&
    candle.low > 0 &&
    Number.isFinite(candle.close) &&
    candle.close > 0 &&
    candle.high >= candle.low &&
    Number.isFinite(candle.volume) &&
    candle.volume >= 0
  );
}

function normalizeSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(normalized))
    throw new Error("invalid market fact symbol");
  return normalized;
}

function finiteTimestamp(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`invalid market fact ${label}`);
  return Math.trunc(value);
}

function finitePositive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`invalid market fact ${label}`);
  return value;
}

function finiteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`invalid market fact ${label}`);
  return value;
}

function finiteNumber(value: number, label: string) {
  if (!Number.isFinite(value))
    throw new Error(`invalid market fact ${label}`);
  return value;
}

function finiteOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(",")}}`;
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
