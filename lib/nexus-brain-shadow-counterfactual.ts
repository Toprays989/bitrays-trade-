export const NEXUS_BRAIN_SHADOW_SKIPPED_RESULT_CODE =
  "NEXUS_BRAIN_SHADOW_READY_ORIGINAL_SKIPPED";
export const NEXUS_BRAIN_SHADOW_CAUSAL_EVIDENCE =
  "SHADOW_COUNTERFACTUAL_CAUSAL";

export const NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES =
  [1, 3, 5, 15, 30, 60] as const;

export function isNexusBrainShadowSkippedTrace(input: {
  resultCode?: string | null;
  entryEvidence?: Record<string, unknown>;
}) {
  return nexusBrainShadowCounterfactualDirection(input) !== null;
}

export function nexusBrainShadowCounterfactualDirection(input: {
  resultCode?: string | null;
  entryEvidence?: Record<string, unknown>;
}): "LONG" | "SHORT" | null {
  if (
    input.resultCode !== NEXUS_BRAIN_SHADOW_SKIPPED_RESULT_CODE
  ) return null;
  const evidence = input.entryEvidence ?? {};
  const shadow = evidence.nexusBrainShadow;
  const counterfactual = evidence.shadowCounterfactual;
  const direction =
    evidence.tradeDirection === "SHORT"
      ? "SHORT"
      : evidence.tradeDirection === "LONG"
        ? "LONG"
        : null;
  return (
    direction &&
    shadow &&
    typeof shadow === "object" &&
    !Array.isArray(shadow) &&
    (shadow as Record<string, unknown>).state === "READY_SHADOW" &&
    counterfactual &&
    typeof counterfactual === "object" &&
    !Array.isArray(counterfactual) &&
    (counterfactual as Record<string, unknown>).version === 1
  )
    ? direction
    : null;
}

export function shadowCounterfactualMinuteDue(
  nowMs: number,
  anchorAtMs: number,
) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(anchorAtMs)) return null;
  const minute = Math.floor((nowMs - anchorAtMs) / 60_000);
  return NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES.includes(
    minute as (typeof NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES)[number],
  )
    ? minute as (typeof NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES)[number]
    : null;
}

export function shadowCounterfactualEvidenceComplete(
  entryEvidence: Record<string, unknown>,
) {
  const shadow = entryEvidence.nexusBrainShadow;
  if (!shadow || typeof shadow !== "object" || Array.isArray(shadow))
    return false;
  const row = shadow as Record<string, unknown>;
  return (
    row.state === "READY_SHADOW" &&
    typeof row.triggerFactId === "string" &&
    row.triggerFactId.length > 0 &&
    Array.isArray(row.confirmationFactIds) &&
    row.confirmationFactIds.length >= 2 &&
    row.orderAffecting === false
  );
}

export function nexusBrainShadowCheckpointSample(input: {
  status: string;
  minuteOffset: number;
  roePercent: number | null;
  evidence: Record<string, unknown>;
}) {
  if (
    input.status !== "MISSED" ||
    input.evidence.sampleType !==
      "NEXUS_BRAIN_SHADOW_COUNTERFACTUAL" ||
    input.evidence.evidenceCompleteness !==
      NEXUS_BRAIN_SHADOW_CAUSAL_EVIDENCE ||
    !NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES.includes(
      input.minuteOffset as (typeof NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES)[number],
    ) ||
    input.roePercent === null ||
    !Number.isFinite(input.roePercent)
  ) return null;
  return {
    minuteOffset:
      input.minuteOffset as (typeof NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES)[number],
    roePercent: input.roePercent,
  };
}
