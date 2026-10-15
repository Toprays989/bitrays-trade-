export const CONTRARIAN_PROBE_LIFECYCLE_VERSION =
  "contrarian-probe-lifecycle-v1" as const;

export type ContrarianProbeLifecycleState =
  | "NOT_CONTRARIAN"
  | "AWAITING_CONFIRMATION"
  | "PROFIT_CONFIRMING"
  | "PROFIT_PROTECTION_ACTIVE"
  | "PROFIT_GIVEBACK";

export type ContrarianProbeLifecycle = {
  modelVersion: typeof CONTRARIAN_PROBE_LIFECYCLE_VERSION;
  isContrarianProbe: boolean;
  state: ContrarianProbeLifecycleState;
  label: string;
  reason: string;
  profitProtectionThresholdRoePercent: number | null;
  automaticOppositeHedgeAllowed: false;
  averagingDownAllowed: false;
  action:
    | "USE_PRIMARY_POSITION_POLICY"
    | "OBSERVE_WITHOUT_ADDING"
    | "KEEP_EXISTING_PROTECTION"
    | "TIGHTEN_PROFIT_PROTECTION";
};

export function analyzeContrarianProbeLifecycle(input: {
  isContrarianProbe: boolean;
  currentRoePercent: number;
  bestRoePercent: number;
  profitProtectionThresholdRoePercent: number | null | undefined;
  trailingDrawdownRoePercent: number;
}): ContrarianProbeLifecycle {
  const threshold = Number(input.profitProtectionThresholdRoePercent);
  const drawdown = Math.max(0, Number(input.trailingDrawdownRoePercent) || 0);
  const base = {
    modelVersion: CONTRARIAN_PROBE_LIFECYCLE_VERSION,
    automaticOppositeHedgeAllowed: false as const,
    averagingDownAllowed: false as const,
  };
  if (!input.isContrarianProbe) {
    return {
      ...base,
      isContrarianProbe: false,
      state: "NOT_CONTRARIAN",
      label: "正常方向仓位",
      reason: "该仓位不属于反向探针，继续使用原策略持仓管理。",
      profitProtectionThresholdRoePercent: null,
      action: "USE_PRIMARY_POSITION_POLICY",
    };
  }
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return {
      ...base,
      isContrarianProbe: true,
      state: "AWAITING_CONFIRMATION",
      label: "反向探针等待确认",
      reason: "利润保护阈值无效，不增加仓位，也不自动建立相反方向。",
      profitProtectionThresholdRoePercent: null,
      action: "OBSERVE_WITHOUT_ADDING",
    };
  }
  if (input.bestRoePercent >= threshold) {
    const givebackTrigger = input.bestRoePercent - drawdown;
    const giveback = input.currentRoePercent <= givebackTrigger;
    return {
      ...base,
      isContrarianProbe: true,
      state: giveback ? "PROFIT_GIVEBACK" : "PROFIT_PROTECTION_ACTIVE",
      label: giveback ? "反向探针利润回吐" : "反向探针利润保护中",
      reason: giveback
        ? `最佳 ROE 已达到 ${input.bestRoePercent.toFixed(2)}%，当前回落至 ${input.currentRoePercent.toFixed(2)}%，由既有移动止损/止盈计划处理。`
        : `最佳 ROE 已达到保护阈值 ${threshold.toFixed(2)}%，保持利润保护，不自动补仓或开相反仓。`,
      profitProtectionThresholdRoePercent: threshold,
      action: giveback
        ? "TIGHTEN_PROFIT_PROTECTION"
        : "KEEP_EXISTING_PROTECTION",
    };
  }
  const profitable = input.currentRoePercent > 0;
  return {
    ...base,
    isContrarianProbe: true,
    state: profitable ? "PROFIT_CONFIRMING" : "AWAITING_CONFIRMATION",
    label: profitable ? "反向探针盈利确认中" : "反向探针尚未确认",
    reason: profitable
      ? `当前 ROE ${input.currentRoePercent.toFixed(2)}%，尚未达到 ${threshold.toFixed(2)}% 保护阈值；只观察，不追加仓位。`
      : `当前 ROE ${input.currentRoePercent.toFixed(2)}%，反向判断尚未被盈利验证；按既有止损计划管理，禁止摊平。`,
    profitProtectionThresholdRoePercent: threshold,
    action: "OBSERVE_WITHOUT_ADDING",
  };
}

export function strategyBranchFamily(
  entryEvidence: Record<string, unknown>,
): "PRIMARY" | "CONTRARIAN_PROBE" {
  const probe = entryEvidence.contrarianProbe;
  if (!probe || typeof probe !== "object" || Array.isArray(probe))
    return "PRIMARY";
  return (probe as Record<string, unknown>).version === 2
    ? "CONTRARIAN_PROBE"
    : "PRIMARY";
}
