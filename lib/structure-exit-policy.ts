export type StructureExitExecutionMode = "OBSERVE_ONLY" | "EXECUTE";

export const CAPITAL_EFFICIENCY_EXIT_RULE_VERSION = 3 as const;
export const CAPITAL_EFFICIENCY_EXIT_CHECKPOINT_MINUTES = [1] as const;
export const CAPITAL_EFFICIENCY_EXIT_OBSERVATION_MAX_DELAY_MS = 90_000;

export type CapitalEfficiencyWaveState =
  | "WAVE_VALID"
  | "WAVE_UNPROVEN"
  | "WAVE_INVALIDATED";

export type CapitalEfficiencyExitRule = {
  version: typeof CAPITAL_EFFICIENCY_EXIT_RULE_VERSION;
  appliesToNewPositionOnly: false;
  appliesToAllOpenPositions: true;
  checkpointMinutes: number[];
  evaluationMode: "CONTINUOUS_AFTER_FIRST_CLOSED_CANDLE";
  invalidationAction: "DISCIPLINARY_MARKET_EXIT";
};

export function unifiedCapitalEfficiencyExitRule(): CapitalEfficiencyExitRule {
  return {
    version: CAPITAL_EFFICIENCY_EXIT_RULE_VERSION,
    appliesToNewPositionOnly: false,
    appliesToAllOpenPositions: true,
    checkpointMinutes: [...CAPITAL_EFFICIENCY_EXIT_CHECKPOINT_MINUTES],
    evaluationMode: "CONTINUOUS_AFTER_FIRST_CLOSED_CANDLE",
    invalidationAction: "DISCIPLINARY_MARKET_EXIT",
  };
}

export function readCapitalEfficiencyExitRule(): CapitalEfficiencyExitRule {
  // Version 3 is a runtime policy for every open strategy position. Persisted
  // version 1/2 snapshots and positions without the old field are deliberately
  // normalized here, so historical records cannot keep an indefinite-hold
  // exception after the unified management release.
  return unifiedCapitalEfficiencyExitRule();
}

export function dueCapitalEfficiencyExitObservationMinute(input: {
  rule: CapitalEfficiencyExitRule | null;
  elapsedMs: number;
  recordedMinuteOffsets?: readonly number[];
}) {
  if (
    !capitalEfficiencyExitUsesContinuousMonitoring(input.rule) ||
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs < 0
  ) return null;
  const recorded = new Set(
    (input.recordedMinuteOffsets ?? []).filter(Number.isInteger),
  );
  const firstCheckpointMinute = Math.min(
    ...(input.rule?.checkpointMinutes ?? [Number.POSITIVE_INFINITY]),
  );
  const elapsedMinute = Math.floor(input.elapsedMs / 60_000);
  const delayMs = input.elapsedMs - elapsedMinute * 60_000;
  return (
      elapsedMinute >= firstCheckpointMinute &&
      !recorded.has(elapsedMinute) &&
      delayMs >= 0 &&
      delayMs <= CAPITAL_EFFICIENCY_EXIT_OBSERVATION_MAX_DELAY_MS
    )
    ? elapsedMinute
    : null;
}

export function isCapitalEfficiencyExitObservationMinute(
  rule: CapitalEfficiencyExitRule | null,
  minuteOffset: number,
) {
  const firstCheckpointMinute = Math.min(
    ...(rule?.checkpointMinutes ?? [Number.POSITIVE_INFINITY]),
  );
  return (
    capitalEfficiencyExitUsesContinuousMonitoring(rule) &&
    Number.isInteger(minuteOffset) &&
    minuteOffset >= firstCheckpointMinute
  );
}

export function capitalEfficiencyExitUsesContinuousMonitoring(
  rule: CapitalEfficiencyExitRule | null,
) {
  return (
    rule?.version === CAPITAL_EFFICIENCY_EXIT_RULE_VERSION &&
    rule.evaluationMode === "CONTINUOUS_AFTER_FIRST_CLOSED_CANDLE"
  );
}

/**
 * Classifies every open strategy position under the same live rule. Persisted
 * legacy snapshots remain historical evidence only and cannot change the
 * current execution policy.
 */
export function assessCapitalEfficiencyWave(input: {
  rule: CapitalEfficiencyExitRule | null;
  observedMinute: number;
  currentRoePercent: number;
  action: string;
  continuationEvidence: boolean;
  bottomReboundEvidence: boolean;
}) {
  const rule = readCapitalEfficiencyExitRule();
  const checkpoint = Boolean(rule.checkpointMinutes.includes(input.observedMinute));
  const continuousMonitoring = capitalEfficiencyExitUsesContinuousMonitoring(
    rule,
  );
  const firstCheckpointMinute = Math.min(
    ...rule.checkpointMinutes,
  );
  const evaluationEligible =
    checkpoint ||
    (
      continuousMonitoring &&
      input.observedMinute >= firstCheckpointMinute
    );
  const base = {
    ruleVersion: rule.version,
    appliesToNewPosition: false,
    appliesToAllOpenPositions: true,
    observedMinute: input.observedMinute,
    checkpoint,
    continuousMonitoring,
    evaluationEligible,
  };
  if (!evaluationEligible)
    return {
      ...base,
      state: "WAVE_UNPROVEN" as const,
      exitAuthorized: false,
      reason: "尚未形成入场后的首根完整1分钟K线，等待新鲜事实且不补仓。",
    };
  if (
    input.action === "EXIT_OR_REDUCE_BY_RISK_PLAN" &&
    Number.isFinite(input.currentRoePercent) &&
    input.currentRoePercent < 0
  )
    return {
      ...base,
      state: "WAVE_INVALIDATED" as const,
      exitAuthorized: true,
      reason:
        "目标币结构、连续闭合价格与真实短周期反向成交量已共同确认原波段失效。",
    };
  if (input.continuationEvidence || input.bottomReboundEvidence)
    return {
      ...base,
      state: "WAVE_VALID" as const,
      exitAuthorized: false,
      reason: "目标币价格结构与真实短周期成交量仍支持原波段，继续持有。",
    };
  return {
    ...base,
    state: "WAVE_UNPROVEN" as const,
    exitAuthorized: false,
    reason: "原波段尚未被反向事实推翻，但延续证据也未闭合；继续观察且不补仓。",
  };
}

export function normalizeStructureExitExecutionMode(): StructureExitExecutionMode {
  // Structure invalidation is now one unified executable rule. The legacy
  // OBSERVE_ONLY value remains readable in stored JSON but has no live effect.
  return "EXECUTE";
}

export function structureExitExecutionAuthorized(input: {
  analysisAuthorized: boolean;
  mode: StructureExitExecutionMode;
  softProtectionExecutable: boolean;
  currentRoePercent: number;
}) {
  return (
    input.analysisAuthorized &&
    input.mode === "EXECUTE" &&
    Number.isFinite(input.currentRoePercent) &&
    input.currentRoePercent < 0
  );
}

/**
 * A deep-position decision may be handed to the five-second protection lane
 * only while both its business deadline and its short in-memory handoff lease
 * are still valid. Keeping this check pure prevents an already-expired
 * decision from being promoted merely because its cache entry still exists.
 */
export function positionIntelligenceHandoffFresh(input: {
  validUntilMs: unknown;
  cachedUntilMs: unknown;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const validUntilMs = Number(input.validUntilMs);
  const cachedUntilMs = Number(input.cachedUntilMs);
  return (
    Number.isFinite(validUntilMs) &&
    Number.isFinite(cachedUntilMs) &&
    validUntilMs > nowMs &&
    cachedUntilMs > nowMs
  );
}

export function authorizedStructureExitHandoffFresh(input: {
  structureExitAuthorized: unknown;
  validUntilMs: unknown;
  cachedUntilMs: unknown;
  nowMs?: number;
}) {
  return (
    input.structureExitAuthorized === true &&
    positionIntelligenceHandoffFresh(input)
  );
}
