// Increment this value whenever entry gates, pilot eligibility, position sizing,
// or effective exit protection changes. Learning samples from different engines
// must remain visible for audit, but must never be pooled into one suggestion.
export const LIQUIDATION_DECISION_ENGINE_VERSION =
  "liq-post-event-factors-20260822-v31";

export function decisionEngineVersionFromEvidence(
  evidence: Record<string, unknown>,
) {
  const value = evidence.decisionEngineVersion;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function retiredNexusExecutionVersionBlock(input: {
  traceConfigVersion: number;
  currentConfigVersion: number;
  evidence: Record<string, unknown>;
}) {
  if (input.traceConfigVersion !== input.currentConfigVersion)
    return {
      code: "STRATEGY_CONFIG_VERSION_RETIRED" as const,
      message:
        `轨迹配置 V${input.traceConfigVersion} 已被当前 V${input.currentConfigVersion} 替代，禁止继续提交旧判断`,
      traceConfigVersion: input.traceConfigVersion,
      currentConfigVersion: input.currentConfigVersion,
      traceEngineVersion: decisionEngineVersionFromEvidence(input.evidence),
      currentEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
    };
  const traceEngineVersion = decisionEngineVersionFromEvidence(input.evidence);
  if (traceEngineVersion !== LIQUIDATION_DECISION_ENGINE_VERSION)
    return {
      code: "DECISION_ENGINE_VERSION_RETIRED" as const,
      message: "该轨迹由旧决策引擎创建，禁止继续提交旧判断",
      traceConfigVersion: input.traceConfigVersion,
      currentConfigVersion: input.currentConfigVersion,
      traceEngineVersion,
      currentEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
    };
  return null;
}
