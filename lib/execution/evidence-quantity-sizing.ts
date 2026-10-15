import { normalizeAutomatedOrderQuantityMultiplier } from
  "../order-quantity.ts";

export const EVIDENCE_QUANTITY_SIZING_VERSION =
  "evidence-quantity-sizing-v1" as const;

/**
 * Chooses one or two exchange-minimum units from explicit facts. This is not
 * a score: every strong-evidence condition must be true, otherwise sizing
 * remains at one unit.
 */
export function resolveEvidenceQuantityMultiplier(input: {
  mode?: "FIXED" | "EVIDENCE_1_TO_2";
  fixedMultiplier?: number;
  eyeVerdict: unknown;
  volumeTimingState: unknown;
  executionTimingEligible: boolean;
  strongSizingAllowed: boolean;
}) {
  if (input.mode !== "EVIDENCE_1_TO_2") {
    const multiplier = normalizeAutomatedOrderQuantityMultiplier(
      input.fixedMultiplier,
    );
    return {
      mode: "FIXED" as const,
      multiplier,
      evidenceTier: "CONFIGURED" as const,
      reason: `策略固定使用 ${multiplier} 倍交易所最小量`,
    };
  }
  const strong =
    input.strongSizingAllowed &&
    input.executionTimingEligible &&
    input.eyeVerdict === "CONFIRMED" &&
    input.volumeTimingState === "CURRENT_EXECUTION_CONFIRMED";
  return {
    mode: "EVIDENCE_1_TO_2" as const,
    multiplier: strong ? 2 : 1,
    evidenceTier: strong ? "STRONG" as const : "VALID" as const,
    reason: strong
      ? "眼睛确认、当前量能接力且委托前时机复核全部成立，使用 2 倍最小量"
      : "证据有效但未同时满足强证据条件，使用 1 倍最小量",
  };
}
