import type { LiveOrderEvent } from "./workspace-model.ts";

export function liveOrderPurposeLabel(
  purpose: LiveOrderEvent["purpose"],
) {
  return {
    ENTRY: "开仓",
    ADDITION: "补仓",
    REDUCTION: "平仓",
    UNKNOWN: "交易",
  }[purpose ?? "UNKNOWN"];
}

export function liveOrderActionLabel(
  order: Pick<LiveOrderEvent, "side" | "positionSide" | "purpose">,
) {
  if (order.purpose === "REDUCTION") {
    return order.positionSide === "LONG" ? "卖出平多" : "买入平空";
  }
  if (order.purpose === "ADDITION") {
    return order.positionSide === "LONG" ? "买入加多" : "卖出加空";
  }
  if (order.purpose === "ENTRY") {
    return order.positionSide === "LONG" ? "买入开多" : "卖出开空";
  }
  return order.side === "BUY" ? "买入" : "卖出";
}
