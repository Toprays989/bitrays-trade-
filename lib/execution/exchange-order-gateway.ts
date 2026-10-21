/**
 * Single application boundary for exchange order mutations and order-state
 * reconciliation. Market-data readers remain in binance-usdm-live; business
 * domains must not import these order operations from the adapter directly.
 */
export {
  cancelLiveOrder,
  getLivePositionSnapshot,
  queryLiveOrder,
  submitLiveEntryOrder,
  submitLiveReduceLimitFokOrder,
  submitLiveReduceMarketOrder,
} from "../binance-usdm-live.ts";

export const EXCHANGE_ORDER_GATEWAY_VERSION =
  "exchange-order-gateway-v1" as const;

