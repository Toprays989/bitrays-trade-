import type { DynamicProfitProtection } from "./dynamic-profit-protection.ts";

export const TAIL_WAVE_EXIT_RULE_VERSION = 1;

export type TailWaveExitPlan = {
  ruleVersion: number;
  enabled: boolean;
  initialQuantity: number;
  observationMinutes: number;
  maximumTailPositionPercent: number;
  peakGivebackAtr: number;
};

export type TailWaveExitProgress = {
  ruleVersion: number;
  phase: "OBSERVING" | "TRACKING_REBREAK";
  startedAtMs: number;
  deadlineAtMs: number;
  softTriggerRoePercent: number;
  rebreakAtMs: number | null;
  rebreakPeakRoePercent: number | null;
  lastObservedAtMs: number;
};

export type TailWaveExitDecision = {
  action:
    | "NONE"
    | "START_OBSERVATION"
    | "CONTINUE_OBSERVATION"
    | "TRACK_REBREAK_PEAK"
    | "EXIT_NOW";
  reasonCode:
    | "NOT_ELIGIBLE"
    | "SOFT_TRIGGER_NOT_HIT"
    | "SOFT_TRIGGER_OBSERVATION_STARTED"
    | "OBSERVING_CONSOLIDATION"
    | "REBREAK_CONFIRMED"
    | "TRACKING_FIRST_WAVE_PEAK"
    | "HARD_PROFIT_FLOOR_HIT"
    | "STRUCTURE_INVALIDATED"
    | "MARKET_EVIDENCE_UNAVAILABLE"
    | "OBSERVATION_TIMEOUT"
    | "FIRST_WAVE_MOMENTUM_DECAY"
    | "FIRST_WAVE_PEAK_GIVEBACK";
  reason: string;
  progress: TailWaveExitProgress | null;
  suppressImmediateTrailingClose: boolean;
};

type EvidenceMode = DynamicProfitProtection["evidenceMode"];

export function normalizeTailWaveExitPlan(
  value: unknown,
): TailWaveExitPlan | null {
  if (!record(value)) return null;
  const ruleVersion = integer(value.ruleVersion);
  const initialQuantity = positive(value.initialQuantity);
  const observationMinutes = integer(value.observationMinutes);
  const maximumTailPositionPercent = positive(
    value.maximumTailPositionPercent,
  );
  const peakGivebackAtr = positive(value.peakGivebackAtr);
  if (
    ruleVersion !== TAIL_WAVE_EXIT_RULE_VERSION ||
    typeof value.enabled !== "boolean" ||
    initialQuantity === null ||
    observationMinutes === null ||
    observationMinutes < 15 ||
    observationMinutes > 30 ||
    maximumTailPositionPercent === null ||
    maximumTailPositionPercent > 35 ||
    peakGivebackAtr === null
  ) return null;
  return {
    ruleVersion,
    enabled: value.enabled,
    initialQuantity,
    observationMinutes,
    maximumTailPositionPercent,
    peakGivebackAtr,
  };
}

export function normalizeTailWaveExitProgress(
  value: unknown,
): TailWaveExitProgress | null {
  if (!record(value)) return null;
  const phase = value.phase === "OBSERVING" ||
      value.phase === "TRACKING_REBREAK"
    ? value.phase
    : null;
  const ruleVersion = integer(value.ruleVersion);
  const startedAtMs = nonNegative(value.startedAtMs);
  const deadlineAtMs = nonNegative(value.deadlineAtMs);
  const softTriggerRoePercent = finite(value.softTriggerRoePercent);
  const lastObservedAtMs = nonNegative(value.lastObservedAtMs);
  if (
    phase === null ||
    ruleVersion !== TAIL_WAVE_EXIT_RULE_VERSION ||
    startedAtMs === null ||
    deadlineAtMs === null ||
    softTriggerRoePercent === null ||
    lastObservedAtMs === null
  ) return null;
  return {
    ruleVersion,
    phase,
    startedAtMs,
    deadlineAtMs,
    softTriggerRoePercent,
    rebreakAtMs: nonNegative(value.rebreakAtMs),
    rebreakPeakRoePercent: finite(value.rebreakPeakRoePercent),
    lastObservedAtMs,
  };
}

export function decideTailWaveExit(input: {
  plan: unknown;
  progress: unknown;
  verifiedTakeProfitCount: number;
  currentQuantity: number;
  currentRoePercent: number;
  softTriggerRoePercent: number | null;
  hardFloorRoePercent: number | null;
  atrRoePercent: number | null;
  evidenceMode: EvidenceMode;
  softTriggerHit: boolean;
  nowMs: number;
}): TailWaveExitDecision {
  const plan = normalizeTailWaveExitPlan(input.plan);
  const progress = normalizeTailWaveExitProgress(input.progress);
  const currentQuantity = positive(input.currentQuantity);
  const currentRoePercent = finite(input.currentRoePercent);
  const softTriggerRoePercent = finite(input.softTriggerRoePercent);
  const hardFloorRoePercent = finite(input.hardFloorRoePercent);
  const atrRoePercent = positive(input.atrRoePercent);
  const nowMs = nonNegative(input.nowMs);
  const tailPercent = plan && currentQuantity !== null
    ? currentQuantity / plan.initialQuantity * 100
    : Number.POSITIVE_INFINITY;
  const eligible = Boolean(
    plan?.enabled &&
      Number.isInteger(input.verifiedTakeProfitCount) &&
      input.verifiedTakeProfitCount > 0 &&
      currentQuantity !== null &&
      currentRoePercent !== null &&
      softTriggerRoePercent !== null &&
      hardFloorRoePercent !== null &&
      atrRoePercent !== null &&
      nowMs !== null &&
      tailPercent <= plan.maximumTailPositionPercent + 1e-9,
  );
  if (!eligible)
    return decision(
      "NONE",
      "NOT_ELIGIBLE",
      "该仓位不是新规则下已真实止盈且不超过上限的尾仓，继续执行原保护。",
      progress,
      false,
    );
  if (currentRoePercent! <= hardFloorRoePercent!)
    return decision(
      "EXIT_NOW",
      "HARD_PROFIT_FLOOR_HIT",
      `尾仓ROE已触及硬保护线 ${hardFloorRoePercent!.toFixed(2)}%，立即退出。`,
      progress,
      false,
    );
  if (input.evidenceMode === "INVALIDATED")
    return decision(
      "EXIT_NOW",
      "STRUCTURE_INVALIDATED",
      "趋势结构已失效，观察期不得覆盖硬退出。",
      progress,
      false,
    );
  if (input.evidenceMode === "UNAVAILABLE")
    return decision(
      "EXIT_NOW",
      "MARKET_EVIDENCE_UNAVAILABLE",
      "闭合行情证据不可用，禁止用延迟退出放大风险。",
      progress,
      false,
    );
  if (!progress) {
    if (!input.softTriggerHit)
      return decision(
        "NONE",
        "SOFT_TRIGGER_NOT_HIT",
        "尾仓尚未触碰只上移的软观察线。",
        null,
        false,
      );
    const next: TailWaveExitProgress = {
      ruleVersion: TAIL_WAVE_EXIT_RULE_VERSION,
      phase: "OBSERVING",
      startedAtMs: nowMs!,
      deadlineAtMs: nowMs! + plan!.observationMinutes * 60_000,
      softTriggerRoePercent: softTriggerRoePercent!,
      rebreakAtMs: null,
      rebreakPeakRoePercent: null,
      lastObservedAtMs: nowMs!,
    };
    return decision(
      "START_OBSERVATION",
      "SOFT_TRIGGER_OBSERVATION_STARTED",
      `尾仓触碰软线，进入 ${plan!.observationMinutes} 分钟结构观察；硬保护仍然有效。`,
      next,
      true,
    );
  }
  if (progress.phase === "OBSERVING") {
    if (nowMs! >= progress.deadlineAtMs)
      return decision(
        "EXIT_NOW",
        "OBSERVATION_TIMEOUT",
        "观察期限内没有形成有效再突破，立即退出尾仓。",
        progress,
        false,
      );
    if (input.evidenceMode === "CONTINUATION") {
      const next = {
        ...progress,
        phase: "TRACKING_REBREAK" as const,
        rebreakAtMs: nowMs!,
        rebreakPeakRoePercent: currentRoePercent!,
        lastObservedAtMs: nowMs!,
      };
      return decision(
        "TRACK_REBREAK_PEAK",
        "REBREAK_CONFIRMED",
        "闭合行情确认再突破，开始跟踪调整后的第一个新波段峰值。",
        next,
        true,
      );
    }
    return decision(
      "CONTINUE_OBSERVATION",
      "OBSERVING_CONSOLIDATION",
      "仍处于有效观察期，等待再突破或硬退出条件。",
      { ...progress, lastObservedAtMs: nowMs! },
      true,
    );
  }

  const peak = Math.max(
    progress.rebreakPeakRoePercent ?? currentRoePercent!,
    currentRoePercent!,
  );
  const next = {
    ...progress,
    rebreakPeakRoePercent: peak,
    lastObservedAtMs: nowMs!,
  };
  if (input.evidenceMode === "WEAKENING")
    return decision(
      "EXIT_NOW",
      "FIRST_WAVE_MOMENTUM_DECAY",
      "再突破后的首个波段动能确认衰减，退出尾仓。",
      next,
      false,
    );
  if (peak - currentRoePercent! >= atrRoePercent! * plan!.peakGivebackAtr)
    return decision(
      "EXIT_NOW",
      "FIRST_WAVE_PEAK_GIVEBACK",
      `首个新波段从峰值回撤已达到 ${plan!.peakGivebackAtr.toFixed(2)} ATR，退出尾仓。`,
      next,
      false,
    );
  return decision(
    "TRACK_REBREAK_PEAK",
    "TRACKING_FIRST_WAVE_PEAK",
    "首个新波段仍在延续，峰值只上移并继续跟踪。",
    next,
    true,
  );
}

function decision(
  action: TailWaveExitDecision["action"],
  reasonCode: TailWaveExitDecision["reasonCode"],
  reason: string,
  progress: TailWaveExitProgress | null,
  suppressImmediateTrailingClose: boolean,
): TailWaveExitDecision {
  return {
    action,
    reasonCode,
    reason,
    progress,
    suppressImmediateTrailingClose,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value: unknown) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegative(value: unknown) {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function integer(value: unknown) {
  const number = finite(value);
  return number !== null && Number.isInteger(number) ? number : null;
}
