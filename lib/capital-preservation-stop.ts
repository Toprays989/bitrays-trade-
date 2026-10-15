type RiskPlanRecord = Record<string, unknown>;

export const CAPITAL_PRESERVATION_STOP_VERSION =
  "nexus-capital-preservation-stop-v1" as const;

export function capitalPreservationStopRoePercent(plan: unknown) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const value = Number(
    (plan as RiskPlanRecord).capitalPreservationStopRoePercent,
  );
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function withCapitalPreservationStop(
  plan: RiskPlanRecord,
  stopLossRoePercent: unknown,
) {
  const value = Number(stopLossRoePercent);
  if (!Number.isFinite(value) || value <= 0) return plan;
  return {
    ...plan,
    capitalPreservationStopVersion: CAPITAL_PRESERVATION_STOP_VERSION,
    capitalPreservationStopRoePercent: value,
  };
}

export function maximumConfiguredStopRoePercent(
  levels: unknown,
) {
  if (!Array.isArray(levels)) return null;
  const values = levels
    .map((level) =>
      Number(
        level && typeof level === "object" && !Array.isArray(level)
          ? (level as RiskPlanRecord).triggerPercent
          : Number.NaN,
      )
    )
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

export function capitalPreservationStopHit(input: {
  plan: unknown;
  currentRoePercent: unknown;
  executable: boolean;
}) {
  const triggerRoePercent = capitalPreservationStopRoePercent(input.plan);
  const currentRoePercent = Number(input.currentRoePercent);
  const hit =
    input.executable &&
    triggerRoePercent !== null &&
    Number.isFinite(currentRoePercent) &&
    currentRoePercent <= -triggerRoePercent;
  return {
    hit,
    triggerRoePercent,
    currentRoePercent: Number.isFinite(currentRoePercent)
      ? currentRoePercent
      : null,
  } as const;
}
