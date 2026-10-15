export const THREE_MINUTE_PROFIT_MONITOR_ROE_PERCENT = 0;
export const THREE_MINUTE_PROFIT_FLOOR_ROE_PERCENT = 2;
export const THREE_MINUTE_PROFIT_EXIT_ROE_PERCENT = 4;
export const THREE_MINUTE_LOSS_FLOOR_ROE_PERCENT = -0.8;
export const THREE_MINUTE_HARD_STOP_ROE_PERCENT = -1.2;

export type ThreeMinuteDynamicProtectionProgress = Readonly<{
  version: "three-minute-dynamic-protection-v1";
  positiveObservedAtMs: number | null;
  profitFloorArmedAtMs: number | null;
  lossObservedAtMs: number | null;
  lossFloorArmedAtMs: number | null;
}>;

export type ThreeMinuteDynamicProtectionAction =
  | "NONE"
  | "TAKE_PROFIT"
  | "TRAILING_STOP"
  | "STOP_LOSS";

export type ThreeMinuteDynamicProtectionDecision = Readonly<{
  progress: ThreeMinuteDynamicProtectionProgress;
  action: ThreeMinuteDynamicProtectionAction;
  reasonCode:
    | "PROFIT_MONITORING"
    | "PROFIT_FLOOR_ARMED"
    | "PROFIT_TARGET_REACHED"
    | "PROFIT_FLOOR_BREACHED"
    | "LOSS_MONITORING"
    | "LOSS_FLOOR_ARMED"
    | "LOSS_FLOOR_BREACHED"
    | "HARD_STOP_REACHED"
    | "NEUTRAL";
  stateChanged: boolean;
}>;

export function advanceThreeMinuteDynamicProtection(input: {
  progress?: unknown;
  currentRoePercent: number;
  observedAtMs: number;
}): ThreeMinuteDynamicProtectionDecision {
  const previous = normalizeThreeMinuteDynamicProtectionProgress(
    input.progress,
  );
  const currentRoePercent = Number(input.currentRoePercent);
  const observedAtMs = finitePositive(input.observedAtMs) ?? Date.now();
  if (!Number.isFinite(currentRoePercent))
    return Object.freeze({
      progress: previous,
      action: "NONE",
      reasonCode: "NEUTRAL",
      stateChanged: false,
    });

  const profitFloorWasArmed = previous.profitFloorArmedAtMs !== null;
  const lossFloorWasArmed = previous.lossFloorArmedAtMs !== null;
  const progress: ThreeMinuteDynamicProtectionProgress = Object.freeze({
    version: "three-minute-dynamic-protection-v1",
    positiveObservedAtMs:
      previous.positiveObservedAtMs ??
      (currentRoePercent > THREE_MINUTE_PROFIT_MONITOR_ROE_PERCENT
        ? observedAtMs
        : null),
    profitFloorArmedAtMs:
      previous.profitFloorArmedAtMs ??
      (currentRoePercent >= THREE_MINUTE_PROFIT_FLOOR_ROE_PERCENT
        ? observedAtMs
        : null),
    lossObservedAtMs:
      previous.lossObservedAtMs ?? (currentRoePercent < 0 ? observedAtMs : null),
    lossFloorArmedAtMs:
      previous.lossFloorArmedAtMs ??
      (currentRoePercent <= THREE_MINUTE_LOSS_FLOOR_ROE_PERCENT
        ? observedAtMs
        : null),
  });

  const stateChanged =
    progress.positiveObservedAtMs !== previous.positiveObservedAtMs ||
    progress.profitFloorArmedAtMs !== previous.profitFloorArmedAtMs ||
    progress.lossObservedAtMs !== previous.lossObservedAtMs ||
    progress.lossFloorArmedAtMs !== previous.lossFloorArmedAtMs;

  if (currentRoePercent >= THREE_MINUTE_PROFIT_EXIT_ROE_PERCENT)
    return decision(progress, "TAKE_PROFIT", "PROFIT_TARGET_REACHED", stateChanged);
  if (currentRoePercent <= THREE_MINUTE_HARD_STOP_ROE_PERCENT)
    return decision(progress, "STOP_LOSS", "HARD_STOP_REACHED", stateChanged);
  if (
    profitFloorWasArmed &&
    currentRoePercent < THREE_MINUTE_PROFIT_FLOOR_ROE_PERCENT
  ) return decision(progress, "TRAILING_STOP", "PROFIT_FLOOR_BREACHED", stateChanged);
  if (
    lossFloorWasArmed &&
    currentRoePercent < THREE_MINUTE_LOSS_FLOOR_ROE_PERCENT
  ) return decision(progress, "STOP_LOSS", "LOSS_FLOOR_BREACHED", stateChanged);
  if (!profitFloorWasArmed && progress.profitFloorArmedAtMs !== null)
    return decision(progress, "NONE", "PROFIT_FLOOR_ARMED", stateChanged);
  if (!lossFloorWasArmed && progress.lossFloorArmedAtMs !== null)
    return decision(progress, "NONE", "LOSS_FLOOR_ARMED", stateChanged);
  if (currentRoePercent > 0)
    return decision(progress, "NONE", "PROFIT_MONITORING", stateChanged);
  if (currentRoePercent < 0)
    return decision(progress, "NONE", "LOSS_MONITORING", stateChanged);
  return decision(progress, "NONE", "NEUTRAL", stateChanged);
}

export function normalizeThreeMinuteDynamicProtectionProgress(
  value: unknown,
): ThreeMinuteDynamicProtectionProgress {
  const progress = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.freeze({
    version: "three-minute-dynamic-protection-v1",
    positiveObservedAtMs: finitePositive(progress.positiveObservedAtMs),
    profitFloorArmedAtMs: finitePositive(progress.profitFloorArmedAtMs),
    lossObservedAtMs: finitePositive(progress.lossObservedAtMs),
    lossFloorArmedAtMs: finitePositive(progress.lossFloorArmedAtMs),
  });
}

function decision(
  progress: ThreeMinuteDynamicProtectionProgress,
  action: ThreeMinuteDynamicProtectionAction,
  reasonCode: ThreeMinuteDynamicProtectionDecision["reasonCode"],
  stateChanged: boolean,
) {
  return Object.freeze({ progress, action, reasonCode, stateChanged });
}

function finitePositive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
