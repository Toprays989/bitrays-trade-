export type DynamicProfitProtection = {
  enabled: boolean;
  observing: boolean;
  armed: boolean;
  phase: "DISABLED" | "OBSERVE" | "ARMED" | "TRIGGERED";
  evidenceMode:
    | "UNAVAILABLE"
    | "NEUTRAL"
    | "CONTINUATION"
    | "WEAKENING"
    | "HORIZON_EXPIRED"
    | "INVALIDATED";
  observationRoePercent: number | null;
  activationRoePercent: number | null;
  atrRoePercent: number | null;
  feeCoveredFloorRoePercent: number | null;
  peakRoePercent: number | null;
  effectiveFloorRoePercent: number | null;
  hit: boolean;
  reason: string;
};

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Adaptive profit protection for real positions.
 *
 * Staged take-profit remains authoritative. Before a position first reaches
 * the net-profit activation line, its original stop-loss protection remains
 * active. Once the monotonic favorable ROE crosses that line, dynamic profit
 * protection takes over and never falls back to the pre-profit mode. The
 * floor is derived from the monotonic favorable price, so it can tighten as
 * profit grows but can never retreat when the current price pulls back.
 *
 * Profit protection has three explicit peak stages. Reaching the activation
 * line starts monitoring without immediately forcing the activation profit to
 * become a hard floor. Two additional ROE points lock the activation profit;
 * five additional ROE points enable peak-following protection. This lets a
 * fresh winner absorb ordinary noise while preventing a mature winner from
 * surrendering already-earned profit.
 */
export function dynamicProfitProtection(input: {
  enabled: boolean;
  entryPrice: number;
  leverage: number;
  currentRoePercent: number;
  favorableRoePercent: number;
  atrPrice?: number | null;
  configuredActivationRoePercent: number;
  configuredGivebackRoePoints: number;
  estimatedRoundTripCostRatePercent?: number;
  extraCostBufferRoePercent?: number;
  observationRoePercent?: number;
  evidenceMode?: DynamicProfitProtection["evidenceMode"];
  lockedFloorRoePercent?: number | null;
}): DynamicProfitProtection {
  const evidenceMode = normalizeEvidenceMode(input.evidenceMode);
  if (!input.enabled)
    return {
      enabled: false,
      observing: false,
      armed: false,
      phase: "DISABLED",
      evidenceMode,
      observationRoePercent: null,
      activationRoePercent: null,
      atrRoePercent: null,
      feeCoveredFloorRoePercent: null,
      peakRoePercent: null,
      effectiveFloorRoePercent: null,
      hit: false,
      reason: "动态移动止损已关闭，固定止盈止损网格独立执行。",
    };

  const entryPrice = finite(input.entryPrice);
  const leverage = finite(input.leverage);
  const currentRoePercent = finite(input.currentRoePercent);
  const favorableRoePercent = finite(input.favorableRoePercent);
  if (
    entryPrice === null ||
    entryPrice <= 0 ||
    leverage === null ||
    leverage <= 0 ||
    currentRoePercent === null ||
    favorableRoePercent === null
  )
    return {
      enabled: true,
      observing: false,
      armed: false,
      phase: "OBSERVE",
      evidenceMode,
      observationRoePercent: Math.max(
        0,
        finite(input.observationRoePercent) ?? 2,
      ),
      activationRoePercent: null,
      atrRoePercent: null,
      feeCoveredFloorRoePercent: null,
      peakRoePercent: favorableRoePercent,
      effectiveFloorRoePercent: null,
      hit: false,
      reason: "动态移动止损缺少有效仓位收益数据，保持观察。",
    };

  const atrPrice = finite(input.atrPrice);
  const atrRoePercent =
    atrPrice !== null && atrPrice > 0
      ? (atrPrice / entryPrice) * leverage * 100
      : null;
  const roundTripCostRatePercent = Math.max(
    0,
    finite(input.estimatedRoundTripCostRatePercent) ?? 0.1,
  );
  const extraCostBufferRoePercent = Math.max(
    0,
    finite(input.extraCostBufferRoePercent) ?? 0.1,
  );
  const feeCoveredFloorRoePercent =
    roundTripCostRatePercent * leverage + extraCostBufferRoePercent;
  const observationRoePercent = Math.max(
    2,
    feeCoveredFloorRoePercent,
    finite(input.observationRoePercent) ?? 2,
  );
  const observing = favorableRoePercent >= observationRoePercent;
  const configuredGivebackRoePoints = finite(
    input.configuredGivebackRoePoints,
  );
  const baseGivebackRoePoints =
    configuredGivebackRoePoints !== null &&
      configuredGivebackRoePoints > 0
      ? configuredGivebackRoePoints
      : Math.max(2, atrRoePercent === null ? 0 : atrRoePercent * 1.5);
  const horizonExpiredGivebackConfirmed =
    evidenceMode === "HORIZON_EXPIRED" &&
    favorableRoePercent >= observationRoePercent &&
    currentRoePercent > feeCoveredFloorRoePercent &&
    favorableRoePercent - currentRoePercent >= baseGivebackRoePoints;
  // The current product rule sets 2% ROE as the default/minimum activation.
  // A deliberately higher configured threshold remains authoritative instead
  // of becoming a hidden ignored parameter. The only exception is an expired
  // intraday mandate that has already covered fees and given back the configured
  // amount from its peak; that complete state may arm protection at the observed
  // profit line. favorableRoePercent is monotonic for the current position
  // version, therefore activation is latched after either policy arms it.
  const configuredActivationRoePercent = Math.max(
    2,
    finite(input.configuredActivationRoePercent) ?? 2,
  );
  const activationRoePercent = Math.max(
    observationRoePercent,
    horizonExpiredGivebackConfirmed
      ? observationRoePercent
      : configuredActivationRoePercent,
  );
  if (favorableRoePercent < activationRoePercent)
    return {
      enabled: true,
      observing,
      armed: false,
      phase: "OBSERVE",
      evidenceMode,
      observationRoePercent,
      activationRoePercent,
      atrRoePercent,
      feeCoveredFloorRoePercent,
      peakRoePercent: favorableRoePercent,
      effectiveFloorRoePercent: null,
      hit: false,
      reason: observing
        ? `峰值ROE ${favorableRoePercent.toFixed(2)}% 已接近首次盈利启动线 ` +
          `${activationRoePercent.toFixed(2)}%；原有止损保护继续有效。`
        : `峰值ROE ${favorableRoePercent.toFixed(2)}% 尚未达到观察线 ` +
          `${observationRoePercent.toFixed(2)}%，保持原仓位保护。`,
    };

  // The configured drawdown is the business control and must not be silently
  // widened by a hidden hard-coded minimum.  The previous implementation
  // forced at least 8 ROE points and then selected the looser of two floors;
  // a normal 5-10% ROE winner could therefore surrender almost all profit.
  // ATR is only the fallback when no usable drawdown was configured.
  const givebackRoePoints = baseGivebackRoePoints *
    (evidenceMode === "CONTINUATION"
      ? 1.25
      : evidenceMode === "WEAKENING" ||
          evidenceMode === "HORIZON_EXPIRED" ||
          evidenceMode === "INVALIDATED"
        ? 0.8
        : 1);
  const volatilityFloorRoePercent =
    favorableRoePercent - givebackRoePoints;
  const profitLockPeakRoePercent = activationRoePercent + 2;
  const peakTrailingPeakRoePercent = activationRoePercent + 5;
  const evidenceRequiresEarlyPeakProtection =
    evidenceMode === "WEAKENING" ||
    evidenceMode === "HORIZON_EXPIRED" ||
    evidenceMode === "INVALIDATED";
  const stageFloorRoePercent =
    favorableRoePercent >= peakTrailingPeakRoePercent ||
      evidenceRequiresEarlyPeakProtection
      ? Math.max(activationRoePercent, volatilityFloorRoePercent)
      : favorableRoePercent >= profitLockPeakRoePercent
        ? activationRoePercent
        : volatilityFloorRoePercent;
  const lockedFloorRoePercent = finite(input.lockedFloorRoePercent);
  const effectiveFloorRoePercent = Math.max(
    feeCoveredFloorRoePercent,
    stageFloorRoePercent,
    lockedFloorRoePercent ?? Number.NEGATIVE_INFINITY,
  );
  const hit = currentRoePercent <= effectiveFloorRoePercent;
  return {
    enabled: true,
    observing: true,
    armed: true,
    phase: hit ? "TRIGGERED" : "ARMED",
    evidenceMode,
    observationRoePercent,
    activationRoePercent,
    atrRoePercent,
    feeCoveredFloorRoePercent,
    peakRoePercent: favorableRoePercent,
    effectiveFloorRoePercent,
    hit,
    reason: hit
      ? `ROE回落至动态利润保护线 ${effectiveFloorRoePercent.toFixed(2)}%，` +
        `${evidenceLabel(evidenceMode)}，触发既有只减仓执行器。`
      : `动态利润保护线 ${effectiveFloorRoePercent.toFixed(2)}% ROE；峰值 ${favorableRoePercent.toFixed(2)}%，` +
        `${peakStageLabel({
          favorableRoePercent,
          activationRoePercent,
          profitLockPeakRoePercent,
          peakTrailingPeakRoePercent,
        })}；${evidenceLabel(evidenceMode)}，历史最高保护线已锁定，只收紧不放宽。`,
  };
}

function peakStageLabel(input: {
  favorableRoePercent: number;
  activationRoePercent: number;
  profitLockPeakRoePercent: number;
  peakTrailingPeakRoePercent: number;
}) {
  if (input.favorableRoePercent >= input.peakTrailingPeakRoePercent)
    return `已进入峰值跟随阶段，最低锁盈 ${input.activationRoePercent.toFixed(2)}%`;
  if (input.favorableRoePercent >= input.profitLockPeakRoePercent)
    return `已进入利润锁定阶段，最低锁盈 ${input.activationRoePercent.toFixed(2)}%`;
  return `处于盈利监控阶段，峰值达到 ${input.profitLockPeakRoePercent.toFixed(2)}% 后锁定 ` +
    `${input.activationRoePercent.toFixed(2)}%`;
}

function normalizeEvidenceMode(
  value: DynamicProfitProtection["evidenceMode"] | undefined,
): DynamicProfitProtection["evidenceMode"] {
  return [
    "NEUTRAL",
    "CONTINUATION",
    "WEAKENING",
    "HORIZON_EXPIRED",
    "INVALIDATED",
  ].includes(String(value))
    ? value as DynamicProfitProtection["evidenceMode"]
    : "UNAVAILABLE";
}

function evidenceLabel(mode: DynamicProfitProtection["evidenceMode"]) {
  if (mode === "CONTINUATION") return "新鲜证据显示趋势仍在，已自适应放宽正常回撤空间";
  if (mode === "WEAKENING") return "新鲜证据显示动能减弱，已适度收紧利润保护";
  if (mode === "HORIZON_EXPIRED") return "日内观察周期已结束且峰值回撤达到配置值，已启用费用后利润保护";
  if (mode === "INVALIDATED") return "新鲜证据显示结构失效，保持严格保护";
  if (mode === "NEUTRAL") return "新鲜证据尚未确认延续或转弱";
  return "眼睛证据未完整，不使用旧数据改变保护距离";
}
