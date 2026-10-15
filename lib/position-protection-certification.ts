import { normalizeRiskProtectionMode } from "./risk-plan-rebalance.ts";
import {
  CAPITAL_EFFICIENCY_EXIT_RULE_VERSION,
  normalizeStructureExitExecutionMode,
  readCapitalEfficiencyExitRule,
} from "./structure-exit-policy.ts";

type UnknownRecord = Record<string, unknown>;

export type PositionProtectionCertificationInput = {
  id: number;
  symbol: string;
  status: string;
  protectionState: string;
  riskPlanJson: string | UnknownRecord;
  trailingActivationPercent: number;
  trailingStopPercent: number;
  pendingCloseClientOrderId?: string | null;
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function plan(value: PositionProtectionCertificationInput["riskPlanJson"]) {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function levels(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item) => {
        const level = record(item);
        return Number.isFinite(Number(level.triggerPercent)) &&
          Number(level.triggerPercent) > 0;
      })
    : [];
}

export function certifyPositionProtection(
  position: PositionProtectionCertificationInput,
) {
  const rawPlan = plan(position.riskPlanJson);
  const normalized = normalizeRiskProtectionMode(
    rawPlan,
    position.trailingStopPercent,
  );
  const dynamicTrailing =
    normalized.plan.dynamicProfitProtectionEnabled === true;
  const fixedStopLevels = levels(normalized.plan.stopLosses);
  const storedFixedStopLevels = levels(rawPlan.stopLosses);
  const dynamicConfigured = dynamicTrailing &&
    Number.isFinite(position.trailingActivationPercent) &&
    position.trailingActivationPercent >= 0.1 &&
    Number.isFinite(position.trailingStopPercent) &&
    position.trailingStopPercent >= 0.1;
  const fixedConfigured = !dynamicTrailing && fixedStopLevels.length > 0;
  const fixedExecutionEnabled = fixedConfigured;
  const dynamicExecutionEnabled = dynamicConfigured;
  const mutuallyExclusive = !(
    fixedExecutionEnabled && dynamicExecutionEnabled
  );
  const selectedMode = dynamicTrailing
    ? "DYNAMIC_TRAILING" as const
    : "FIXED_STOP_GRID" as const;
  const structureRule = readCapitalEfficiencyExitRule();
  const structureMode = normalizeStructureExitExecutionMode();
  const reasons: string[] = [];
  if (position.status !== "OPEN") reasons.push("POSITION_NOT_OPEN");
  if (position.protectionState !== "ACTIVE")
    reasons.push(`PROTECTION_${position.protectionState || "UNKNOWN"}`);
  if (!dynamicConfigured && !fixedConfigured)
    reasons.push("SELECTED_STOP_MODE_NOT_CONFIGURED");
  if (!mutuallyExclusive) reasons.push("STOP_MODES_EXECUTE_TOGETHER");
  if (
    structureRule.version !== CAPITAL_EFFICIENCY_EXIT_RULE_VERSION ||
    !structureRule.appliesToAllOpenPositions ||
    structureMode !== "EXECUTE"
  ) reasons.push("UNIFIED_STRUCTURE_EXIT_NOT_ACTIVE");

  return {
    positionId: position.id,
    symbol: position.symbol,
    certified: reasons.length === 0,
    selectedStopMode: selectedMode,
    executionLanes: {
      fixedStopGrid: fixedExecutionEnabled,
      dynamicTrailing: dynamicExecutionEnabled,
      mutuallyExclusive,
    },
    fixedStopLevelCount: fixedStopLevels.length,
    staleFixedStopLevelCount:
      dynamicTrailing ? storedFixedStopLevels.length : 0,
    pendingClose: Boolean(position.pendingCloseClientOrderId),
    unifiedStructureExit: {
      version: structureRule.version,
      appliesToAllOpenPositions: structureRule.appliesToAllOpenPositions,
      executionMode: structureMode,
      continuousAfterFirstClosedCandle:
        structureRule.evaluationMode ===
          "CONTINUOUS_AFTER_FIRST_CLOSED_CANDLE",
    },
    reasons,
  };
}

export function certifyOpenPositionProtection(
  positions: PositionProtectionCertificationInput[],
) {
  const items = positions.map(certifyPositionProtection);
  const failed = items.filter((item) => !item.certified);
  return {
    version: 1 as const,
    ruleVersion: CAPITAL_EFFICIENCY_EXIT_RULE_VERSION,
    totalOpenPositions: items.length,
    certifiedPositions: items.length - failed.length,
    failedPositions: failed.length,
    fixedStopGridPositions: items.filter(
      (item) => item.selectedStopMode === "FIXED_STOP_GRID",
    ).length,
    dynamicTrailingPositions: items.filter(
      (item) => item.selectedStopMode === "DYNAMIC_TRAILING",
    ).length,
    mutualExclusionViolations: items.filter(
      (item) => !item.executionLanes.mutuallyExclusive,
    ).length,
    pendingClosePositions: items.filter((item) => item.pendingClose).length,
    allCertified: failed.length === 0,
    failed: failed.map((item) => ({
      positionId: item.positionId,
      symbol: item.symbol,
      selectedStopMode: item.selectedStopMode,
      reasons: item.reasons,
    })),
    accountEquityDrawdownRule: {
      separateFromPositionStopMode: true,
      note: "账户权益回撤由账户级状态机独立认证，不与固定止损或移动止损叠加为同一模式。",
    },
  };
}
