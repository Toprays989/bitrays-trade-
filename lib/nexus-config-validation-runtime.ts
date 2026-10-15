import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  auditEvents,
  strategies,
  strategyConfigValidations,
  strategyConfigVersions,
  strategyLearningCycles,
  strategyParameterSuggestions,
} from "../db/schema";
import { buildNexusConfigValidation } from "./nexus-config-validation";
import {
  candidateConfirmationMatches,
  manualCandidateConfirmation,
} from "./nexus-suggestion-contract";

export const NEXUS_CONFIG_ROLLBACK_ACTOR =
  "SYSTEM_DETERIORATION_GUARD" as const;
export async function reconcileNexusConfigValidation(input: {
  strategyId: number;
  candidateVersion: number;
}) {
  const db = getDb();
  const [validation] = await db
    .select()
    .from(strategyConfigValidations)
    .where(and(
      eq(strategyConfigValidations.strategyId, input.strategyId),
      eq(
        strategyConfigValidations.candidateVersion,
        input.candidateVersion,
      ),
    ))
    .limit(1);
  if (!validation) return null;
  if (["PROMOTED", "ROLLED_BACK", "RELEARNING"].includes(validation.status))
    return {
      row: validation,
      evaluation: safeRecord(validation.evaluationJson),
      changed: false,
    };
  const validationMetadata = safeRecord(validation.evaluationJson);
  const directCandidate =
    validationMetadata.candidateKind === "LIQUIDATION_FACTOR_MODE";
  const [suggestions, cycles] = await Promise.all([
    db
      .select()
      .from(strategyParameterSuggestions)
      .where(and(
        eq(strategyParameterSuggestions.strategyId, input.strategyId),
        inArray(
          strategyParameterSuggestions.id,
          queryablePositiveIntegerArray(validation.suggestionIdsJson),
        ),
      )),
    db
      .select({
        configVersion: strategyLearningCycles.configVersion,
        terminalStatus: strategyLearningCycles.terminalStatus,
        exactNetAvailable: strategyLearningCycles.exactNetAvailable,
        exactNetPnlUsdt: strategyLearningCycles.exactNetPnlUsdt,
        eligibility: strategyLearningCycles.eligibility,
        manualIntervention: strategyLearningCycles.manualIntervention,
        updatedAt: strategyLearningCycles.updatedAt,
      })
      .from(strategyLearningCycles)
      .where(and(
        eq(strategyLearningCycles.strategyId, input.strategyId),
        inArray(strategyLearningCycles.configVersion, [
          validation.candidateVersion,
          validation.baselineVersion,
        ]),
      ))
      .orderBy(asc(strategyLearningCycles.updatedAt)),
  ]);
  const evaluation = buildNexusConfigValidation({
    configVersion: validation.candidateVersion,
    sourceConfigVersion: validation.baselineVersion,
    suggestions: suggestions.map((suggestion) => ({
      id: suggestion.id,
      status: suggestion.status,
      evidenceJson: suggestion.evidenceJson,
    })),
    cycles: cycles.map((cycle) => ({
      configVersion: cycle.configVersion,
      terminalStatus: cycle.terminalStatus,
      exactNetAvailable: cycle.exactNetAvailable,
      exactNetPnlUsdt: cycle.exactNetPnlUsdt,
      eligibility: cycle.eligibility,
      manualIntervention: cycle.manualIntervention,
      updatedAtMs: cycle.updatedAt.getTime(),
    })),
    directCandidate,
  });
  const operatorConfirmation = resolveOperatorConfirmation({
    validation,
    metadata: validationMetadata,
    suggestions,
  });
  const persistedEvaluation = {
    ...validationMetadata,
    ...evaluation,
    ...(directCandidate
      ? { candidateKind: "LIQUIDATION_FACTOR_MODE" as const }
      : {}),
    automaticPromotionAllowed: false as const,
    automaticDeteriorationRollbackAllowed: true as const,
    ...(operatorConfirmation ? { operatorConfirmation } : {}),
  };
  const now = new Date();
  if (evaluation.status !== "ROLLBACK_REQUIRED") {
    const nextStatus = evaluation.status === "PROMOTION_READY"
      ? "PROMOTION_READY" as const
      : "COLLECTING" as const;
    const [row] = await db
      .update(strategyConfigValidations)
      .set({
        status: nextStatus,
        evaluationJson: JSON.stringify(persistedEvaluation),
        lastEvaluatedAt: now,
        updatedAt: now,
      })
      .where(eq(strategyConfigValidations.id, validation.id))
      .returning();
    return { row: row ?? validation, evaluation, changed: true };
  }

  await db
    .update(strategyConfigValidations)
    .set({
      status: "ROLLBACK_REQUIRED",
      evaluationJson: JSON.stringify(persistedEvaluation),
      lastEvaluatedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(strategyConfigValidations.id, validation.id),
      inArray(strategyConfigValidations.status, [
        "COLLECTING",
        "PROMOTION_READY",
        "ROLLBACK_REQUIRED",
      ]),
    ));
  return applyAutomaticRollback({
    validation,
    suggestions,
    evaluation: persistedEvaluation,
    now,
  });
}

export async function nexusConfigValidationEntryBlock(input: {
  strategyId: number;
  configVersion: number;
}) {
  const reconciled = await reconcileNexusConfigValidation({
    strategyId: input.strategyId,
    candidateVersion: input.configVersion,
  });
  const row = reconciled?.row;
  if (!row || ["PROMOTED", "ROLLED_BACK"].includes(row.status)) return null;
  const evaluation = safeRecord(row.evaluationJson);
  const suggestionIds = positiveIntegerArray(row.suggestionIdsJson);
  if (
    ["COLLECTING", "PROMOTION_READY"].includes(row.status) &&
    !candidateConfirmationMatches({
      confirmation: evaluation.operatorConfirmation,
      baselineVersion: row.baselineVersion,
      candidateVersion: row.candidateVersion,
      suggestionIds,
    })
  )
    return {
      code: "NEXUS_CONFIG_CANDIDATE_CONFIRMATION_REQUIRED",
      message:
        `候选参数版本 V${row.candidateVersion} 缺少有效人工确认，禁止继续提交新订单`,
      status: row.status,
      baselineVersion: row.baselineVersion,
      reasons: ["候选确认快照缺失、过期或与当前版本不一致"],
    };
  if (![
    "ROLLBACK_REQUIRED",
    "RELEARNING",
  ].includes(row.status)) return null;
  return {
    code: "NEXUS_CONFIG_VALIDATION_ROLLBACK",
    message:
      `候选参数版本 V${row.candidateVersion} 已触发恶化回退，禁止继续提交新订单`,
    status: row.status,
    baselineVersion: row.baselineVersion,
    reasons: stringArray(evaluation.deteriorationReasons),
  };
}

export async function promoteNexusConfigValidation(input: {
  strategyId: number;
  candidateVersion: number;
  ownerEmail: string;
  reviewedBy: string;
}) {
  const reconciled = await reconcileNexusConfigValidation({
    strategyId: input.strategyId,
    candidateVersion: input.candidateVersion,
  });
  if (!reconciled)
    return { ok: false as const, error: "候选验证不存在" };
  if (reconciled.row.status !== "PROMOTION_READY")
    return {
      ok: false as const,
      error: reconciled.row.status === "ROLLED_BACK"
        ? "候选版本已因恶化回退，不能晋升"
        : "候选版本尚未达到晋升规则",
    };
  const promotionMetadata = safeRecord(reconciled.row.evaluationJson);
  if (!candidateConfirmationMatches({
    confirmation: promotionMetadata.operatorConfirmation,
    baselineVersion: reconciled.row.baselineVersion,
    candidateVersion: reconciled.row.candidateVersion,
    suggestionIds: positiveIntegerArray(
      reconciled.row.suggestionIdsJson,
    ),
  }))
    return {
      ok: false as const,
      error: "候选版本缺少有效人工确认，请从最新建议重新建立候选",
    };
  const db = getDb();
  const [[strategy], suggestions] = await Promise.all([
    db
      .select()
      .from(strategies)
      .where(and(
        eq(strategies.id, input.strategyId),
        eq(strategies.ownerEmail, input.ownerEmail),
      ))
      .limit(1),
    db
      .select()
      .from(strategyParameterSuggestions)
      .where(and(
        eq(strategyParameterSuggestions.strategyId, input.strategyId),
        inArray(
          strategyParameterSuggestions.id,
          queryablePositiveIntegerArray(reconciled.row.suggestionIdsJson),
        ),
      )),
  ]);
  if (!strategy || strategy.configVersion !== input.candidateVersion)
    return { ok: false as const, error: "候选版本已不再是当前发布版本" };
  const now = new Date();
  const promotionDecision = {
    status: "PROMOTED" as const,
    reviewedBy: input.reviewedBy,
    reviewedAt: now.toISOString(),
    candidateVersion: input.candidateVersion,
    baselineVersion: reconciled.row.baselineVersion,
  };
  await db.batch([
    db
      .update(strategyConfigVersions)
      .set({ isBaseline: false })
      .where(and(
        eq(strategyConfigVersions.strategyId, input.strategyId),
        eq(strategyConfigVersions.ownerEmail, input.ownerEmail),
      )),
    db
      .update(strategyConfigVersions)
      .set({ isBaseline: true })
      .where(and(
        eq(strategyConfigVersions.strategyId, input.strategyId),
        eq(
          strategyConfigVersions.version,
          input.candidateVersion,
        ),
      )),
    db
      .update(strategyConfigValidations)
      .set({
        status: "PROMOTED",
        evaluationJson: JSON.stringify({
          ...promotionMetadata,
          validationDecision: promotionDecision,
        }),
        resolvedBy: input.reviewedBy,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(strategyConfigValidations.id, reconciled.row.id),
        eq(strategyConfigValidations.status, "PROMOTION_READY"),
      )),
    db.insert(auditEvents).values({
      ownerEmail: input.ownerEmail,
      accountId: strategy.accountId,
      action: "HUMAN_PROMOTE_VALIDATED_STRATEGY_CONFIG",
      resourceType: "strategy",
      resourceId: String(input.strategyId),
      detailJson: JSON.stringify(promotionDecision),
      createdAt: now,
    }),
    ...suggestions.map((suggestion) =>
      db
        .update(strategyParameterSuggestions)
        .set({
          evidenceJson: JSON.stringify({
            ...safeRecord(suggestion.evidenceJson),
            validationDecision: promotionDecision,
          }),
        })
        .where(eq(strategyParameterSuggestions.id, suggestion.id))
    ),
  ]);
  const [row] = await db
    .select()
    .from(strategyConfigValidations)
    .where(eq(strategyConfigValidations.id, reconciled.row.id))
    .limit(1);
  if (!row || row.status !== "PROMOTED")
    return {
      ok: false as const,
      error: "候选版本晋升发生并发冲突，请刷新后重新确认",
    };
  return { ok: true as const, row: row ?? reconciled.row };
}

async function applyAutomaticRollback(input: {
  validation: typeof strategyConfigValidations.$inferSelect;
  suggestions: Array<typeof strategyParameterSuggestions.$inferSelect>;
  evaluation: ReturnType<typeof buildNexusConfigValidation>;
  now: Date;
}) {
  const db = getDb();
  const [[strategy], [baseline], [candidate]] = await Promise.all([
    db
      .select()
      .from(strategies)
      .where(eq(strategies.id, input.validation.strategyId))
      .limit(1),
    db
      .select()
      .from(strategyConfigVersions)
      .where(and(
        eq(strategyConfigVersions.strategyId, input.validation.strategyId),
        eq(
          strategyConfigVersions.version,
          input.validation.baselineVersion,
        ),
      ))
      .limit(1),
    db
      .select()
      .from(strategyConfigVersions)
      .where(and(
        eq(strategyConfigVersions.strategyId, input.validation.strategyId),
        eq(
          strategyConfigVersions.version,
          input.validation.candidateVersion,
        ),
      ))
      .limit(1),
  ]);
  if (!strategy || !baseline || !candidate)
    return {
      row: input.validation,
      evaluation: input.evaluation,
      changed: false,
      rollbackError: "BASELINE_OR_CANDIDATE_SNAPSHOT_MISSING",
    };
  const markRelearning = async () => {
    const [row] = await db
      .update(strategyConfigValidations)
      .set({
        status: "RELEARNING",
        resolvedBy: NEXUS_CONFIG_ROLLBACK_ACTOR,
        resolvedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(strategyConfigValidations.id, input.validation.id))
      .returning();
    return {
      row: row ?? input.validation,
      evaluation: input.evaluation,
      changed: true,
      superseded: true,
    };
  };
  const candidateIsCurrent =
    strategy.configVersion === input.validation.candidateVersion;
  const baselineAlreadyRestored =
    strategy.configVersion === input.validation.baselineVersion;
  if (!candidateIsCurrent && !baselineAlreadyRestored) {
    return markRelearning();
  }
  const validationMetadata = safeRecord(input.validation.evaluationJson);
  if (
    candidateIsCurrent &&
    validationMetadata.candidateKind === "LIQUIDATION_FACTOR_MODE"
  ) {
    return applyLiquidationFactorShadowRelearning({
      strategy,
      baseline,
      candidate,
      validation: input.validation,
      suggestions: input.suggestions,
      evaluation: input.evaluation,
      now: input.now,
    });
  }
  const preserveNewerDraft = strategy.draftVersion > candidate.version;
  const decision = {
    status: "ROLLED_BACK" as const,
    actor: NEXUS_CONFIG_ROLLBACK_ACTOR,
    candidateVersion: candidate.version,
    baselineVersion: baseline.version,
    reasons: input.evaluation.deteriorationReasons,
    rolledBackAt: input.now.toISOString(),
    oldPositionsKeepBoundVersion: true,
    relearningRequired: true,
  };
  if (candidateIsCurrent) {
    const [restoredStrategy] = await db
      .update(strategies)
      .set({
        accountId: baseline.accountId,
        strategyType: baseline.strategyType,
        symbolScope: baseline.symbolScope,
        configJson: baseline.configJson,
        configVersion: baseline.version,
        publishedVersion: baseline.version,
        ...(!preserveNewerDraft
          ? {
              draftAccountId: baseline.accountId,
              draftName: strategy.name,
              draftSymbolScope: baseline.symbolScope,
              draftConfigJson: baseline.configJson,
              draftVersion: baseline.version,
              draftUpdatedAt: input.now,
            }
          : {}),
        updatedAt: input.now,
      })
      .where(and(
        eq(strategies.id, strategy.id),
        eq(strategies.configVersion, candidate.version),
      ))
      .returning({ id: strategies.id });
    if (!restoredStrategy) {
      const [currentStrategy] = await db
        .select({ configVersion: strategies.configVersion })
        .from(strategies)
        .where(eq(strategies.id, strategy.id))
        .limit(1);
      if (currentStrategy?.configVersion !== baseline.version)
        return markRelearning();
    }
  }
  await db.batch([
    db
      .update(strategyConfigVersions)
      .set({ lifecycle: "RETIRED", isBaseline: false })
      .where(eq(strategyConfigVersions.id, candidate.id)),
    db
      .update(strategyConfigVersions)
      .set({ lifecycle: "PUBLISHED", isBaseline: true })
      .where(eq(strategyConfigVersions.id, baseline.id)),
    db
      .update(strategyConfigValidations)
      .set({
        status: "ROLLED_BACK",
        evaluationJson: JSON.stringify({
          ...input.evaluation,
          validationDecision: decision,
        }),
        resolvedBy: NEXUS_CONFIG_ROLLBACK_ACTOR,
        resolvedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(
        eq(strategyConfigValidations.id, input.validation.id),
        eq(strategyConfigValidations.status, "ROLLBACK_REQUIRED"),
      )),
    db.insert(auditEvents).values({
      ownerEmail: input.validation.ownerEmail,
      accountId: baseline.accountId,
      action: "AUTO_ROLLBACK_STRATEGY_CONFIG",
      resourceType: "strategy",
      resourceId: String(input.validation.strategyId),
      detailJson: JSON.stringify(decision),
      createdAt: input.now,
    }),
    ...input.suggestions.map((suggestion) =>
      db
        .update(strategyParameterSuggestions)
        .set({
          status: "REJECTED",
          reviewedAt: input.now,
          evidenceJson: JSON.stringify({
            ...safeRecord(suggestion.evidenceJson),
            validationDecision: decision,
          }),
        })
        .where(eq(strategyParameterSuggestions.id, suggestion.id))
    ),
  ]);
  const [row] = await db
    .select()
    .from(strategyConfigValidations)
    .where(eq(strategyConfigValidations.id, input.validation.id))
    .limit(1);
  return {
    row: row ?? input.validation,
    evaluation: input.evaluation,
    changed: true,
    rolledBack: true,
    baselineVersion: baseline.version,
  };
}

async function applyLiquidationFactorShadowRelearning(input: {
  strategy: typeof strategies.$inferSelect;
  baseline: typeof strategyConfigVersions.$inferSelect;
  candidate: typeof strategyConfigVersions.$inferSelect;
  validation: typeof strategyConfigValidations.$inferSelect;
  suggestions: Array<typeof strategyParameterSuggestions.$inferSelect>;
  evaluation: ReturnType<typeof buildNexusConfigValidation>;
  now: Date;
}) {
  const db = getDb();
  const nextVersion = Math.max(
    input.strategy.configVersion,
    input.strategy.publishedVersion,
    input.strategy.draftVersion,
    input.candidate.version,
  ) + 1;
  const baselineConfig = safeRecord(input.baseline.configJson);
  const baselineFactors = safeRecord(baselineConfig.liquidationFactors);
  const relearningConfigJson = JSON.stringify({
    ...baselineConfig,
    liquidationFactors: {
      ...baselineFactors,
      mode: "SHADOW",
    },
  });
  const preserveNewerDraft = input.strategy.draftVersion > input.candidate.version;
  const decision = {
    status: "ROLLED_BACK" as const,
    actor: NEXUS_CONFIG_ROLLBACK_ACTOR,
    candidateVersion: input.candidate.version,
    baselineVersion: input.baseline.version,
    relearningVersion: nextVersion,
    reasons: input.evaluation.deteriorationReasons,
    rolledBackAt: input.now.toISOString(),
    oldPositionsKeepBoundVersion: true,
    relearningRequired: true,
  };
  await db.batch([
    db
      .update(strategyConfigVersions)
      .set({ lifecycle: "RETIRED", isBaseline: false })
      .where(inArray(strategyConfigVersions.id, [
        input.baseline.id,
        input.candidate.id,
      ])),
    db.insert(strategyConfigVersions).values({
      strategyId: input.strategy.id,
      ownerEmail: input.strategy.ownerEmail,
      accountId: input.baseline.accountId,
      version: nextVersion,
      sourceVersion: input.candidate.version,
      versionLabel: "爆仓因子回退SHADOW再学习",
      note: "LIVE候选恶化后自动回退，并以新配置版本重新积累样本",
      isBaseline: true,
      lifecycle: "PUBLISHED",
      strategyType: input.baseline.strategyType,
      symbolScope: input.baseline.symbolScope,
      configJson: relearningConfigJson,
      createdAt: input.now,
    }),
    db
      .update(strategies)
      .set({
        accountId: input.baseline.accountId,
        strategyType: input.baseline.strategyType,
        symbolScope: input.baseline.symbolScope,
        configJson: relearningConfigJson,
        configVersion: nextVersion,
        publishedVersion: nextVersion,
        ...(!preserveNewerDraft
          ? {
              draftAccountId: input.baseline.accountId,
              draftName: input.strategy.name,
              draftSymbolScope: input.baseline.symbolScope,
              draftConfigJson: relearningConfigJson,
              draftVersion: nextVersion,
              draftUpdatedAt: input.now,
            }
          : {}),
        updatedAt: input.now,
      })
      .where(and(
        eq(strategies.id, input.strategy.id),
        eq(strategies.configVersion, input.candidate.version),
      )),
    db
      .update(strategyConfigValidations)
      .set({
        status: "ROLLED_BACK",
        evaluationJson: JSON.stringify({
          ...input.evaluation,
          candidateKind: "LIQUIDATION_FACTOR_MODE",
          validationDecision: decision,
        }),
        resolvedBy: NEXUS_CONFIG_ROLLBACK_ACTOR,
        resolvedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(strategyConfigValidations.id, input.validation.id)),
    db.insert(auditEvents).values({
      ownerEmail: input.strategy.ownerEmail,
      accountId: input.baseline.accountId,
      action: "AUTO_ROLLBACK_LIQUIDATION_FACTOR_TO_SHADOW",
      resourceType: "strategy",
      resourceId: String(input.strategy.id),
      detailJson: JSON.stringify(decision),
      createdAt: input.now,
    }),
    ...input.suggestions.map((suggestion) =>
      db
        .update(strategyParameterSuggestions)
        .set({
          status: "REJECTED",
          reviewedAt: input.now,
          evidenceJson: JSON.stringify({
            ...safeRecord(suggestion.evidenceJson),
            validationDecision: decision,
          }),
        })
        .where(eq(strategyParameterSuggestions.id, suggestion.id))
    ),
  ]);
  const [row] = await db
    .select()
    .from(strategyConfigValidations)
    .where(eq(strategyConfigValidations.id, input.validation.id))
    .limit(1);
  return {
    row: row ?? input.validation,
    evaluation: input.evaluation,
    changed: true,
    rolledBack: true,
    baselineVersion: input.baseline.version,
    relearningVersion: nextVersion,
  };
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

function resolveOperatorConfirmation(input: {
  validation: typeof strategyConfigValidations.$inferSelect;
  metadata: Record<string, unknown>;
  suggestions: Array<typeof strategyParameterSuggestions.$inferSelect>;
}) {
  const suggestionIds = positiveIntegerArray(
    input.validation.suggestionIdsJson,
  );
  if (candidateConfirmationMatches({
    confirmation: input.metadata.operatorConfirmation,
    baselineVersion: input.validation.baselineVersion,
    candidateVersion: input.validation.candidateVersion,
    suggestionIds,
  })) return input.metadata.operatorConfirmation;

  if (
    input.metadata.activatedBy === "HUMAN_CONFIG_PUBLISH" &&
    input.metadata.candidateKind === "LIQUIDATION_FACTOR_MODE" &&
    suggestionIds.length === 0
  )
    return manualCandidateConfirmation({
      confirmedBy: input.validation.ownerEmail,
      confirmedAt: input.validation.createdAt,
      baselineVersion: input.validation.baselineVersion,
      candidateVersion: input.validation.candidateVersion,
    });

  if (
    suggestionIds.length === 0 ||
    input.suggestions.length !== suggestionIds.length
  ) return null;
  const decisions = input.suggestions.map((suggestion) => {
    const evidence = safeRecord(suggestion.evidenceJson);
    const decision = safeRecord(evidence.humanDecision);
    const reviewedAtMs = suggestion.reviewedAt?.getTime() ?? Number.NaN;
    const evidenceReviewedAtMs = Date.parse(String(decision.reviewedAt ?? ""));
    return {
      suggestion,
      evidence,
      decision,
      reviewedAtMs,
      valid:
        suggestion.status === "ACCEPTED" &&
        suggestion.configVersion === input.validation.baselineVersion &&
        Number(evidence.sourceConfigVersion) ===
          input.validation.baselineVersion &&
        Number(evidence.targetDraftVersion) ===
          input.validation.candidateVersion &&
        decision.status === "ACCEPTED_TO_DRAFT" &&
        Number(decision.suggestionId) === suggestion.id &&
        typeof decision.reviewerEmail === "string" &&
        decision.reviewerEmail.trim().length > 0 &&
        Number.isFinite(reviewedAtMs) &&
        Number.isFinite(evidenceReviewedAtMs) &&
        Math.abs(reviewedAtMs - evidenceReviewedAtMs) <= 1_000 &&
        reviewedAtMs <= input.validation.createdAt.getTime(),
    };
  });
  if (decisions.some((item) => !item.valid)) return null;
  const latest = decisions.reduce((current, item) =>
    item.reviewedAtMs > current.reviewedAtMs ? item : current
  );
  return {
    status: "CONFIRMED_TO_SMALL_LIVE_VALIDATION" as const,
    source: "ACCEPTED_PARAMETER_SUGGESTION" as const,
    confirmedBy: String(latest.decision.reviewerEmail).trim(),
    confirmedAt: new Date(latest.reviewedAtMs).toISOString(),
    baselineVersion: input.validation.baselineVersion,
    candidateVersion: input.validation.candidateVersion,
    suggestionIds,
  };
}

function positiveIntegerArray(value: string) {
  try {
    return uniquePositiveIntegers(JSON.parse(value) as unknown[]);
  } catch {
    return [];
  }
}

function queryablePositiveIntegerArray(value: string) {
  const ids = positiveIntegerArray(value);
  return ids.length ? ids : [-1];
}

function uniquePositiveIntegers(values: unknown[]) {
  return [...new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  )];
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
