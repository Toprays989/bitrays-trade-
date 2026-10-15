import { and, desc, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  contractSymbols,
  livePositionAdditionEvidence,
  livePositionAdditions,
  liveOrderEvents,
  livePositions,
  strategies,
  strategyConfigValidations,
  strategyConfigVersions,
  strategyExecutionEvents,
  strategyExecutionEventRollups,
  strategyExecutionTraces,
  strategyLearningCycles,
  strategyLearningReviews,
  strategyParameterSuggestions,
  strategyPositionEvidence,
  tradingAccounts,
} from "../../../../db/schema";
import {
  resolveLiquidationTrendConfig,
  validateLiquidationNetProfitPath,
} from "../../../../lib/liquidation-trend-config";
import {
  STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION,
  strategyParameterProfileError,
} from "../../../../lib/strategy-default-parameters";
import {
  createBrainKey,
  NEXUS_PRODUCTION_BRAIN_TEMPLATE,
  nexusBrainDisplayName,
  normalizeBrainCustomName,
  requireNexusBrainKey,
} from "../../../../lib/nexus-brain-identity";
import {
  hasUnpublishedNexusBrainDraft,
  nextNexusBrainDraftVersion,
} from "../../../../lib/nexus-brain-versioning";
import { calculateAutomatedDailyMarginQuota } from "../../../../lib/automated-order-capacity.mjs";
import {
  attributedOrderInitialMargin,
  attributedPositionUnrealizedPnl,
} from "../../../../lib/strategy-order-attribution";
import { chinaTradingDayWindow } from "../../../../lib/trading-calendar";
import {
  ensureMainTradingAccount,
  isResponse,
  requirePermission,
  writeAudit,
} from "../shared";
import {
  CONTROL_STRATEGY_TYPES,
  isCreatableControlStrategyType,
  isControlStrategyType,
} from "../../../../lib/control-strategy-types";
import {
  ACTIVE_LIVE_ORDER_STATUSES,
  ACTIVE_STRATEGY_EXECUTION_STATES,
  findStrategyDeletionBlocker,
} from "../../../../lib/strategy-deletion-guard";
import {
  acceptedSuggestionEvidence,
  manualCandidateConfirmation,
  suggestionMatchesDraftConfig,
  validateFreshCandidateSuggestions,
} from "../../../../lib/nexus-suggestion-contract";
import {
  type StrategyLearningReviewSummary,
} from "../../../../lib/strategy-learning-review";
import {
  evaluateLiquidationFactorLearning,
  type LiquidationFactorLearningSummary,
} from "../../../../lib/liquidation-factor-learning";
import { normalizeLiquidationFactorPolicy } from "../../../../lib/liquidation-derived-factors";
import { strategyEntryFundingConfigurationError } from "../../../../lib/strategy-entry-funding-coherence";
import {
  SIMPLE_REBOUND_CONFIG,
  validateSimpleReboundConfig,
} from "../../../../lib/simple-rebound-config";

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const [rows, versions] = await Promise.all([
    getDb()
      .select()
      .from(strategies)
      .where(
        and(
          eq(strategies.ownerEmail, user.email),
          inArray(strategies.strategyType, [...CONTROL_STRATEGY_TYPES]),
        ),
      )
      .orderBy(desc(strategies.updatedAt))
      .limit(50),
    getDb().select().from(strategyConfigVersions).where(eq(strategyConfigVersions.ownerEmail, user.email)).orderBy(desc(strategyConfigVersions.createdAt)).limit(500),
  ]);
  const strategyIds = rows.map((row) => row.id);
  const {
    startedAt: dayStartedAt,
    nextStartedAt: dailyMarginResetAt,
  } = chinaTradingDayWindow();
  const [traceRows, positionRows, dailyOrderRows] = strategyIds.length
    ? await Promise.all([
        getDb()
          .select({
            id: strategyExecutionTraces.id,
            strategyId: strategyExecutionTraces.strategyId,
            positionId: strategyExecutionTraces.positionId,
          })
          .from(strategyExecutionTraces)
          .where(
            and(
              eq(strategyExecutionTraces.ownerEmail, user.email),
              inArray(strategyExecutionTraces.strategyId, strategyIds),
              or(
                gte(strategyExecutionTraces.createdAt, dayStartedAt),
                inArray(strategyExecutionTraces.state, [
                  "POSITION_OPEN",
                  "TRAILING_ARMED",
                  "TRAILING_ACTIVE",
                  "EXIT_PENDING",
                  "EXECUTION_UNKNOWN",
                ]),
              ),
            ),
          ),
        getDb()
          .select({
            id: livePositions.id,
            positionSide: livePositions.positionSide,
            quantity: livePositions.quantity,
            entryPrice: livePositions.entryPrice,
            markPrice: livePositions.markPrice,
          })
          .from(livePositions)
          .where(
            and(
              eq(livePositions.ownerEmail, user.email),
              inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
            ),
          ),
        getDb()
          .select({
            clientOrderId: liveOrderEvents.clientOrderId,
            estimatedNotional: liveOrderEvents.estimatedNotional,
            responseJson: liveOrderEvents.responseJson,
          })
          .from(liveOrderEvents)
          .where(
            and(
              eq(liveOrderEvents.ownerEmail, user.email),
              eq(liveOrderEvents.testOnly, false),
              gte(liveOrderEvents.createdAt, dayStartedAt),
              inArray(liveOrderEvents.status, [
                "PENDING",
                "NEW",
                "PARTIALLY_FILLED",
                "SUBMITTED",
                "FILLED",
                "EXECUTION_UNKNOWN",
              ]),
            ),
          ),
      ])
    : [[], [], []];
  const [learningCycleRows, learningReviewRows, pendingSuggestionRows] =
    strategyIds.length
      ? await Promise.all([
          getDb()
            .select({
              strategyId: strategyLearningCycles.strategyId,
              readyForReview: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.id} IS NULL AND json_extract(${strategyLearningCycles.detailJson}, '$.fastLearning.status') IN ('LEARNED', 'PARTIAL') THEN 1 ELSE 0 END), 0)`,
              feesPending: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningCycles.exactNetAvailable} = 0 THEN 1 ELSE 0 END), 0)`,
            })
            .from(strategyLearningCycles)
            .leftJoin(
              strategyLearningReviews,
              eq(
                strategyLearningCycles.learningKey,
                strategyLearningReviews.learningKey,
              ),
            )
            .where(and(
              inArray(strategyLearningCycles.strategyId, strategyIds),
              eq(strategyLearningCycles.terminalStatus, "CLOSED"),
            ))
            .groupBy(strategyLearningCycles.strategyId),
          getDb()
            .select({
              strategyId: strategyLearningReviews.strategyId,
              confirmed: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' THEN 1 ELSE 0 END), 0)`,
              provisional: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.promotionStatus} = 'PROVISIONAL' THEN 1 ELSE 0 END), 0)`,
              noise: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'NOISE' THEN 1 ELSE 0 END), 0)`,
              deferred: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'DEFERRED' THEN 1 ELSE 0 END), 0)`,
              promotedExperiences: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.promotionStatus} IN ('PROVISIONAL', 'PROMOTED') THEN 1 ELSE 0 END), 0)`,
              exactNetExperiences: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 THEN 1 ELSE 0 END), 0)`,
              wins: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 AND ${strategyLearningReviews.outcome} = 'WIN' THEN 1 ELSE 0 END), 0)`,
              losses: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 AND ${strategyLearningReviews.outcome} = 'LOSS' THEN 1 ELSE 0 END), 0)`,
              breakeven: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 AND ${strategyLearningReviews.outcome} = 'BREAKEVEN' THEN 1 ELSE 0 END), 0)`,
              exactNetPnlUsdt: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 THEN ${strategyLearningReviews.exactNetPnlUsdt} ELSE 0 END), 0)`,
            })
            .from(strategyLearningReviews)
            .where(inArray(strategyLearningReviews.strategyId, strategyIds))
            .groupBy(strategyLearningReviews.strategyId),
          getDb()
            .select({
              strategyId: strategyParameterSuggestions.strategyId,
              configVersion: strategyParameterSuggestions.configVersion,
            })
            .from(strategyParameterSuggestions)
            .where(and(
              inArray(strategyParameterSuggestions.strategyId, strategyIds),
              eq(strategyParameterSuggestions.status, "PENDING"),
            )),
        ])
      : [[], [], []];
  const [factorObservationRows, factorCycleRows, factorValidationRows] =
    strategyIds.length
      ? await Promise.all([
          getDb()
            .select({
              strategyId: strategyExecutionEventRollups.strategyId,
              configVersion: strategyExecutionEventRollups.configVersion,
              traceId: strategyExecutionEventRollups.traceId,
              eventType: strategyExecutionEventRollups.eventType,
              observedAt: strategyExecutionEventRollups.lastEventAt,
            })
            .from(strategyExecutionEventRollups)
            .where(and(
              inArray(strategyExecutionEventRollups.strategyId, strategyIds),
              eq(strategyExecutionEventRollups.ownerEmail, user.email),
              like(
                strategyExecutionEventRollups.eventType,
                "NEXUS_LIQUIDATION_FACTORS:%",
              ),
            ))
            .orderBy(desc(strategyExecutionEventRollups.lastEventAt))
            .limit(10_000),
          getDb()
            .select({
              strategyId: strategyLearningCycles.strategyId,
              configVersion: strategyLearningCycles.configVersion,
              traceId: strategyLearningCycles.traceId,
              terminalStatus: strategyLearningCycles.terminalStatus,
              exactNetAvailable: strategyLearningCycles.exactNetAvailable,
              exactNetPnlUsdt: strategyLearningCycles.exactNetPnlUsdt,
              eligibility: strategyLearningCycles.eligibility,
              manualIntervention: strategyLearningCycles.manualIntervention,
              updatedAt: strategyLearningCycles.updatedAt,
            })
            .from(strategyLearningCycles)
            .where(and(
              inArray(strategyLearningCycles.strategyId, strategyIds),
              eq(strategyLearningCycles.terminalStatus, "CLOSED"),
            ))
            .orderBy(desc(strategyLearningCycles.updatedAt))
            .limit(10_000),
          getDb()
            .select({
              strategyId: strategyConfigValidations.strategyId,
              candidateVersion: strategyConfigValidations.candidateVersion,
              baselineVersion: strategyConfigValidations.baselineVersion,
              status: strategyConfigValidations.status,
              updatedAt: strategyConfigValidations.updatedAt,
            })
            .from(strategyConfigValidations)
            .where(inArray(strategyConfigValidations.strategyId, strategyIds))
            .orderBy(desc(strategyConfigValidations.updatedAt))
            .limit(500),
        ])
      : [[], [], []];
  const learningSummaryByStrategy = new Map<
    number,
    StrategyLearningReviewSummary
  >();
  for (const row of rows) {
    const cycles = learningCycleRows.find(
      (cycle) => cycle.strategyId === row.id,
    );
    const reviews = learningReviewRows.find(
      (review) => review.strategyId === row.id,
    );
    const exactNetExperiences = Number(reviews?.exactNetExperiences ?? 0);
    const wins = Number(reviews?.wins ?? 0);
    learningSummaryByStrategy.set(row.id, {
      readyForReview: Number(cycles?.readyForReview ?? 0),
      feesPending: Number(cycles?.feesPending ?? 0),
      confirmed: Number(reviews?.confirmed ?? 0),
      provisional: Number(reviews?.provisional ?? 0),
      noise: Number(reviews?.noise ?? 0),
      deferred: Number(reviews?.deferred ?? 0),
      pendingSuggestions: pendingSuggestionRows.filter(
        (suggestion) =>
          suggestion.strategyId === row.id &&
          suggestion.configVersion === row.configVersion,
      ).length,
      capability: {
        promotedExperiences: Number(reviews?.promotedExperiences ?? 0),
        exactNetExperiences,
        wins,
        losses: Number(reviews?.losses ?? 0),
        breakeven: Number(reviews?.breakeven ?? 0),
        exactNetPnlUsdt: Number(reviews?.exactNetPnlUsdt ?? 0),
        exactNetWinRatePercent: exactNetExperiences
          ? (wins / exactNetExperiences) * 100
          : null,
      },
    });
  }
  const liquidationFactorLearningByStrategy = new Map<
    number,
    LiquidationFactorLearningSummary
  >();
  for (const row of rows) {
    const resolved = resolveLiquidationTrendConfig(safeParse(row.configJson));
    if (!resolved.config) continue;
    if (
      resolved.config.trigger.kind !== "LIQUIDATION_WINDOW" &&
      resolved.config.trigger.kind !==
        "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
    ) continue;
    const policy = normalizeLiquidationFactorPolicy(
      resolved.config.liquidationFactors,
      {
        minimumEvents: resolved.config.trigger.minClusterEvents ?? 3,
        minimumAmountUsdt:
          resolved.config.trigger.minLiquidationNotionalUsdt,
        observationWindowSeconds:
          resolved.config.trigger.maxClusterSpanSeconds ?? 120,
        minimumVolumeRatio: resolved.config.trend.volumeRatio3m,
      },
    );
    const latestValidation = factorValidationRows.find(
      (validation) =>
        validation.strategyId === row.id &&
        (validation.candidateVersion === row.configVersion ||
          validation.baselineVersion === row.configVersion),
    );
    liquidationFactorLearningByStrategy.set(
      row.id,
      evaluateLiquidationFactorLearning({
        mode: policy.mode,
        automaticModeSwitch: policy.automaticModeSwitch,
        configVersion: row.configVersion,
        targetEpisodes: policy.learningTargetEpisodes,
        minimumExactCycles: policy.learningMinimumExactCycles,
        observations: factorObservationRows
          .filter(
            (observation) =>
              observation.strategyId === row.id &&
              observation.configVersion === row.configVersion,
          )
          .map((observation) => ({
            traceId: observation.traceId,
            verdict: observation.eventType.slice(
              "NEXUS_LIQUIDATION_FACTORS:".length,
            ),
            observedAtMs: observation.observedAt.getTime(),
          })),
        cycles: factorCycleRows
          .filter(
            (cycle) =>
              cycle.strategyId === row.id &&
              cycle.configVersion === row.configVersion,
          )
          .map((cycle) => ({
            traceId: cycle.traceId,
            terminalStatus: cycle.terminalStatus,
            exactNetAvailable: cycle.exactNetAvailable,
            exactNetPnlUsdt: cycle.exactNetPnlUsdt,
            eligibility: cycle.eligibility,
            manualIntervention: cycle.manualIntervention,
            updatedAtMs: cycle.updatedAt.getTime(),
          })),
        hasUnpublishedDraft: hasUnpublishedNexusBrainDraft(row),
        validationStatus: latestValidation?.status ?? null,
      }),
    );
  }
  const runtimeMarginByStrategy = new Map<
    number,
    {
      quota: ReturnType<typeof calculateAutomatedDailyMarginQuota>;
      nextResetAt: Date;
    }
  >();
  for (const row of rows) {
    if (!isControlStrategyType(row.strategyType)) continue;
    const resolved = resolveLiquidationTrendConfig(safeParse(row.configJson));
    if (!resolved.config) continue;
    const config = resolved.config;
    const ownedTraces = traceRows.filter((trace) => trace.strategyId === row.id);
    const ownedPositionIds = ownedTraces
      .map((trace) => Number(trace.positionId))
      .filter((positionId) => Number.isSafeInteger(positionId) && positionId > 0);
    runtimeMarginByStrategy.set(
      row.id,
      {
        quota: calculateAutomatedDailyMarginQuota({
          usedMarginUsdt: attributedOrderInitialMargin(
            dailyOrderRows,
            ownedTraces.map((trace) => trace.id),
            config.execution.leverage,
          ),
          limitMarginUsdt: config.execution.maxDailyNotionalUsdt,
          unrealizedPnlUsdt: attributedPositionUnrealizedPnl(
            positionRows,
            ownedPositionIds,
          ),
        }),
        nextResetAt: dailyMarginResetAt,
      },
    );
  }
  return Response.json({
    strategies: rows.map((row) =>
      serializeStrategy(
        row,
        runtimeMarginByStrategy.get(row.id),
        learningSummaryByStrategy.get(row.id),
        liquidationFactorLearningByStrategy.get(row.id),
      ),
    ),
    versions: versions.map((version) => ({
      ...version,
      config: safeParse(version.configJson),
    })),
  });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const payload = await request.json() as {
    strategyId?: number;
    expectedConfigVersion?: number;
    expectedDraftVersion?: number;
    accountId?: string;
    name?: string;
    strategyType?: "LIQ_CHASE" | "SENTINEL" | "SIMPLE_REBOUND";
    symbolScope?: string;
    config?: unknown;
    acceptedSuggestionIds?: number[];
    clientParameterProfileVersion?: string;
  };
  if (
    payload.clientParameterProfileVersion !==
      STRATEGY_DEFAULT_PARAMETER_PROFILE_VERSION
  )
    return Response.json(
      { error: "策略参数页面版本已过期，请刷新页面后重新配置" },
      { status: 409 },
    );
  const customName = normalizeBrainCustomName(payload.name);
  if (!customName)
    return Response.json({ error: "策略名称不能为空" }, { status: 400 });
  if (!payload.strategyType || !payload.symbolScope?.trim()) return Response.json({ error: "策略参数不完整" }, { status: 400 });
  if (!(["LIQ_CHASE", "SENTINEL", "SIMPLE_REBOUND"] as const).includes(payload.strategyType))
    return Response.json(
      { error: "仅支持统一 NEXUS 大脑模板" },
      { status: 410 },
    );
  const effectiveStrategyType = payload.strategyType;
  if (
    !Number.isInteger(payload.strategyId) &&
    !isCreatableControlStrategyType(effectiveStrategyType)
  )
    return Response.json(
      { error: "哨兵已升级为全局观察事实层，不再创建独立哨兵策略" },
      { status: 410 },
    );
  let storedConfig = payload.config ?? {};
  let storedScope = payload.symbolScope.trim();
  await ensureMainTradingAccount(user);
  const accountId = payload.accountId?.trim().toLowerCase() || user.accountId;
  const [tradingAccount] = await getDb().select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, accountId))).limit(1);
  if (!tradingAccount?.isActive) return Response.json({ error: "策略运行账户不存在或已停用" }, { status: 409 });
  if (tradingAccount.accountType === "MAIN") return Response.json({ error: "主账户不参与交易策略，请选择子账户" }, { status: 403 });
  if (effectiveStrategyType === "SIMPLE_REBOUND") {
    if (payload.config !== undefined && !validateSimpleReboundConfig(payload.config))
      return Response.json({ error: "Simple Rebound 配置必须使用固定策略参数" }, { status: 400 });
    storedConfig = { ...SIMPLE_REBOUND_CONFIG, triggerKind: "SIMPLE_REBOUND" };
    storedScope = "TOP_VOLUME_30";
  } else if (["LIQ_CHASE", "SENTINEL"].includes(effectiveStrategyType)) {
    const resolved = resolveLiquidationTrendConfig(payload.config);
    if (!resolved.config)
      return Response.json({ error: resolved.error }, { status: 400 });
    const config = resolved.config;
    const fundingConfigurationError = strategyEntryFundingConfigurationError({
      leverage: config.execution.leverage,
      minimumPositionNotionalUsdt:
        config.execution.minimumPositionNotionalUsdt ?? 15,
      maxOrderMarginUsdt: config.execution.maxOrderNotionalUsdt,
    });
    if (fundingConfigurationError)
      return Response.json({ error: fundingConfigurationError }, { status: 400 });
    const parameterProfileError = strategyParameterProfileError(
      config,
      config.trigger.kind!,
    );
    if (parameterProfileError)
      return Response.json({ error: parameterProfileError }, { status: 409 });
    const profitPathError = validateLiquidationNetProfitPath(config);
    if (profitPathError)
      return Response.json({ error: profitPathError }, { status: 400 });
    const activeSymbolCheck = await checkActiveContractSymbols(
      config.selectedSymbols,
    );
    if (!activeSymbolCheck.ok)
      return Response.json(
        { error: activeSymbolCheck.error },
        { status: 503 },
      );
    if (activeSymbolCheck.missing.length)
      return Response.json(
        {
          error: inactiveContractMessage(
            "策略包含已停用或不在系统合约池中的合约",
            activeSymbolCheck.missing,
          ),
        },
        { status: 409 },
      );
    storedConfig = config;
    storedScope = config.selectedSymbols.join(",") || "POOL";
  }
  const db = getDb();
  const [existing] = Number.isInteger(payload.strategyId)
    ? await db
        .select()
        .from(strategies)
        .where(
          and(
            eq(strategies.id, payload.strategyId!),
            eq(strategies.ownerEmail, user.email),
          ),
        )
        .limit(1)
    : [];
  if (existing) {
    if (
      Number.isInteger(payload.expectedDraftVersion) &&
      existing.draftVersion !== payload.expectedDraftVersion
    )
      return Response.json(
        { error: "策略草稿已被其他页面更新，请刷新后重新修改" },
        { status: 409 },
      );
    if (
      !Number.isInteger(payload.expectedDraftVersion) &&
      Number.isInteger(payload.expectedConfigVersion) &&
      existing.configVersion !== payload.expectedConfigVersion
    )
      return Response.json(
        { error: "策略参数已被其他页面更新，请刷新后重新修改" },
        { status: 409 },
      );
    if (existing.strategyType !== effectiveStrategyType)
      return Response.json(
        { error: "该记录尚未完成 NEXUS 大脑迁移，请刷新后重试" },
        { status: 409 },
      );
    const [nameConflict] = await db
      .select({ id: strategies.id })
      .from(strategies)
      .where(
        and(
          eq(strategies.ownerEmail, user.email),
          eq(strategies.strategyType, effectiveStrategyType),
          or(
            eq(strategies.name, customName),
            eq(strategies.draftName, customName),
          ),
        ),
      )
      .limit(1);
    if (nameConflict && nameConflict.id !== existing.id)
      return Response.json(
        { error: "策略名称已存在，请使用其他名称" },
        { status: 409 },
      );
    const now = new Date();
    const nextVersion = nextNexusBrainDraftVersion(existing);
    const brainKey = requireNexusBrainKey(existing.brainKey);
    const requestedSuggestionIds = [
      ...new Set(
        (payload.acceptedSuggestionIds ?? []).filter(
          (id) => Number.isInteger(id) && id > 0,
        ),
      ),
    ].slice(0, 20);
    const acceptedSuggestions = requestedSuggestionIds.length
      ? await db
          .select()
          .from(strategyParameterSuggestions)
          .where(
            and(
              eq(strategyParameterSuggestions.strategyId, existing.id),
              eq(
                strategyParameterSuggestions.configVersion,
                existing.configVersion,
              ),
              eq(strategyParameterSuggestions.status, "PENDING"),
              inArray(strategyParameterSuggestions.id, requestedSuggestionIds),
            ),
          )
      : [];
    if (acceptedSuggestions.length !== requestedSuggestionIds.length)
      return Response.json(
        { error: "学习建议已变化，请重新打开运行日志后再带入草稿" },
        { status: 409 },
      );
    if (acceptedSuggestions.length > 1)
      return Response.json(
        { error: "每个候选版本只允许验证一个参数；请只带入一条学习建议" },
        { status: 409 },
      );
    for (const suggestion of acceptedSuggestions) {
      const evidence = safeParse(suggestion.evidenceJson) as Record<string, unknown>;
      if (
        evidence.proposalMode !== "DRAFT_ONLY" ||
        evidence.automaticPublishAllowed !== false ||
        evidence.learningEligible !== true ||
        !suggestionMatchesDraftConfig({
          parameterName: suggestion.parameterName,
          suggestedValue: safeParse(suggestion.suggestedValueJson),
          draftConfig: storedConfig,
        })
      )
        return Response.json(
          { error: "草稿参数与学习建议不一致，已阻止错误归因" },
          { status: 409 },
        );
    }
    const [strategy] = await db
      .update(strategies)
      .set({
        brainKey,
        draftAccountId: accountId,
        draftName: customName,
        draftSymbolScope: storedScope,
        draftConfigJson: JSON.stringify(storedConfig),
        draftVersion: nextVersion,
        draftUpdatedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(strategies.id, existing.id),
          eq(strategies.ownerEmail, user.email),
          eq(strategies.draftVersion, existing.draftVersion),
        ),
      )
      .returning();
    if (!strategy)
      return Response.json(
        { error: "策略草稿已被其他请求更新，请刷新后重试" },
        { status: 409 },
      );
    await db.batch([
      db
        .update(strategyConfigVersions)
        .set({ lifecycle: "RETIRED" })
        .where(
          and(
            eq(strategyConfigVersions.strategyId, strategy.id),
            eq(strategyConfigVersions.ownerEmail, user.email),
            eq(strategyConfigVersions.lifecycle, "DRAFT"),
          ),
        ),
      db.insert(strategyConfigVersions).values({ strategyId: strategy.id, ownerEmail: user.email, accountId, version: nextVersion, sourceVersion: existing.publishedVersion > 0 ? existing.publishedVersion : null, lifecycle: "DRAFT", strategyType: effectiveStrategyType, symbolScope: storedScope, configJson: JSON.stringify(storedConfig), createdAt: now }),
      ...acceptedSuggestions.map((suggestion) =>
        db
          .update(strategyParameterSuggestions)
          .set({
            status: "ACCEPTED",
            reviewedAt: now,
            evidenceJson: JSON.stringify(
              acceptedSuggestionEvidence({
                currentEvidence: safeParse(suggestion.evidenceJson),
                suggestionId: suggestion.id,
                sourceConfigVersion: existing.configVersion,
                targetDraftVersion: nextVersion,
                reviewerEmail: user.email,
                reviewedAt: now,
              }),
            ),
          })
          .where(eq(strategyParameterSuggestions.id, suggestion.id)),
      ),
    ]);
    await writeAudit(user, "SAVE_STRATEGY_DRAFT", "strategy", String(strategy.id), { name: customName, accountId, draftVersion: nextVersion, publishedVersion: strategy.publishedVersion, acceptedSuggestionIds: acceptedSuggestions.map((suggestion) => suggestion.id), validationMode: acceptedSuggestions.length ? "SMALL_LIVE_SAMPLE" : null });
    return Response.json({
      strategy: serializeStrategy(strategy),
      updated: true,
      activated: false,
      draftSaved: true,
    });
  }
  if (Number.isInteger(payload.strategyId))
    return Response.json({ error: "要修改的策略不存在" }, { status: 404 });
  const [nameConflict] = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(
      and(
          eq(strategies.ownerEmail, user.email),
          eq(strategies.strategyType, effectiveStrategyType),
          or(
            eq(strategies.name, customName),
            eq(strategies.draftName, customName),
          ),
      ),
    )
    .limit(1);
  if (nameConflict)
    return Response.json(
      { error: "策略名称已存在；请从策略列表打开原策略后修改" },
      { status: 409 },
    );
  const now = new Date();
  const [strategy] = await db
    .insert(strategies)
    .values({
      brainKey: createBrainKey(),
      ownerEmail: user.email,
      accountId,
      name: customName,
      brainTemplate: NEXUS_PRODUCTION_BRAIN_TEMPLATE,
      runtimeMode: "SHADOW",
      strategyType: effectiveStrategyType,
      symbolScope: storedScope,
      configJson: "{}",
      configVersion: 0,
      publishedVersion: 0,
      draftName: customName,
      draftAccountId: accountId,
      draftSymbolScope: storedScope,
      draftConfigJson: JSON.stringify(storedConfig),
      draftVersion: 1,
      draftUpdatedAt: now,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await db.insert(strategyConfigVersions).values({ strategyId: strategy.id, ownerEmail: user.email, accountId, version: 1, lifecycle: "DRAFT", strategyType: effectiveStrategyType, symbolScope: storedScope, configJson: JSON.stringify(storedConfig), createdAt: now });
  await writeAudit(user, "CREATE_STRATEGY_DRAFT", "strategy", String(strategy.id), { name: customName, accountId, draftVersion: 1, status: "DRAFT" });
  return Response.json(
    {
      strategy: serializeStrategy(strategy),
      activated: false,
      draftSaved: true,
    },
    { status: 201 },
  );
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const payload = await request.json() as { id?: number; action?: "PUBLISH_DRAFT"; expectedDraftVersion?: number; status?: "RUNNING" | "PAUSED"; rollbackVersion?: number; confirmation?: string; versionMetadata?: { version?: number; versionLabel?: string; note?: string; isBaseline?: boolean } };
  if (!Number.isInteger(payload.id) || (!payload.action && !payload.status && !Number.isInteger(payload.rollbackVersion) && !payload.versionMetadata)) return Response.json({ error: "无效的策略状态请求" }, { status: 400 });
  const db = getDb();
  const [current] = await db.select().from(strategies).where(and(eq(strategies.id, payload.id!), eq(strategies.ownerEmail, user.email))).limit(1);
  if (!current) return Response.json({ error: "策略不存在" }, { status: 404 });
  if (payload.action === "PUBLISH_DRAFT") {
    if (
      Number.isInteger(payload.expectedDraftVersion) &&
      payload.expectedDraftVersion !== current.draftVersion
    )
      return Response.json(
        { error: "策略草稿已变化，请刷新后重新发布" },
        { status: 409 },
      );
    if (
      current.draftVersion <= current.publishedVersion ||
      !current.draftName?.trim() ||
      !current.draftAccountId?.trim() ||
      !current.draftSymbolScope?.trim() ||
      !current.draftConfigJson
    )
      return Response.json(
        { error: "没有可发布的新草稿" },
        { status: 409 },
      );
    const [draftSnapshot] = await db
      .select()
      .from(strategyConfigVersions)
      .where(
        and(
          eq(strategyConfigVersions.strategyId, current.id),
          eq(strategyConfigVersions.ownerEmail, user.email),
          eq(strategyConfigVersions.version, current.draftVersion),
          eq(strategyConfigVersions.lifecycle, "DRAFT"),
        ),
      )
      .limit(1);
    if (!draftSnapshot)
      return Response.json(
        { error: "草稿版本快照不存在，禁止发布" },
        { status: 409 },
      );
    const [account] = await db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.ownerEmail, user.email),
          eq(tradingAccounts.accountId, current.draftAccountId),
        ),
      )
      .limit(1);
    if (!account?.isActive || account.accountType === "MAIN")
      return Response.json(
        { error: "草稿绑定的交易子账户不存在或已停用" },
        { status: 409 },
      );
    if (current.strategyType === "SIMPLE_REBOUND") {
      const fixedConfig = safeParse(current.draftConfigJson);
      if (!validateSimpleReboundConfig(fixedConfig))
        return Response.json(
          { error: "Simple Rebound 草稿必须使用固定策略参数" },
          { status: 409 },
        );
      const now = new Date();
      const normalizedDraftConfig = JSON.stringify({
        ...SIMPLE_REBOUND_CONFIG,
        triggerKind: "SIMPLE_REBOUND",
      });
      await db.batch([
        db
          .update(strategyConfigVersions)
          .set({ lifecycle: "RETIRED" })
          .where(
            and(
              eq(strategyConfigVersions.strategyId, current.id),
              eq(strategyConfigVersions.ownerEmail, user.email),
              eq(strategyConfigVersions.lifecycle, "PUBLISHED"),
            ),
          ),
        db
          .update(strategyConfigVersions)
          .set({
            lifecycle: "PUBLISHED",
            symbolScope: "TOP_VOLUME_30",
            configJson: normalizedDraftConfig,
          })
          .where(eq(strategyConfigVersions.id, draftSnapshot.id)),
        db
          .update(strategies)
          .set({
            accountId: current.draftAccountId,
            name: current.draftName,
            strategyType: "SIMPLE_REBOUND",
            brainTemplate: NEXUS_PRODUCTION_BRAIN_TEMPLATE,
            symbolScope: "TOP_VOLUME_30",
            configJson: normalizedDraftConfig,
            configVersion: current.draftVersion,
            publishedVersion: current.draftVersion,
            runtimeMode: "LIVE",
            status:
              current.status === "DRAFT" || current.status === "READY"
                ? "RUNNING"
                : current.status,
            updatedAt: now,
          })
          .where(
            and(
              eq(strategies.id, current.id),
              eq(strategies.ownerEmail, user.email),
              eq(strategies.draftVersion, current.draftVersion),
              eq(strategies.publishedVersion, current.publishedVersion),
            ),
          ),
      ]);
      const [strategy] = await db
        .select()
        .from(strategies)
        .where(
          and(
            eq(strategies.id, current.id),
            eq(strategies.ownerEmail, user.email),
          ),
        )
        .limit(1);
      if (!strategy || strategy.publishedVersion !== current.draftVersion)
        return Response.json(
          { error: "Simple Rebound 草稿发布发生并发冲突，请刷新核对" },
          { status: 409 },
        );
      await writeAudit(
        user,
        "PUBLISH_STRATEGY_DRAFT",
        "strategy",
        String(strategy.id),
        {
          brainKey: strategy.brainKey,
          fromVersion: current.publishedVersion,
          publishedVersion: strategy.publishedVersion,
          strategyType: "SIMPLE_REBOUND",
        },
      );
      return Response.json({
        strategy: serializeStrategy(strategy),
        published: true,
        activated: true,
      });
    }
    const draftConfig = resolveLiquidationTrendConfig(
      safeParse(current.draftConfigJson),
    );
    if (!draftConfig.config)
      return Response.json(
        { error: `策略草稿参数无效：${draftConfig.error}` },
        { status: 409 },
      );
    const draftParameterProfileError = strategyParameterProfileError(
      draftConfig.config,
      draftConfig.config.trigger.kind!,
    );
    if (draftParameterProfileError)
      return Response.json(
        { error: `策略草稿不能发布：${draftParameterProfileError}` },
        { status: 409 },
      );
    const draftFundingConfigurationError =
      strategyEntryFundingConfigurationError({
        leverage: draftConfig.config.execution.leverage,
        minimumPositionNotionalUsdt:
          draftConfig.config.execution.minimumPositionNotionalUsdt ?? 15,
        maxOrderMarginUsdt:
          draftConfig.config.execution.maxOrderNotionalUsdt,
      });
    if (draftFundingConfigurationError)
      return Response.json(
        { error: `策略草稿不能发布：${draftFundingConfigurationError}` },
        { status: 409 },
      );
    const profitPathError = validateLiquidationNetProfitPath(draftConfig.config);
    if (profitPathError)
      return Response.json(
        { error: `策略草稿不能发布：${profitPathError}` },
        { status: 409 },
      );
    const activeSymbolCheck = await checkActiveContractSymbols(
      draftConfig.config.selectedSymbols,
    );
    if (!activeSymbolCheck.ok)
      return Response.json(
        { error: activeSymbolCheck.error },
        { status: 503 },
      );
    if (activeSymbolCheck.missing.length)
      return Response.json(
        {
          error: inactiveContractMessage(
            "策略草稿包含已停用合约，不能发布",
            activeSymbolCheck.missing,
          ),
        },
        { status: 409 },
      );
    const [draftAccount] = await db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.ownerEmail, user.email),
          eq(tradingAccounts.accountId, current.draftAccountId),
        ),
      )
      .limit(1);
    if (!draftAccount || draftAccount.accountType === "MAIN")
      return Response.json(
        { error: "策略草稿绑定的交易子账户不存在" },
        { status: 409 },
      );
    const normalizedDraftConfig = draftConfig.config;
    const normalizedDraftConfigJson = JSON.stringify(normalizedDraftConfig);
    const normalizedDraftSymbolScope =
      normalizedDraftConfig.selectedSymbols.join(",") || "POOL";
    const strategyDailyLossLimitUsdt =
      normalizedDraftConfig.risk.dailyLossLimitUsdt;
    const validationSuggestions = await db
      .select({
        id: strategyParameterSuggestions.id,
        status: strategyParameterSuggestions.status,
        configVersion: strategyParameterSuggestions.configVersion,
        parameterName: strategyParameterSuggestions.parameterName,
        suggestedValueJson: strategyParameterSuggestions.suggestedValueJson,
        evidenceJson: strategyParameterSuggestions.evidenceJson,
        reviewedAt: strategyParameterSuggestions.reviewedAt,
      })
      .from(strategyParameterSuggestions)
      .where(and(
        eq(strategyParameterSuggestions.strategyId, current.id),
        eq(strategyParameterSuggestions.status, "ACCEPTED"),
      ))
      .orderBy(desc(strategyParameterSuggestions.reviewedAt))
      .limit(100);
    const candidateSuggestionIds = validationSuggestions
      .filter((suggestion) =>
        Number(
          (safeParse(suggestion.evidenceJson) as Record<string, unknown>)
            .targetDraftVersion,
        ) === current.draftVersion
      )
      .map((suggestion) => suggestion.id);
    const publishedConfig = resolveLiquidationTrendConfig(
      safeParse(current.configJson),
    ).config;
    const liquidationFactorModeTransitionToLive =
      publishedConfig?.liquidationFactors?.mode !== "LIVE" &&
      normalizedDraftConfig.liquidationFactors?.mode === "LIVE";
    const baselineVersion =
      draftSnapshot.sourceVersion ?? current.publishedVersion;
    const now = new Date();
    const candidateSuggestionValidation = validateFreshCandidateSuggestions({
      baselineVersion,
      candidateVersion: current.draftVersion,
      draftUpdatedAt: current.draftUpdatedAt,
      draftConfig: normalizedDraftConfig,
      suggestions: validationSuggestions.filter((suggestion) =>
        candidateSuggestionIds.includes(suggestion.id)
      ),
    });
    if (!candidateSuggestionValidation.ok)
      return Response.json(
        { error: candidateSuggestionValidation.error },
        { status: 409 },
      );
    const operatorConfirmation =
      candidateSuggestionValidation.confirmation ??
      (liquidationFactorModeTransitionToLive && baselineVersion > 0
        ? manualCandidateConfirmation({
            confirmedBy: user.email,
            confirmedAt: now,
            baselineVersion,
            candidateVersion: current.draftVersion,
          })
        : null);
    const candidateKind = liquidationFactorModeTransitionToLive
      ? "LIQUIDATION_FACTOR_MODE"
      : candidateSuggestionIds.length
        ? "PARAMETER_SUGGESTION"
        : null;
    const candidateEvaluationMetadata = candidateKind && operatorConfirmation
      ? JSON.stringify({
          candidateKind,
          automaticPromotionAllowed: false,
          automaticDeteriorationRollbackAllowed: true,
          operatorConfirmation,
        })
      : "{}";
    await db.batch([
      db
        .update(strategyConfigVersions)
        .set({ lifecycle: "RETIRED" })
        .where(
          and(
            eq(strategyConfigVersions.strategyId, current.id),
            eq(strategyConfigVersions.ownerEmail, user.email),
            eq(strategyConfigVersions.lifecycle, "PUBLISHED"),
          ),
        ),
      db
        .update(strategyConfigVersions)
        .set({
          lifecycle: "PUBLISHED",
          symbolScope: normalizedDraftSymbolScope,
          configJson: normalizedDraftConfigJson,
        })
        .where(eq(strategyConfigVersions.id, draftSnapshot.id)),
      db
        .update(strategies)
        .set({
          accountId: current.draftAccountId,
          name: current.draftName,
          strategyType: draftSnapshot.strategyType,
          brainTemplate: NEXUS_PRODUCTION_BRAIN_TEMPLATE,
          symbolScope: normalizedDraftSymbolScope,
          configJson: normalizedDraftConfigJson,
          configVersion: current.draftVersion,
          publishedVersion: current.draftVersion,
          runtimeMode: "LIVE",
          status:
            current.status === "DRAFT" ||
            current.status === "READY"
              ? "RUNNING"
              : current.status,
          updatedAt: now,
        })
        .where(
          and(
            eq(strategies.id, current.id),
            eq(strategies.ownerEmail, user.email),
            eq(strategies.draftVersion, current.draftVersion),
            eq(strategies.publishedVersion, current.publishedVersion),
          ),
        ),
      ...((candidateSuggestionIds.length ||
          liquidationFactorModeTransitionToLive) && baselineVersion > 0
        ? [
            db
              .insert(strategyConfigValidations)
              .values({
                strategyId: current.id,
                ownerEmail: user.email,
                brainKey: requireNexusBrainKey(current.brainKey),
                candidateVersion: current.draftVersion,
                baselineVersion,
                suggestionIdsJson: JSON.stringify(candidateSuggestionIds),
                status: "COLLECTING",
                evaluationJson: candidateEvaluationMetadata,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [
                  strategyConfigValidations.strategyId,
                  strategyConfigValidations.candidateVersion,
                ],
                set: {
                  baselineVersion,
                  suggestionIdsJson: JSON.stringify(candidateSuggestionIds),
                  status: "COLLECTING",
                  evaluationJson: candidateEvaluationMetadata,
                  lastEvaluatedAt: null,
                  resolvedBy: null,
                  resolvedAt: null,
                  updatedAt: now,
                },
              }),
          ]
        : []),
    ]);
    const [strategy] = await db
      .select()
      .from(strategies)
      .where(
        and(
          eq(strategies.id, current.id),
          eq(strategies.ownerEmail, user.email),
        ),
      )
      .limit(1);
    if (!strategy || strategy.publishedVersion !== current.draftVersion)
      return Response.json(
        { error: "草稿发布发生并发冲突，请刷新核对" },
        { status: 409 },
      );
    await writeAudit(
      user,
      "PUBLISH_STRATEGY_DRAFT",
      "strategy",
      String(strategy.id),
      {
        brainKey: strategy.brainKey,
        fromVersion: current.publishedVersion,
        publishedVersion: strategy.publishedVersion,
        oldPositionsKeepBoundVersion: true,
        strategyDailyLossLimitUsdt,
      },
    );
    return Response.json({
      strategy: serializeStrategy(strategy),
      published: true,
      activated: true,
      strategyRisk: {
        dailyLossLimitUsdt: strategyDailyLossLimitUsdt,
      },
    });
  }
  if (payload.versionMetadata) {
    const metadata = payload.versionMetadata;
    if (!Number.isInteger(metadata.version)) return Response.json({ error: "策略版本无效" }, { status: 400 });
    const versionLabel = metadata.versionLabel?.trim() || null;
    const note = metadata.note?.trim() || null;
    if (versionLabel && versionLabel.length > 40) return Response.json({ error: "版本标签不能超过 40 个字符" }, { status: 400 });
    if (note && note.length > 200) return Response.json({ error: "版本备注不能超过 200 个字符" }, { status: 400 });
    const [snapshot] = await db.select().from(strategyConfigVersions).where(and(eq(strategyConfigVersions.strategyId, current.id), eq(strategyConfigVersions.ownerEmail, user.email), eq(strategyConfigVersions.version, metadata.version!))).limit(1);
    if (!snapshot) return Response.json({ error: "目标参数版本不存在" }, { status: 404 });
    if (metadata.isBaseline) await db.update(strategyConfigVersions).set({ isBaseline: false }).where(and(eq(strategyConfigVersions.strategyId, current.id), eq(strategyConfigVersions.ownerEmail, user.email)));
    const [version] = await db.update(strategyConfigVersions).set({ versionLabel, note, isBaseline: Boolean(metadata.isBaseline) }).where(and(eq(strategyConfigVersions.id, snapshot.id), eq(strategyConfigVersions.ownerEmail, user.email))).returning();
    await writeAudit(user, "ANNOTATE_STRATEGY_CONFIG_VERSION", "strategy", String(current.id), { version: version.version, versionLabel, note, isBaseline: version.isBaseline });
    return Response.json({ version: { ...version, config: safeParse(version.configJson) } });
  }
  if (Number.isInteger(payload.rollbackVersion)) {
    if (payload.confirmation !== "ROLLBACK_STRATEGY_CONFIG") return Response.json({ error: "策略回滚确认信息无效" }, { status: 400 });
    const [snapshot] = await db.select().from(strategyConfigVersions).where(and(eq(strategyConfigVersions.strategyId, current.id), eq(strategyConfigVersions.ownerEmail, user.email), eq(strategyConfigVersions.version, payload.rollbackVersion!))).limit(1);
    if (!snapshot) return Response.json({ error: "目标参数版本不存在" }, { status: 404 });
    if (
      snapshot.version === current.publishedVersion &&
      current.draftVersion <= current.publishedVersion
    )
      return Response.json(
        { error: "当前已经发布该参数版本" },
        { status: 409 },
      );
    const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, snapshot.accountId))).limit(1);
    if (!account?.isActive) return Response.json({ error: "历史版本绑定的策略账户不存在或已停用" }, { status: 409 });
    let rollbackConfigJson = snapshot.configJson;
    let rollbackSymbolScope = snapshot.symbolScope;
    if (!["LIQ_CHASE", "SENTINEL"].includes(snapshot.strategyType))
      return Response.json(
        { error: "旧策略模板已下线，不能回滚到旧模板版本" },
        { status: 409 },
      );
    if (["LIQ_CHASE", "SENTINEL"].includes(snapshot.strategyType)) {
      const snapshotConfig = resolveLiquidationTrendConfig(
        safeParse(snapshot.configJson),
        { allowHistoricalLeverage: true },
      );
      if (!snapshotConfig.config)
        return Response.json(
          { error: `历史爆仓策略参数已不符合当前规则：${snapshotConfig.error}` },
          { status: 409 },
        );
      const profitPathError = validateLiquidationNetProfitPath(snapshotConfig.config);
      if (profitPathError)
        return Response.json(
          { error: `历史爆仓策略缺少完整净获利路径：${profitPathError}` },
          { status: 409 },
        );
      const activeSymbolCheck = await checkActiveContractSymbols(
        snapshotConfig.config.selectedSymbols,
      );
      if (!activeSymbolCheck.ok)
        return Response.json(
          { error: activeSymbolCheck.error },
          { status: 503 },
        );
      if (activeSymbolCheck.missing.length)
        return Response.json(
          {
            error: inactiveContractMessage(
              "历史策略版本包含已停用合约，不能回滚",
              activeSymbolCheck.missing,
            ),
          },
          { status: 409 },
        );
      rollbackConfigJson = JSON.stringify(snapshotConfig.config);
      rollbackSymbolScope =
        snapshotConfig.config.selectedSymbols.join(",") || "POOL";
    }
    const nextVersion = nextNexusBrainDraftVersion(current);
    const now = new Date();
    const [strategy] = await db
      .update(strategies)
      .set({
        brainKey: requireNexusBrainKey(current.brainKey),
        draftAccountId: snapshot.accountId,
        draftName: current.draftName ?? current.name,
        draftSymbolScope: rollbackSymbolScope,
        draftConfigJson: rollbackConfigJson,
        draftVersion: nextVersion,
        draftUpdatedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(strategies.id, current.id),
          eq(strategies.ownerEmail, user.email),
          eq(strategies.draftVersion, current.draftVersion),
        ),
      )
      .returning();
    if (!strategy) return Response.json({ error: "策略草稿已变化，请刷新后重试" }, { status: 409 });
    await db.batch([
      db
        .update(strategyConfigVersions)
        .set({ lifecycle: "RETIRED" })
        .where(
          and(
            eq(strategyConfigVersions.strategyId, strategy.id),
            eq(strategyConfigVersions.ownerEmail, user.email),
            eq(strategyConfigVersions.lifecycle, "DRAFT"),
          ),
        ),
      db.insert(strategyConfigVersions).values({ strategyId: strategy.id, ownerEmail: user.email, accountId: snapshot.accountId, version: nextVersion, sourceVersion: snapshot.version, lifecycle: "DRAFT", strategyType: snapshot.strategyType, symbolScope: rollbackSymbolScope, configJson: rollbackConfigJson, createdAt: now }),
    ]);
    await writeAudit(user, "CREATE_STRATEGY_ROLLBACK_DRAFT", "strategy", String(strategy.id), { publishedVersion: current.publishedVersion, sourceVersion: snapshot.version, draftVersion: nextVersion, activationMode: "DRAFT_ONLY" });
    return Response.json({
      strategy: serializeStrategy(strategy),
      rolledBack: true,
      activated: false,
      draftSaved: true,
      sourceVersion: snapshot.version,
    });
  }
  if (!payload.status) return Response.json({ error: "无效的策略状态请求" }, { status: 400 });
  if (payload.status === "RUNNING") {
    if (current.strategyType === "SIMPLE_REBOUND")
      return Response.json(
        { error: "Simple Rebound 独立运行器尚未启用，请先完成本地验证" },
        { status: 409 },
      );
    const [account] = await db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, current.accountId))).limit(1);
    if (!account?.isActive) return Response.json({ error: "策略运行账户不存在或已停用" }, { status: 409 });
    if (["LIQ_CHASE", "SENTINEL"].includes(current.strategyType)) {
      const liquidationConfig = resolveLiquidationTrendConfig(
        safeParse(current.configJson),
      );
      if (!liquidationConfig.config)
        return Response.json(
          { error: `爆仓策略参数无效：${liquidationConfig.error}` },
          { status: 409 },
        );
      const profitPathError =
        validateLiquidationNetProfitPath(liquidationConfig.config);
      if (profitPathError)
        return Response.json(
          { error: `爆仓策略不能启用：${profitPathError}` },
          { status: 409 },
        );
    }
    if (!["LIQ_CHASE", "SENTINEL"].includes(current.strategyType))
      return Response.json(
        { error: "旧策略模板已下线，请先保存为统一爆仓策略" },
        { status: 409 },
      );
  }
  const statusChangedAt = new Date();
  const [strategy] = await db
    .update(strategies)
    .set({ status: payload.status, updatedAt: statusChangedAt })
    .where(
      and(
        eq(strategies.id, current.id),
        eq(strategies.ownerEmail, user.email),
      ),
    )
    .returning();
  await writeAudit(user, "CHANGE_STRATEGY_STATUS", "strategy", String(strategy.id), {
    status: strategy.status,
  });
  return Response.json({ strategy: serializeStrategy(strategy) });
}

export async function DELETE(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const payload = (await request.json()) as {
    id?: number;
    confirmation?: string;
  };
  if (!Number.isInteger(payload.id) || payload.id! < 1)
    return Response.json({ error: "策略编号无效" }, { status: 400 });
  if (payload.confirmation !== "DELETE_STRATEGY_AND_RELATED_RECORDS")
    return Response.json({ error: "策略删除确认信息无效" }, { status: 400 });

  const db = getDb();
  const [current] = await db
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, payload.id!), eq(strategies.ownerEmail, user.email)))
    .limit(1);
  if (!current) return Response.json({ error: "策略不存在" }, { status: 404 });

  const [versions, validations, traces, events, evidence, suggestions] =
    await Promise.all([
      db.select({ id: strategyConfigVersions.id }).from(strategyConfigVersions).where(eq(strategyConfigVersions.strategyId, current.id)),
      db.select({ id: strategyConfigValidations.id }).from(strategyConfigValidations).where(eq(strategyConfigValidations.strategyId, current.id)),
      db.select({
        id: strategyExecutionTraces.id,
        state: strategyExecutionTraces.state,
        symbol: strategyExecutionTraces.symbol,
        expiresAt: strategyExecutionTraces.expiresAt,
        exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
        positionId: strategyExecutionTraces.positionId,
      }).from(strategyExecutionTraces).where(eq(strategyExecutionTraces.strategyId, current.id)),
      db.select({ id: strategyExecutionEvents.id }).from(strategyExecutionEvents).where(eq(strategyExecutionEvents.strategyId, current.id)),
      db.select({ id: strategyPositionEvidence.id }).from(strategyPositionEvidence).where(eq(strategyPositionEvidence.strategyId, current.id)),
      db.select({ id: strategyParameterSuggestions.id }).from(strategyParameterSuggestions).where(eq(strategyParameterSuggestions.strategyId, current.id)),
    ]);
  const strategyPositionIds = [
    ...new Set(
      traces
        .map((trace) => Number(trace.positionId))
        .filter((positionId) => Number.isInteger(positionId) && positionId > 0),
    ),
  ];
  const [activePosition] = strategyPositionIds.length
    ? await db
        .select({
          id: livePositions.id,
          symbol: livePositions.symbol,
          side: livePositions.positionSide,
          status: livePositions.status,
        })
        .from(livePositions)
        .where(and(
          inArray(livePositions.id, strategyPositionIds),
          inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
        ))
        .limit(1)
    : [];
  const additionRows = strategyPositionIds.length
    ? await db
        .select({
          id: livePositionAdditions.id,
          status: livePositionAdditions.status,
        })
        .from(livePositionAdditions)
        .where(inArray(livePositionAdditions.positionId, strategyPositionIds))
    : [];
  const unresolvedAddition = additionRows.find((addition) =>
    ["PENDING", "EXECUTION_UNKNOWN"].includes(addition.status)
  );
  const activeTraceRows = traces.filter((trace) =>
    ACTIVE_STRATEGY_EXECUTION_STATES.includes(
      trace.state as (typeof ACTIVE_STRATEGY_EXECUTION_STATES)[number],
    ),
  );
  const exchangeOrderIds = [
    ...new Set(
      activeTraceRows
        .map((trace) => trace.exchangeOrderId)
        .filter((orderId): orderId is string => Boolean(orderId)),
    ),
  ];
  const [activeOrder] = exchangeOrderIds.length
    ? await db
        .select({
          id: liveOrderEvents.id,
          symbol: liveOrderEvents.symbol,
          status: liveOrderEvents.status,
        })
        .from(liveOrderEvents)
        .where(and(
          eq(liveOrderEvents.ownerEmail, user.email),
          inArray(liveOrderEvents.exchangeOrderId, exchangeOrderIds),
          inArray(liveOrderEvents.status, [...ACTIVE_LIVE_ORDER_STATUSES]),
        ))
        .limit(1)
    : [];
  const blocker = findStrategyDeletionBlocker({
    strategyStatus: current.status,
    traces: activeTraceRows,
    activePosition,
    hasUnresolvedAddition: Boolean(unresolvedAddition),
    activeOrder,
  });
  if (blocker?.kind === "POSITION")
    return Response.json(
      {
        error: `该策略仍管理 ${blocker.position.symbol} ${blocker.position.side} 实盘仓位（${blocker.position.status}），平仓并完成对账后才能删除。`,
        code: "STRATEGY_POSITION_OR_ADDITION_ACTIVE",
      },
      { status: 409 },
    );
  if (blocker?.kind === "ADDITION")
    return Response.json(
      {
        error: "该策略仍有关联的待对账补仓，完成委托对账后才能删除。",
        code: "STRATEGY_POSITION_OR_ADDITION_ACTIVE",
      },
      { status: 409 },
    );
  if (blocker?.kind === "ORDER")
    return Response.json(
      {
        error: `该策略仍有 ${blocker.order.symbol} 实盘委托（${blocker.order.status}），撤单并完成对账后才能删除。`,
        code: "STRATEGY_ORDER_ACTIVE",
      },
      { status: 409 },
    );
  if (blocker?.kind === "EXECUTION")
    return Response.json(
      {
        error: `该策略的 ${blocker.trace.symbol} 信号仍在 ${blocker.trace.state} 阶段；请先暂停策略，待本轮信号结束后再删除。`,
        code: "STRATEGY_EXECUTION_ACTIVE",
      },
      { status: 409 },
    );
  const additionIds = additionRows.map((addition) => addition.id);
  const additionEvidenceRows = additionIds.length
    ? await db
        .select({ id: livePositionAdditionEvidence.id })
        .from(livePositionAdditionEvidence)
        .where(inArray(livePositionAdditionEvidence.additionId, additionIds))
    : [];

  await db.batch([
    db.delete(strategyConfigValidations).where(eq(strategyConfigValidations.strategyId, current.id)),
    db.delete(strategyParameterSuggestions).where(eq(strategyParameterSuggestions.strategyId, current.id)),
    db.delete(strategyConfigVersions).where(eq(strategyConfigVersions.strategyId, current.id)),
    db.delete(strategies).where(
      and(eq(strategies.id, current.id), eq(strategies.ownerEmail, user.email)),
    ),
  ]);

  const purged = {
    versions: versions.length,
    configValidations: validations.length,
    parameterSuggestions: suggestions.length,
  };
  const retained = {
    positionAdditions: additionRows.length,
    executionTraces: traces.length,
    executionEvents: events.length,
    positionEvidence: evidence.length,
    positionAdditionEvidence: additionEvidenceRows.length,
    reason:
      "真实委托、仓位、执行轨迹、持仓证据和学习周期属于不可变生命周期账本；删除策略只移除可变配置和建议",
  };
  await writeAudit(user, "DELETE_STRATEGY_AND_RELATED_RECORDS", "strategy_deleted", String(current.id), {
    name: current.name,
    accountId: current.accountId,
    configVersion: current.configVersion,
    purged,
    retained,
  });
  return Response.json({
    deleted: true,
    strategyId: current.id,
    name: current.name,
    purged,
    retained,
  });
}

function safeParse(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    delete parsed.executionMode;
    return parsed;
  } catch { return {}; }
}

const CONTRACT_SYMBOL_QUERY_CHUNK_SIZE = 50;

async function checkActiveContractSymbols(symbols: string[]): Promise<
  | { ok: true; missing: string[] }
  | { ok: false; error: string }
> {
  const normalized = [
    ...new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!normalized.length) return { ok: true, missing: [] };
  const active = new Set<string>();
  try {
    // D1/SQLite environments may expose a much lower bind-variable ceiling
    // than desktop SQLite. Keep every query bounded so a full TradFi scope
    // cannot turn a valid publish into an unhandled HTTP 500.
    for (
      let offset = 0;
      offset < normalized.length;
      offset += CONTRACT_SYMBOL_QUERY_CHUNK_SIZE
    ) {
      const chunk = normalized.slice(
        offset,
        offset + CONTRACT_SYMBOL_QUERY_CHUNK_SIZE,
      );
      const rows = await getDb()
        .select({ symbol: contractSymbols.symbol })
        .from(contractSymbols)
        .where(
          and(
            eq(contractSymbols.isActive, true),
            inArray(contractSymbols.symbol, chunk),
          ),
        );
      for (const row of rows) active.add(row.symbol);
    }
  } catch {
    return {
      ok: false,
      error: "系统合约池校验暂不可用，请稍后重试；策略草稿已保留",
    };
  }
  return {
    ok: true,
    missing: normalized.filter((symbol) => !active.has(symbol)),
  };
}

function inactiveContractMessage(prefix: string, symbols: string[]) {
  const preview = symbols.slice(0, 5).join("、");
  const remaining = symbols.length - Math.min(symbols.length, 5);
  return `${prefix}：${preview}${remaining > 0 ? ` 等${symbols.length}个` : ""}`;
}

function serializeStrategy(
  row: typeof strategies.$inferSelect,
  runtimeMargin?: {
    quota: ReturnType<typeof calculateAutomatedDailyMarginQuota>;
    nextResetAt: Date;
  },
  learningReview?: StrategyLearningReviewSummary,
  liquidationFactorLearning?: LiquidationFactorLearningSummary,
) {
  const hasUnpublishedDraft = hasUnpublishedNexusBrainDraft(row);
  const draft = hasUnpublishedDraft
    ? {
        name: row.draftName ?? row.name,
        accountId: row.draftAccountId ?? row.accountId,
        symbolScope: row.draftSymbolScope ?? row.symbolScope,
        config: safeParse(row.draftConfigJson ?? "{}"),
        version: row.draftVersion,
        updatedAt: row.draftUpdatedAt,
      }
    : null;
  return {
    ...row,
    brainKey: requireNexusBrainKey(row.brainKey),
    displayName: nexusBrainDisplayName(row.name),
    publishedVersion: row.publishedVersion || row.configVersion,
    config: safeParse(row.configJson),
    draft,
    hasUnpublishedDraft,
    runtimeMargin: runtimeMargin
      ? {
          configuredMarginUsdt:
            runtimeMargin.quota.configuredLimitMarginUsdt,
          unrealizedPnlUsdt: runtimeMargin.quota.unrealizedPnlUsdt,
          dynamicMarginUsdt: runtimeMargin.quota.dynamicLimitMarginUsdt,
          usedMarginUsdt: runtimeMargin.quota.usedMarginUsdt,
          availableMarginUsdt: runtimeMargin.quota.remainingMarginUsdt,
          exhausted: runtimeMargin.quota.exhausted,
          enforced: false,
          nextResetAt: runtimeMargin.nextResetAt.toISOString(),
        }
      : null,
    learningReview: learningReview ?? null,
    liquidationFactorLearning: liquidationFactorLearning ?? null,
  };
}
