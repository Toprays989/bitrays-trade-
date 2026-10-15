import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  contractSymbols,
  exchangeCredentials,
  liveOrderEvents,
  livePositionReductions,
  livePositions,
  strategies,
  strategyExecutionEvents,
  strategyExecutionTraces,
  tradingAccounts,
} from "../../../../db/schema";
import {
  BinanceLiveError,
  getBinanceLiveMarkPrices,
  getBinanceLiveSystemMetrics,
  getLivePositionSnapshot,
} from "../../../../lib/binance-usdm-live";
import {
  submitLiveEntryOrder,
  submitLiveReduceMarketOrder,
} from "../../../../lib/execution/exchange-order-gateway";
import { binanceAnalysisCapacity } from "../../../../lib/binance-analysis-capacity";
import {
  mapWithConcurrency,
  NEXUS_MARKET_ANALYSIS_CONCURRENCY,
} from "../../../../lib/bounded-concurrency";
import { marketAnalysisPressureResponse } from
  "../../../../lib/runtime-memory-pressure";
import { evaluateAutomatedEntryContractLeverage } from "../../../../lib/automated-entry-leverage-policy";
import {
  credentialContext,
  decryptCredential,
  liveTradingAllowedByServer,
} from "../../../../lib/credential-vault";
import { getTradeReadiness } from "../../../../lib/trade-readiness";
import {
  type LiquidationTrendConfig,
  resolveLiquidationTrendConfig,
} from "../../../../lib/liquidation-trend-config";
import { filterContractsByStrategyAssetScope } from
  "../../../../lib/strategy-asset-scope";
import { buildPilotRiskPlan } from "../../../../lib/liquidation-live-execution";
import {
  DEFAULT_RELATIVE_STRENGTH_CONFIG,
  RELATIVE_STRENGTH_TREND_VERSION,
  analyzeRelativeStrengthSymbol,
  buildBalancedMinimumPairSizing,
  buildRelativeStrengthUniverse,
  normalizeRelativeStrengthConfig,
  relativeStrengthPairKey,
  selectRelativeStrengthPair,
  selectRelativeStrengthScanBatch,
} from "../../../../lib/relative-strength-trend";
import { nexusUnifiedMarketData } from "../../../../lib/nexus-unified-market-data-live";
import { NexusMarketAnalysisCycle } from "../../../../lib/nexus-market-analysis-cycle";
import {
  persistFilledAutomatedPosition,
} from "../../../../lib/execution/automated-entry-ledger";
import {
  buildFilledPositionProtection,
} from "../../../../lib/execution/filled-position-protection";
import {
  buildFilledPositionInsertValues,
  buildFilledPositionRecoveryValues,
} from "../../../../lib/execution/filled-position-persistence";
import {
  advanceNexusExecutionIntent,
  reserveNexusExecutionIntent,
  settleNexusExecutionIntentWithLiveOrder,
} from "../../../../lib/nexus-execution-intent-store";
import { requireNexusBrainKey } from "../../../../lib/nexus-brain-identity";
import { buildEntryDecisionHandoff } from "../../../../lib/trade-lifecycle-contract";
import { readTradingStrategyDailyPnl, writeAudit } from "../../control/shared";

export const dynamic = "force-dynamic";

const RELATIVE_STRENGTH_TRIGGER_VERSION =
  "relative-strength-continuation-v2" as const;

const scanCursorByStrategy = new Map<string, number>();
const marketCohortSnapshotsByStrategy = new Map<
  string,
  Map<string, NonNullable<ReturnType<typeof analyzeRelativeStrengthSymbol>>>
>();
const MINIMUM_MARKET_COHORT_COVERAGE = 0.9;
// The relative-strength universe is a broad, low-priority scanner. Each
// candidate can require three closed K-line reads (5m/30m/1h, weight 2 each).
// Preserve enough REST headroom for fresh entry revalidation, order recovery
// and post-entry intelligence instead of letting a market-wide refresh make
// the shared eye temporarily blind.
const RELATIVE_STRENGTH_REST_WEIGHT_PER_SYMBOL = 6;
const CRITICAL_TRADING_REST_RESERVE_WEIGHT = 240;
const lastObservationByStrategy = new Map<
  string,
  { key: string; writtenAtMs: number }
>();

type RunningStrategy = typeof strategies.$inferSelect;
type ContractRow = typeof contractSymbols.$inferSelect;
type CredentialRow = typeof exchangeCredentials.$inferSelect;

function relativeStrengthRuntimeKey(strategy: {
  id: number;
  configVersion: number;
}) {
  return `${strategy.id}:v${strategy.configVersion}`;
}

function authorized(request: Request) {
  const configured = (
    env as unknown as { NQ_INTERNAL_LIQUIDATION_TOKEN?: string }
  ).NQ_INTERNAL_LIQUIDATION_TOKEN ?? "";
  return configured.length >= 32 &&
    request.headers.get("authorization") === `Bearer ${configured}`;
}

async function liveAllowed() {
  return await liveTradingAllowedByServer();
}

function safeConfig(value: string) {
  try {
    return JSON.parse(value) as LiquidationTrendConfig;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseRecord(value: string) {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "内部相对强弱策略凭据无效" }, { status: 401 });
  const compactResponse =
    new URL(request.url).searchParams.get("compact") === "1";
  const pressureResponse = marketAnalysisPressureResponse();
  if (pressureResponse) return pressureResponse;
  const startedAt = Date.now();
  const db = getDb();
  const rows = await db
    .select()
    .from(strategies)
    .where(
      and(
        eq(strategies.strategyType, "LIQ_CHASE"),
        eq(strategies.brainTemplate, "NEXUS_MARKET_BRAIN"),
        eq(strategies.runtimeMode, "LIVE"),
        eq(strategies.status, "RUNNING"),
      ),
    );
  const running = rows
    .map((strategy) => ({ strategy, config: safeConfig(strategy.configJson) }))
    .filter((row): row is { strategy: RunningStrategy; config: LiquidationTrendConfig } =>
      Boolean(row.config?.marketProfile?.mode === "RELATIVE_STRENGTH")
    );
  const runningRuntimeKeys = new Set(
    running.map((row) => relativeStrengthRuntimeKey(row.strategy)),
  );
  for (const runtimeKey of scanCursorByStrategy.keys())
    if (!runningRuntimeKeys.has(runtimeKey)) scanCursorByStrategy.delete(runtimeKey);
  for (const runtimeKey of marketCohortSnapshotsByStrategy.keys())
    if (!runningRuntimeKeys.has(runtimeKey))
      marketCohortSnapshotsByStrategy.delete(runtimeKey);
  for (const runtimeKey of lastObservationByStrategy.keys())
    if (!runningRuntimeKeys.has(runtimeKey))
      lastObservationByStrategy.delete(runtimeKey);
  if (!running.length)
    return Response.json({
      strategies: 0,
      evaluated: 0,
      ready: 0,
      liveOrdersCreated: 0,
      timings: { totalMs: Date.now() - startedAt },
      checkedAt: new Date().toISOString(),
    });

  const marketAnalysisCycle = new NexusMarketAnalysisCycle(
    nexusUnifiedMarketData,
    startedAt,
  );

  const contracts = await db
    .select()
    .from(contractSymbols)
    .where(eq(contractSymbols.isActive, true));
  let evaluated = 0;
  let ready = 0;
  let liveOrdersCreated = 0;
  const results: Array<Record<string, unknown>> = [];

  for (const { strategy, config: rawConfig } of running) {
    const runtimeKey = relativeStrengthRuntimeKey(strategy);
    const resolved = resolveLiquidationTrendConfig(rawConfig);
    if (!resolved.config) {
      results.push({ strategyId: strategy.id, status: "INVALID_CONFIG", message: resolved.error });
      await persistRelativeStrengthObservation(strategy, "INVALID_CONFIG", {
        message: resolved.error,
      });
      continue;
    }
    const config = resolved.config;
    const relativeConfig = normalizeRelativeStrengthConfig(
      config.relativeStrength ?? DEFAULT_RELATIVE_STRENGTH_CONFIG,
    );
    const scopedContracts = filterContractsByStrategyAssetScope({
      contracts,
      scope: config.assetClassScope ?? "ALL",
      selectedSymbols: config.selectedSymbols,
    });
    const universe = buildRelativeStrengthUniverse({
      rows: scopedContracts,
      config: {
        ...relativeConfig,
        // An explicit TradFi/custom universe is authoritative. The legacy
        // includeTradfi flag only controls the ALL universe.
        includeTradfi: ["TRADFI", "CUSTOM"].includes(
          config.assetClassScope ?? "ALL",
        ) || relativeConfig.includeTradfi,
      },
    });
    let scanCapacity: ReturnType<typeof binanceAnalysisCapacity>;
    try {
      const metrics = await getBinanceLiveSystemMetrics();
      scanCapacity = binanceAnalysisCapacity({
        rest: metrics.rest,
        weightPerSymbol: RELATIVE_STRENGTH_REST_WEIGHT_PER_SYMBOL,
        configuredMaxSymbols: relativeConfig.maxCandidatesPerCycle,
        reservedWeight: CRITICAL_TRADING_REST_RESERVE_WEIGHT,
      });
    } catch (error) {
      const detail = {
        message: error instanceof Error
          ? error.message
          : "Binance REST容量状态暂不可读",
        orderAffecting: false,
        signalConditionsChanged: false,
      };
      results.push({
        strategyId: strategy.id,
        status: "MARKET_DATA_CAPACITY_WAIT",
        ...detail,
      });
      await persistRelativeStrengthObservation(
        strategy,
        "MARKET_DATA_CAPACITY_WAIT",
        detail,
      );
      continue;
    }
    if (!scanCapacity.available || scanCapacity.maxSymbols < 2) {
      const detail = {
        usedWeight: scanCapacity.usedWeight,
        admissionLimit: scanCapacity.admissionLimit,
        reservedWeight: CRITICAL_TRADING_REST_RESERVE_WEIGHT,
        remainingAnalysisWeight: scanCapacity.remainingAnalysisWeight,
        orderAffecting: false,
        signalConditionsChanged: false,
        message: "当前REST容量优先保留给下单复核与持仓管理，相对强弱全市场扫描顺延",
      };
      results.push({
        strategyId: strategy.id,
        status: "MARKET_DATA_CAPACITY_WAIT",
        ...detail,
      });
      await persistRelativeStrengthObservation(
        strategy,
        "MARKET_DATA_CAPACITY_WAIT",
        detail,
      );
      continue;
    }
    const batch = selectRelativeStrengthScanBatch({
      universe,
      maxCandidates: scanCapacity.maxSymbols,
      cursor: scanCursorByStrategy.get(runtimeKey) ?? 0,
    });
    scanCursorByStrategy.set(runtimeKey, batch.nextCursor);
    const scanErrors: Array<{ symbol: string; message: string }> = [];
    const snapshots = (await mapWithConcurrency(
      batch.rows,
      NEXUS_MARKET_ANALYSIS_CONCURRENCY,
      async (member) => {
        try {
          const [trade5m, trade30m, trade1h] = await Promise.all([
            marketAnalysisCycle.closedSnapshot({ symbol: member.symbol, interval: "5m", source: "TRADE", limit: 40 }),
            marketAnalysisCycle.closedSnapshot({ symbol: member.symbol, interval: "30m", source: "TRADE", limit: 8 }),
            marketAnalysisCycle.closedSnapshot({ symbol: member.symbol, interval: "1h", source: "TRADE", limit: 8 }),
          ]);
          return analyzeRelativeStrengthSymbol({
            symbol: member.symbol,
            group: member.group,
            trade5m: trade5m.rows,
            trade30m: trade30m.rows,
            trade1h: trade1h.rows,
            config: relativeConfig,
          });
        } catch (error) {
          scanErrors.push({
            symbol: member.symbol,
            message: error instanceof Error ? error.message : "行情分析失败",
          });
          return null;
        }
      },
    )).filter((row): row is NonNullable<typeof row> => row !== null);
    evaluated += snapshots.length;
    const cohortStore = marketCohortSnapshotsByStrategy.get(runtimeKey) ??
      new Map<string, NonNullable<ReturnType<typeof analyzeRelativeStrengthSymbol>>>();
    const universeSymbols = new Set(universe.map((member) => member.symbol));
    for (const symbol of cohortStore.keys())
      if (!universeSymbols.has(symbol)) cohortStore.delete(symbol);
    for (const snapshot of snapshots) cohortStore.set(snapshot.symbol, snapshot);
    marketCohortSnapshotsByStrategy.set(runtimeKey, cohortStore);
    const latestCohortOpenTime = Math.max(
      0,
      ...[...cohortStore.values()].map((snapshot) => snapshot.candle5mOpenTime),
    );
    const comparableSnapshots = [...cohortStore.values()].filter(
      (snapshot) => snapshot.candle5mOpenTime === latestCohortOpenTime,
    );
    const requiredComparableSnapshots = Math.min(
      universe.length,
      Math.max(2, Math.ceil(universe.length * MINIMUM_MARKET_COHORT_COVERAGE)),
    );
    if (comparableSnapshots.length < requiredComparableSnapshots) {
      results.push({
        strategyId: strategy.id,
        status: "MARKET_COHORT_WARMING",
        universe: universe.length,
        scanned: batch.rows.length,
        analyzed: snapshots.length,
        cohortOpenTime: latestCohortOpenTime || null,
        cohortReady: comparableSnapshots.length,
        cohortRequired: requiredComparableSnapshots,
        reasons: ["等待同一根闭合5分钟K线覆盖全市场候选后统一排名"],
        scanErrors,
      });
      await persistRelativeStrengthObservation(strategy, "MARKET_COHORT_WARMING", {
        universe: universe.length,
        scanned: batch.rows.length,
        analyzed: snapshots.length,
        cohortOpenTime: latestCohortOpenTime || null,
        cohortReady: comparableSnapshots.length,
        cohortRequired: requiredComparableSnapshots,
        scanErrors,
      });
      continue;
    }
    const decision = selectRelativeStrengthPair({
      snapshots: comparableSnapshots,
      config: relativeConfig,
    });
    if (decision.status !== "READY" || !decision.strong || !decision.weak || !decision.group) {
      results.push({
        strategyId: strategy.id,
        status: "WAIT",
        universe: universe.length,
        scanned: batch.rows.length,
        analyzed: snapshots.length,
        cohortAnalyzed: comparableSnapshots.length,
        reasons: decision.reasons,
        scanErrors,
      });
      await persistRelativeStrengthObservation(strategy, "WAIT", {
        universe: universe.length,
        scanned: batch.rows.length,
        analyzed: snapshots.length,
        cohortAnalyzed: comparableSnapshots.length,
        reasons: decision.reasons,
        scanErrors,
      });
      continue;
    }
    ready += 1;
    const outcome = await executeRelativeStrengthPair({
      strategy,
      config,
      relativeConfig,
      contracts: scopedContracts,
      decision: {
        group: decision.group,
        strong: decision.strong,
        weak: decision.weak,
        spread5mPercent: decision.spread5mPercent!,
        spread30mPercent: decision.spread30mPercent!,
        spread1hPercent: decision.spread1hPercent!,
        spread4hPercent: decision.spread4hPercent!,
        reasons: decision.reasons,
      },
    });
    liveOrdersCreated += outcome.liveOrdersCreated;
    results.push({ strategyId: strategy.id, ...outcome });
    await persistRelativeStrengthObservation(
      strategy,
      String(outcome.status ?? "UNKNOWN"),
      { pairKey: outcome.pairKey ?? null, outcome, scanErrors },
    );
  }

  const timings = { totalMs: Date.now() - startedAt };
  const checkedAt = new Date().toISOString();
  marketAnalysisCycle.clear();
  if (compactResponse)
    return Response.json({
      strategies: running.length,
      evaluated,
      ready,
      liveOrdersCreated,
      resultCount: results.length,
      runtimeState: {
        strategyVersions: runningRuntimeKeys.size,
        cohortSymbols: [...marketCohortSnapshotsByStrategy.values()].reduce(
          (total, cohort) => total + cohort.size,
          0,
        ),
      },
      timings,
      checkedAt,
    });

  return Response.json({
    strategies: running.length,
    evaluated,
    ready,
    liveOrdersCreated,
    results,
    timings,
    checkedAt,
  });
}

async function persistRelativeStrengthObservation(
  strategy: RunningStrategy,
  status: string,
  detail: Record<string, unknown>,
) {
  const nowMs = Date.now();
  const key = JSON.stringify({
    status,
    pairKey: detail.pairKey ?? null,
    cohortOpenTime: detail.cohortOpenTime ?? null,
    errors: Array.isArray(detail.scanErrors) ? detail.scanErrors.length : 0,
  });
  const runtimeKey = relativeStrengthRuntimeKey(strategy);
  const previous = lastObservationByStrategy.get(runtimeKey);
  if (
    previous &&
    previous.key === key &&
    nowMs - previous.writtenAtMs < 5 * 60_000
  ) return;
  const now = new Date(nowMs);
  const reasons = Array.isArray(detail.reasons)
    ? detail.reasons.filter((item): item is string => typeof item === "string")
    : [];
  const message = typeof detail.message === "string"
    ? detail.message
    : reasons.length
      ? reasons.join("；")
      : `相对强弱扫描状态：${status}`;
  const traceId = `relative-strength-monitor-status:${strategy.id}`;
  const values = {
    strategyId: strategy.id,
    strategyRunId: "relative-strength-monitor-status",
    configVersion: strategy.configVersion,
    ownerEmail: strategy.ownerEmail,
    accountId: strategy.accountId,
    symbol: "BTCUSDT",
    triggerKind: "RELATIVE_STRENGTH_CONTINUATION" as const,
    triggerVersion: RELATIVE_STRENGTH_TRIGGER_VERSION,
    triggerDirection: "LONG" as const,
    triggerReferencePrice: 1,
    triggerFactSnapshotId: null,
    triggerSourceId: traceId,
    liquidationSide: "SELL" as const,
    liquidationPrice: 1,
    liquidationNotional: 0,
    eventTime: now,
    receivedAt: now,
    expiresAt: new Date(nowMs + 5 * 60_000),
    state: "CLOSED" as const,
    resultCode: "RELATIVE_STRENGTH_MONITOR_STATUS",
    resultMessage: message,
    configSnapshotJson: strategy.configJson,
    entryEvidenceJson: JSON.stringify({
      triggerIdentity: {
        triggerKind: "RELATIVE_STRENGTH_CONTINUATION",
        triggerVersion: RELATIVE_STRENGTH_TRIGGER_VERSION,
        direction: "BOTH",
        sourceId: traceId,
        canAuthorizeOrder: false,
      },
      monitorDiagnostic: true,
      monitorStatus: status,
      detail,
      checkedAt: now.toISOString(),
    }),
    updatedAt: now,
    completedAt: now,
  };
  await getDb()
    .insert(strategyExecutionTraces)
    .values({ traceId, ...values, createdAt: now })
    .onConflictDoUpdate({
      target: strategyExecutionTraces.traceId,
      set: values,
    });
  lastObservationByStrategy.set(runtimeKey, { key, writtenAtMs: nowMs });
}

async function executeRelativeStrengthPair(input: {
  strategy: RunningStrategy;
  config: LiquidationTrendConfig;
  relativeConfig: ReturnType<typeof normalizeRelativeStrengthConfig>;
  contracts: ContractRow[];
  decision: {
    group: "CRYPTO" | "TRADFI";
    strong: NonNullable<ReturnType<typeof analyzeRelativeStrengthSymbol>>;
    weak: NonNullable<ReturnType<typeof analyzeRelativeStrengthSymbol>>;
    spread5mPercent: number;
    spread30mPercent: number;
    spread1hPercent: number;
    spread4hPercent: number;
    reasons: string[];
  };
}) {
  const db = getDb();
  const pairKey = relativeStrengthPairKey({
    group: input.decision.group,
    strongSymbol: input.decision.strong.symbol,
    weakSymbol: input.decision.weak.symbol,
  });
  const openPositions = await db
    .select()
    .from(livePositions)
    .where(
      and(
        eq(livePositions.ownerEmail, input.strategy.ownerEmail),
        eq(livePositions.accountId, input.strategy.accountId),
        inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
      ),
    );
  const conflictingOpenPosition = openPositions.some((position) => {
    const expectedSide = position.symbol === input.decision.strong.symbol
      ? "LONG"
      : position.symbol === input.decision.weak.symbol
        ? "SHORT"
        : null;
    if (!expectedSide) return false;
    return input.config.execution.existingPositionPolicy !==
        "ALLOW_SAME_DIRECTION" || position.positionSide !== expectedSide;
  });
  if (conflictingOpenPosition)
    return { status: "SYMBOL_ALREADY_OPEN", pairKey, liveOrdersCreated: 0 };

  const [recentSamePair] = await db
    .select({ entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson, createdAt: strategyExecutionTraces.createdAt })
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.strategyId, input.strategy.id))
    .orderBy(desc(strategyExecutionTraces.id))
    .limit(100)
    .then((rows) => rows.filter((row) => asRecord(parseRecord(row.entryEvidenceJson).relativeStrengthPair).pairKey === pairKey));
  const cooldownMs = input.relativeConfig.pairCooldownMinutes * 60_000;
  if (recentSamePair && Date.now() - recentSamePair.createdAt.getTime() < cooldownMs)
    return { status: "PAIR_COOLDOWN", pairKey, liveOrdersCreated: 0 };

  const [account] = await db
    .select()
    .from(tradingAccounts)
    .where(
      and(
        eq(tradingAccounts.ownerEmail, input.strategy.ownerEmail),
        eq(tradingAccounts.accountId, input.strategy.accountId),
      ),
    )
    .limit(1);
  const [credential] = await db
    .select()
    .from(exchangeCredentials)
    .where(
      and(
        eq(exchangeCredentials.ownerEmail, input.strategy.ownerEmail),
        eq(exchangeCredentials.accountId, input.strategy.accountId),
      ),
    )
    .limit(1);
  const readiness = account
    ? getTradeReadiness(account, credential, await liveAllowed())
    : null;
  if (!account || !credential || !readiness?.liveReady)
    return {
      status: "ACCOUNT_NOT_READY",
      pairKey,
      blockers: readiness?.blockers ?? ["交易账户不存在"],
      liveOrdersCreated: 0,
    };
  if (input.relativeConfig.executionMode !== "LIVE")
    return { status: "SHADOW_READY", pairKey, liveOrdersCreated: 0 };
  const strategyDailyPnl = await readTradingStrategyDailyPnl(
    { email: input.strategy.ownerEmail, accountId: input.strategy.accountId },
    account,
    input.strategy.id,
  );
  if (strategyDailyPnl.dailyPnl <= -input.config.risk.dailyLossLimitUsdt)
    return {
      status: "STRATEGY_DAILY_LOSS_LIMIT",
      pairKey,
      strategyId: input.strategy.id,
      dailyPnl: strategyDailyPnl.dailyPnl,
      dailyLossLimitUsdt: input.config.risk.dailyLossLimitUsdt,
      liveOrdersCreated: 0,
    };

  const strongContract = input.contracts.find((row) => row.symbol === input.decision.strong.symbol);
  const weakContract = input.contracts.find((row) => row.symbol === input.decision.weak.symbol);
  if (!strongContract || !weakContract)
    return { status: "CONTRACT_RULE_MISSING", pairKey, liveOrdersCreated: 0 };
  const strongLeverage = evaluateAutomatedEntryContractLeverage(
    strongContract.maxLeverage,
    input.config.execution.leverage,
  );
  const weakLeverage = evaluateAutomatedEntryContractLeverage(
    weakContract.maxLeverage,
    input.config.execution.leverage,
  );
  if (!strongLeverage.allowed || !weakLeverage.allowed)
    return {
      status: "PAIR_CONTRACT_LEVERAGE_TOO_LOW",
      pairKey,
      strongLeverage,
      weakLeverage,
      liveOrdersCreated: 0,
    };

  const markRows = await getBinanceLiveMarkPrices([
    strongContract.symbol,
    weakContract.symbol,
  ]);
  const strongMark = markRows.find((row) => row.symbol === strongContract.symbol);
  const weakMark = markRows.find((row) => row.symbol === weakContract.symbol);
  if (!freshMark(strongMark) || !freshMark(weakMark))
    return { status: "MARK_PRICE_STALE", pairKey, liveOrdersCreated: 0 };
  const sizing = buildBalancedMinimumPairSizing({
    strong: sizingRule(strongContract, strongMark.markPrice),
    weak: sizingRule(weakContract, weakMark.markPrice),
    leverage: input.config.execution.leverage,
    sizingCapitalUsdt: Number(credential.availableBalance ?? 0),
    equityAllocationPercent:
      input.config.execution.equityAllocationPercent ?? 5,
    minimumPositionNotionalUsdt:
      input.config.execution.minimumPositionNotionalUsdt ?? 15,
    maximumMarginPerLegUsdt: input.config.execution.maxOrderNotionalUsdt,
    minimumOrderQuantityMultiplier:
      input.config.execution.minimumOrderQuantityMultiplier,
  });
  if (!sizing)
    return {
      status: "STRATEGY_BALANCED_PAIR_SIZING_UNAVAILABLE",
      pairKey,
      sizingCapitalUsdt: Number(credential.availableBalance ?? 0),
      equityAllocationPercent:
        input.config.execution.equityAllocationPercent ?? 5,
      minimumPositionNotionalUsdt:
        input.config.execution.minimumPositionNotionalUsdt ?? 15,
      maximumMarginPerLegUsdt:
        input.config.execution.maxOrderNotionalUsdt,
      liveOrdersCreated: 0,
    };
  const strongSizing = sizing.strong;
  const weakSizing = sizing.weak;

  const pairId = `rsp-${input.strategy.id}-${Date.now().toString(36)}`;
  const evidence = {
    version: RELATIVE_STRENGTH_TREND_VERSION,
    pairId,
    pairKey,
    group: input.decision.group,
    strong: input.decision.strong,
    weak: input.decision.weak,
    balancedMinimumSizing: {
      targetNotionalUsdt: sizing.targetNotionalUsdt,
      balanceDifferencePercent: sizing.balanceDifferencePercent,
      strongNotionalUsdt: sizing.strong.notional,
      weakNotionalUsdt: sizing.weak.notional,
      leverage: input.config.execution.leverage,
      sizingCapitalUsdt: sizing.sizingCapitalUsdt,
      equityAllocationPercent: sizing.equityAllocationPercent,
      equityTargetMarginPerLegUsdt:
        sizing.equityTargetMarginPerLegUsdt,
      evidenceAdjustedTargetMarginPerLegUsdt:
        sizing.evidenceAdjustedTargetMarginPerLegUsdt,
      approvedTargetMarginPerLegUsdt:
        sizing.approvedTargetMarginPerLegUsdt,
      minimumPositionNotionalUsdt:
        sizing.minimumPositionNotionalUsdt,
    },
    spread5mPercent: input.decision.spread5mPercent,
    spread30mPercent: input.decision.spread30mPercent,
    spread1hPercent: input.decision.spread1hPercent,
    spread4hPercent: input.decision.spread4hPercent,
    reasons: input.decision.reasons,
    executionPolicy: "TWO_LEG_MINIMUM_MARKET_WITH_ROLLBACK",
  };
  const strongTrace = await createTrace({
    strategy: input.strategy,
    config: input.config,
    pairId,
    symbol: strongContract.symbol,
    positionSide: "LONG",
    referencePrice: strongMark.markPrice,
    evidence,
    ownSnapshot: input.decision.strong,
  });
  const weakTrace = await createTrace({
    strategy: input.strategy,
    config: input.config,
    pairId,
    symbol: weakContract.symbol,
    positionSide: "SHORT",
    referencePrice: weakMark.markPrice,
    evidence,
    ownSnapshot: input.decision.weak,
  });
  const brainKey = requireNexusBrainKey(input.strategy.brainKey);
  const expiresAt = Date.now() + 60_000;
  const strongIntent = await reserveNexusExecutionIntent({
    strategyId: input.strategy.id,
    brainKey,
    configVersion: input.strategy.configVersion,
    traceId: strongTrace.traceId,
    intentPurpose: "OPEN_POSITION",
    authoritySource: "ENTRY_BRAIN",
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    symbol: strongContract.symbol,
    positionSide: "LONG",
    positionMode: credential.positionMode ?? "ONE_WAY",
    orderType: "MARKET",
    quantity: strongSizing.quantity,
    requiredMarginUsdt: strongSizing.requiredMargin,
    riskBudgetUsdt: strongSizing.requiredMargin,
    priority: 80,
    observedAt: Date.now(),
    expiresAt,
  }, Number(credential.availableBalance ?? 0));
  if (!strongIntent.decision.executionOwner) {
    await rejectTrace(strongTrace.id, strongTrace.traceId, input.strategy.id, strongIntent.decision.reasonCode, strongIntent.decision.reason);
    await rejectTrace(weakTrace.id, weakTrace.traceId, input.strategy.id, "PAIR_RESERVATION_FAILED", "强腿未取得中央执行预留，两腿均未提交");
    return { status: strongIntent.decision.reasonCode, pairKey, liveOrdersCreated: 0 };
  }
  const weakIntent = await reserveNexusExecutionIntent({
    strategyId: input.strategy.id,
    brainKey,
    configVersion: input.strategy.configVersion,
    traceId: weakTrace.traceId,
    intentPurpose: "OPEN_POSITION",
    authoritySource: "ENTRY_BRAIN",
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    symbol: weakContract.symbol,
    positionSide: "SHORT",
    positionMode: credential.positionMode ?? "ONE_WAY",
    orderType: "MARKET",
    quantity: weakSizing.quantity,
    requiredMarginUsdt: weakSizing.requiredMargin,
    riskBudgetUsdt: weakSizing.requiredMargin,
    priority: 80,
    observedAt: Date.now(),
    expiresAt,
  }, Math.max(0, Number(credential.availableBalance ?? 0) - strongSizing.requiredMargin));
  if (!weakIntent.decision.executionOwner) {
    await advanceNexusExecutionIntent({ intentKey: strongIntent.decision.intentKey, nextStatus: "REJECTED", reasonCode: "PAIR_SECOND_LEG_RESERVATION_FAILED", reasonMessage: "弱腿未取得预留，强腿预留已释放" });
    await rejectTrace(strongTrace.id, strongTrace.traceId, input.strategy.id, "PAIR_RESERVATION_RELEASED", "弱腿预留失败，两腿均未提交");
    await rejectTrace(weakTrace.id, weakTrace.traceId, input.strategy.id, weakIntent.decision.reasonCode, weakIntent.decision.reason);
    return { status: weakIntent.decision.reasonCode, pairKey, liveOrdersCreated: 0 };
  }

  const keys = await decryptedKeys(credential);
  let strongFill: Awaited<ReturnType<typeof submitPairLeg>> | null = null;
  try {
    strongFill = await submitPairLeg({
      strategy: input.strategy,
      config: input.config,
      credential,
      keys,
      contract: strongContract,
      trace: strongTrace,
      intentKey: strongIntent.decision.intentKey,
      pairId,
      pairKey,
      peerSymbol: weakContract.symbol,
      positionSide: "LONG",
      referencePrice: strongMark.markPrice,
      quantity: strongSizing.quantity,
    });
    const weakFill = await submitPairLeg({
      strategy: input.strategy,
      config: input.config,
      credential,
      keys,
      contract: weakContract,
      trace: weakTrace,
      intentKey: weakIntent.decision.intentKey,
      pairId,
      pairKey,
      peerSymbol: strongContract.symbol,
      positionSide: "SHORT",
      referencePrice: weakMark.markPrice,
      quantity: weakSizing.quantity,
    });
    await appendEvent(strongTrace.traceId, input.strategy.id, "RELATIVE_STRENGTH_PAIR_OPEN", "ORDER", "PASSED", "强腿多仓与弱腿空仓均已成交，组合进入统一智能持仓管理", { pairId, pairKey, strongPositionId: strongFill.position.id, weakPositionId: weakFill.position.id });
    await writeAudit(
      { email: input.strategy.ownerEmail, accountId: input.strategy.accountId },
      "RELATIVE_STRENGTH_PAIR_LIVE_OPEN",
      "strategy",
      String(input.strategy.id),
      { pairId, pairKey, strongPositionId: strongFill.position.id, weakPositionId: weakFill.position.id },
    );
    return { status: "PAIR_OPEN", pairId, pairKey, liveOrdersCreated: 2 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "双腿执行失败";
    if (strongFill) {
      if (error instanceof BinanceLiveError && error.executionUnknown) {
        await appendEvent(strongTrace.traceId, input.strategy.id, "RELATIVE_STRENGTH_PAIR_EXECUTION_UNKNOWN", "ORDER", "ERROR", "弱腿执行结果未知，禁止盲目回退强腿；保留已确认仓位保护并等待交易所核对", { pairId, pairKey, error: message });
        return {
          status: "PAIR_EXECUTION_UNKNOWN",
          pairId,
          pairKey,
          error: message,
          liveOrdersCreated: 1,
        };
      }
      const rollback = await rollbackFilledLeg({
        keys,
        credential,
        contract: strongContract,
        position: strongFill.position,
        trace: strongTrace,
        strategyId: input.strategy.id,
        pairId,
        pairKey,
      });
      return {
        status: rollback.ok ? "SECOND_LEG_FAILED_ROLLED_BACK" : "LEG_IMBALANCE_REQUIRES_PROTECTION",
        pairId,
        pairKey,
        error: message,
        rollback,
        liveOrdersCreated: 1,
      };
    }
    try {
      await advanceNexusExecutionIntent({ intentKey: weakIntent.decision.intentKey, nextStatus: "REJECTED", reasonCode: "FIRST_LEG_FAILED", reasonMessage: "强腿未成交，弱腿禁止提交" });
    } catch {
      // The weak reservation may already be terminal after a concurrent repair.
    }
    return { status: "FIRST_LEG_FAILED", pairId, pairKey, error: message, liveOrdersCreated: 0 };
  }
}

function sizingRule(contract: ContractRow, markPrice: number) {
  return {
    markPrice,
    minOrderQty: contract.minOrderQty,
    quantityStep: contract.quantityStep,
    minNotionalUsdt: contract.minNotionalUsdt,
  };
}

function freshMark(row: { markPrice: number; time: number } | undefined): row is { symbol: string; markPrice: number; time: number } {
  return Boolean(row && Number.isFinite(row.markPrice) && row.markPrice > 0 && Date.now() - row.time <= 5_000);
}

async function decryptedKeys(credential: CredentialRow) {
  return {
    apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(credential.ownerEmail, credential.accountId, "api-key")),
    secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(credential.ownerEmail, credential.accountId, "secret-key")),
  };
}

async function createTrace(input: {
  strategy: RunningStrategy;
  config: LiquidationTrendConfig;
  pairId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  referencePrice: number;
  evidence: Record<string, unknown>;
  ownSnapshot: NonNullable<
    ReturnType<typeof analyzeRelativeStrengthSymbol>
  >;
}) {
  const now = new Date();
  const traceId = `${input.pairId}:${input.positionSide.toLowerCase()}`;
  const [trace] = await getDb().insert(strategyExecutionTraces).values({
    traceId,
    strategyId: input.strategy.id,
    strategyRunId: input.pairId,
    configVersion: input.strategy.configVersion,
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    symbol: input.symbol,
    triggerKind: "RELATIVE_STRENGTH_CONTINUATION",
    triggerVersion: RELATIVE_STRENGTH_TRIGGER_VERSION,
    triggerDirection: input.positionSide,
    triggerReferencePrice: input.referencePrice,
    triggerFactSnapshotId: input.pairId,
    triggerSourceId: input.pairId,
    liquidationSide: input.positionSide === "LONG" ? "SELL" : "BUY",
    liquidationPrice: input.referencePrice,
    liquidationNotional: 0,
    eventTime: now,
    receivedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    state: "ORDER_READY",
    resultCode: "RELATIVE_STRENGTH_PAIR_READY",
    resultMessage: input.positionSide === "LONG" ? "相对强势腿等待做多" : "相对弱势腿等待做空",
    configSnapshotJson: JSON.stringify(input.config),
    entryEvidenceJson: JSON.stringify({
      triggerIdentity: {
        triggerKind: "RELATIVE_STRENGTH_CONTINUATION",
        triggerVersion: RELATIVE_STRENGTH_TRIGGER_VERSION,
        direction: input.positionSide,
        factSnapshotId: input.pairId,
        sourceId: input.pairId,
        referencePrice: input.referencePrice,
        canAuthorizeOrder: false,
      },
      relativeStrengthPair: input.evidence,
      pairLeg: input.positionSide,
      nexusOwnMultiHourContext: input.ownSnapshot.multiHourContext,
      nexusOwnEntryRegime5m: input.ownSnapshot.entryRegime5m,
    }),
    createdAt: now,
    updatedAt: now,
  }).returning();
  await appendEvent(traceId, input.strategy.id, "RELATIVE_STRENGTH_PAIR_READY", "SIGNAL", "PASSED", trace.resultMessage ?? "相对强弱组合已确认", { pairId: input.pairId, positionSide: input.positionSide, evidence: input.evidence });
  return trace;
}

async function submitPairLeg(input: {
  strategy: RunningStrategy;
  config: LiquidationTrendConfig;
  credential: CredentialRow;
  keys: { apiKey: string; secretKey: string };
  contract: ContractRow;
  trace: typeof strategyExecutionTraces.$inferSelect;
  intentKey: string;
  pairId: string;
  pairKey: string;
  peerSymbol: string;
  positionSide: "LONG" | "SHORT";
  referencePrice: number;
  quantity: number;
}) {
  const now = new Date();
  const clientOrderId = `nqp_${input.trace.id}_${input.positionSide === "LONG" ? "l" : "s"}_${input.pairId.slice(-8)}`.slice(0, 36);
  const pendingRiskPlan = buildRelativeStrengthRiskPlan(input, input.quantity);
  const entryDecisionHandoffJson = JSON.stringify(buildEntryDecisionHandoff({
    traceId: input.trace.traceId,
    strategyId: input.strategy.id,
    configVersion: input.trace.configVersion,
    positionSide: input.positionSide,
    decisionAt: now,
    executionIntentId: input.intentKey,
    resultCode: input.trace.resultCode,
    resultMessage: input.trace.resultMessage,
    entryEvidence: parseRecord(input.trace.entryEvidenceJson),
  }));
  const [event] = await getDb().insert(liveOrderEvents).values({
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    credentialId: input.credential.id,
    clientOrderId,
    symbol: input.contract.symbol,
    side: input.positionSide === "LONG" ? "BUY" : "SELL",
    positionSide: input.positionSide,
    orderType: "MARKET",
    quantity: input.quantity,
    referencePrice: input.referencePrice,
    estimatedNotional: input.quantity * input.referencePrice,
    testOnly: false,
    status: "PENDING",
    responseJson: JSON.stringify({
      requestedLeverage: input.config.execution.leverage,
      relativeStrengthPairId: input.pairId,
      strategyPendingEntry: {
        leverage: input.config.execution.leverage,
        trailingActivationPercent: input.config.risk.trailingActivationPercent,
        trailingStopPercent:
          input.config.risk.dynamicTrailingEnabled === false
            ? 0
            : input.config.risk.trailingDrawdownPercent,
        riskPlan: pendingRiskPlan,
      },
    }),
    lifecycleId: input.trace.traceId,
    entryDecisionHandoffJson,
    createdAt: now,
    updatedAt: now,
  }).returning();
  await advanceNexusExecutionIntent({ intentKey: input.intentKey, nextStatus: "SUBMITTING", detail: { liveOrderEventId: event.id, clientOrderId, pairId: input.pairId } });
  try {
    const result = await submitLiveEntryOrder(input.keys, {
      symbol: input.contract.symbol,
      side: input.positionSide === "LONG" ? "BUY" : "SELL",
      positionSide: input.positionSide,
      quantity: input.quantity,
      clientOrderId,
      leverage: input.config.execution.leverage,
      positionMode: input.credential.positionMode,
      orderType: "MARKET",
    });
    const executedQuantity = Number(result.data.executedQty);
    if (!Number.isFinite(executedQuantity) || executedQuantity <= 0)
      throw new BinanceLiveError("Binance 返回的相对强弱委托未包含有效成交数量", 502, undefined, true);
    const entryPrice = Number(result.data.avgPrice) || input.referencePrice;
    const riskPlan = buildRelativeStrengthRiskPlan(input, executedQuantity);
    const positionProtection = buildFilledPositionProtection({
      plan: riskPlan,
      activatedAt: now,
      trailingActivationPercent:
        input.config.risk.trailingActivationPercent,
      trailingStopPercent:
        input.config.risk.dynamicTrailingEnabled === false
          ? 0
          : input.config.risk.trailingDrawdownPercent,
    });
    const positionValues = buildFilledPositionInsertValues({
      ownerEmail: input.strategy.ownerEmail,
      accountId: input.strategy.accountId,
      credentialId: input.credential.id,
      sourceEventId: event.id,
      handoffOrigin: "STRATEGY",
      lifecycleId: event.lifecycleId,
      entryDecisionHandoffJson: event.entryDecisionHandoffJson,
      symbol: input.contract.symbol,
      instrumentId: input.contract.instrumentId,
      instrumentRuleVersion: input.contract.ruleVersion,
      positionSide: input.positionSide,
      quantity: executedQuantity,
      entryPrice,
      leverage: result.timing.confirmedLeverage,
      protection: positionProtection,
      openedAt: now,
      updatedAt: now,
    });
    const { position } = await persistFilledAutomatedPosition({
      insertValues: positionValues,
      recoveryValues: buildFilledPositionRecoveryValues({
        lifecycleId: event.lifecycleId,
        entryDecisionHandoffJson: event.entryDecisionHandoffJson,
        positionHandoffKey: positionValues.positionHandoffKey,
        positionHandoffVersion: positionValues.positionHandoffVersion,
        positionHandoffJson: positionValues.positionHandoffJson,
        leverage: result.timing.confirmedLeverage,
        protection: positionProtection,
        updatedAt: now,
      }),
    });
    await settleNexusExecutionIntentWithLiveOrder({
      intentKey: input.intentKey,
      liveOrderEventId: event.id,
      nextStatus: "FILLED",
      exchangeOrderId: String(result.data.orderId ?? ""),
      responseJson: JSON.stringify({
        ...result.data,
        confirmedLeverage: result.timing.confirmedLeverage,
        requestedLeverage: input.config.execution.leverage,
        relativeStrengthPairId: input.pairId,
        strategyPendingEntry: {
          leverage: result.timing.confirmedLeverage,
          trailingActivationPercent: input.config.risk.trailingActivationPercent,
          trailingStopPercent:
            input.config.risk.dynamicTrailingEnabled === false
              ? 0
              : input.config.risk.trailingDrawdownPercent,
          riskPlan,
        },
      }),
      livePositionId: position.id,
      filledQuantity: executedQuantity,
      detail: { pairId: input.pairId, positionId: position.id },
    });
    await getDb().update(strategyExecutionTraces).set({
      state: "POSITION_OPEN",
      resultCode: input.positionSide === "LONG" ? "RELATIVE_STRENGTH_STRONG_LONG_OPEN" : "RELATIVE_STRENGTH_WEAK_SHORT_OPEN",
      resultMessage: input.positionSide === "LONG" ? "相对强势腿做多已成交" : "相对弱势腿做空已成交",
      exchangeOrderId: String(result.data.orderId ?? ""),
      positionId: String(position.id),
      updatedAt: new Date(),
    }).where(eq(strategyExecutionTraces.id, input.trace.id));
    await appendEvent(input.trace.traceId, input.strategy.id, "RELATIVE_STRENGTH_LEG_FILLED", "ORDER", "PASSED", input.positionSide === "LONG" ? "相对强势腿做多成交" : "相对弱势腿做空成交", { pairId: input.pairId, pairKey: input.pairKey, positionId: position.id, quantity: executedQuantity, entryPrice, leverage: result.timing.confirmedLeverage });
    return { event, position, executedQuantity, entryPrice };
  } catch (error) {
    const unknown = error instanceof BinanceLiveError && error.executionUnknown;
    const message = error instanceof Error ? error.message : "相对强弱单腿提交失败";
    await getDb().update(liveOrderEvents).set({ status: unknown ? "EXECUTION_UNKNOWN" : "REJECTED", responseJson: JSON.stringify({ error: message, relativeStrengthPairId: input.pairId }), updatedAt: new Date() }).where(eq(liveOrderEvents.id, event.id));
    await getDb().update(strategyExecutionTraces).set({ state: unknown ? "EXECUTION_UNKNOWN" : "REJECTED", resultCode: unknown ? "RELATIVE_STRENGTH_EXECUTION_UNKNOWN" : "RELATIVE_STRENGTH_LEG_REJECTED", resultMessage: message, completedAt: unknown ? null : new Date(), updatedAt: new Date() }).where(eq(strategyExecutionTraces.id, input.trace.id));
    if (unknown)
      await advanceNexusExecutionIntent({ intentKey: input.intentKey, nextStatus: "EXECUTION_UNKNOWN", detail: { liveOrderEventId: event.id, clientOrderId, pairId: input.pairId }, reasonCode: "EXCHANGE_EXECUTION_UNKNOWN", reasonMessage: message });
    else
      await settleNexusExecutionIntentWithLiveOrder({ intentKey: input.intentKey, liveOrderEventId: event.id, nextStatus: "REJECTED", responseJson: JSON.stringify({ error: message }), reasonCode: "EXCHANGE_ORDER_REJECTED", reasonMessage: message });
    await appendEvent(input.trace.traceId, input.strategy.id, unknown ? "RELATIVE_STRENGTH_EXECUTION_UNKNOWN" : "RELATIVE_STRENGTH_LEG_REJECTED", "ORDER", "ERROR", message, { pairId: input.pairId, positionSide: input.positionSide });
    throw error;
  }
}

function buildRelativeStrengthRiskPlan(
  input: {
    strategy: RunningStrategy;
    config: LiquidationTrendConfig;
    contract: ContractRow;
    trace: typeof strategyExecutionTraces.$inferSelect;
    pairId: string;
    pairKey: string;
    peerSymbol: string;
    positionSide: "LONG" | "SHORT";
  },
  quantity: number,
) {
  return {
    ...buildPilotRiskPlan(
      input.config,
      quantity,
      input.contract.minOrderQty,
      input.contract.quantityStep,
      {
        referencePrice: input.referencePrice,
        minNotionalUsdt: input.contract.minNotionalUsdt,
      },
    ),
    orderOrigin: "STRATEGY" as const,
    riskClass: "STANDARD" as const,
    strategyId: input.strategy.id,
    strategyConfigVersion: input.strategy.configVersion,
    traceId: input.trace.traceId,
    relativeStrengthPair: {
      version: RELATIVE_STRENGTH_TREND_VERSION,
      strategyId: input.strategy.id,
      pairId: input.pairId,
      pairKey: input.pairKey,
      peerSymbol: input.peerSymbol,
      leg: input.positionSide === "LONG" ? "STRONG_LONG" : "WEAK_SHORT",
    },
  };
}

async function rollbackFilledLeg(input: {
  keys: { apiKey: string; secretKey: string };
  credential: CredentialRow;
  contract: ContractRow;
  position: typeof livePositions.$inferSelect;
  trace: typeof strategyExecutionTraces.$inferSelect;
  strategyId: number;
  pairId: string;
  pairKey: string;
}) {
  const clientOrderId = `nqrr_${input.strategyId}_${input.position.id}`.slice(0, 36);
  try {
    const current = await getLivePositionSnapshot(input.keys, input.position.symbol, input.position.positionSide);
    if (!(current.quantity > 0)) return { ok: true, status: "ALREADY_FLAT" };
    const result = await submitLiveReduceMarketOrder(input.keys, {
      symbol: input.position.symbol,
      positionSide: input.position.positionSide,
      quantity: current.quantity,
      quantityStep: input.contract.quantityStep,
      clientOrderId,
    });
    const exitPrice = Number(result.data.avgPrice) || input.position.entryPrice;
    const realizedPnl = input.position.positionSide === "LONG"
      ? (exitPrice - input.position.entryPrice) * current.quantity
      : (input.position.entryPrice - exitPrice) * current.quantity;
    const now = new Date();
    await getDb().batch([
      getDb().insert(livePositionReductions).values({
        positionId: input.position.id,
        lifecycleId: input.position.lifecycleId,
        ownerEmail: input.position.ownerEmail,
        accountId: input.position.accountId,
        clientOrderId,
        exchangeOrderId: String(result.data.orderId ?? ""),
        symbol: input.position.symbol,
        positionSide: input.position.positionSide,
        quantity: current.quantity,
        exitPrice,
        realizedPnl,
        reason: "EXTERNAL",
        responseJson: JSON.stringify({ ...result.data, relativeStrengthRollback: true, pairId: input.pairId }),
        createdAt: now,
      }),
      getDb().update(livePositions).set({ status: "CLOSED", quantity: 0, markPrice: exitPrice, realizedPnl, exitReason: "EXTERNAL", closedAt: now, updatedAt: now }).where(eq(livePositions.id, input.position.id)),
      getDb().update(strategyExecutionTraces).set({ state: "CLOSED", resultCode: "RELATIVE_STRENGTH_LEG_ROLLED_BACK", resultMessage: "另一腿失败，已立即回退成交腿，未保留单边裸仓", completedAt: now, updatedAt: now }).where(eq(strategyExecutionTraces.id, input.trace.id)),
    ]);
    await appendEvent(input.trace.traceId, input.strategyId, "RELATIVE_STRENGTH_LEG_ROLLED_BACK", "ORDER", "PASSED", "另一腿失败，成交腿已立即市价回退", { pairId: input.pairId, pairKey: input.pairKey, exitPrice, quantity: current.quantity });
    return { ok: true, status: "ROLLED_BACK", exitPrice, quantity: current.quantity };
  } catch (error) {
    const message = error instanceof Error ? error.message : "成交腿回退失败";
    await appendEvent(input.trace.traceId, input.strategyId, "RELATIVE_STRENGTH_LEG_IMBALANCE", "ORDER", "ERROR", "另一腿失败且成交腿暂未能回退；现有统一持仓保护继续接管", { pairId: input.pairId, pairKey: input.pairKey, error: message });
    return { ok: false, status: "ROLLBACK_FAILED", error: message };
  }
}

async function rejectTrace(id: number, traceId: string, strategyId: number, code: string, message: string) {
  await getDb().update(strategyExecutionTraces).set({ state: "REJECTED", resultCode: code, resultMessage: message, completedAt: new Date(), updatedAt: new Date() }).where(eq(strategyExecutionTraces.id, id));
  await appendEvent(traceId, strategyId, code, "ORDER", "REJECTED", message, {});
}

async function appendEvent(
  traceId: string,
  strategyId: number,
  eventType: string,
  stage: "SIGNAL" | "ORDER" | "POSITION_MANAGEMENT",
  outcome: "PASSED" | "PENDING" | "REJECTED" | "INFO" | "ERROR",
  message: string,
  detail: Record<string, unknown>,
) {
  const db = getDb();
  const [latest] = await db
    .select({ sequence: strategyExecutionEvents.sequence })
    .from(strategyExecutionEvents)
    .where(eq(strategyExecutionEvents.traceId, traceId))
    .orderBy(desc(strategyExecutionEvents.sequence))
    .limit(1);
  const now = new Date();
  await db.insert(strategyExecutionEvents).values({
    traceId,
    strategyId,
    sequence: (latest?.sequence ?? 0) + 1,
    eventType,
    stage,
    outcome,
    message,
    detailJson: JSON.stringify(detail),
    eventAt: now,
    createdAt: now,
  });
}
