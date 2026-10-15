import {
  normalizeTailWaveExitProgress,
  type TailWaveExitProgress,
} from "./tail-wave-exit.ts";
import {
  normalizeThreeMinuteDynamicProtectionProgress,
  type ThreeMinuteDynamicProtectionProgress,
} from "./three-minute-dynamic-protection.ts";

export type ExecutedRiskProgress = {
  takeProfits: number[];
  stopLosses: number[];
  takeProfitQuantities: Record<string, number>;
  takeProfitDeferrals: Record<string, TakeProfitDeferral>;
  dynamicProfitReduction: DynamicProfitReductionProgress | null;
  verifiedProfitTaking: VerifiedProfitTakingProgress | null;
  tailWaveExit: TailWaveExitProgress | null;
  evidenceRiskReduction: EvidenceRiskReductionProgress | null;
  threeMinuteDynamicProtection: ThreeMinuteDynamicProtectionProgress;
};

export type EvidenceRiskReductionProgress = {
  executedQuantity: number;
  reductionPercent: number;
  executedAtMs: number;
  opportunityId: string | null;
};

export type VerifiedProfitTakingProgress = {
  count: number;
  executedQuantity: number;
  lastExecutedAtMs: number;
};

export type TakeProfitDeferral = {
  count: number;
  lastDeferredAtMs: number;
  triggerRoePercent: number;
  plannedQuantity: number;
  executableRoePercent: number | null;
  grossPnlUsdt: number | null;
  estimatedCostUsdt: number | null;
  estimatedNetPnlUsdt: number | null;
  minimumNetPnlUsdt: number | null;
  reason: string;
};

export type DynamicProfitReductionProgress = {
  anchorQuantity: number;
  executedQuantity: number;
  completedStages: number[];
  lastStageRoePercent: number | null;
  lastStageAtMs: number | null;
  softActivationRuleVersion?: number | null;
  softActivatedAtMs?: number | null;
  softActivationRoePercent?: number | null;
  /** Highest executable ROE floor observed in this position lifecycle. */
  lockedProtectionFloorRoePercent?: number | null;
};

export const DYNAMIC_PROFIT_SOFT_ACTIVATION_RULE_VERSION = 1;

export function normalizeExecutedRiskProgress(
  value: Partial<ExecutedRiskProgress> | null | undefined,
): ExecutedRiskProgress {
  return {
    takeProfits: uniqueIndexes(value?.takeProfits),
    stopLosses: uniqueIndexes(value?.stopLosses),
    takeProfitQuantities: normalizeQuantities(value?.takeProfitQuantities),
    takeProfitDeferrals: normalizeTakeProfitDeferrals(
      value?.takeProfitDeferrals,
    ),
    dynamicProfitReduction: normalizeDynamicProfitReduction(
      value?.dynamicProfitReduction,
    ),
    verifiedProfitTaking: normalizeVerifiedProfitTaking(
      value?.verifiedProfitTaking,
    ),
    tailWaveExit: normalizeTailWaveExitProgress(value?.tailWaveExit),
    evidenceRiskReduction: normalizeEvidenceRiskReduction(
      value?.evidenceRiskReduction,
    ),
    threeMinuteDynamicProtection:
      normalizeThreeMinuteDynamicProtectionProgress(
        value?.threeMinuteDynamicProtection,
      ),
  };
}

export function applyEvidenceRiskReductionExecution(input: {
  progress: ExecutedRiskProgress;
  executedQuantity: number;
  reductionPercent: number;
  executedAtMs: number;
  opportunityId?: string | null;
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  if (next.evidenceRiskReduction) return next;
  next.evidenceRiskReduction = {
    executedQuantity: finiteNonNegative(input.executedQuantity),
    reductionPercent: Math.max(
      0,
      Math.min(99, finiteNonNegative(input.reductionPercent)),
    ),
    executedAtMs: finiteNonNegative(input.executedAtMs),
    opportunityId:
      typeof input.opportunityId === "string" && input.opportunityId
        ? input.opportunityId
        : null,
  };
  return next;
}

export function recordVerifiedTakeProfitExecution(input: {
  progress: ExecutedRiskProgress;
  executedQuantity: number;
  executedAtMs: number;
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  const previous = next.verifiedProfitTaking;
  next.verifiedProfitTaking = {
    count: (previous?.count ?? 0) + 1,
    executedQuantity:
      (previous?.executedQuantity ?? 0) +
      finiteNonNegative(input.executedQuantity),
    lastExecutedAtMs: finiteNonNegative(input.executedAtMs),
  };
  return next;
}

export function applyDynamicProfitReductionExecution(input: {
  progress: ExecutedRiskProgress;
  stage: number;
  anchorQuantity: number;
  executedQuantity: number;
  triggerRoePercent: number;
  executedAtMs: number;
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  const previous = next.dynamicProfitReduction;
  next.dynamicProfitReduction = {
    anchorQuantity: Math.max(
      finiteNonNegative(input.anchorQuantity),
      previous?.anchorQuantity ?? 0,
    ),
    executedQuantity:
      (previous?.executedQuantity ?? 0) +
      finiteNonNegative(input.executedQuantity),
    completedStages: uniqueIndexes([
      ...(previous?.completedStages ?? []),
      input.stage,
    ]),
    lastStageRoePercent: finiteOrNull(input.triggerRoePercent),
    lastStageAtMs: finiteOrNull(input.executedAtMs),
    softActivationRuleVersion:
      previous?.softActivationRuleVersion ?? null,
    softActivatedAtMs: previous?.softActivatedAtMs ?? null,
    softActivationRoePercent:
      previous?.softActivationRoePercent ?? null,
    lockedProtectionFloorRoePercent:
      previous?.lockedProtectionFloorRoePercent ?? null,
  };
  return next;
}

/**
 * The 2% pre-first-TP protection is a forward-only rule. It may be armed only
 * by an ROE observation made while this rule is running; a historical
 * favorable price must never retroactively arm an old position after deploy.
 */
export function observeDynamicProfitSoftActivation(input: {
  progress: ExecutedRiskProgress;
  enabled: boolean;
  currentQuantity: number;
  currentRoePercent: number;
  activationRoePercent?: number;
  observedAtMs: number;
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  const activationRoePercent = Math.max(
    2,
    finiteOrNull(input.activationRoePercent) ?? 2,
  );
  if (
    !input.enabled ||
    !Number.isFinite(input.currentRoePercent) ||
    input.currentRoePercent < activationRoePercent
  ) return next;
  const previous = next.dynamicProfitReduction;
  if (
    previous?.softActivationRuleVersion ===
      DYNAMIC_PROFIT_SOFT_ACTIVATION_RULE_VERSION &&
    previous.softActivatedAtMs !== null
  ) return next;
  next.dynamicProfitReduction = {
    anchorQuantity: Math.max(
      finiteNonNegative(input.currentQuantity),
      previous?.anchorQuantity ?? 0,
    ),
    executedQuantity: previous?.executedQuantity ?? 0,
    completedStages: previous?.completedStages ?? [],
    lastStageRoePercent: previous?.lastStageRoePercent ?? null,
    lastStageAtMs: previous?.lastStageAtMs ?? null,
    softActivationRuleVersion:
      DYNAMIC_PROFIT_SOFT_ACTIVATION_RULE_VERSION,
    softActivatedAtMs: finiteOrNull(input.observedAtMs),
    softActivationRoePercent: activationRoePercent,
    lockedProtectionFloorRoePercent:
      previous?.lockedProtectionFloorRoePercent ?? null,
  };
  return next;
}

/**
 * Persist the strongest dynamic floor reached by a live position. Market
 * evidence can tighten the next floor, but a later CONTINUATION/NEUTRAL label
 * must never loosen protection that was already established.
 */
export function observeDynamicProfitProtectionFloor(input: {
  progress: ExecutedRiskProgress;
  enabled: boolean;
  currentQuantity: number;
  effectiveFloorRoePercent: number | null;
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  const observedFloor = finiteOrNull(input.effectiveFloorRoePercent);
  if (!input.enabled || observedFloor === null) return next;
  const previous = next.dynamicProfitReduction;
  next.dynamicProfitReduction = {
    anchorQuantity: Math.max(
      finiteNonNegative(input.currentQuantity),
      previous?.anchorQuantity ?? 0,
    ),
    executedQuantity: previous?.executedQuantity ?? 0,
    completedStages: previous?.completedStages ?? [],
    lastStageRoePercent: previous?.lastStageRoePercent ?? null,
    lastStageAtMs: previous?.lastStageAtMs ?? null,
    softActivationRuleVersion:
      previous?.softActivationRuleVersion ?? null,
    softActivatedAtMs: previous?.softActivatedAtMs ?? null,
    softActivationRoePercent:
      previous?.softActivationRoePercent ?? null,
    lockedProtectionFloorRoePercent: Math.max(
      observedFloor,
      previous?.lockedProtectionFloorRoePercent ??
        Number.NEGATIVE_INFINITY,
    ),
  };
  return next;
}

export function resetGridProgressPreservingDynamic(
  progress: ExecutedRiskProgress,
) {
  const normalized = normalizeExecutedRiskProgress(progress);
  return {
    ...normalizeExecutedRiskProgress(null),
    dynamicProfitReduction: normalized.dynamicProfitReduction,
    verifiedProfitTaking: normalized.verifiedProfitTaking,
    tailWaveExit: normalized.tailWaveExit,
    evidenceRiskReduction: normalized.evidenceRiskReduction,
    threeMinuteDynamicProtection:
      normalized.threeMinuteDynamicProtection,
  };
}

/**
 * Adding quantity creates a new aggregate position basis, but it must not
 * revive a dynamic reduction stage that already executed earlier in the same
 * position lifecycle.  The anchor therefore grows with the new live quantity
 * while the cumulative reductions and completed stages remain monotonic.
 */
export function reanchorProgressAfterAddition(input: {
  progress: ExecutedRiskProgress;
  newPositionQuantity: number;
}) {
  const next = resetGridProgressPreservingDynamic(input.progress);
  const dynamic = next.dynamicProfitReduction;
  if (!dynamic) return next;
  next.dynamicProfitReduction = {
    ...dynamic,
    anchorQuantity: Math.max(
      dynamic.anchorQuantity,
      finiteNonNegative(input.newPositionQuantity) +
        dynamic.executedQuantity,
    ),
  };
  return next;
}

/**
 * An operator reduction is part of the same position lifecycle. Count it
 * toward the dynamic reduction budget so the next risk tick cannot trim the
 * same 25%/55% tranche for a second time. Static TP/SL grids are intentionally
 * reset by the caller after they are rebuilt for the remaining quantity.
 */
export function applyExternalPositionReduction(input: {
  progress: ExecutedRiskProgress;
  quantityBeforeReduction: number;
  executedQuantity: number;
}) {
  const next = resetGridProgressPreservingDynamic(input.progress);
  const executedQuantity = finiteNonNegative(input.executedQuantity);
  if (executedQuantity <= 0) return next;
  const previous = next.dynamicProfitReduction;
  const anchorQuantity = Math.max(
    finiteNonNegative(input.quantityBeforeReduction),
    previous?.anchorQuantity ?? 0,
  );
  const cumulativeExecuted = Math.min(
    anchorQuantity,
    (previous?.executedQuantity ?? 0) + executedQuantity,
  );
  const completedStages = new Set(previous?.completedStages ?? []);
  if (anchorQuantity > 0 && cumulativeExecuted >= anchorQuantity * 0.25 - 1e-12)
    completedStages.add(1);
  if (anchorQuantity > 0 && cumulativeExecuted >= anchorQuantity * 0.55 - 1e-12)
    completedStages.add(2);
  next.dynamicProfitReduction = {
    anchorQuantity,
    executedQuantity: cumulativeExecuted,
    completedStages: [...completedStages].sort((left, right) => left - right),
    lastStageRoePercent: previous?.lastStageRoePercent ?? null,
    lastStageAtMs: previous?.lastStageAtMs ?? null,
    softActivationRuleVersion:
      previous?.softActivationRuleVersion ?? null,
    softActivatedAtMs: previous?.softActivatedAtMs ?? null,
    softActivationRoePercent:
      previous?.softActivationRoePercent ?? null,
    lockedProtectionFloorRoePercent:
      previous?.lockedProtectionFloorRoePercent ?? null,
  };
  return next;
}

export function remainingTakeProfitQuantity(
  progress: ExecutedRiskProgress,
  index: number,
  plannedQuantity: number,
) {
  const planned = finitePositive(plannedQuantity);
  if (planned === null || progress.takeProfits.includes(index)) return 0;
  const filled = finiteNonNegative(progress.takeProfitQuantities[String(index)]);
  return Math.max(0, planned - filled);
}

export function applyTakeProfitExecution(input: {
  progress: ExecutedRiskProgress;
  levels: Array<{ index: number; plannedQuantity: number }>;
  executedQuantity: number;
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  let unallocated = finiteNonNegative(input.executedQuantity);
  for (const item of input.levels) {
    if (unallocated <= 1e-12) break;
    const planned = finitePositive(item.plannedQuantity);
    if (planned === null || next.takeProfits.includes(item.index)) continue;
    const key = String(item.index);
    const previous = finiteNonNegative(next.takeProfitQuantities[key]);
    const remaining = Math.max(0, planned - previous);
    const allocated = Math.min(remaining, unallocated);
    const cumulative = previous + allocated;
    next.takeProfitQuantities[key] = cumulative;
    unallocated -= allocated;
    if (cumulative >= planned - 1e-12) {
      next.takeProfits.push(item.index);
      next.takeProfitQuantities[key] = planned;
    }
  }
  next.takeProfits = uniqueIndexes(next.takeProfits);
  for (const item of input.levels)
    if (next.takeProfits.includes(item.index))
      delete next.takeProfitDeferrals[String(item.index)];
  return next;
}

export function recordTakeProfitDeferral(input: {
  progress: ExecutedRiskProgress;
  levels: Array<{
    index: number;
    triggerRoePercent: number;
    plannedQuantity: number;
  }>;
  observedAtMs: number;
  guard: {
    executableRoePercent: number | null;
    grossPnlUsdt: number | null;
    estimatedCostUsdt: number | null;
    estimatedNetPnlUsdt: number | null;
    minimumNetPnlUsdt: number | null;
    reason: string;
  };
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  for (const level of input.levels) {
    const key = String(level.index);
    const previous = next.takeProfitDeferrals[key];
    if (
      previous &&
      input.observedAtMs - previous.lastDeferredAtMs < 60_000
    ) continue;
    next.takeProfitDeferrals[key] = {
      count: (previous?.count ?? 0) + 1,
      lastDeferredAtMs: finiteNonNegative(input.observedAtMs),
      triggerRoePercent: finiteNonNegative(level.triggerRoePercent),
      plannedQuantity: finiteNonNegative(level.plannedQuantity),
      executableRoePercent: finiteOrNull(input.guard.executableRoePercent),
      grossPnlUsdt: finiteOrNull(input.guard.grossPnlUsdt),
      estimatedCostUsdt: finiteOrNull(input.guard.estimatedCostUsdt),
      estimatedNetPnlUsdt: finiteOrNull(input.guard.estimatedNetPnlUsdt),
      minimumNetPnlUsdt: finiteOrNull(input.guard.minimumNetPnlUsdt),
      reason: String(input.guard.reason || "止盈档位净收益不足"),
    };
  }
  return next;
}

export function applyStopLossExecution(input: {
  progress: ExecutedRiskProgress;
  indexes: number[];
}) {
  const next = normalizeExecutedRiskProgress(input.progress);
  next.stopLosses = uniqueIndexes([
    ...next.stopLosses,
    ...input.indexes,
  ]);
  return next;
}

function uniqueIndexes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is number =>
          Number.isInteger(item) && Number(item) >= 0,
      ),
    ),
  ];
}

function normalizeQuantities(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, quantity]) =>
        /^\d+$/.test(key) &&
        Number.isFinite(Number(quantity)) &&
        Number(quantity) >= 0
      )
      .map(([key, quantity]) => [key, Number(quantity)]),
  );
}

function normalizeTakeProfitDeferrals(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TakeProfitDeferral> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^\d+$/.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw))
      continue;
    const item = raw as Partial<TakeProfitDeferral>;
    result[key] = {
      count: Math.trunc(finiteNonNegative(item.count)),
      lastDeferredAtMs: finiteNonNegative(item.lastDeferredAtMs),
      triggerRoePercent: finiteNonNegative(item.triggerRoePercent),
      plannedQuantity: finiteNonNegative(item.plannedQuantity),
      executableRoePercent: finiteOrNull(item.executableRoePercent),
      grossPnlUsdt: finiteOrNull(item.grossPnlUsdt),
      estimatedCostUsdt: finiteOrNull(item.estimatedCostUsdt),
      estimatedNetPnlUsdt: finiteOrNull(item.estimatedNetPnlUsdt),
      minimumNetPnlUsdt: finiteOrNull(item.minimumNetPnlUsdt),
      reason: typeof item.reason === "string"
        ? item.reason
        : "止盈档位净收益不足",
    };
  }
  return result;
}

function normalizeDynamicProfitReduction(
  value: unknown,
): DynamicProfitReductionProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<DynamicProfitReductionProgress>;
  const anchorQuantity = finiteNonNegative(item.anchorQuantity);
  const executedQuantity = finiteNonNegative(item.executedQuantity);
  const completedStages = uniqueIndexes(item.completedStages).filter(
    (stage) => stage >= 1 && stage <= 3,
  );
  if (
    anchorQuantity <= 0 &&
    executedQuantity <= 0 &&
    completedStages.length === 0 &&
    finiteOrNull(item.softActivatedAtMs) === null
  ) return null;
  return {
    anchorQuantity,
    executedQuantity,
    completedStages,
    lastStageRoePercent: finiteOrNull(item.lastStageRoePercent),
    lastStageAtMs: finiteOrNull(item.lastStageAtMs),
    softActivationRuleVersion:
      finiteOrNull(item.softActivationRuleVersion),
    softActivatedAtMs: finiteOrNull(item.softActivatedAtMs),
    softActivationRoePercent:
      finiteOrNull(item.softActivationRoePercent),
    lockedProtectionFloorRoePercent:
      finiteOrNull(item.lockedProtectionFloorRoePercent),
  };
}

function normalizeVerifiedProfitTaking(
  value: unknown,
): VerifiedProfitTakingProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<VerifiedProfitTakingProgress>;
  const count = Math.trunc(finiteNonNegative(item.count));
  const executedQuantity = finiteNonNegative(item.executedQuantity);
  const lastExecutedAtMs = finiteNonNegative(item.lastExecutedAtMs);
  if (count <= 0 || executedQuantity <= 0 || lastExecutedAtMs <= 0) return null;
  return { count, executedQuantity, lastExecutedAtMs };
}

function normalizeEvidenceRiskReduction(
  value: unknown,
): EvidenceRiskReductionProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<EvidenceRiskReductionProgress>;
  const executedQuantity = finiteNonNegative(item.executedQuantity);
  const reductionPercent = finiteNonNegative(item.reductionPercent);
  const executedAtMs = finiteNonNegative(item.executedAtMs);
  if (
    executedQuantity <= 0 ||
    reductionPercent <= 0 ||
    reductionPercent >= 100 ||
    executedAtMs <= 0
  ) return null;
  return {
    executedQuantity,
    reductionPercent,
    executedAtMs,
    opportunityId:
      typeof item.opportunityId === "string" && item.opportunityId
        ? item.opportunityId
        : null,
  };
}

function finitePositive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
