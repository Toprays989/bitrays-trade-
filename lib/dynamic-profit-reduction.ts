import type {
  DynamicProfitReductionProgress,
} from "./risk-execution-progress.ts";
import {
  DYNAMIC_PROFIT_SOFT_ACTIVATION_RULE_VERSION,
} from "./risk-execution-progress.ts";
import type {
  DynamicProfitProtection,
} from "./dynamic-profit-protection.ts";
import {
  evaluateProfitReductionExecution,
  type ProfitReductionExecutionGuard,
} from "./profit-reduction-execution-guard.ts";

export type DynamicProfitReductionDecision = {
  action: "NONE" | "PARTIAL" | "CLOSE_REMAINDER";
  stage: 0 | 1 | 2 | 3;
  anchorQuantity: number;
  targetCumulativeRatio: number;
  requestedQuantity: number;
  givebackRoePoints: number;
  economics: ProfitReductionExecutionGuard | null;
  reason: string;
};

/**
 * Pre-first-TP reduction policy.
 *
 * The first weakening drawdown takes 25% off, a further adverse move raises
 * cumulative reduction to 55%, and only a cost-floor breach or confirmed
 * structure invalidation closes the remainder. A continuation signal pauses
 * partial reductions so a normal pullback cannot repeatedly trim a winner.
 */
export function decideDynamicProfitReduction(input: {
  protection: DynamicProfitProtection;
  currentRoePercent: number;
  firstTakeProfitRoePercent: number | null;
  completedTakeProfitLevels: number;
  currentQuantity: number;
  progress: DynamicProfitReductionProgress | null;
  nowMs: number;
  minimumStageIntervalMs?: number;
  protectedRemainderFloorRoePercent?: number;
  continuationShockGivebackRoePoints?: number;
  economics?: {
    positionSide: "LONG" | "SHORT";
    entryPrice: number;
    executablePrice: number;
  };
}): DynamicProfitReductionDecision {
  const currentQuantity = positive(input.currentQuantity) ?? 0;
  const progress = normalizeProgress(input.progress, currentQuantity);
  const peakRoePercent =
    finite(input.protection.peakRoePercent) ?? input.currentRoePercent;
  const softArmed =
    input.protection.enabled &&
    progress.softActivationRuleVersion ===
      DYNAMIC_PROFIT_SOFT_ACTIVATION_RULE_VERSION &&
    progress.softActivatedAtMs !== null;
  const base = {
    stage: 0 as const,
    anchorQuantity: progress.anchorQuantity,
    targetCumulativeRatio: 0,
    requestedQuantity: 0,
    givebackRoePoints: Math.max(
      0,
      peakRoePercent - input.currentRoePercent,
    ),
    economics: null,
  };
  if (
    !input.protection.enabled ||
    (!input.protection.armed && !softArmed) ||
    currentQuantity <= 0
  )
    return { action: "NONE", ...base, reason: "动态利润保护尚未启动。" };
  if (input.completedTakeProfitLevels > 0)
    return { action: "NONE", ...base, reason: "首档止盈已执行，交由既有止盈后保护。" };
  const firstTakeProfit = positive(input.firstTakeProfitRoePercent);
  if (firstTakeProfit !== null && input.currentRoePercent >= firstTakeProfit)
    return { action: "NONE", ...base, reason: "已触及首档止盈，配置止盈优先。" };

  const costFloor = input.protection.feeCoveredFloorRoePercent ?? 0;
  const completed = new Set(progress.completedStages);
  const lastStage = completed.has(2) ? 2 : completed.has(1) ? 1 : 0;
  const protectedRemainderFloorRoePercent = Math.max(
    costFloor,
    finite(input.protectedRemainderFloorRoePercent) ?? 2,
  );
  if (
    lastStage > 0 &&
    input.currentRoePercent <= protectedRemainderFloorRoePercent
  ) return closeRemainder(
    progress,
    currentQuantity,
    base.givebackRoePoints,
    `首档止盈前已完成利润减仓，ROE回落至尾仓保护线 ${protectedRemainderFloorRoePercent.toFixed(2)}%，关闭剩余仓位。`,
  );
  if (
    input.protection.evidenceMode === "INVALIDATED" ||
    input.currentRoePercent <= costFloor
  ) return closeRemainder(
    progress,
    currentQuantity,
    base.givebackRoePoints,
    input.protection.evidenceMode === "INVALIDATED"
      ? "结构已经失效，关闭动态保护剩余仓位。"
      : "ROE已回到费用覆盖保护线，关闭剩余仓位。",
  );

  const continuationShockGivebackRoePoints = Math.max(
    0,
    finite(input.continuationShockGivebackRoePoints) ?? 2.5,
  );
  if (
    input.protection.evidenceMode === "CONTINUATION" &&
    base.givebackRoePoints < continuationShockGivebackRoePoints
  )
    return { action: "NONE", ...base, reason: "趋势延续证据仍有效，暂停动态分步减仓。" };

  const minimumInterval = Math.max(0, input.minimumStageIntervalMs ?? 15_000);
  const intervalReady =
    progress.lastStageAtMs === null ||
    input.nowMs - progress.lastStageAtMs >= minimumInterval;
  if (!intervalReady)
    return { action: "NONE", ...base, reason: "上一档刚成交，等待新价格证据，禁止连续重复减仓。" };

  const atrStep = input.protection.atrRoePercent === null
    ? 1
    : Math.max(1, Math.min(2, input.protection.atrRoePercent * 0.25));
  const adverseFromLastStage = progress.lastStageRoePercent === null
    ? base.givebackRoePoints
    : progress.lastStageRoePercent - input.currentRoePercent;
  if (lastStage === 0 && base.givebackRoePoints >= 1)
    return feeAwarePartial(input, progress, currentQuantity, 1, 0.25, base.givebackRoePoints,
      "峰值回撤达到1个ROE点且未确认延续，先减仓25%。");
  if (lastStage === 1 && adverseFromLastStage >= atrStep)
    return feeAwarePartial(input, progress, currentQuantity, 2, 0.55, base.givebackRoePoints,
      `上一档后继续恶化${adverseFromLastStage.toFixed(2)}个ROE点，累计减仓至55%。`);
  return {
    action: "NONE",
    ...base,
    reason: lastStage >= 2
      ? "已完成两档动态减仓，保留尾仓等待费用线或结构失效。"
      : "回撤尚未达到下一档条件，继续观察。",
  };
}

function feeAwarePartial(
  input: Parameters<typeof decideDynamicProfitReduction>[0],
  progress: DynamicProfitReductionProgress,
  currentQuantity: number,
  stage: 1 | 2,
  targetCumulativeRatio: number,
  givebackRoePoints: number,
  reason: string,
): DynamicProfitReductionDecision {
  const decision = partial(
    progress,
    currentQuantity,
    stage,
    targetCumulativeRatio,
    givebackRoePoints,
    reason,
  );
  if (!input.economics || decision.requestedQuantity <= 0) return decision;
  const economics = evaluateProfitReductionExecution({
    ...input.economics,
    quantity: decision.requestedQuantity,
  });
  if (economics.eligible)
    return {
      ...decision,
      economics,
      reason: `${reason} ${economics.reason}。`,
    };

  if (stage === 1) {
    const merged = partial(
      progress,
      currentQuantity,
      2,
      0.55,
      givebackRoePoints,
      reason,
    );
    const mergedEconomics = evaluateProfitReductionExecution({
      ...input.economics,
      quantity: merged.requestedQuantity,
    });
    if (
      merged.requestedQuantity > decision.requestedQuantity + 1e-12 &&
      mergedEconomics.eligible
    )
      return {
        ...merged,
        economics: mergedEconomics,
        reason:
          `首档25%减仓费用后不足，已合并为累计55%的单次减仓；${mergedEconomics.reason}。`,
      };
  }

  return {
    action: "NONE",
    stage: 0,
    anchorQuantity: progress.anchorQuantity,
    targetCumulativeRatio: 0,
    requestedQuantity: 0,
    givebackRoePoints,
    economics,
    reason:
      `${economics.reason}；不制造碎片盈利单，保留仓位直到收益覆盖成本、费用保护线触发或结构失效。`,
  };
}

function partial(
  progress: DynamicProfitReductionProgress,
  currentQuantity: number,
  stage: 1 | 2,
  targetCumulativeRatio: number,
  givebackRoePoints: number,
  reason: string,
): DynamicProfitReductionDecision {
  const cumulativeTarget = progress.anchorQuantity * targetCumulativeRatio;
  return {
    action: "PARTIAL",
    stage,
    anchorQuantity: progress.anchorQuantity,
    targetCumulativeRatio,
    requestedQuantity: Math.min(
      currentQuantity,
      Math.max(0, cumulativeTarget - progress.executedQuantity),
    ),
    givebackRoePoints,
    economics: null,
    reason,
  };
}

function closeRemainder(
  progress: DynamicProfitReductionProgress,
  currentQuantity: number,
  givebackRoePoints: number,
  reason: string,
): DynamicProfitReductionDecision {
  return {
    action: "CLOSE_REMAINDER",
    stage: 3,
    anchorQuantity: progress.anchorQuantity,
    targetCumulativeRatio: 1,
    requestedQuantity: currentQuantity,
    givebackRoePoints,
    economics: null,
    reason,
  };
}

function normalizeProgress(
  value: DynamicProfitReductionProgress | null,
  currentQuantity: number,
): DynamicProfitReductionProgress {
  return {
    anchorQuantity: positive(value?.anchorQuantity) ?? currentQuantity,
    executedQuantity: Math.max(0, finite(value?.executedQuantity) ?? 0),
    completedStages: Array.isArray(value?.completedStages)
      ? [...new Set(value.completedStages.filter((stage) => stage >= 1 && stage <= 3))]
      : [],
    lastStageRoePercent: finite(value?.lastStageRoePercent),
    lastStageAtMs: finite(value?.lastStageAtMs),
    softActivationRuleVersion: finite(value?.softActivationRuleVersion),
    softActivatedAtMs: finite(value?.softActivatedAtMs),
    softActivationRoePercent: finite(value?.softActivationRoePercent),
  };
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
