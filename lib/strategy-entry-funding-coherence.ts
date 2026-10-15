export type StrategyEntryFundingCoherenceStatus =
  | "READY"
  | "STRONG_EVIDENCE_ONLY"
  | "CURRENT_BALANCE_BLOCKED"
  | "CONFIG_IMPOSSIBLE"
  | "BALANCE_UNAVAILABLE";

export type StrategyEntryFundingCoherence = {
  status: StrategyEntryFundingCoherenceStatus;
  minimumPositionNotionalUsdt: number;
  baseTargetNotionalUsdt: number | null;
  maximumTargetNotionalUsdt: number | null;
  configuredMaximumNotionalUsdt: number;
};

export function strategyEntryFundingCoherenceView(
  result: StrategyEntryFundingCoherence,
) {
  const target = result.baseTargetNotionalUsdt;
  const maximum = result.maximumTargetNotionalUsdt;
  const detail =
    `基础目标 ${target === null ? "—" : target.toFixed(2)} USDT` +
    ` · 强证据上限 ${maximum === null ? "—" : maximum.toFixed(2)} USDT` +
    ` · 最低要求 ${result.minimumPositionNotionalUsdt.toFixed(2)} USDT`;
  if (result.status === "READY")
    return { label: "资金可执行", tone: "positive", executable: true, detail } as const;
  if (result.status === "STRONG_EVIDENCE_ONLY")
    return { label: "仅强证据可执行", tone: "warning-text", executable: true, detail } as const;
  if (result.status === "CURRENT_BALANCE_BLOCKED")
    return { label: "资金不足待命", tone: "warning-text", executable: false, detail } as const;
  if (result.status === "CONFIG_IMPOSSIBLE")
    return { label: "配置不可执行", tone: "negative", executable: false, detail } as const;
  return { label: "余额待同步", tone: "muted", executable: false, detail } as const;
}

export function evaluateStrategyEntryFundingCoherence(input: {
  availableBalanceUsdt?: number | null;
  leverage: number;
  equityAllocationPercent: number;
  quantitySizingMode?: "FIXED" | "EVIDENCE_1_TO_2";
  fixedMultiplier?: number;
  minimumPositionNotionalUsdt: number;
  maxOrderMarginUsdt: number;
}): StrategyEntryFundingCoherence {
  const leverage = positive(input.leverage);
  const allocationPercent = positive(input.equityAllocationPercent);
  const minimumPositionNotionalUsdt = positive(
    input.minimumPositionNotionalUsdt,
  );
  const configuredMarginCeiling = positive(input.maxOrderMarginUsdt);
  const configuredMaximumNotionalUsdt = configuredMarginCeiling * leverage;
  const baseMultiplier = input.quantitySizingMode === "FIXED"
    ? Math.max(1, Math.trunc(positive(input.fixedMultiplier) || 1))
    : 1;
  const maximumMultiplier = input.quantitySizingMode === "EVIDENCE_1_TO_2"
    ? 2
    : baseMultiplier;
  const base = {
    minimumPositionNotionalUsdt,
    baseTargetNotionalUsdt: null,
    maximumTargetNotionalUsdt: null,
    configuredMaximumNotionalUsdt,
  };

  if (
    !leverage ||
    !allocationPercent ||
    !minimumPositionNotionalUsdt ||
    !configuredMarginCeiling ||
    configuredMaximumNotionalUsdt + 1e-10 < minimumPositionNotionalUsdt
  ) return { ...base, status: "CONFIG_IMPOSSIBLE" };

  const availableBalanceUsdt = nullableNonNegative(input.availableBalanceUsdt);
  if (availableBalanceUsdt === null)
    return { ...base, status: "BALANCE_UNAVAILABLE" };

  const equityTargetMarginUsdt =
    availableBalanceUsdt * allocationPercent / 100;
  const baseTargetNotionalUsdt = Math.min(
    equityTargetMarginUsdt * baseMultiplier,
    configuredMarginCeiling,
  ) * leverage;
  const maximumTargetNotionalUsdt = Math.min(
    equityTargetMarginUsdt * maximumMultiplier,
    configuredMarginCeiling,
  ) * leverage;
  const result = {
    ...base,
    baseTargetNotionalUsdt,
    maximumTargetNotionalUsdt,
  };
  if (maximumTargetNotionalUsdt + 1e-10 < minimumPositionNotionalUsdt)
    return { ...result, status: "CURRENT_BALANCE_BLOCKED" };
  if (baseTargetNotionalUsdt + 1e-10 < minimumPositionNotionalUsdt)
    return { ...result, status: "STRONG_EVIDENCE_ONLY" };
  return { ...result, status: "READY" };
}

export function strategyEntryFundingConfigurationError(input: {
  leverage: number;
  minimumPositionNotionalUsdt: number;
  maxOrderMarginUsdt: number;
}) {
  const result = evaluateStrategyEntryFundingCoherence({
    ...input,
    availableBalanceUsdt: null,
    equityAllocationPercent: 100,
    quantitySizingMode: "FIXED",
    fixedMultiplier: 1,
  });
  if (result.status !== "CONFIG_IMPOSSIBLE") return null;
  return `最低开仓名义价值 ${result.minimumPositionNotionalUsdt.toFixed(2)} USDT 超过单笔保证金额度在当前杠杆下可支持的上限 ${result.configuredMaximumNotionalUsdt.toFixed(2)} USDT`;
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nullableNonNegative(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
