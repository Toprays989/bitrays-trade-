import {
  analyzeNexusFundingContext,
  type NexusFundingContext,
  type NexusTradeDirection,
} from "./nexus-funding-context.ts";

export const POST_ENTRY_FUNDING_VOLUME_OBSERVATION_VERSION =
  "post-entry-funding-volume-observation-v1" as const;

export type PostEntryFundingVolumeStatus =
  | "UNAVAILABLE"
  | "SQUEEZE_CONTINUATION"
  | "POSITION_CONTINUATION"
  | "CROWDING_REVERSAL_RISK"
  | "POSITIONING_UNWINDING"
  | "MIXED";

export type PostEntryFundingVolumeObservation = {
  version: typeof POST_ENTRY_FUNDING_VOLUME_OBSERVATION_VERSION;
  orderAffecting: false;
  status: PostEntryFundingVolumeStatus;
  direction: NexusTradeDirection;
  observedMinute: number;
  favorableToPosition: boolean | null;
  entryFundingRatePercent: number | null;
  currentFundingRatePercent: number | null;
  fundingTransition:
    | "UNAVAILABLE"
    | "STABLE"
    | "INTENSIFYING"
    | "UNWINDING"
    | "FLIPPED";
  entryQuoteVolume24h: number | null;
  currentQuoteVolume24h: number | null;
  rolling24hVolumeChangePercent: number | null;
  volumeTransition: "UNAVAILABLE" | "STABLE" | "INCREASED" | "DECREASED";
  priceDirectionSinceEntry: "UP" | "DOWN" | "FLAT";
  currentFundingContext: NexusFundingContext;
  summary: string;
};

export function analyzePostEntryFundingVolumeObservation(input: {
  direction: NexusTradeDirection;
  observedMinute: number;
  entryPrice: number;
  currentMarkPrice: number;
  currentRoePercent: number;
  entryFundingRate?: number | null;
  currentFundingRate?: number | null;
  nextFundingTime?: number | null;
  entryQuoteVolume24h?: number | null;
  currentQuoteVolume24h?: number | null;
}): PostEntryFundingVolumeObservation {
  const entryFundingRate = finiteOrNull(input.entryFundingRate);
  const currentFundingRate = finiteOrNull(input.currentFundingRate);
  const entryQuoteVolume24h = positiveOrNull(input.entryQuoteVolume24h);
  const currentQuoteVolume24h = positiveOrNull(input.currentQuoteVolume24h);
  const priceDirectionSinceEntry = priceDirection(
    input.entryPrice,
    input.currentMarkPrice,
  );
  const rolling24hVolumeChangePercent =
    entryQuoteVolume24h !== null && currentQuoteVolume24h !== null
      ? ((currentQuoteVolume24h - entryQuoteVolume24h) /
          entryQuoteVolume24h) *
        100
      : null;
  const volumeTransition = volumeTransitionOf(
    rolling24hVolumeChangePercent,
  );
  const fundingTransition = fundingTransitionOf(
    entryFundingRate,
    currentFundingRate,
  );
  const priceFavorable =
    input.direction === "LONG"
      ? priceDirectionSinceEntry === "UP"
      : priceDirectionSinceEntry === "DOWN";
  const currentFundingContext = analyzeNexusFundingContext({
    direction: input.direction,
    fundingRate: currentFundingRate,
    nextFundingTime: input.nextFundingTime,
    observedPriceDirection:
      priceDirectionSinceEntry === "FLAT"
        ? null
        : priceDirectionSinceEntry,
    // Rolling 24-hour turnover is useful lifecycle evidence, but it is not
    // equivalent to concentrated short-window volume. Never label it as such.
    volumeConcentrated: false,
    contextPhase: "STABLE",
  });

  if (entryFundingRate === null || currentFundingRate === null)
    return result({
      input,
      status: "UNAVAILABLE",
      favorableToPosition: null,
      entryFundingRate,
      currentFundingRate,
      fundingTransition,
      entryQuoteVolume24h,
      currentQuoteVolume24h,
      rolling24hVolumeChangePercent,
      volumeTransition,
      priceDirectionSinceEntry,
      currentFundingContext,
      summary:
        "入场或当前资金费率缺失；保留价格与成交额路径，不据此改变仓位",
    });

  const crowdingAgainstPosition =
    currentFundingContext.relationToDirection ===
    "CONTRARIAN_SQUEEZE_POTENTIAL";
  const sameSideCrowding =
    currentFundingContext.relationToDirection === "SAME_SIDE_CROWDING";
  const volumeIncreasing = volumeTransition === "INCREASED";
  let status: PostEntryFundingVolumeStatus = "MIXED";
  let favorableToPosition: boolean | null = null;
  let summary =
    "资金费率、滚动24小时成交额与持仓价格路径暂未形成一致结论";

  if (
    crowdingAgainstPosition &&
    priceFavorable &&
    volumeIncreasing &&
    Number(input.currentRoePercent) > 0
  ) {
    status = "SQUEEZE_CONTINUATION";
    favorableToPosition = true;
    summary =
      "反向持仓拥挤，价格沿持仓方向运行且滚动成交额增加；记录为挤压延续证据";
  } else if (
    sameSideCrowding &&
    !priceFavorable &&
    volumeIncreasing &&
    Number(input.currentRoePercent) < 0
  ) {
    status = "CROWDING_REVERSAL_RISK";
    favorableToPosition = false;
    summary =
      "同向持仓拥挤，价格逆持仓运行且滚动成交额增加；记录为拥挤反转风险";
  } else if (
    priceFavorable &&
    Number(input.currentRoePercent) >= 0 &&
    fundingTransition !== "FLIPPED"
  ) {
    status = "POSITION_CONTINUATION";
    favorableToPosition = true;
    summary =
      "价格与当前持仓方向一致，资金费率未发生反向翻转；记录为持仓延续证据";
  } else if (
    fundingTransition === "UNWINDING" &&
    volumeTransition !== "INCREASED"
  ) {
    status = "POSITIONING_UNWINDING";
    favorableToPosition = priceFavorable ? true : null;
    summary =
      "资金费率拥挤程度下降且滚动成交额未扩张；记录为仓位回补或热度退潮";
  } else if (!priceFavorable && Number(input.currentRoePercent) < 0) {
    favorableToPosition = false;
  }

  return result({
    input,
    status,
    favorableToPosition,
    entryFundingRate,
    currentFundingRate,
    fundingTransition,
    entryQuoteVolume24h,
    currentQuoteVolume24h,
    rolling24hVolumeChangePercent,
    volumeTransition,
    priceDirectionSinceEntry,
    currentFundingContext,
    summary,
  });
}

function result(input: {
  input: {
    direction: NexusTradeDirection;
    observedMinute: number;
  };
  status: PostEntryFundingVolumeStatus;
  favorableToPosition: boolean | null;
  entryFundingRate: number | null;
  currentFundingRate: number | null;
  fundingTransition: PostEntryFundingVolumeObservation["fundingTransition"];
  entryQuoteVolume24h: number | null;
  currentQuoteVolume24h: number | null;
  rolling24hVolumeChangePercent: number | null;
  volumeTransition: PostEntryFundingVolumeObservation["volumeTransition"];
  priceDirectionSinceEntry:
    PostEntryFundingVolumeObservation["priceDirectionSinceEntry"];
  currentFundingContext: NexusFundingContext;
  summary: string;
}): PostEntryFundingVolumeObservation {
  return {
    version: POST_ENTRY_FUNDING_VOLUME_OBSERVATION_VERSION,
    orderAffecting: false,
    status: input.status,
    direction: input.input.direction,
    observedMinute: Math.max(
      0,
      Math.trunc(Number(input.input.observedMinute) || 0),
    ),
    favorableToPosition: input.favorableToPosition,
    entryFundingRatePercent:
      input.entryFundingRate === null
        ? null
        : input.entryFundingRate * 100,
    currentFundingRatePercent:
      input.currentFundingRate === null
        ? null
        : input.currentFundingRate * 100,
    fundingTransition: input.fundingTransition,
    entryQuoteVolume24h: input.entryQuoteVolume24h,
    currentQuoteVolume24h: input.currentQuoteVolume24h,
    rolling24hVolumeChangePercent:
      input.rolling24hVolumeChangePercent,
    volumeTransition: input.volumeTransition,
    priceDirectionSinceEntry: input.priceDirectionSinceEntry,
    currentFundingContext: input.currentFundingContext,
    summary: input.summary,
  };
}

function fundingTransitionOf(
  entryRate: number | null,
  currentRate: number | null,
): PostEntryFundingVolumeObservation["fundingTransition"] {
  if (entryRate === null || currentRate === null) return "UNAVAILABLE";
  if (
    entryRate !== 0 &&
    currentRate !== 0 &&
    Math.sign(entryRate) !== Math.sign(currentRate)
  )
    return "FLIPPED";
  const entryMagnitude = Math.abs(entryRate);
  const currentMagnitude = Math.abs(currentRate);
  const tolerance = Math.max(0.00001, entryMagnitude * 0.1);
  if (currentMagnitude > entryMagnitude + tolerance) return "INTENSIFYING";
  if (currentMagnitude < Math.max(0, entryMagnitude - tolerance))
    return "UNWINDING";
  return "STABLE";
}

function volumeTransitionOf(
  changePercent: number | null,
): PostEntryFundingVolumeObservation["volumeTransition"] {
  if (changePercent === null) return "UNAVAILABLE";
  if (changePercent >= 0.1) return "INCREASED";
  if (changePercent <= -0.1) return "DECREASED";
  return "STABLE";
}

function priceDirection(entryPrice: number, currentPrice: number) {
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  )
    return "FLAT" as const;
  const change = (currentPrice - entryPrice) / entryPrice;
  if (change > 0.0001) return "UP" as const;
  if (change < -0.0001) return "DOWN" as const;
  return "FLAT" as const;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
