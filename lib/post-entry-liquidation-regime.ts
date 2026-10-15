import type {
  GlobalLiquidationContext,
  LiquidationWindowSnapshot,
} from "./coinglass-web-liquidations.ts";

export type PostEntryLiquidationRegime = {
  status: "FAVORABLE" | "NEUTRAL" | "ADVERSE" | "UNAVAILABLE";
  positionSide: "LONG" | "SHORT";
  oneHourDominantSide:
    | "LONG_LIQUIDATIONS"
    | "SHORT_LIQUIDATIONS"
    | "MIXED"
    | null;
  oneHourDominantSharePercent: number | null;
  fourHourConfirms: boolean | null;
  orderAffecting: false;
  usage: "POST_ENTRY_POSITION_MANAGEMENT_ONLY";
  reason: string;
};

/**
 * 全市场爆仓失衡只解释成交后的波段环境。
 *
 * 它不能放行、拒绝或改变入场订单；对盈利仓只决定是否应进入利润保护，
 * 对亏损仓也必须与单合约支撑破位等证据共振，不能单独触发平仓。
 */
export function analyzePostEntryLiquidationRegime(input: {
  context: GlobalLiquidationContext;
  positionSide: "LONG" | "SHORT";
}): PostEntryLiquidationRegime {
  const oneHour = windowAt(input.context.windows, 1);
  const fourHour = windowAt(input.context.windows, 4);
  if (
    input.context.status === "UNAVAILABLE" ||
    !oneHour
  ) {
    return unavailablePostEntryLiquidationRegime(
      input.positionSide,
      input.context.error ?? "1小时全市场爆仓数据不足",
    );
  }

  const favorableDominantSide =
    input.positionSide === "LONG"
      ? "SHORT_LIQUIDATIONS"
      : "LONG_LIQUIDATIONS";
  const adverseDominantSide =
    input.positionSide === "LONG"
      ? "LONG_LIQUIDATIONS"
      : "SHORT_LIQUIDATIONS";
  const status =
    oneHour.dominantSide === favorableDominantSide
      ? "FAVORABLE"
      : oneHour.dominantSide === adverseDominantSide
        ? "ADVERSE"
        : "NEUTRAL";
  const fourHourConfirms =
    fourHour?.dominantSide === "MIXED"
      ? false
      : fourHour
        ? fourHour.dominantSide === oneHour.dominantSide
        : null;
  const sideLabel = input.positionSide === "LONG" ? "多仓" : "空仓";
  const pressureLabel =
    oneHour.dominantSide === "LONG_LIQUIDATIONS"
      ? "多头去杠杆"
      : oneHour.dominantSide === "SHORT_LIQUIDATIONS"
        ? "空头挤压"
        : "多空爆仓接近";
  const statusLabel =
    status === "FAVORABLE"
      ? "顺风"
      : status === "ADVERSE"
        ? "逆风"
        : "中性";

  return {
    status,
    positionSide: input.positionSide,
    oneHourDominantSide: oneHour.dominantSide,
    oneHourDominantSharePercent: round(oneHour.dominantShare * 100),
    fourHourConfirms,
    orderAffecting: false,
    usage: "POST_ENTRY_POSITION_MANAGEMENT_ONLY",
    reason:
      `成交后持仓环境：1小时${pressureLabel}占比 ${(
        oneHour.dominantShare * 100
      ).toFixed(1)}%，对${sideLabel}${statusLabel}` +
      (fourHourConfirms === true
        ? "，4小时同向确认"
        : fourHourConfirms === false
          ? "，4小时未同向确认"
          : "，4小时数据不足") +
      "；不参与入场判断。",
  };
}

export function unavailablePostEntryLiquidationRegime(
  positionSide: "LONG" | "SHORT",
  reason = "全市场爆仓数据暂不可用",
): PostEntryLiquidationRegime {
  return {
    status: "UNAVAILABLE",
    positionSide,
    oneHourDominantSide: null,
    oneHourDominantSharePercent: null,
    fourHourConfirms: null,
    orderAffecting: false,
    usage: "POST_ENTRY_POSITION_MANAGEMENT_ONLY",
    reason: `${reason}；本轮不据此改变持仓判断，也不参与入场判断。`,
  };
}

function windowAt(
  windows: LiquidationWindowSnapshot[],
  hours: LiquidationWindowSnapshot["hours"],
) {
  return windows.find((row) => row.hours === hours) ?? null;
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
