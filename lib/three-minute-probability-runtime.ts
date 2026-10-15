import type {
  NexusMarketInterval,
  NexusUnifiedCandle,
  NexusUnifiedMarketData,
} from "./nexus-unified-market-data.ts";
import type { NexusLiveOrderFlow } from "./nexus-order-flow-live.ts";
import {
  decideThreeMinuteProbability,
  rankThreeMinuteProbabilityDecisions,
  type ThreeMinuteProbabilityDecision,
} from "./three-minute-probability-model.ts";
import { threeMinuteRoundAt } from "./three-minute-round.ts";
import { resolveStrategyTriggerAdapter } from "./strategy-triggers/registry.ts";
import {
  THREE_MINUTE_PROBABILITY_TRIGGER_VERSION,
  type ThreeMinuteProbabilityFact,
} from "./strategy-triggers/three-minute-probability.ts";
import {
  createStrategyTriggerWake,
  type StrategyTriggerWake,
} from "./strategy-trigger-wake.ts";
import {
  mapWithConcurrency,
  NEXUS_MARKET_ANALYSIS_CONCURRENCY,
} from "./bounded-concurrency.ts";
import { NexusMarketAnalysisCycle } from "./nexus-market-analysis-cycle.ts";

export const THREE_MINUTE_PROBABILITY_RUNTIME_VERSION =
  "three-minute-probability-runtime-v3" as const;

const FULL_INTERVALS: readonly NexusMarketInterval[] = Object.freeze([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
]);

const THREE_MINUTE_ORDER_FLOW_WARMUP_MS = 3_200;

export type ThreeMinuteSymbolLearningStats = Readonly<{
  longWins: number;
  longLosses: number;
  shortWins: number;
  shortLosses: number;
  averageLongWinBps: number;
  averageLongLossBps: number;
  averageShortWinBps: number;
  averageShortLossBps: number;
}>;

export type ThreeMinuteStrategyLearningStats = Readonly<{
  completedRoundCount: number;
  exactNetSampleCount: number;
  exactNetPnlUsdt: number;
  recentExactBatchSampleCount: number;
  recentExactBatchPnlUsdt: number;
  pendingExactSettlementCount: number;
  freshPendingExactSettlementCount: number;
  stalePendingExactSettlementCount: number;
}>;

export type ThreeMinuteLearningStats = Readonly<{
  bySymbol: ReadonlyMap<string, ThreeMinuteSymbolLearningStats>;
  strategy: ThreeMinuteStrategyLearningStats;
}>;

export type ThreeMinuteEntryFeasibility = Readonly<{
  executable: boolean;
  reason: string;
  requiredMarginUsdt?: number | null;
  availableTargetMarginUsdt?: number | null;
}>;

function emptyThreeMinuteLearningStats(): ThreeMinuteLearningStats {
  return {
    bySymbol: new Map(),
    strategy: {
      completedRoundCount: 0,
      exactNetSampleCount: 0,
      exactNetPnlUsdt: 0,
      recentExactBatchSampleCount: 0,
      recentExactBatchPnlUsdt: 0,
      pendingExactSettlementCount: 0,
      freshPendingExactSettlementCount: 0,
      stalePendingExactSettlementCount: 0,
    },
  };
}

export async function loadThreeMinuteOrderFlowWithWarmup(input: {
  symbols: string[];
  loadOrderFlow: (symbols: string[]) => Promise<{
    rows: NexusLiveOrderFlow[];
  }>;
  warmupMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const symbols = [...new Set(input.symbols
    .map(normalizeSupportedSymbol)
    .filter((symbol): symbol is string => symbol !== null))];
  const readyRows = new Map<string, NexusLiveOrderFlow>();
  const errors = new Map<string, string>();
  const load = async (targets: string[]) => {
    if (!targets.length) return;
    try {
      const result = await input.loadOrderFlow(targets);
      const rowsBySymbol = new Map<string, NexusLiveOrderFlow>();
      for (const candidate of result.rows) {
        const symbol = normalizeSupportedSymbol(candidate.symbol);
        if (symbol) rowsBySymbol.set(symbol, candidate);
      }
      for (const symbol of targets) {
        const row = rowsBySymbol.get(symbol);
        if (row?.orderFlowReady && row.fresh) {
          readyRows.set(symbol, row);
          errors.delete(symbol);
        } else {
          errors.set(symbol, "订单流窗口尚未成熟");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "订单流读取失败";
      for (const symbol of targets) errors.set(symbol, message);
    }
  };

  await load(symbols);
  const initiallyMissing = symbols.filter((symbol) => !readyRows.has(symbol));
  if (initiallyMissing.length) {
    const wait = input.wait ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    await wait(Math.max(0, input.warmupMs ?? THREE_MINUTE_ORDER_FLOW_WARMUP_MS));
    await load(initiallyMissing);
  }
  const missingSymbols = symbols.filter((symbol) => !readyRows.has(symbol));
  return {
    rows: symbols.flatMap((symbol) => {
      const row = readyRows.get(symbol);
      return row ? [row] : [];
    }),
    missingSymbols,
    errors: missingSymbols.map((symbol) => ({
      symbol,
      message: errors.get(symbol) ?? "订单流窗口尚未成熟",
    })),
  };
}

export async function evaluateThreeMinuteProbabilityRuntime(input: {
  marketData: NexusUnifiedMarketData;
  loadMarks: (symbols: string[]) => Promise<Array<{
    symbol: string;
    markPrice: number;
    eventAt: number;
    receivedAt: number;
    history?: Array<{
      markPrice: number;
      eventAtMs: number;
      receivedAtMs?: number;
    }>;
  }>>;
  loadOrderFlow: (symbols: string[]) => Promise<{
    rows: NexusLiveOrderFlow[];
  }>;
  loadLearningStats?: (
    symbols: string[],
  ) => Promise<ThreeMinuteLearningStats>;
  learningEnabled?: boolean;
  evaluateEntryFeasibility?: (candidate: Readonly<{
    symbol: string;
    direction: "LONG" | "SHORT";
    referencePrice: number;
  }>) => ThreeMinuteEntryFeasibility;
  symbols: string[];
  explicitSymbolScope: boolean;
  scanCursor: number;
  scanBatchSize?: number;
  maximumCandidates: number;
  candidateDiscoveryLimit?: number;
  minimumProbabilityPercent: number;
  minimumNetEdgeBps: number;
  estimatedRoundTripFeeBps: number;
  estimatedSlippageBps: number;
  maxFactAgeMs: number;
  calibrationRounds: number;
  calibrationMode: "MINIMUM_ORDER" | "OBSERVE_ONLY";
  negativeExpectancyMode: "MINIMUM_ORDER" | "OBSERVE_ONLY";
  batchSize: number;
  analysisValiditySeconds: number;
  strategyId: number;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  now: number;
}) {
  const round = threeMinuteRoundAt(input.now);
  const skippedUnsupportedSymbols = [...new Set(input.symbols
    .filter((value) => normalizeSupportedSymbol(value) === null)
    .map(diagnosticSymbol)
    .filter(Boolean))].sort();
  const symbols = [...new Set(input.symbols
    .map(normalizeSupportedSymbol)
    .filter((symbol): symbol is string => symbol !== null))].sort();
  const configuredScanBatchSize = Number.isFinite(input.scanBatchSize)
    ? Math.trunc(Number(input.scanBatchSize))
    : input.maximumCandidates * 2;
  const scanBatchSize = Math.min(
    symbols.length,
    Math.max(
      input.maximumCandidates,
      configuredScanBatchSize,
    ),
  );
  // Scanning and queue admission are deliberately independent. Even when the
  // durable queue is full, the rotating cursor keeps moving through the whole
  // market so the next free slot receives a current fact rather than an old
  // snapshot.
  const rotation = takeRotating(symbols, input.scanCursor, scanBatchSize);
  const cacheErrors: Array<{ symbol: string; interval: string; message: string }> = [];
  const marketCycle = new NexusMarketAnalysisCycle(input.marketData, input.now);
  const rotationMarks = await input.loadMarks(rotation.rows);
  const marksBySymbol = new Map<string, (typeof rotationMarks)[number]>();
  for (const row of rotationMarks) {
    const symbol = normalizeSupportedSymbol(row.symbol);
    if (symbol) marksBySymbol.set(symbol, row);
  }
  const prefiltered = rotation.rows
      .map((symbol) => ({
        symbol,
        score: prefilterMarkHistoryScore(
          marksBySymbol.get(symbol),
          input.now,
        ),
    }))
    .filter((row) => row.score !== null)
    .sort((left, right) =>
      Number(right.score) - Number(left.score) || left.symbol.localeCompare(right.symbol)
    )
    .slice(0, Math.min(
      rotation.rows.length,
      Math.max(input.maximumCandidates, input.maximumCandidates * 3),
    ))
    .map((row) => row.symbol);
  await mapWithConcurrency(
    prefiltered.flatMap((symbol) => [
      ...FULL_INTERVALS.map((interval) => ({
        symbol,
        interval,
        source: "MARK_PRICE" as const,
      })),
      { symbol, interval: "3m" as const, source: "TRADE" as const },
    ]),
    NEXUS_MARKET_ANALYSIS_CONCURRENCY,
    async ({ symbol, interval, source }) => {
      try {
        await marketCycle.load({
          symbol,
          interval,
          source,
          limit: interval === "1m"
            ? 60
            : interval === "1h"
              ? 72
              : interval === "1d"
                ? 14
                : 40,
        });
      } catch (error) {
        cacheErrors.push({
          symbol,
          interval,
          message: error instanceof Error ? error.message : "完整特征加载失败",
        });
      }
    },
  );
  const [orderFlow, learningStats] = await Promise.all([
    loadThreeMinuteOrderFlowWithWarmup({
      symbols: prefiltered,
      loadOrderFlow: input.loadOrderFlow,
      warmupMs: 0,
    }),
    Promise.resolve(emptyThreeMinuteLearningStats()),
  ]);
  const flowBySymbol = new Map<string, (typeof orderFlow.rows)[number]>();
  for (const row of orderFlow.rows) {
    const symbol = normalizeSupportedSymbol(row.symbol);
    if (symbol) flowBySymbol.set(symbol, row);
  }
  const decisions: ThreeMinuteProbabilityDecision[] = [];
  const executionEligibleDecisions: ThreeMinuteProbabilityDecision[] = [];
  const observeOnlyFacts: ThreeMinuteProbabilityFact[] = [];
  const executionInfeasibleSymbols: Array<{
    symbol: string;
    direction: "LONG" | "SHORT";
    reason: string;
    requiredMarginUsdt: number | null;
    availableTargetMarginUsdt: number | null;
  }> = [];
  const facts: ThreeMinuteProbabilityFact[] = [];
  const strategyLearning = learningStats.strategy;
  for (const symbol of prefiltered) {
    const mark = marksBySymbol.get(symbol);
    const liveFlow = flowBySymbol.get(symbol);
    const series = fullSeries(marketCycle, symbol);
    if (!mark || !series) continue;
    const flow = liveFlow?.orderFlowReady && liveFlow.fresh
      ? {
          eventTime: liveFlow.eventTime,
          aggressorImbalance3s: liveFlow.aggressorImbalance3s,
          depthImbalance: liveFlow.depthImbalance,
          available: true,
        }
      : {
          eventTime: mark.eventAt,
          aggressorImbalance3s: 0,
          depthImbalance: 0,
          available: false,
        };
    const learning = learningStats.bySymbol.get(symbol) ?? {
      longWins: 0,
      longLosses: 0,
      shortWins: 0,
      shortLosses: 0,
      averageLongWinBps: 0,
      averageLongLossBps: 0,
      averageShortWinBps: 0,
      averageShortLossBps: 0,
    };
    const snapshotId = factSnapshotId({
      symbol,
      roundId: round.roundId,
      markPrice: mark.markPrice,
      latest1m: series.oneMinute.at(-1)?.openTime ?? 0,
      latest3m: series.threeMinute.at(-1)?.openTime ?? 0,
      latest5m: series.fiveMinute.at(-1)?.openTime ?? 0,
      latest15m: series.fifteenMinute.at(-1)?.openTime ?? 0,
      latest30m: series.thirtyMinute.at(-1)?.openTime ?? 0,
      latest1h: series.oneHour.at(-1)?.openTime ?? 0,
      latest4h: series.fourHour.at(-1)?.openTime ?? 0,
      latest1d: series.oneDay.at(-1)?.openTime ?? 0,
      flowEventTime: flow.eventTime,
    });
    const featureVector = {
      return1mBps: seriesReturnBps(series.oneMinute, 1),
      return3mBps: seriesReturnBps(series.threeMinute, 1),
      return4mBps: seriesReturnBps(series.oneMinute, 4),
      return5mBps: seriesReturnBps(series.fiveMinute, 1),
      return15mBps: seriesReturnBps(series.fifteenMinute, 1),
      return30mBps: seriesReturnBps(series.thirtyMinute, 1),
      return1hBps: seriesReturnBps(series.oneHour, 1),
      return4hBps: seriesReturnBps(series.fourHour, 1),
      return1dBps: seriesReturnBps(series.oneDay, 1),
      atr5m: averageTrueRange(series.fiveMinute, 14),
      relativeVolume3m: relativeVolume(series.tradeThreeMinute),
      aggressorImbalance3s: flow.aggressorImbalance3s,
      depthImbalance: flow.depthImbalance,
      position24hPercent: rangePosition(series.oneHour.slice(-24), mark.markPrice),
      position72hPercent: rangePosition(series.oneHour.slice(-72), mark.markPrice),
      position7dPercent: rangePosition(series.oneDay.slice(-7), mark.markPrice),
      twoSecondDownCount: consecutiveMarkDeclines(mark.history ?? [], input.now),
      oneMinuteBearishCount: consecutiveBearishCandles(series.oneMinute.slice(0, -1)),
      oneMinuteRecovery: mark.markPrice > (series.oneMinute.at(-1)?.open ?? mark.markPrice),
    };
    const symbolSampleCount = learning.longWins + learning.longLosses +
      learning.shortWins + learning.shortLosses;
    const sampleCount = strategyLearning.completedRoundCount;
    const learningMode = "ACTIVE" as const;
    const eligibilityMode = "DIRECT_PROBABILITY" as const;
    const admissionMinimumProbabilityPercent =
      input.minimumProbabilityPercent;
    const decision = decideThreeMinuteProbability({
      features: {
        symbol,
        factSnapshotId: snapshotId,
        observedAt: input.now,
        markAgeMs: Math.max(0, input.now - mark.eventAt),
        ...featureVector,
        historicalLongWins: learning.longWins,
        historicalLongLosses: learning.longLosses,
        historicalShortWins: learning.shortWins,
        historicalShortLosses: learning.shortLosses,
        averageLongWinBps: learning.averageLongWinBps,
        averageLongLossBps: learning.averageLongLossBps,
        averageShortWinBps: learning.averageShortWinBps,
        averageShortLossBps: learning.averageShortLossBps,
      },
      // Current shared facts directly authorize a candidate when the selected
      // side reaches the strategy probability threshold. Cost estimates remain
      // observable but do not block this minimum-order sampling strategy.
      minimumProbabilityPercent: admissionMinimumProbabilityPercent,
      minimumNetEdgeBps: input.minimumNetEdgeBps,
      estimatedRoundTripFeeBps: input.estimatedRoundTripFeeBps,
      estimatedSlippageBps: input.estimatedSlippageBps,
      maxFactAgeMs: input.maxFactAgeMs,
      eligibilityMode,
    });
    decisions.push(decision);
    const fact: ThreeMinuteProbabilityFact = Object.freeze({
      symbol,
      roundId: round.roundId,
      roundStartedAt: round.startedAt,
      roundEndsAt: round.endsAt,
      eventAt: input.now,
      receivedAt: input.now,
      referencePrice: mark.markPrice,
      factSnapshotId: snapshotId,
      modelVersion: decision.modelVersion,
      pLongPercent: decision.pLongPercent,
      pShortPercent: decision.pShortPercent,
      grossEdgeBps: decision.grossEdgeBps,
      estimatedCostBps: decision.estimatedCostBps,
      netEdgeBps: decision.netEdgeBps,
      breakEvenProbabilityPercent: decision.breakEvenProbabilityPercent,
      configuredMinimumProbabilityPercent: input.minimumProbabilityPercent,
      admissionMinimumProbabilityPercent,
      candidateRole: "DIRECT_PROBABILITY",
      eligibilityMode: decision.eligibilityMode,
      sampleCount,
      dataQuality: decision.dataQuality,
      featureVector: Object.freeze({
        ...featureVector,
        orderFlowAvailable: flow.available ? 1 : 0,
        symbolSampleCount,
        strategyCompletedRoundCount: sampleCount,
        exactNetSampleCount: strategyLearning.exactNetSampleCount,
        exactNetPnlUsdt: strategyLearning.exactNetPnlUsdt,
        recentExactBatchSampleCount:
          strategyLearning.recentExactBatchSampleCount,
        recentExactBatchPnlUsdt: strategyLearning.recentExactBatchPnlUsdt,
        pendingExactSettlementCount:
          strategyLearning.pendingExactSettlementCount,
        freshPendingExactSettlementCount:
          strategyLearning.freshPendingExactSettlementCount,
        stalePendingExactSettlementCount:
          strategyLearning.stalePendingExactSettlementCount,
      }),
      learningMode,
    });
    facts.push(fact);
    const candidateDirection = decision.direction !== "NO_TRADE"
      ? decision.direction
      : null;
    if (candidateDirection) {
      const entryFeasibility = input.evaluateEntryFeasibility?.({
        symbol,
        direction: candidateDirection,
        referencePrice: mark.markPrice,
      });
      if (!entryFeasibility || entryFeasibility.executable) {
        executionEligibleDecisions.push(decision);
      }
      else
        executionInfeasibleSymbols.push({
          symbol,
          direction: candidateDirection,
          reason: entryFeasibility.reason,
          requiredMarginUsdt:
            Number.isFinite(entryFeasibility.requiredMarginUsdt)
              ? Number(entryFeasibility.requiredMarginUsdt)
              : null,
          availableTargetMarginUsdt:
            Number.isFinite(entryFeasibility.availableTargetMarginUsdt)
              ? Number(entryFeasibility.availableTargetMarginUsdt)
              : null,
        });
    }
  }
  const candidateDiscoveryLimit = Math.max(
    input.maximumCandidates,
    Math.trunc(
      Number.isFinite(input.candidateDiscoveryLimit)
        ? Number(input.candidateDiscoveryLimit)
        : input.maximumCandidates,
    ),
  );
  const ranked = rankThreeMinuteProbabilityDecisions({
    decisions: executionEligibleDecisions,
    maximum: candidateDiscoveryLimit,
  });
  const selectedSymbols = new Set(ranked.map((row) => row.symbol));
  const candidates = resolveStrategyTriggerAdapter("THREE_MINUTE_PROBABILITY")
    .evaluate({
      facts: {
        rows: facts.filter((row) => selectedSymbols.has(row.symbol)),
        processedAt: input.now,
      },
      config: {
        maxFactAgeMs: input.maxFactAgeMs,
        maximumCandidates: candidateDiscoveryLimit,
        minimumProbabilityPercent: input.minimumProbabilityPercent,
        minimumNetEdgeBps: input.minimumNetEdgeBps,
      },
    });
  const wakes: StrategyTriggerWake[] = candidates.map((candidate) =>
    createStrategyTriggerWake({
      triggerKind: candidate.kind,
      triggerVersion: THREE_MINUTE_PROBABILITY_TRIGGER_VERSION,
      strategyId: input.strategyId,
      configVersion: input.configVersion,
      ownerEmail: input.ownerEmail,
      accountId: input.accountId,
      symbol: candidate.symbol,
      direction: candidate.direction,
      eventAt: candidate.eventAt,
      receivedAt: candidate.receivedAt,
      analysisValiditySeconds: input.analysisValiditySeconds,
      referencePrice: candidate.referencePrice,
      factSnapshotId: candidate.factSnapshotId,
      sourceId: `${candidate.roundId}:${candidate.factSnapshotId}`,
      evidence: candidate,
    })
  );
  const result = {
    version: THREE_MINUTE_PROBABILITY_RUNTIME_VERSION,
    triggerOnly: true as const,
    canAuthorizeOrder: false as const,
    round,
    skippedUnsupportedSymbols,
    scannedSymbols: rotation.rows,
    prefilteredSymbols: prefiltered,
    nextScanCursor: rotation.nextCursor,
    cacheErrors: cacheErrors.sort((left, right) =>
      left.symbol.localeCompare(right.symbol) || left.interval.localeCompare(right.interval)
    ),
    executionInfeasibleSymbols,
    orderFlowMissingSymbols: orderFlow.missingSymbols,
    orderFlowErrors: orderFlow.errors,
    decisions,
    observeOnlyFacts: observeOnlyFacts
      .sort((left, right) =>
        right.netEdgeBps - left.netEdgeBps ||
        Math.max(right.pLongPercent, right.pShortPercent) -
          Math.max(left.pLongPercent, left.pShortPercent) ||
        left.symbol.localeCompare(right.symbol)
      )
      .slice(0, Math.max(0, Math.trunc(input.maximumCandidates))),
    wakes,
  };
  marketCycle.clear();
  return result;
}

function fullSeries(marketCycle: NexusMarketAnalysisCycle, symbol: string) {
  const read = (
    interval: NexusMarketInterval,
    limit: number,
    source: "MARK_PRICE" | "TRADE" = "MARK_PRICE",
  ) =>
    marketCycle.cached({
      symbol,
      interval,
      source,
      limit,
    }) ?? [];
  const oneMinute = read("1m", 60);
  const threeMinute = read("3m", 40);
  const tradeThreeMinute = read("3m", 40, "TRADE");
  const fiveMinute = read("5m", 40);
  const fifteenMinute = read("15m", 40);
  const thirtyMinute = read("30m", 40);
  const oneHour = read("1h", 72);
  const fourHour = read("4h", 40);
  const oneDay = read("1d", 14);
  if (
    oneMinute.length < 5 ||
    threeMinute.length < 3 ||
    tradeThreeMinute.length < 3 ||
    fiveMinute.length < 3 ||
    fifteenMinute.length < 3 ||
    thirtyMinute.length < 3 ||
    oneHour.length < 24 ||
    fourHour.length < 3 ||
    oneDay.length < 7
  )
    return null;
  return {
    oneMinute,
    threeMinute,
    tradeThreeMinute,
    fiveMinute,
    fifteenMinute,
    thirtyMinute,
    oneHour,
    fourHour,
    oneDay,
  };
}

function prefilterMarkHistoryScore(
  mark: {
    markPrice: number;
    eventAt: number;
    history?: Array<{ markPrice: number; eventAtMs: number }>;
  } | undefined,
  nowMs: number,
) {
  if (!mark || !(mark.markPrice > 0) || nowMs - mark.eventAt > 5_000)
    return null;
  const history = (mark.history ?? [])
    .filter((row) =>
      Number.isFinite(row.markPrice) && row.markPrice > 0 &&
      Number.isFinite(row.eventAtMs) && row.eventAtMs <= nowMs &&
      row.eventAtMs >= nowMs - 35_000
    )
    .sort((left, right) => left.eventAtMs - right.eventAtMs);
  // A newly watched symbol has no 30-second history yet. Keep it in the cheap
  // coarse ranking with a neutral score so the first rotation can warm and
  // evaluate a bounded finalist set without loading candles for all symbols.
  if (history.length < 2) return 0;
  const prices = history.map((row) => row.markPrice);
  const first = prices[0];
  const last = mark.markPrice;
  const returnBps = Math.abs((last / first - 1) * 10_000);
  const amplitudeBps = (Math.max(...prices, last) - Math.min(...prices, last)) /
    first * 10_000;
  return returnBps + amplitudeBps * 0.5;
}

function consecutiveMarkDeclines(
  history: readonly { markPrice: number; eventAtMs: number }[],
  nowMs: number,
) {
  const rows = history
    .filter((row) => Number.isFinite(row.markPrice) && row.markPrice > 0 && row.eventAtMs <= nowMs)
    .sort((left, right) => left.eventAtMs - right.eventAtMs)
    .slice(-20);
  let count = 0;
  for (let index = rows.length - 1; index > 0; index -= 1) {
    if (rows[index]!.markPrice < rows[index - 1]!.markPrice) count += 1;
    else break;
  }
  return count;
}

function consecutiveBearishCandles(rows: readonly NexusUnifiedCandle[]) {
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.close < row.open) count += 1;
    else break;
  }
  return count;
}

function seriesReturnBps(rows: readonly NexusUnifiedCandle[], periods: number) {
  if (rows.length <= periods) return 0;
  const latest = rows.at(-1)!.close;
  const previous = rows.at(-(periods + 1))!.close;
  return previous > 0 ? (latest / previous - 1) * 10_000 : 0;
}

function relativeVolume(rows: readonly NexusUnifiedCandle[]) {
  if (rows.length < 2) return 1;
  const latest = rows.at(-1)!.quoteVolume ?? rows.at(-1)!.volume;
  const history = rows.slice(0, -1).slice(-20);
  const average = history.reduce(
    (sum, row) => sum + (row.quoteVolume ?? row.volume),
    0,
  ) / history.length;
  return average > 0 ? latest / average : 1;
}

function averageTrueRange(
  rows: readonly NexusUnifiedCandle[],
  requestedPeriod: number,
) {
  if (rows.length < 2) return 0;
  const trueRanges = rows.slice(1).map((row, index) => {
    const previousClose = rows[index]!.close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose),
    );
  });
  const period = Math.min(
    trueRanges.length,
    Math.max(1, Math.trunc(requestedPeriod)),
  );
  return trueRanges.slice(-period).reduce((sum, value) => sum + value, 0) /
    period;
}

function rangePosition(rows: readonly NexusUnifiedCandle[], markPrice: number) {
  if (!rows.length) return 50;
  const low = Math.min(...rows.map((row) => row.low));
  const high = Math.max(...rows.map((row) => row.high));
  return high > low ? Math.max(0, Math.min(100, (markPrice - low) / (high - low) * 100)) : 50;
}

function takeRotating<T>(rows: T[], cursor: number, count: number) {
  if (!rows.length || count <= 0) return { rows: [] as T[], nextCursor: 0 };
  const start = Number.isFinite(cursor) ? Math.abs(Math.trunc(cursor)) % rows.length : 0;
  const selected = Array.from(
    { length: Math.min(count, rows.length) },
    (_, index) => rows[(start + index) % rows.length],
  );
  return { rows: selected, nextCursor: (start + selected.length) % rows.length };
}

function normalizeSupportedSymbol(value: unknown) {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9]{3,30}$/.test(symbol) ? symbol : null;
}

function diagnosticSymbol(value: unknown) {
  return String(value ?? "").trim().toUpperCase().slice(0, 40);
}

function factSnapshotId(input: Record<string, string | number>) {
  const source = Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `3m-facts-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
