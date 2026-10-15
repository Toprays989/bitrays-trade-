import type {
  NexusUnifiedMarketData,
  NexusUnifiedMarketSnapshot,
} from "./nexus-unified-market-data.ts";
import {
  mapWithConcurrency,
  NEXUS_MARKET_ANALYSIS_CONCURRENCY,
} from "./bounded-concurrency.ts";
import { createStrategyTriggerWake } from "./strategy-trigger-wake.ts";
import { BREAKOUT_RETEST_TRIGGER_VERSION } from "./strategy-triggers/breakout-retest.ts";
import type { BreakoutRetestTriggerConfig } from "./strategy-triggers/breakout-retest-config.ts";
import { GRID_PRICE_LEVEL_TRIGGER_VERSION } from "./strategy-triggers/grid-price-level.ts";
import type { GridPriceLevelTriggerConfig } from "./strategy-triggers/grid-price-level-config.ts";
import { resolveStrategyTriggerAdapter } from "./strategy-triggers/registry.ts";
import { SCHEDULED_SCAN_TRIGGER_VERSION } from "./strategy-triggers/scheduled-scan.ts";
import type { ScheduledScanTriggerConfig } from "./strategy-triggers/scheduled-scan-config.ts";

export const MARKET_STRUCTURE_TRIGGER_RUNTIME_VERSION =
  "market-structure-trigger-runtime-v2" as const;

export const MAX_BREAKOUT_RETEST_SCAN_SYMBOLS_PER_CYCLE = 24;

export type BreakoutRetestScanCoverage = Readonly<{
  scanCount: number;
  coverageCycles: number;
  requiredScanCount: number;
  fullSweepSeconds: number;
  meetsFactAge: boolean;
  capped: boolean;
}>;

export function planBreakoutRetestScanCoverage(input: {
  totalSymbols: number;
  scanIntervalSeconds: number;
  maxFactAgeMs: number;
  maxWakeCandidatesPerCycle: number;
}): BreakoutRetestScanCoverage {
  const totalSymbols = Math.max(0, Math.trunc(input.totalSymbols));
  const scanIntervalSeconds = Math.max(
    1,
    Math.trunc(input.scanIntervalSeconds),
  );
  const maxFactAgeMs = Math.max(1, Math.trunc(input.maxFactAgeMs));
  const coverageCycles = Math.max(
    1,
    Math.floor(maxFactAgeMs / (scanIntervalSeconds * 1_000)),
  );
  const requiredScanCount = totalSymbols
    ? Math.ceil(totalSymbols / coverageCycles)
    : 0;
  const plannedScanCount = Math.min(
    totalSymbols,
    MAX_BREAKOUT_RETEST_SCAN_SYMBOLS_PER_CYCLE,
    Math.max(
      scanCount(totalSymbols, input.maxWakeCandidatesPerCycle),
      requiredScanCount,
    ),
  );
  const fullSweepSeconds = plannedScanCount
    ? Math.ceil(totalSymbols / plannedScanCount) * scanIntervalSeconds
    : 0;
  return {
    scanCount: plannedScanCount,
    coverageCycles,
    requiredScanCount,
    fullSweepSeconds,
    meetsFactAge: fullSweepSeconds * 1_000 <= maxFactAgeMs,
    capped:
      requiredScanCount > MAX_BREAKOUT_RETEST_SCAN_SYMBOLS_PER_CYCLE,
  };
}

type RuntimeIdentity = Readonly<{
  strategyId: number;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  analysisValiditySeconds: number;
  direction: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  now: number;
}>;

type MarkRow = Readonly<{
  symbol: string;
  markPrice: number;
  eventAt: number;
  receivedAt: number;
}>;

export async function evaluateGridPriceLevelTriggerRuntime(
  input: RuntimeIdentity & {
    loadMarks: (symbols: string[]) => Promise<MarkRow[]>;
    symbols: string[];
    config: GridPriceLevelTriggerConfig;
  },
) {
  const symbols = normalizedSymbols(input.symbols);
  const marks = symbols.length ? await input.loadMarks(symbols) : [];
  const processedAt = latestReceivedAt(input.now, marks);
  const candidates = resolveStrategyTriggerAdapter("GRID_PRICE_LEVEL").evaluate({
    facts: {
      processedAt,
      rows: marks.map((mark) => ({
        ...mark,
        factSnapshotId:
          `grid:${mark.symbol.toUpperCase()}:${mark.eventAt}:${mark.markPrice}`,
      })),
    },
    config: {
      lowerPrice: input.config.lowerPrice,
      upperPrice: input.config.upperPrice,
      gridCount: input.config.gridCount,
      activationToleranceBps: input.config.activationToleranceBps,
      maxFactAgeMs: input.config.maxFactAgeMs,
      direction: input.direction,
    },
  }).slice(0, 1);
  return runtimeResult({
    triggerKind: "GRID_PRICE_LEVEL",
    triggerVersion: GRID_PRICE_LEVEL_TRIGGER_VERSION,
    input: { ...input, now: processedAt },
    symbols,
    scannedSymbols: symbols,
    candidates,
    referencePrice: (candidate) => candidate.markPrice,
    eventAt: (candidate) => candidate.eventAt,
    receivedAt: (candidate) => candidate.receivedAt,
    evidence: (candidate) => ({
      gridLevel: candidate.gridLevel,
      gridIndex: candidate.gridIndex,
      gridCount: candidate.gridCount,
      distanceBps: candidate.distanceBps,
      lowerPrice: input.config.lowerPrice,
      upperPrice: input.config.upperPrice,
    }),
    cacheErrors: [],
    nextScanCursor: 0,
  });
}

export async function evaluateScheduledScanTriggerRuntime(
  input: RuntimeIdentity & {
    marketData: NexusUnifiedMarketData;
    symbols: string[];
    scanCursor: number;
    config: ScheduledScanTriggerConfig;
  },
) {
  const symbols = normalizedSymbols(input.symbols);
  const rotation = takeRotating(
    symbols,
    input.scanCursor,
    input.config.scanAllSymbols
      ? symbols.length
      : scanCount(symbols.length, input.config.maxWakeCandidatesPerCycle),
  );
  const loaded = await loadCandleSnapshots({
    marketData: input.marketData,
    symbols: rotation.rows,
    limit: 3,
    now: input.now,
  });
  const processedAt = latestReceivedAt(input.now, loaded.snapshots);
  const scheduleWindowStartedAt = Math.floor(
    processedAt / (input.config.intervalSeconds * 1_000),
  ) * input.config.intervalSeconds * 1_000;
  const scheduleWindowEndsAt =
    scheduleWindowStartedAt + input.config.intervalSeconds * 1_000;
  const rankedCandidates = resolveStrategyTriggerAdapter("SCHEDULED_SCAN").evaluate({
    facts: {
      processedAt,
      rows: loaded.snapshots.flatMap((snapshot) => {
        const previous = snapshot.rows.at(-2);
        const latest = snapshot.rows.at(-1);
        if (!previous || !latest) return [];
        return [{
          symbol: snapshot.symbol,
          previousClose: previous.close,
          latestClose: latest.close,
          eventAt: latest.openTime + 5 * 60_000 - 1,
          receivedAt: snapshot.receivedAt,
          scheduleWindowStartedAt,
          scheduleWindowEndsAt,
          factSnapshotId:
            `schedule:${scheduleWindowStartedAt}:${snapshot.symbol}:${latest.openTime}`,
        }];
      }),
    },
    config: {
      maxFactAgeMs: input.config.maxFactAgeMs,
      direction: input.direction,
    },
  });
  const candidates = input.config.scanAllSymbols
    ? rankedCandidates
    : rankedCandidates.slice(
      0,
      input.config.maxWakeCandidatesPerCycle *
        (input.direction === "BOTH" ? 2 : 1),
    );
  return runtimeResult({
    triggerKind: "SCHEDULED_SCAN",
    triggerVersion: SCHEDULED_SCAN_TRIGGER_VERSION,
    input: { ...input, now: processedAt },
    symbols,
    scannedSymbols: rotation.rows,
    candidates,
    referencePrice: (candidate) => candidate.referencePrice,
    eventAt: (candidate) => candidate.eventAt,
    receivedAt: (candidate) => candidate.receivedAt,
    evidence: (candidate) => ({
      changeBps: candidate.changeBps,
      scheduleWindowStartedAt: candidate.scheduleWindowStartedAt,
      scheduleWindowEndsAt: candidate.scheduleWindowEndsAt,
      intervalSeconds: input.config.intervalSeconds,
    }),
    cacheErrors: loaded.errors,
    nextScanCursor: rotation.nextCursor,
  });
}

export async function evaluateBreakoutRetestTriggerRuntime(
  input: RuntimeIdentity & {
    marketData: NexusUnifiedMarketData;
    loadMarks: (symbols: string[]) => Promise<MarkRow[]>;
    symbols: string[];
    scanCursor: number;
    config: BreakoutRetestTriggerConfig;
  },
) {
  const symbols = normalizedSymbols(input.symbols);
  const scanCoverage = planBreakoutRetestScanCoverage({
    totalSymbols: symbols.length,
    scanIntervalSeconds: input.config.scanIntervalSeconds,
    maxFactAgeMs: input.config.maxFactAgeMs,
    maxWakeCandidatesPerCycle: input.config.maxWakeCandidatesPerCycle,
  });
  const rotation = takeRotating(
    symbols,
    input.scanCursor,
    scanCoverage.scanCount,
  );
  const [loaded, marks] = await Promise.all([
    loadCandleSnapshots({
      marketData: input.marketData,
      symbols: rotation.rows,
      limit: Math.min(
        99,
        input.config.lookbackCandles + input.config.maximumRetestCandles + 2,
      ),
      now: input.now,
    }),
    rotation.rows.length ? input.loadMarks(rotation.rows) : Promise.resolve([]),
  ]);
  const marksBySymbol = new Map(
    marks.map((mark) => [mark.symbol.trim().toUpperCase(), mark]),
  );
  const processedAt = latestReceivedAt(
    input.now,
    [...loaded.snapshots, ...marks],
  );
  const candidates = resolveStrategyTriggerAdapter("BREAKOUT_RETEST").evaluate({
    facts: {
      processedAt,
      rows: loaded.snapshots.flatMap((snapshot) => {
        const mark = marksBySymbol.get(snapshot.symbol);
        const latest = snapshot.rows.at(-1);
        if (!mark || !latest) return [];
        return [{
          symbol: snapshot.symbol,
          markPrice: mark.markPrice,
          markEventAt: mark.eventAt,
          markReceivedAt: mark.receivedAt,
          candles: snapshot.rows,
          candleReceivedAt: snapshot.receivedAt,
          factSnapshotId:
            `breakout-retest:${snapshot.symbol}:${latest.openTime}:${mark.eventAt}`,
        }];
      }),
    },
    config: {
      ...input.config,
      direction: input.direction,
    },
  }).slice(0, input.config.maxWakeCandidatesPerCycle);
  return runtimeResult({
    triggerKind: "BREAKOUT_RETEST",
    triggerVersion: BREAKOUT_RETEST_TRIGGER_VERSION,
    input: { ...input, now: processedAt },
    symbols,
    scannedSymbols: rotation.rows,
    candidates,
    referencePrice: (candidate) => candidate.referencePrice,
    eventAt: (candidate) => candidate.eventAt,
    receivedAt: (candidate) => candidate.receivedAt,
    evidence: (candidate) => ({
      breakoutLevel: candidate.breakoutLevel,
      breakoutClose: candidate.breakoutClose,
      breakoutAt: candidate.breakoutAt,
      retestAt: candidate.retestAt,
      breakoutDistanceBps: candidate.breakoutDistanceBps,
      retestDistanceBps: candidate.retestDistanceBps,
      breakoutVolumeRatio: candidate.breakoutVolumeRatio,
      interval: "5m",
    }),
    cacheErrors: loaded.errors,
    nextScanCursor: rotation.nextCursor,
    scanCoverage,
  });
}

function runtimeResult<TCandidate extends {
  symbol: string;
  direction: "LONG" | "SHORT";
  factSnapshotId: string;
}>(input: {
  triggerKind: "GRID_PRICE_LEVEL" | "SCHEDULED_SCAN" | "BREAKOUT_RETEST";
  triggerVersion: string;
  input: RuntimeIdentity;
  symbols: string[];
  scannedSymbols: string[];
  candidates: TCandidate[];
  referencePrice: (candidate: TCandidate) => number;
  eventAt: (candidate: TCandidate) => number;
  receivedAt: (candidate: TCandidate) => number;
  evidence: (candidate: TCandidate) => Record<string, unknown>;
  cacheErrors: Array<{ symbol: string; message: string }>;
  nextScanCursor: number;
  scanCoverage?: BreakoutRetestScanCoverage;
}) {
  return {
    version: MARKET_STRUCTURE_TRIGGER_RUNTIME_VERSION,
    triggerOnly: true as const,
    canAuthorizeOrder: false as const,
    evaluatedAt: input.input.now,
    totalSymbolCount: input.symbols.length,
    scannedSymbols: input.scannedSymbols,
    nextScanCursor: input.nextScanCursor,
    cacheErrors: input.cacheErrors,
    scanCoverage: input.scanCoverage ?? null,
    wakes: input.candidates.map((candidate) => createStrategyTriggerWake({
      triggerKind: input.triggerKind,
      triggerVersion: input.triggerVersion,
      strategyId: input.input.strategyId,
      configVersion: input.input.configVersion,
      ownerEmail: input.input.ownerEmail,
      accountId: input.input.accountId,
      symbol: candidate.symbol,
      direction: candidate.direction,
      eventAt: input.eventAt(candidate),
      receivedAt: input.receivedAt(candidate),
      analysisValiditySeconds: input.input.analysisValiditySeconds,
      referencePrice: input.referencePrice(candidate),
      factSnapshotId: candidate.factSnapshotId,
      sourceId: candidate.factSnapshotId,
      evidence: {
        ...input.evidence(candidate),
        factSnapshotId: candidate.factSnapshotId,
      },
    })),
  };
}

async function loadCandleSnapshots(input: {
  marketData: NexusUnifiedMarketData;
  symbols: string[];
  limit: number;
  now: number;
}) {
  const snapshots: NexusUnifiedMarketSnapshot[] = [];
  const errors: Array<{ symbol: string; message: string }> = [];
  await mapWithConcurrency(
    input.symbols,
    NEXUS_MARKET_ANALYSIS_CONCURRENCY,
    async (symbol) => {
    try {
      snapshots.push(await input.marketData.closedCandles({
        symbol,
        interval: "5m",
        source: "TRADE",
        limit: input.limit,
        now: input.now,
      }));
    } catch (error) {
      errors.push({
        symbol,
        message: error instanceof Error ? error.message : "5分钟闭合行情加载失败",
      });
    }
    },
  );
  snapshots.sort((left, right) => left.symbol.localeCompare(right.symbol));
  errors.sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { snapshots, errors };
}

function normalizedSymbols(values: string[]) {
  return [...new Set(values.map((value) => value.trim().toUpperCase()))]
    .filter((value) => /^[A-Z0-9]{3,30}$/.test(value))
    .sort();
}

function latestReceivedAt(
  baseline: number,
  rows: ReadonlyArray<{ receivedAt: number }>,
) {
  return rows.reduce(
    (latest, row) => Math.max(latest, row.receivedAt),
    baseline,
  );
}

function scanCount(total: number, maximumWakeCount: number) {
  return Math.min(
    total,
    Math.max(maximumWakeCount, Math.min(12, maximumWakeCount * 4)),
  );
}

function takeRotating<T>(rows: T[], cursor: number, count: number) {
  if (!rows.length || count <= 0)
    return { rows: [] as T[], nextCursor: 0 };
  const start = Number.isFinite(cursor)
    ? Math.abs(Math.trunc(cursor)) % rows.length
    : 0;
  const selected = Array.from(
    { length: Math.min(count, rows.length) },
    (_, index) => rows[(start + index) % rows.length],
  );
  return {
    rows: selected,
    nextCursor: (start + selected.length) % rows.length,
  };
}
