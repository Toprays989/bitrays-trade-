export type NexusOrderOrigin = "MANUAL" | "SEMI_AUTO" | "STRATEGY";

export type NexusPositionMemory = {
  origin: NexusOrderOrigin;
  strategyId: number | null;
  strategyConfigVersion: number | null;
  traceId: string | null;
  opportunityContext: Record<string, unknown> | null;
  entryStructureBaseline: Record<string, unknown> | null;
  entryThesis: Record<string, unknown> | null;
  netExpectancy: Record<string, unknown> | null;
  waveThesis: Record<string, unknown> | null;
  holdingMandate: Record<string, unknown> | null;
  entryMultiHourContext: Record<string, unknown> | null;
  positionHandoffKey: string | null;
  positionAuthority: "UNIFIED_POSITION_LIFECYCLE" | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readNexusPositionMemory(
  riskPlanJson: string | null | undefined,
  lifecycle?: {
    lifecycleId?: string | null;
    entryDecisionHandoffJson?: string | null;
    positionHandoffJson?: string | null;
  },
): NexusPositionMemory {
  try {
    const plan = record(JSON.parse(riskPlanJson ?? "{}")) ?? {};
    const positionHandoff = parseFilledPositionHandoff(
      lifecycle?.positionHandoffJson,
    );
    const handoff = positionHandoff?.entryDecision ??
      record(JSON.parse(lifecycle?.entryDecisionHandoffJson ?? "{}")) ?? {};
    const handoffEvidence = record(handoff.evidence) ?? {};
    const opportunityContext =
      record(handoffEvidence.opportunityContext) ??
      record(plan.opportunityContext);
    const entryStructureBaseline =
      record(handoffEvidence.entryStructureBaseline) ??
      record(plan.entryStructureBaseline);
    const entryThesis = record(handoff.entryThesis);
    const netExpectancy =
      record(handoffEvidence.netExpectancy) ??
      record(plan.nexusNetExpectancyDecision) ??
      record(plan.nexusNetExpectancy) ??
      record(plan.netExpectancy);
    const waveThesis =
      record(handoffEvidence.waveThesis) ?? record(plan.waveThesis);
    const holdingMandate = record(handoffEvidence.holdingMandate);
    const entryMultiHourContext =
      record(handoffEvidence.entryMultiHourContext) ??
      record(plan.nexusOwnMultiHourContext);
    const lifecycleId =
      nonEmptyString(positionHandoff?.lifecycleId) ??
      nonEmptyString(lifecycle?.lifecycleId) ??
      nonEmptyString(handoff.lifecycleId) ??
      nonEmptyString(plan.traceId);
    const origin =
      lifecycleId
        ? "STRATEGY"
        : plan.orderOrigin === "SEMI_AUTO" && opportunityContext
        ? "SEMI_AUTO"
        : plan.orderOrigin === "STRATEGY"
          ? "STRATEGY"
          : "MANUAL";
    return {
      origin,
      strategyId:
        positiveInteger(handoff.strategyId) ?? positiveInteger(plan.strategyId),
      strategyConfigVersion:
        positiveInteger(handoff.configVersion) ??
        positiveInteger(plan.strategyConfigVersion),
      traceId: lifecycleId,
      opportunityContext,
      entryStructureBaseline,
      entryThesis,
      netExpectancy,
      waveThesis,
      holdingMandate,
      entryMultiHourContext,
      positionHandoffKey: positionHandoff?.handoffKey ?? null,
      positionAuthority:
        positionHandoff?.ownership.positionAuthority ?? null,
    };
  } catch {
    return {
      origin: "MANUAL",
      strategyId: null,
      strategyConfigVersion: null,
      traceId: null,
      opportunityContext: null,
      entryStructureBaseline: null,
      entryThesis: null,
      netExpectancy: null,
      waveThesis: null,
      holdingMandate: null,
      entryMultiHourContext: null,
      positionHandoffKey: null,
      positionAuthority: null,
    };
  }
}

export function mergeRiskPlanWithPositionMemory<T extends object>(
  currentRiskPlanJson: string | null | undefined,
  nextPlan: T,
) {
  try {
    const current = record(JSON.parse(currentRiskPlanJson ?? "{}"));
    if (!current) return nextPlan;
    const merged: Record<string, unknown> = { ...current, ...nextPlan };
    // Entry-time execution policy is immutable for the life of a position.
    // Rebalancing quantities or rebuilding grids after an add-on must never
    // upgrade a legacy/open position into the newest autonomous-exit rule.
    for (const key of [
      "capitalEfficiencyExit",
      "structureExitExecutionMode",
      "tailWaveExit",
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(current, key))
        merged[key] = current[key];
      else delete merged[key];
    }
    return merged as Record<string, unknown> & T;
  } catch {
    return nextPlan;
  }
}
import { parseFilledPositionHandoff } from
  "./position-lifecycle/filled-position-handoff.ts";
