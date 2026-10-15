import { CAPITAL_EFFICIENCY_EXIT_RULE_VERSION } from "./structure-exit-policy.ts";

export type DurableStructureExitIntent = {
  opportunityId: string;
  traceId: string;
  observedMinute: number;
  observedAtMs: number;
  authorizedAtMs: number;
  ruleVersion: number;
};

export type StructureExitEvidenceRow = {
  traceId: string;
  minuteOffset: number;
  evidenceJson: string;
  createdAt: Date | number;
};

/**
 * A structure exit is a one-way execution authorization. Once complete V3
 * causal evidence has authorized the exit, later observations may explain the
 * market but cannot silently revoke an unfilled instruction. The instruction
 * is terminal only after the recorded execution confirms the position closed.
 */
export function readDurableStructureExitIntent(
  rows: readonly StructureExitEvidenceRow[],
): DurableStructureExitIntent | null {
  const ordered = [...rows].sort(
    (left, right) => toTime(right.createdAt) - toTime(left.createdAt),
  );
  if (ordered.some((row) => {
    const outcome = asRecord(
      parseRecord(row.evidenceJson).positionManagementExecutionOutcome,
    );
    return outcome.status === "EXECUTED" && outcome.closed === true;
  })) return null;
  for (const row of ordered) {
    const evidence = parseRecord(row.evidenceJson);
    const inherited = parseIntent(evidence.durableStructureExitIntent);
    if (inherited) return inherited;

    const decision = asRecord(evidence.positionManagementDecision);
    const assessment = asRecord(evidence.capitalEfficiencyWaveAssessment);
    const binding = asRecord(evidence.positionManagementExecutionBinding);
    const causalComplete = evidence.evidenceCompleteness === "CAUSAL_ENRICHED";
    if (
      !causalComplete ||
      decision.structureExitAuthorized !== true ||
      Number(assessment.ruleVersion) !== CAPITAL_EFFICIENCY_EXIT_RULE_VERSION ||
      assessment.appliesToAllOpenPositions !== true ||
      assessment.exitAuthorized !== true ||
      binding.executor !== "DISCIPLINARY_MARKET_EXIT" ||
      binding.changesPositionImmediately !== true
    ) continue;
    const opportunityId = String(decision.opportunityId ?? "").trim();
    const observedAtMs = Number(decision.observedAtMs ?? toTime(row.createdAt));
    if (!opportunityId || !Number.isFinite(observedAtMs)) continue;
    return {
      opportunityId,
      traceId: row.traceId,
      observedMinute: row.minuteOffset,
      observedAtMs,
      authorizedAtMs: toTime(row.createdAt),
      ruleVersion: CAPITAL_EFFICIENCY_EXIT_RULE_VERSION,
    };
  }
  return null;
}

export function createDurableStructureExitIntent(input: {
  opportunityId: string;
  traceId: string;
  observedMinute: number;
  observedAtMs: number;
  authorizedAtMs?: number;
}): DurableStructureExitIntent {
  return {
    opportunityId: input.opportunityId,
    traceId: input.traceId,
    observedMinute: input.observedMinute,
    observedAtMs: input.observedAtMs,
    authorizedAtMs: input.authorizedAtMs ?? input.observedAtMs,
    ruleVersion: CAPITAL_EFFICIENCY_EXIT_RULE_VERSION,
  };
}

function parseIntent(value: unknown): DurableStructureExitIntent | null {
  const item = asRecord(value);
  const opportunityId = String(item.opportunityId ?? "").trim();
  const traceId = String(item.traceId ?? "").trim();
  const observedMinute = Number(item.observedMinute);
  const observedAtMs = Number(item.observedAtMs);
  const authorizedAtMs = Number(item.authorizedAtMs);
  const ruleVersion = Number(item.ruleVersion);
  return opportunityId && traceId &&
      Number.isInteger(observedMinute) &&
      Number.isFinite(observedAtMs) &&
      Number.isFinite(authorizedAtMs) &&
      ruleVersion === CAPITAL_EFFICIENCY_EXIT_RULE_VERSION
    ? {
        opportunityId,
        traceId,
        observedMinute,
        observedAtMs,
        authorizedAtMs,
        ruleVersion,
      }
    : null;
}

function parseRecord(value: string) {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toTime(value: Date | number) {
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
