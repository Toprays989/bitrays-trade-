export const NEXUS_FUNDING_CONTEXT_VERSION = 1;

export type NexusTradeDirection = "LONG" | "SHORT";
export type NexusFundingPayerSide = "LONG" | "SHORT" | "BALANCED";
export type NexusFundingRegime =
  | "UNAVAILABLE"
  | "NEUTRAL"
  | "LONGS_PAYING"
  | "SHORTS_PAYING"
  | "LONGS_CROWDED"
  | "SHORTS_CROWDED";
export type NexusFundingDirectionRelation =
  | "UNAVAILABLE"
  | "NEUTRAL"
  | "ALIGNED"
  | "SAME_SIDE_CROWDING"
  | "CONTRARIAN_SQUEEZE_POTENTIAL";
export type NexusFundingWavePhase =
  | "UNAVAILABLE"
  | "NEUTRAL"
  | "POSITIONING_ONLY_WAIT_VOLUME"
  | "SHORT_SQUEEZE_EXPANSION"
  | "LONG_SQUEEZE_DECLINE"
  | "HIGH_VOLUME_REVERSAL_WATCH"
  | "VOLUME_CONFIRMED_POSITIONING";

export type NexusFundingContext = {
  version: number;
  available: boolean;
  orderAffecting: false;
  direction: NexusTradeDirection;
  fundingRate: number | null;
  fundingRatePercent: number | null;
  nextFundingTime: number | null;
  payerSide: NexusFundingPayerSide;
  positioningBias: "LONG" | "SHORT" | "NEUTRAL";
  regime: NexusFundingRegime;
  relationToDirection: NexusFundingDirectionRelation;
  wavePhase: NexusFundingWavePhase;
  volumeConfirmed: boolean;
  summary: string;
};

// These are interpretation defaults for evidence classification, not Binance
// trading rules. 0.005% filters near-zero noise; 0.05% marks crowding.
const NEUTRAL_RATE = 0.00005;
const CROWDED_RATE = 0.0005;

function percentLabel(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(4)}%`;
}

/**
 * Conservative one-settlement funding buffer for execution economics.
 * Favorable funding is not counted as profit; only the side currently paying
 * funding contributes a cost so a trade never relies on a rebate to pass.
 */
export function adverseFundingCostRate(input: {
  direction: NexusTradeDirection;
  fundingRate?: number | null;
}) {
  const fundingRate = Number(input.fundingRate);
  if (!Number.isFinite(fundingRate) || fundingRate === 0) return 0;
  if (input.direction === "LONG" && fundingRate > 0) return fundingRate;
  if (input.direction === "SHORT" && fundingRate < 0)
    return Math.abs(fundingRate);
  return 0;
}

export function analyzeNexusFundingContext(input: {
  direction: NexusTradeDirection;
  fundingRate?: number | null;
  nextFundingTime?: number | null;
  observedPriceDirection?: string | null;
  volumeConcentrated?: boolean | null;
  contextPhase?:
    | "ACCELERATING"
    | "DECELERATING"
    | "REVERSING"
    | "STABLE"
    | "INSUFFICIENT"
    | null;
}): NexusFundingContext {
  const fundingRate =
    input.fundingRate === null || input.fundingRate === undefined
      ? Number.NaN
      : Number(input.fundingRate);
  const available = Number.isFinite(fundingRate);
  const nextFundingTime = Number(input.nextFundingTime);
  const normalizedNextFundingTime =
    Number.isFinite(nextFundingTime) && nextFundingTime > 0
      ? nextFundingTime
      : null;

  if (!available)
    return {
      version: NEXUS_FUNDING_CONTEXT_VERSION,
      available: false,
      orderAffecting: false,
      direction: input.direction,
      fundingRate: null,
      fundingRatePercent: null,
      nextFundingTime: normalizedNextFundingTime,
      payerSide: "BALANCED",
      positioningBias: "NEUTRAL",
      regime: "UNAVAILABLE",
      relationToDirection: "UNAVAILABLE",
      wavePhase: "UNAVAILABLE",
      volumeConfirmed: false,
      summary: "资金费率暂不可用；不据此放行或否决订单",
    };

  const absoluteRate = Math.abs(fundingRate);
  if (absoluteRate < NEUTRAL_RATE)
    return {
      version: NEXUS_FUNDING_CONTEXT_VERSION,
      available: true,
      orderAffecting: false,
      direction: input.direction,
      fundingRate,
      fundingRatePercent: fundingRate * 100,
      nextFundingTime: normalizedNextFundingTime,
      payerSide: "BALANCED",
      positioningBias: "NEUTRAL",
      regime: "NEUTRAL",
      relationToDirection: "NEUTRAL",
      wavePhase: "NEUTRAL",
      volumeConfirmed: Boolean(input.volumeConcentrated),
      summary: `资金费率 ${percentLabel(fundingRate)}，多空付费接近平衡；仅作为学习证据`,
    };

  const positioningBias = fundingRate > 0 ? "LONG" : "SHORT";
  const payerSide = positioningBias;
  const crowded = absoluteRate >= CROWDED_RATE;
  const sameDirection = input.direction === positioningBias;
  const regime: NexusFundingRegime =
    positioningBias === "LONG"
      ? crowded
        ? "LONGS_CROWDED"
        : "LONGS_PAYING"
      : crowded
        ? "SHORTS_CROWDED"
        : "SHORTS_PAYING";
  const relationToDirection: NexusFundingDirectionRelation = crowded
    ? sameDirection
      ? "SAME_SIDE_CROWDING"
      : "CONTRARIAN_SQUEEZE_POTENTIAL"
    : sameDirection
      ? "ALIGNED"
      : "CONTRARIAN_SQUEEZE_POTENTIAL";
  const payerLabel = payerSide === "LONG" ? "多头付费" : "空头付费";
  const relationLabel =
    relationToDirection === "ALIGNED"
      ? "与当前交易方向一致"
      : relationToDirection === "SAME_SIDE_CROWDING"
        ? "同向持仓拥挤，需防反向挤压"
        : "与当前方向相反，存在挤压或反转机会";
  const volumeConfirmed = input.volumeConcentrated === true;
  const wavePhase: NexusFundingWavePhase = !volumeConfirmed
    ? "POSITIONING_ONLY_WAIT_VOLUME"
    : input.contextPhase === "REVERSING"
      ? "HIGH_VOLUME_REVERSAL_WATCH"
      : positioningBias === "SHORT" &&
          input.observedPriceDirection === "UP"
        ? "SHORT_SQUEEZE_EXPANSION"
        : positioningBias === "LONG" &&
            input.observedPriceDirection === "DOWN"
          ? "LONG_SQUEEZE_DECLINE"
          : "VOLUME_CONFIRMED_POSITIONING";
  const waveLabel = {
    POSITIONING_ONLY_WAIT_VOLUME:
      "尚无集中成交量确认，不能把拥挤侧直接当作方向",
    SHORT_SQUEEZE_EXPANSION:
      "空头付费并伴随放量上冲，确认逼空拉升阶段",
    LONG_SQUEEZE_DECLINE:
      "多头付费并伴随放量下跌，确认多头挤压阶段",
    HIGH_VOLUME_REVERSAL_WATCH:
      "放量后价格结构正在反转，进入派发或回补观察",
    VOLUME_CONFIRMED_POSITIONING:
      "成交量已经集中，但波段方向仍由价格结构确认",
    UNAVAILABLE: "资金费率不可用",
    NEUTRAL: "多空付费接近平衡",
  }[wavePhase];

  return {
    version: NEXUS_FUNDING_CONTEXT_VERSION,
    available: true,
    orderAffecting: false,
    direction: input.direction,
    fundingRate,
    fundingRatePercent: fundingRate * 100,
    nextFundingTime: normalizedNextFundingTime,
    payerSide,
    positioningBias,
    regime,
    relationToDirection,
    wavePhase,
    volumeConfirmed,
    summary: `资金费率 ${percentLabel(fundingRate)}，${payerLabel}；${relationLabel}；${waveLabel}。费率不单独决定下单`,
  };
}
