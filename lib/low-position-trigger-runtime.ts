import { observeCachedLowPositionTriggers } from "./low-position-trigger-observation.ts";
import type { NexusUnifiedMarketData } from "./nexus-unified-market-data.ts";
import {
  lowPositionStrategyTriggerWake,
  type StrategyTriggerWake,
} from "./strategy-trigger-wake.ts";
import { LOW_POSITION_WINDOW_TRIGGER_VERSION } from "./strategy-triggers/low-position-window.ts";
import {
  mapWithConcurrency,
  NEXUS_MARKET_ANALYSIS_CONCURRENCY,
} from "./bounded-concurrency.ts";

export const LOW_POSITION_TRIGGER_RUNTIME_VERSION =
  "low-position-trigger-runtime-v1" as const;

export async function evaluateLowPositionTriggerRuntime(input: {
  marketData: NexusUnifiedMarketData;
  loadMarks: (symbols: string[]) => Promise<Array<{
    symbol: string;
    markPrice: number;
    eventAt: number;
    receivedAt: number;
  }>>;
  symbols: string[];
  scanCursor: number;
  maxPosition72hPercent: number;
  maxFactAgeMs: number;
  maxWakeCandidatesPerCycle: number;
  analysisValiditySeconds: number;
  strategyId: number;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  now: number;
}) {
  const symbols = [...new Set(input.symbols.map(normalizeSymbol))].sort();
  const maximumWakeCount = positiveInteger(
    input.maxWakeCandidatesPerCycle,
    "maxWakeCandidatesPerCycle",
  );
  const scanCount = Math.min(
    symbols.length,
    Math.max(maximumWakeCount, Math.min(12, maximumWakeCount * 4)),
  );
  const rotation = takeRotating(symbols, input.scanCursor, scanCount);
  const cacheErrors: Array<{ symbol: string; message: string }> = [];
  await mapWithConcurrency(
    rotation.rows,
    NEXUS_MARKET_ANALYSIS_CONCURRENCY,
    async (symbol) => {
      try {
        await input.marketData.closedCandles({
          symbol,
          interval: "1h",
          source: "MARK_PRICE",
          limit: 72,
          now: input.now,
        });
      } catch (error) {
        cacheErrors.push({
          symbol,
          message: error instanceof Error ? error.message : "72小时缓存加载失败",
        });
      }
    },
  );
  let marks: Awaited<ReturnType<typeof input.loadMarks>> = [];
  if (rotation.rows.length) marks = await input.loadMarks(rotation.rows);
  const report = observeCachedLowPositionTriggers({
    marketData: input.marketData,
    symbols: rotation.rows,
    marks,
    maxPosition72hPercent: input.maxPosition72hPercent,
    maxMarkAgeMs: input.maxFactAgeMs,
    now: input.now,
  });
  const wakes: StrategyTriggerWake[] = report.candidates
    .slice(0, maximumWakeCount)
    .map((candidate) => lowPositionStrategyTriggerWake({
      candidate,
      triggerVersion: LOW_POSITION_WINDOW_TRIGGER_VERSION,
      strategyId: input.strategyId,
      configVersion: input.configVersion,
      ownerEmail: input.ownerEmail,
      accountId: input.accountId,
      analysisValiditySeconds: input.analysisValiditySeconds,
    }));
  return {
    version: LOW_POSITION_TRIGGER_RUNTIME_VERSION,
    triggerOnly: true as const,
    canAuthorizeOrder: false as const,
    evaluatedAt: input.now,
    totalSymbolCount: symbols.length,
    scannedSymbols: rotation.rows,
    nextScanCursor: rotation.nextCursor,
    cacheErrors: cacheErrors.sort((left, right) =>
      left.symbol.localeCompare(right.symbol)
    ),
    report,
    wakes,
  };
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

function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol))
    throw new Error("低位触发器合约代码无效");
  return symbol;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`低位触发器 ${label} 无效`);
  return value;
}
