import { positionRoePercent } from "./position-roe.ts";

export type PositionAdditionRevalidationReason =
  | "OK"
  | "ADD_ON_OPPORTUNITY_EXPIRED"
  | "ADD_ON_MARK_STALE"
  | "ADD_ON_REBOUND_LOST"
  | "ADD_ON_NO_LONGER_NEEDED"
  | "LOSS_EXCEEDS_ADD_ON_RANGE"
  | "SCALE_IN_NOT_PROFITABLE"
  | "SCALE_IN_GIVEBACK_TOO_DEEP";

export function positionAdditionFillAnchor(input: {
  exchangeOrder?: { updateTime?: unknown; time?: unknown } | null;
  createdAtMs: number;
  confirmedAtMs?: number | null;
  observedAtMs?: number;
}): {
  anchorAtMs: number;
  source:
    | "EXCHANGE_UPDATE_TIME"
    | "EXCHANGE_ORDER_TIME"
    | "LOCAL_FILL_CONFIRMATION"
    | "ORDER_CREATED_LEGACY";
} {
  const observedAtMs = finiteOr(input.observedAtMs, Date.now());
  const createdAtMs = finiteOr(input.createdAtMs, observedAtMs);
  const order = input.exchangeOrder ?? {};
  const exchangeCandidates = [
    ["EXCHANGE_UPDATE_TIME", Number(order.updateTime)],
    ["EXCHANGE_ORDER_TIME", Number(order.time)],
  ] as const;
  for (const [source, candidate] of exchangeCandidates) {
    if (
      Number.isFinite(candidate) &&
      candidate > 0 &&
      candidate >= createdAtMs - 5_000 &&
      candidate <= observedAtMs + 5_000
    )
      return { anchorAtMs: candidate, source };
  }
  const confirmedAtMs = Number(input.confirmedAtMs);
  if (
    Number.isFinite(confirmedAtMs) &&
    confirmedAtMs > 0 &&
    confirmedAtMs >= createdAtMs - 5_000 &&
    confirmedAtMs <= observedAtMs + 5_000
  )
    return {
      anchorAtMs: confirmedAtMs,
      source: "LOCAL_FILL_CONFIRMATION",
    };
  return {
    anchorAtMs: createdAtMs,
    source: "ORDER_CREATED_LEGACY",
  };
}

export function selectPositionAdditionLearningMark(input: {
  scheduledAtMs: number;
  sampledAtMs: number;
  liveMarkPrice: number;
  candles?: Array<{
    openTime: number;
    closeTime: number;
    close: number;
  }>;
  terminalClose?: {
    closedAtMs: number;
    exitPrice: number;
  } | null;
  maximumRealtimeDelayMs?: number;
}): {
  markPrice: number;
  source:
    | "CENTRAL_MARK_PRICE_WEBSOCKET"
    | "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL"
    | "POSITION_CLOSED_TERMINAL";
  candleOpenTime: number | null;
  candleCloseTime: number | null;
} | null {
  const scheduledAtMs = Number(input.scheduledAtMs);
  const sampledAtMs = Number(input.sampledAtMs);
  const liveMarkPrice = Number(input.liveMarkPrice);
  const maximumRealtimeDelayMs = positiveOr(
    input.maximumRealtimeDelayMs,
    90_000,
  );
  const delayMs = sampledAtMs - scheduledAtMs;
  const terminalClosedAtMs = Number(input.terminalClose?.closedAtMs);
  const terminalExitPrice = Number(input.terminalClose?.exitPrice);
  if (
    Number.isFinite(terminalClosedAtMs) &&
    Number.isFinite(terminalExitPrice) &&
    terminalExitPrice > 0 &&
    terminalClosedAtMs <= scheduledAtMs
  )
    return {
      markPrice: terminalExitPrice,
      source: "POSITION_CLOSED_TERMINAL",
      candleOpenTime: null,
      candleCloseTime: null,
    };
  if (
    Number.isFinite(delayMs) &&
    delayMs >= 0 &&
    delayMs <= maximumRealtimeDelayMs &&
    Number.isFinite(liveMarkPrice) &&
    liveMarkPrice > 0
  )
    return {
      markPrice: liveMarkPrice,
      source: "CENTRAL_MARK_PRICE_WEBSOCKET",
      candleOpenTime: null,
      candleCloseTime: null,
    };
  const candle = [...(input.candles ?? [])]
    .filter(
      (row) =>
        Number.isFinite(row.closeTime) &&
        row.closeTime <= scheduledAtMs &&
        scheduledAtMs - row.closeTime <= 60_000 &&
        Number.isFinite(row.close) &&
        row.close > 0,
    )
    .sort((left, right) => left.closeTime - right.closeTime)
    .at(-1);
  return candle
    ? {
        markPrice: candle.close,
        source: "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL",
        candleOpenTime: candle.openTime,
        candleCloseTime: candle.closeTime,
      }
    : null;
}

export function revalidatePositionAdditionOpportunity(input: {
  nowMs: number;
  observedAtMs: number;
  validUntilMs: number;
  markTimeMs: number;
  maxMarkAgeMs?: number;
  markPrice: number;
  entryPrice: number;
  leverage: number;
  positionSide: "LONG" | "SHORT";
  worstRoePercent: number;
  bestRoePercent?: number;
  bottomRecoveryRoePoints: number;
  maxAddOnLossRoePercent: number;
  mode?: "REBOUND_ADD_ON" | "PROFIT_SCALE_IN";
  maxProfitGivebackRoePoints?: number;
}): {
  allowed: boolean;
  reason: PositionAdditionRevalidationReason;
  currentRoePercent: number | null;
  recoveryFromTroughRoePoints: number | null;
} {
  const nowMs = Number(input.nowMs);
  const observedAtMs = Number(input.observedAtMs);
  const validUntilMs = Number(input.validUntilMs);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(validUntilMs) ||
    nowMs < observedAtMs ||
    nowMs > validUntilMs
  )
    return denied("ADD_ON_OPPORTUNITY_EXPIRED");

  const markTimeMs = Number(input.markTimeMs);
  const markPrice = Number(input.markPrice);
  const maxMarkAgeMs = positiveOr(input.maxMarkAgeMs, 5_000);
  if (
    !Number.isFinite(markTimeMs) ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0 ||
    markTimeMs > nowMs + 1_000 ||
    nowMs - markTimeMs > maxMarkAgeMs
  )
    return denied("ADD_ON_MARK_STALE");

  const currentRoePercent = positionRoePercent(
    input.entryPrice,
    markPrice,
    input.leverage,
    input.positionSide,
  );
  const worstRoePercent = Number(input.worstRoePercent);
  const bestRoePercent = Math.max(
    currentRoePercent,
    Number.isFinite(Number(input.bestRoePercent))
      ? Number(input.bestRoePercent)
      : currentRoePercent,
  );
  const bottomRecoveryRoePoints = positiveOr(
    input.bottomRecoveryRoePoints,
    2,
  );
  const maxAddOnLossRoePercent = positiveOr(
    input.maxAddOnLossRoePercent,
    1,
  );
  if (
    !Number.isFinite(currentRoePercent) ||
    !Number.isFinite(worstRoePercent)
  )
    return denied("ADD_ON_MARK_STALE");
  const recoveryFromTroughRoePoints = Math.max(
    0,
    currentRoePercent - worstRoePercent,
  );
  if (input.mode === "PROFIT_SCALE_IN") {
    const givebackFromPeakRoePoints = Math.max(
      0,
      bestRoePercent - currentRoePercent,
    );
    const maxGiveback = positiveOr(input.maxProfitGivebackRoePoints, 1.5);
    if (currentRoePercent <= 0)
      return {
        allowed: false,
        reason: "SCALE_IN_NOT_PROFITABLE",
        currentRoePercent: precise(currentRoePercent),
        recoveryFromTroughRoePoints: precise(recoveryFromTroughRoePoints),
      };
    if (givebackFromPeakRoePoints > maxGiveback)
      return {
        allowed: false,
        reason: "SCALE_IN_GIVEBACK_TOO_DEEP",
        currentRoePercent: precise(currentRoePercent),
        recoveryFromTroughRoePoints: precise(recoveryFromTroughRoePoints),
      };
    return {
      allowed: true,
      reason: "OK",
      currentRoePercent: precise(currentRoePercent),
      recoveryFromTroughRoePoints: precise(recoveryFromTroughRoePoints),
    };
  }
  if (currentRoePercent >= 0)
    return {
      allowed: false,
      reason: "ADD_ON_NO_LONGER_NEEDED",
      currentRoePercent: precise(currentRoePercent),
      recoveryFromTroughRoePoints: precise(recoveryFromTroughRoePoints),
    };
  if (currentRoePercent < -maxAddOnLossRoePercent)
    return {
      allowed: false,
      reason: "LOSS_EXCEEDS_ADD_ON_RANGE",
      currentRoePercent: precise(currentRoePercent),
      recoveryFromTroughRoePoints: precise(recoveryFromTroughRoePoints),
    };
  if (recoveryFromTroughRoePoints < bottomRecoveryRoePoints)
    return {
      allowed: false,
      reason: "ADD_ON_REBOUND_LOST",
      currentRoePercent: precise(currentRoePercent),
      recoveryFromTroughRoePoints: precise(recoveryFromTroughRoePoints),
    };
  return {
    allowed: true,
    reason: "OK",
    currentRoePercent: precise(currentRoePercent),
    recoveryFromTroughRoePoints: precise(recoveryFromTroughRoePoints),
  };
}

export function combinePositionAddition(input: {
  currentQuantity: number;
  currentEntryPrice: number;
  addedQuantity: number;
  addedEntryPrice: number;
}) {
  const currentQuantity = positive(input.currentQuantity, "当前仓位数量");
  const currentEntryPrice = positive(input.currentEntryPrice, "当前开仓均价");
  const addedQuantity = positive(input.addedQuantity, "补仓成交数量");
  const addedEntryPrice = positive(input.addedEntryPrice, "补仓成交价格");
  const combinedQuantity = currentQuantity + addedQuantity;
  const combinedEntryPrice =
    (currentQuantity * currentEntryPrice + addedQuantity * addedEntryPrice) /
    combinedQuantity;
  return {
    combinedQuantity: precise(combinedQuantity),
    combinedEntryPrice: precise(combinedEntryPrice),
  };
}

export function estimatePositionAdditionNetEffect(input: {
  previousQuantity: number;
  previousEntryPrice: number;
  addedQuantity: number;
  addedEntryPrice: number;
  leverage: number;
  grossAdditionRoePercent: number;
  grossCompositeRoeImprovement: number;
  estimatedRoundTripFeePercent?: number;
}) {
  const previousQuantity = positive(input.previousQuantity, "补仓前数量");
  const previousEntryPrice = positive(input.previousEntryPrice, "补仓前均价");
  const addedQuantity = positive(input.addedQuantity, "补仓数量");
  const addedEntryPrice = positive(input.addedEntryPrice, "补仓价格");
  const leverage = positive(input.leverage, "杠杆");
  const grossAdditionRoePercent = finite(
    input.grossAdditionRoePercent,
    "补仓腿毛ROE",
  );
  const grossCompositeRoeImprovement = finite(
    input.grossCompositeRoeImprovement,
    "组合仓位毛ROE改善",
  );
  const roundTripFeePercent = nonNegative(
    input.estimatedRoundTripFeePercent ?? 0.08,
    "预估双边手续费率",
  );
  const previousNotional = previousQuantity * previousEntryPrice;
  const addedNotional = addedQuantity * addedEntryPrice;
  const addedNotionalWeight = addedNotional / (previousNotional + addedNotional);
  const estimatedAdditionFeeRoePercent = roundTripFeePercent * leverage;
  const estimatedCompositeFeeRoePercent =
    estimatedAdditionFeeRoePercent * addedNotionalWeight;
  return {
    addedNotionalWeight: precise(addedNotionalWeight),
    estimatedRoundTripFeePercent: roundTripFeePercent,
    estimatedAdditionFeeRoePercent: precise(
      estimatedAdditionFeeRoePercent,
    ),
    estimatedCompositeFeeRoePercent: precise(
      estimatedCompositeFeeRoePercent,
    ),
    netAdditionRoePercent: precise(
      grossAdditionRoePercent - estimatedAdditionFeeRoePercent,
    ),
    netCompositeRoeImprovement: precise(
      grossCompositeRoeImprovement - estimatedCompositeFeeRoePercent,
    ),
  };
}

function positive(value: unknown, label: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0)
    throw new Error(`${label}必须大于 0`);
  return numeric;
}

function finite(value: unknown, label: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`${label}必须为有效数字`);
  return numeric;
}

function nonNegative(value: unknown, label: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0)
    throw new Error(`${label}不能小于 0`);
  return numeric;
}

function positiveOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function finiteOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function denied(reason: PositionAdditionRevalidationReason) {
  return {
    allowed: false,
    reason,
    currentRoePercent: null,
    recoveryFromTroughRoePoints: null,
  };
}

function precise(value: number) {
  return Number(value.toPrecision(15));
}
