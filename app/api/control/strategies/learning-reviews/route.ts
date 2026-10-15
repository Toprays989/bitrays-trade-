import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  strategies,
  strategyConfigValidations,
  strategyExecutionTraces,
  strategyLearningCycles,
  strategyLearningReviews,
  strategyParameterSuggestions,
} from "../../../../../db/schema";
import { buildNexusConfigValidation } from "../../../../../lib/nexus-config-validation";
import { promoteNexusConfigValidation } from "../../../../../lib/nexus-config-validation-runtime";
import {
  addStrategyLearningCapabilityReview,
  buildStrategyLearningReviewAttribution,
  buildStrategyLearningExperience,
  learningReviewReadiness,
  numberArray,
  type StrategyLearningReviewDecision,
  type StrategyLearningReviewItem,
  type StrategyLearningReviewSummary,
} from "../../../../../lib/strategy-learning-review";
import { isResponse, requirePermission } from "../../shared";

export const dynamic = "force-dynamic";

const LEARNING_REVIEW_PAGE_SIZE = 40;
const LEARNING_REVIEW_MAX_PAGE_SIZE = 100;

type LearningReviewFilter =
  | "READY"
  | "CONFIRMED"
  | "NOISE"
  | "DEFERRED"
  | "ALL";

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const url = new URL(request.url);
  const strategyId = Number(url.searchParams.get("strategyId"));
  if (!Number.isSafeInteger(strategyId) || strategyId < 1)
    return Response.json({ error: "策略编号无效" }, { status: 400 });
  const filter = learningReviewFilter(url.searchParams.get("filter"));
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, 100_000);
  const limit = boundedInteger(
    url.searchParams.get("limit"),
    LEARNING_REVIEW_PAGE_SIZE,
    1,
    LEARNING_REVIEW_MAX_PAGE_SIZE,
  );
  const db = getDb();
  const [strategy] = await db
    .select()
    .from(strategies)
    .where(and(
      eq(strategies.id, strategyId),
      user.dataScope === "ALL"
        ? undefined
        : eq(strategies.ownerEmail, user.email),
    ))
    .limit(1);
  if (!strategy)
    return Response.json({ error: "策略不存在或无权访问" }, { status: 404 });

  const reviewReadyCondition = sql`(
    json_extract(${strategyLearningCycles.detailJson}, '$.fastLearning.status') IN ('LEARNED', 'PARTIAL')
    OR (
      ${strategyLearningCycles.eligibility} = 'ELIGIBLE'
      AND ${strategyLearningCycles.exactNetAvailable} = 1
    )
  )`;
  const reviewFilterCondition = filter === "READY"
    ? and(
        isNull(strategyLearningReviews.id),
        reviewReadyCondition,
      )
    : filter === "ALL"
      ? undefined
      : eq(strategyLearningReviews.decision, filter);
  const [pageKeys, suggestions, suggestionSummaryRows, cycleSummaryRows, reviewSummaryRows, validationCycles, validationRows] = await Promise.all([
    db
      .select({ learningKey: strategyLearningCycles.learningKey })
      .from(strategyLearningCycles)
      .leftJoin(
        strategyLearningReviews,
        eq(
          strategyLearningCycles.learningKey,
          strategyLearningReviews.learningKey,
        ),
      )
      .where(and(
        eq(strategyLearningCycles.strategyId, strategy.id),
        eq(strategyLearningCycles.terminalStatus, "CLOSED"),
        reviewFilterCondition,
      ))
      .orderBy(
        desc(strategyLearningCycles.updatedAt),
        desc(strategyLearningCycles.id),
      )
      .limit(limit + 1)
      .offset(offset),
    db
      .select()
      .from(strategyParameterSuggestions)
      .where(eq(strategyParameterSuggestions.strategyId, strategy.id))
      .orderBy(desc(strategyParameterSuggestions.createdAt))
      .limit(100),
    db
      .select({ pending: sql<number>`COUNT(*)` })
      .from(strategyParameterSuggestions)
      .where(and(
        eq(strategyParameterSuggestions.strategyId, strategy.id),
        eq(strategyParameterSuggestions.configVersion, strategy.configVersion),
        eq(strategyParameterSuggestions.status, "PENDING"),
      )),
    db
      .select({
        total: sql<number>`COUNT(*)`,
        readyForReview: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.id} IS NULL AND ${reviewReadyCondition} THEN 1 ELSE 0 END), 0)`,
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
        eq(strategyLearningCycles.strategyId, strategy.id),
        eq(strategyLearningCycles.terminalStatus, "CLOSED"),
      )),
    db
      .select({
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
      .where(eq(strategyLearningReviews.strategyId, strategy.id)),
    db
      .select()
      .from(strategyLearningCycles)
      .where(and(
        eq(strategyLearningCycles.strategyId, strategy.id),
        eq(strategyLearningCycles.terminalStatus, "CLOSED"),
      ))
      .orderBy(desc(strategyLearningCycles.updatedAt))
      .limit(240),
    db
      .select()
      .from(strategyConfigValidations)
      .where(eq(strategyConfigValidations.strategyId, strategy.id))
      .orderBy(desc(strategyConfigValidations.updatedAt))
      .limit(1),
  ]);
  const hasMore = pageKeys.length > limit;
  const learningKeys = pageKeys.slice(0, limit).map((row) => row.learningKey);
  const [cycleRows, reviews] = learningKeys.length
    ? await Promise.all([
        db
          .select()
          .from(strategyLearningCycles)
          .where(inArray(strategyLearningCycles.learningKey, learningKeys)),
        db
          .select()
          .from(strategyLearningReviews)
          .where(inArray(strategyLearningReviews.learningKey, learningKeys)),
      ])
    : [[], []];
  const cycleMap = new Map(
    cycleRows.map((cycle) => [cycle.learningKey, cycle]),
  );
  const cycles = learningKeys.flatMap((learningKey) => {
    const cycle = cycleMap.get(learningKey);
    return cycle ? [cycle] : [];
  });
  const traceIds = [...new Set(cycles.map((cycle) => cycle.traceId))];
  const traces = traceIds.length
    ? await db
        .select({
          traceId: strategyExecutionTraces.traceId,
          symbol: strategyExecutionTraces.symbol,
          triggerKind: strategyExecutionTraces.triggerKind,
          triggerVersion: strategyExecutionTraces.triggerVersion,
          entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
        })
        .from(strategyExecutionTraces)
        .where(and(
          eq(strategyExecutionTraces.ownerEmail, strategy.ownerEmail),
          inArray(strategyExecutionTraces.traceId, traceIds),
        ))
    : [];
  const traceMap = new Map(traces.map((trace) => [trace.traceId, trace]));
  const reviewMap = new Map(
    reviews.map((review) => [review.learningKey, review]),
  );
  const items = cycles.map((cycle) =>
    serializeLearningReviewItem(
      cycle,
      reviewMap.get(cycle.learningKey) ?? null,
      traceMap.get(cycle.traceId) ?? null,
      suggestions.filter((suggestion) =>
        suggestion.configVersion === cycle.configVersion
      ),
    )
  );
  const cycleSummary = cycleSummaryRows[0];
  const reviewSummary = reviewSummaryRows[0];
  const exactNetExperiences = Number(reviewSummary?.exactNetExperiences ?? 0);
  const wins = Number(reviewSummary?.wins ?? 0);
  const capability = {
    promotedExperiences: Number(reviewSummary?.promotedExperiences ?? 0),
    exactNetExperiences,
    wins,
    losses: Number(reviewSummary?.losses ?? 0),
    breakeven: Number(reviewSummary?.breakeven ?? 0),
    exactNetPnlUsdt: Number(reviewSummary?.exactNetPnlUsdt ?? 0),
    exactNetWinRatePercent: exactNetExperiences
      ? (wins / exactNetExperiences) * 100
      : null,
  };
  const summary: StrategyLearningReviewSummary = {
    readyForReview: Number(cycleSummary?.readyForReview ?? 0),
    feesPending: Number(cycleSummary?.feesPending ?? 0),
    confirmed: Number(reviewSummary?.confirmed ?? 0),
    provisional: Number(reviewSummary?.provisional ?? 0),
    noise: Number(reviewSummary?.noise ?? 0),
    deferred: Number(reviewSummary?.deferred ?? 0),
    pendingSuggestions: Number(suggestionSummaryRows[0]?.pending ?? 0),
    capability,
  };
  const validationRecord = validationRows[0] ?? null;
  const validationMetadata = safeRecord(
    validationRecord?.evaluationJson ?? "{}",
  );
  const calculatedConfigValidation = buildNexusConfigValidation({
    configVersion:
      validationRecord?.candidateVersion ?? strategy.configVersion,
    sourceConfigVersion: validationRecord?.baselineVersion ?? null,
    suggestions: suggestions.map((suggestion) => ({
      id: suggestion.id,
      status: suggestion.status,
      evidenceJson: suggestion.evidenceJson,
    })),
    cycles: validationCycles.map((cycle) => ({
      configVersion: cycle.configVersion,
      terminalStatus: cycle.terminalStatus,
      exactNetAvailable: cycle.exactNetAvailable,
      exactNetPnlUsdt: cycle.exactNetPnlUsdt,
      eligibility: cycle.eligibility,
      manualIntervention: cycle.manualIntervention,
      updatedAtMs: cycle.updatedAt.getTime(),
    })),
    directCandidate:
      validationMetadata.candidateKind === "LIQUIDATION_FACTOR_MODE",
  });
  const terminalValidationStatus = validationRecord &&
      ["PROMOTED", "ROLLED_BACK"].includes(validationRecord.status)
    ? validationRecord.status as "PROMOTED" | "ROLLED_BACK"
    : null;
  const configValidation = {
    ...calculatedConfigValidation,
    ...(terminalValidationStatus ? { status: terminalValidationStatus } : {}),
    operatorConfirmed:
      safeRecord(validationMetadata.operatorConfirmation).status ===
        "CONFIRMED_TO_SMALL_LIVE_VALIDATION",
    lastEvaluatedAt: validationRecord?.lastEvaluatedAt ?? null,
  };
  return Response.json({
    strategy: {
      id: strategy.id,
      name: strategy.name,
      brainKey: strategy.brainKey,
      configVersion: strategy.configVersion,
    },
    summary,
    items,
    page: {
      filter,
      offset,
      limit,
      hasMore,
      total: learningReviewFilterTotal(filter, summary, cycleSummary?.total),
    },
    suggestions: suggestions
      .filter((suggestion) => suggestion.configVersion === strategy.configVersion)
      .map((suggestion) => ({
        id: suggestion.id,
        parameterName: suggestion.parameterName,
        status: suggestion.status,
        sampleCount: suggestion.sampleCount,
        currentValue: safeJsonValue(suggestion.currentValueJson),
        suggestedValue: safeJsonValue(suggestion.suggestedValueJson),
        evidence: safeRecord(suggestion.evidenceJson),
        reviewedAt: suggestion.reviewedAt,
      })),
    configValidation,
    boundaries: {
      automaticTerminalAbsorption: true,
      operatorReviewBlocksFastLearning: false,
      reviewChangesLiveOrders: false,
      automaticPromotionAllowed: false,
      automaticDeteriorationRollbackAllowed: true,
      oldPositionsKeepBoundVersionOnRollback: true,
    },
  });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  let body: {
    strategyId?: number;
    learningKey?: string;
    action?: StrategyLearningReviewDecision;
    comment?: string;
  } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "学习确认请求格式无效" }, { status: 400 });
  }
  const strategyId = Number(body.strategyId);
  const learningKey = String(body.learningKey ?? "").trim();
  const action = body.action;
  const comment = String(body.comment ?? "").trim().slice(0, 500) || null;
  if (!Number.isSafeInteger(strategyId) || strategyId < 1 || !learningKey)
    return Response.json({ error: "学习样本定位无效" }, { status: 400 });
  if (!action || !["CONFIRMED", "NOISE", "DEFERRED"].includes(action))
    return Response.json({ error: "学习复核操作无效" }, { status: 400 });

  const db = getDb();
  const [[strategy], [cycle], [existing]] = await Promise.all([
    db
      .select()
      .from(strategies)
      .where(and(
        eq(strategies.id, strategyId),
        user.dataScope === "ALL"
          ? undefined
          : eq(strategies.ownerEmail, user.email),
      ))
      .limit(1),
    db
      .select()
      .from(strategyLearningCycles)
      .where(and(
        eq(strategyLearningCycles.strategyId, strategyId),
        eq(strategyLearningCycles.learningKey, learningKey),
      ))
      .limit(1),
    db
      .select()
      .from(strategyLearningReviews)
      .where(eq(strategyLearningReviews.learningKey, learningKey))
      .limit(1),
  ]);
  if (!strategy || !cycle)
    return Response.json({ error: "学习样本不存在或无权访问" }, { status: 404 });
  const readiness = learningReviewReadiness(cycle);
  if (!readiness.ready)
    return Response.json(
      { error: "该样本尚未吸收止盈止损终局，暂不能人工复核" },
      { status: 409 },
    );
  if (
    existing && existing.decision !== "DEFERRED" &&
    existing.decision !== action
  )
    return Response.json(
      { error: "该样本已经形成不可变复核结论，不能改写" },
      { status: 409 },
    );

  const [capabilityBeforeRow] = await db
    .select({
      promotedExperiences: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.promotionStatus} IN ('PROVISIONAL', 'PROMOTED') THEN 1 ELSE 0 END), 0)`,
      exactNetExperiences: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 THEN 1 ELSE 0 END), 0)`,
      wins: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 AND ${strategyLearningReviews.outcome} = 'WIN' THEN 1 ELSE 0 END), 0)`,
      losses: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 AND ${strategyLearningReviews.outcome} = 'LOSS' THEN 1 ELSE 0 END), 0)`,
      breakeven: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 AND ${strategyLearningReviews.outcome} = 'BREAKEVEN' THEN 1 ELSE 0 END), 0)`,
      exactNetPnlUsdt: sql<number>`COALESCE(SUM(CASE WHEN ${strategyLearningReviews.decision} = 'CONFIRMED' AND ${strategyLearningReviews.exactNetAvailable} = 1 THEN ${strategyLearningReviews.exactNetPnlUsdt} ELSE 0 END), 0)`,
    })
    .from(strategyLearningReviews)
    .where(and(
      eq(strategyLearningReviews.brainKey, cycle.brainKey),
      eq(strategyLearningReviews.configVersion, cycle.configVersion),
      sql`${strategyLearningReviews.learningKey} <> ${learningKey}`,
    ));
  const exactNetExperiences = Number(
    capabilityBeforeRow?.exactNetExperiences ?? 0,
  );
  const winsBefore = Number(capabilityBeforeRow?.wins ?? 0);
  const capabilityBefore = {
    promotedExperiences: Number(
      capabilityBeforeRow?.promotedExperiences ?? 0,
    ),
    exactNetExperiences,
    wins: winsBefore,
    losses: Number(capabilityBeforeRow?.losses ?? 0),
    breakeven: Number(capabilityBeforeRow?.breakeven ?? 0),
    exactNetPnlUsdt: Number(capabilityBeforeRow?.exactNetPnlUsdt ?? 0),
    exactNetWinRatePercent: exactNetExperiences
      ? (winsBefore / exactNetExperiences) * 100
      : null,
  };
  const built = buildStrategyLearningExperience({
    learningKey: cycle.learningKey,
    strategyId: cycle.strategyId,
    brainKey: cycle.brainKey,
    configVersion: cycle.configVersion,
    traceId: cycle.traceId,
    orderSource: cycle.orderSource,
    terminalStatus: cycle.terminalStatus,
    exactNetAvailable: cycle.exactNetAvailable,
    exactNetPnlUsdt: cycle.exactNetPnlUsdt,
    preTradeFactsComplete: cycle.preTradeFactsComplete,
    observedCheckpointMinutes: numberArray(
      safeArray(cycle.checkpointMinutesJson),
    ),
    detailJson: cycle.detailJson,
    sampleUpdatedAt: cycle.updatedAt,
  });
  const promotionStatus = action === "CONFIRMED"
    ? cycle.exactNetAvailable
      ? "PROMOTED" as const
      : "PROVISIONAL" as const
    : action === "NOISE"
      ? "IGNORED" as const
      : "DEFERRED" as const;
  const memoryVersion = action === "CONFIRMED"
    ? existing?.memoryVersion ?? cycle.id
    : null;
  const candidateMetric = {
    decision: action,
    promotionStatus,
    exactNetAvailable: cycle.exactNetAvailable,
    exactNetPnlUsdt: cycle.exactNetPnlUsdt,
    outcome: built.outcome,
  };
  const capabilityAfter = addStrategyLearningCapabilityReview(
    capabilityBefore,
    candidateMetric,
  );
  const now = new Date();
  await db
    .insert(strategyLearningReviews)
    .values({
      learningKey,
      strategyId: cycle.strategyId,
      brainKey: cycle.brainKey,
      configVersion: cycle.configVersion,
      traceId: cycle.traceId,
      decision: action,
      promotionStatus,
      memoryVersion,
      sampleUpdatedAt: cycle.updatedAt,
      exactNetAvailable: cycle.exactNetAvailable,
      exactNetPnlUsdt: cycle.exactNetAvailable
        ? cycle.exactNetPnlUsdt
        : null,
      outcome: built.outcome,
      evidenceComplete: built.evidenceComplete,
      reviewComment: comment,
      reviewedBy: user.email,
      experienceJson: action === "CONFIRMED"
        ? JSON.stringify(built.experience)
        : "{}",
      capabilityBeforeJson: JSON.stringify(capabilityBefore),
      capabilityAfterJson: JSON.stringify(capabilityAfter),
      reviewedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: strategyLearningReviews.learningKey,
      set: {
        decision: action,
        promotionStatus,
        memoryVersion,
        sampleUpdatedAt: cycle.updatedAt,
        exactNetAvailable: cycle.exactNetAvailable,
        exactNetPnlUsdt: cycle.exactNetAvailable
          ? cycle.exactNetPnlUsdt
          : null,
        outcome: built.outcome,
        evidenceComplete: built.evidenceComplete,
        reviewComment: comment,
        reviewedBy: user.email,
        experienceJson: action === "CONFIRMED"
          ? JSON.stringify(built.experience)
          : "{}",
        capabilityBeforeJson: JSON.stringify(capabilityBefore),
        capabilityAfterJson: JSON.stringify(capabilityAfter),
        reviewedAt: now,
        updatedAt: now,
      },
    });
  const [saved] = await db
    .select()
    .from(strategyLearningReviews)
    .where(eq(strategyLearningReviews.learningKey, learningKey))
    .limit(1);
  return Response.json({
    review: saved,
    capability: capabilityAfter,
    message: action === "CONFIRMED"
      ? cycle.exactNetAvailable
        ? `大脑经验版本 #${memoryVersion} 已形成，等待同类样本验证能力变化`
        : `大脑经验版本 #${memoryVersion} 已形成；精确费用补齐后自动升级同一经验`
      : action === "NOISE"
        ? "样本已标记为噪音，只保留事实，不参与经验晋级"
        : "样本已暂缓，终局事实仍保留在大脑观察记忆中",
    boundaries: {
      orderAffecting: false,
      automaticConfigMutationAllowed: false,
    },
  });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  let body: {
    strategyId?: number;
    candidateVersion?: number;
    action?: "PROMOTE_VALIDATED_CONFIG";
    confirmation?: string;
  } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "候选版本操作格式无效" }, { status: 400 });
  }
  const strategyId = Number(body.strategyId);
  const candidateVersion = Number(body.candidateVersion);
  if (
    !Number.isSafeInteger(strategyId) ||
    strategyId < 1 ||
    !Number.isSafeInteger(candidateVersion) ||
    candidateVersion < 1 ||
    body.action !== "PROMOTE_VALIDATED_CONFIG" ||
    body.confirmation !== "PROMOTE_VALIDATED_CONFIG"
  )
    return Response.json(
      { error: "候选版本晋升确认信息无效" },
      { status: 400 },
    );
  const [strategy] = await getDb()
    .select({ ownerEmail: strategies.ownerEmail })
    .from(strategies)
    .where(and(
      eq(strategies.id, strategyId),
      user.dataScope === "ALL"
        ? undefined
        : eq(strategies.ownerEmail, user.email),
    ))
    .limit(1);
  if (!strategy)
    return Response.json(
      { error: "策略不存在或无权访问" },
      { status: 404 },
    );
  const result = await promoteNexusConfigValidation({
    strategyId,
    candidateVersion,
    ownerEmail: strategy.ownerEmail,
    reviewedBy: user.email,
  });
  if (!result.ok)
    return Response.json({ error: result.error }, { status: 409 });
  return Response.json({
    promoted: true,
    validation: result.row,
    message:
      `候选版本 V${candidateVersion} 已由人工确认晋升为稳定基线；后续经验继续按新基线独立学习。`,
  });
}

function serializeLearningReviewItem(
  cycle: typeof strategyLearningCycles.$inferSelect,
  review: typeof strategyLearningReviews.$inferSelect | null,
  trace: {
    symbol: string;
    triggerKind: string;
    triggerVersion: string;
    entryEvidenceJson: string;
  } | null,
  suggestions: Array<typeof strategyParameterSuggestions.$inferSelect>,
): StrategyLearningReviewItem {
  const built = buildStrategyLearningExperience({
    learningKey: cycle.learningKey,
    strategyId: cycle.strategyId,
    brainKey: cycle.brainKey,
    configVersion: cycle.configVersion,
    traceId: cycle.traceId,
    orderSource: cycle.orderSource,
    terminalStatus: cycle.terminalStatus,
    exactNetAvailable: cycle.exactNetAvailable,
    exactNetPnlUsdt: cycle.exactNetPnlUsdt,
    preTradeFactsComplete: cycle.preTradeFactsComplete,
    observedCheckpointMinutes: numberArray(
      safeArray(cycle.checkpointMinutesJson),
    ),
    detailJson: cycle.detailJson,
    sampleUpdatedAt: cycle.updatedAt,
  });
  const experience = built.experience;
  return {
    learningKey: cycle.learningKey,
    strategyId: cycle.strategyId,
    brainKey: cycle.brainKey,
    configVersion: cycle.configVersion,
    traceId: cycle.traceId,
    symbol: trace?.symbol ?? experience.symbol,
    direction: experience.direction,
    orderSource: cycle.orderSource,
    terminalStatus: cycle.terminalStatus,
    eligibility: cycle.eligibility,
    exactNetAvailable: cycle.exactNetAvailable,
    exactNetPnlUsdt: cycle.exactNetPnlUsdt,
    observedPnlUsdt: experience.observedPnlUsdt,
    outcome: built.outcome,
    evidenceComplete: built.evidenceComplete,
    fastLearningStatus: experience.fastLearningStatus,
    timingAttribution: experience.timingAttribution,
    observedCheckpointMinutes: experience.observedCheckpointMinutes,
    requiredCheckpointMinutes: experience.requiredCheckpointMinutes,
    missingCheckpointMinutes: experience.missingCheckpointMinutes,
    exitReasons: experience.exitReasons,
    holdingDurationMinutes: experience.holdingDurationMinutes,
    mfeRoePercent: experience.mfeRoePercent,
    maeRoePercent: experience.maeRoePercent,
    summary: experience.summary,
    attribution: buildStrategyLearningReviewAttribution({
      detailJson: cycle.detailJson,
      entryEvidenceJson: trace?.entryEvidenceJson ?? null,
      triggerKind: trace?.triggerKind ?? null,
      triggerVersion: trace?.triggerVersion ?? null,
      observedCheckpointMinutes: experience.observedCheckpointMinutes,
      evidenceComplete: built.evidenceComplete,
      exactNetAvailable: cycle.exactNetAvailable,
      eligibility: cycle.eligibility,
      parameterSuggestions: suggestions.map((suggestion) => ({
        parameterName: suggestion.parameterName,
        status: suggestion.status,
        sampleCount: suggestion.sampleCount,
        evidenceJson: suggestion.evidenceJson,
      })),
    }),
    reviewReady: learningReviewReadiness(cycle).ready,
    updatedAt: cycle.updatedAt.toISOString(),
    review: review
      ? {
          decision: review.decision,
          promotionStatus: review.promotionStatus,
          memoryVersion: review.memoryVersion,
          reviewComment: review.reviewComment,
          reviewedBy: review.reviewedBy,
          reviewedAt: review.reviewedAt.toISOString(),
          sampleUpdatedAt: review.sampleUpdatedAt.toISOString(),
          needsSettlementRefresh:
            review.decision === "CONFIRMED" &&
            review.sampleUpdatedAt.getTime() < cycle.updatedAt.getTime(),
        }
      : null,
  };
}

function learningReviewFilter(value: string | null): LearningReviewFilter {
  return value === "CONFIRMED" || value === "NOISE" || value === "DEFERRED" ||
      value === "ALL"
    ? value
    : "READY";
}

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
}

function learningReviewFilterTotal(
  filter: LearningReviewFilter,
  summary: StrategyLearningReviewSummary,
  total: number | null | undefined,
) {
  if (filter === "READY") return summary.readyForReview;
  if (filter === "CONFIRMED") return summary.confirmed;
  if (filter === "NOISE") return summary.noise;
  if (filter === "DEFERRED") return summary.deferred;
  return Number(total ?? 0);
}

function safeRecord(value: string | unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeJsonValue(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function safeArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
