export const NEXUS_LEARNING_MARKET_CONTEXT_VERSION =
  "nexus-learning-market-context-v3" as const;

type NexusLearningTrend =
  | "UP"
  | "DOWN"
  | "RANGE"
  | "TRANSITION"
  | "UNKNOWN";

type NexusLearningFlow =
  | "CONFIRMED"
  | "PENDING"
  | "QUIET"
  | "UNRELIABLE"
  | "UNKNOWN";

export type NexusLearningMarketContext = {
  version: typeof NEXUS_LEARNING_MARKET_CONTEXT_VERSION;
  key: string;
  trend: NexusLearningTrend;
  rawTrend: string;
  volatility: "HIGH" | "ELEVATED" | "NORMAL" | "UNKNOWN";
  liquidity: "DEEP" | "NORMAL" | "THIN" | "UNKNOWN";
  flow: NexusLearningFlow;
  rawFlow: string;
  stress: "CASCADE" | "PRICE_SHOCK" | "DECELERATING" | "NORMAL" | "UNKNOWN";
  temporal:
    | "UP_EXPANSION"
    | "DOWN_EXPANSION"
    | "VOLATILE_NOISE"
    | "MEAN_REVERSION"
    | "TRENDING"
    | "NEUTRAL"
    | "UNKNOWN";
  summary: string;
  learningOnly: true;
  orderAffecting: false;
};

/**
 * 将已经存在于入场证据中的趋势、波动、流动性、量价与爆仓冲击
 * 收口为低基数市场情境。它只用于完整周期分组和复盘，不能成为
 * 新的拒单门槛，避免“大脑”各模块各说各话或样本被过度切碎。
 */
export function buildNexusLearningMarketContext(
  entryEvidence: Record<string, unknown>,
): NexusLearningMarketContext {
  const ownContext = record(entryEvidence.nexusOwnMultiHourContext);
  const dailyActivity = record(entryEvidence.nexusDailyMarketActivity);
  const volumeTiming = record(entryEvidence.nexusVolumeTiming);
  const priceImpulse = record(entryEvidence.nexusPriceImpulse);
  const temporalShadow = record(entryEvidence.nexusTemporalShadow);

  const rawTrend = normalizedToken(
    ownContext.phase ??
      ownContext.decisionRegime ??
      ownContext.regime,
    "UNKNOWN",
  );
  const trend = trendState(rawTrend);
  const volatility = volatilityState(priceImpulse);
  const liquidity = liquidityState(dailyActivity);
  const rawFlow = normalizedToken(volumeTiming.state, "UNKNOWN");
  const flow = flowState(rawFlow);
  const stress = stressState(priceImpulse);
  const temporal = temporalState(temporalShadow);
  const key = [
    `TREND_${trend}`,
    `VOL_${volatility}`,
    `LIQ_${liquidity}`,
    `FLOW_${flow}`,
    `STRESS_${stress}`,
    `TEMP_${temporal}`,
  ].join("|");

  return {
    version: NEXUS_LEARNING_MARKET_CONTEXT_VERSION,
    key,
    trend,
    rawTrend,
    volatility,
    liquidity,
    flow,
    rawFlow,
    stress,
    temporal,
    summary:
      `趋势 ${trend}；波动 ${volatility}；流动性 ${liquidity}；` +
      `量价 ${flow}；爆仓冲击 ${stress}；时序 ${temporal}。` +
      `仅用于完整周期对照学习。`,
    learningOnly: true,
    orderAffecting: false,
  };
}

function temporalState(
  shadow: Record<string, unknown>,
): NexusLearningMarketContext["temporal"] {
  if (shadow.status !== "READY") return "UNKNOWN";
  const phase = normalizedToken(shadow.phase, "UNKNOWN");
  if (phase === "UPSIDE_EXPANSION") return "UP_EXPANSION";
  if (phase === "DOWNSIDE_EXPANSION") return "DOWN_EXPANSION";
  if (phase === "VOLATILE_NOISE") return "VOLATILE_NOISE";
  if (phase === "MEAN_REVERSION_WATCH") return "MEAN_REVERSION";
  if (phase === "TREND_PERSISTENCE") return "TRENDING";
  if (phase === "NO_DECISIVE_CHANGE") return "NEUTRAL";
  return "UNKNOWN";
}

function trendState(value: string): NexusLearningTrend {
  if (["TREND_UP", "BULLISH", "UP", "RISING"].includes(value)) return "UP";
  if (["TREND_DOWN", "BEARISH", "DOWN", "FALLING"].includes(value))
    return "DOWN";
  if (["GRIND", "RANGE", "SIDEWAYS", "FLAT", "CONSOLIDATION"].includes(value))
    return "RANGE";
  if (["TRANSITION", "REVERSAL", "REVERSING", "BREAKOUT"].includes(value))
    return "TRANSITION";
  return "UNKNOWN";
}

function flowState(value: string): NexusLearningFlow {
  if (value === "CURRENT_EXECUTION_CONFIRMED") return "CONFIRMED";
  if (value === "POST_TRIGGER_EXECUTION_PENDING") return "PENDING";
  if (
    [
      "BACKGROUND_WITHOUT_EXECUTION",
      "IMPULSE_DECAYED",
      "CURRENT_QUIET",
    ].includes(value)
  )
    return "QUIET";
  if (
    ["TIME_MISALIGNED", "CURRENT_FACT_STALE", "DATA_INCOMPLETE"].includes(
      value,
    )
  )
    return "UNRELIABLE";
  return "UNKNOWN";
}

function volatilityState(
  impulse: Record<string, unknown>,
): NexusLearningMarketContext["volatility"] {
  const rangeToNoise = safeRatio(
    impulse.contextRangePercent,
    impulse.noisePercent,
  );
  const impulseToThreshold = safeRatio(
    impulse.magnitudePercent,
    impulse.thresholdPercent,
  );
  const strongestRatio = Math.max(
    rangeToNoise ?? Number.NEGATIVE_INFINITY,
    impulseToThreshold ?? Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(strongestRatio))
    return impulse.priceImpulseConfirmed === true ? "ELEVATED" : "UNKNOWN";
  if (strongestRatio >= 2) return "HIGH";
  if (strongestRatio >= 1 || impulse.priceImpulseConfirmed === true)
    return "ELEVATED";
  return "NORMAL";
}

function liquidityState(
  activity: Record<string, unknown>,
): NexusLearningMarketContext["liquidity"] {
  const level = normalizedToken(activity.level, "UNKNOWN");
  if (level === "EXTREME" || level === "HIGH") return "DEEP";
  if (level === "MEDIUM") return "NORMAL";
  if (level === "LOW") return "THIN";
  return "UNKNOWN";
}

function stressState(
  impulse: Record<string, unknown>,
): NexusLearningMarketContext["stress"] {
  const phase = normalizedToken(impulse.contextPhase, "UNKNOWN");
  const confirmed = impulse.priceImpulseConfirmed === true;
  const concentrated = impulse.volumeConcentrated === true;
  if (confirmed && concentrated) return "CASCADE";
  if (confirmed) return "PRICE_SHOCK";
  if (phase === "DECELERATING" || phase === "REVERSING")
    return "DECELERATING";
  if (phase === "UNKNOWN" || phase === "INSUFFICIENT") return "UNKNOWN";
  return "NORMAL";
}

function safeRatio(numerator: unknown, denominator: unknown) {
  const left = Number(numerator);
  const right = Number(denominator);
  return Number.isFinite(left) && left >= 0 && Number.isFinite(right) && right > 0
    ? left / right
    : null;
}

function normalizedToken(value: unknown, fallback: string) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
