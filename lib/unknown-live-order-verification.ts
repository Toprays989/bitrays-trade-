import {
  liveOrderStatusFromExchange,
  type LiveOrderStatus,
} from "./live-order-status.ts";

type LiveKeys = { apiKey: string; secretKey: string };

export const UNKNOWN_ORDER_VISIBILITY_GRACE_MS = 5_000;

type ExchangeOrderResult = {
  orderId?: string | number;
  clientOrderId?: string;
  status?: string;
  executedQty?: string;
  avgPrice?: string;
  cumQuote?: string;
  price?: string;
  time?: number;
  updateTime?: number;
};

export type UnknownLiveOrderVerification = {
  resolved: boolean;
  status: LiveOrderStatus;
  exchangeOrderId: string | null;
  response: Record<string, unknown>;
  reason:
    | "VALID_WORKING_ORDER"
    | "CONFIRMED_NO_FILL"
    | "ORDER_NOT_FOUND"
    | "ORDER_VISIBILITY_GRACE"
    | "EXECUTION_REQUIRES_POSITION_RECOVERY"
    | "CANCELED_UNKNOWN_EXCHANGE_STATE"
    | "QUERY_FAILED";
};

type VerificationDependencies = {
  query: (
    credentials: LiveKeys,
    symbol: string,
    clientOrderId: string,
  ) => Promise<{ data: ExchangeOrderResult }>;
  cancel: (
    credentials: LiveKeys,
    symbol: string,
    clientOrderId: string,
  ) => Promise<{ data: ExchangeOrderResult }>;
};

function exchangeErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = Number((error as { code?: unknown }).code);
  return Number.isFinite(code) ? code : null;
}

function exchangeOrderId(data: ExchangeOrderResult) {
  const value = String(data.orderId ?? "").trim();
  return value || null;
}

function executedQuantity(data: ExchangeOrderResult) {
  const value = Number(data.executedQty);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function verifiedResult(
  data: ExchangeOrderResult,
): UnknownLiveOrderVerification {
  const quantity = executedQuantity(data);
  const status = liveOrderStatusFromExchange(data.status, quantity);
  const response = { ...data };
  if (quantity > 0 && ["FILLED", "CANCELED", "EXPIRED"].includes(status))
    return {
      resolved: false,
      status: "EXECUTION_UNKNOWN",
      exchangeOrderId: exchangeOrderId(data),
      response,
      reason: "EXECUTION_REQUIRES_POSITION_RECOVERY",
    };
  if (["NEW", "PARTIALLY_FILLED"].includes(status))
    return {
      resolved: true,
      status,
      exchangeOrderId: exchangeOrderId(data),
      response,
      reason: "VALID_WORKING_ORDER",
    };
  if (["CANCELED", "EXPIRED", "REJECTED"].includes(status))
    return {
      resolved: true,
      status,
      exchangeOrderId: exchangeOrderId(data),
      response,
      reason: "CONFIRMED_NO_FILL",
    };
  return {
    resolved: false,
    status: "EXECUTION_UNKNOWN",
    exchangeOrderId: exchangeOrderId(data),
    response,
    reason: "QUERY_FAILED",
  };
}

export async function verifyUnknownLiveOrder(
  input: {
    credentials: LiveKeys;
    symbol: string;
    clientOrderId: string;
    createdAtMs?: number;
    nowMs?: number;
    visibilityGraceMs?: number;
  },
  dependencies: VerificationDependencies,
): Promise<UnknownLiveOrderVerification> {
  const { query, cancel } = dependencies;
  try {
    const queried = await query(
      input.credentials,
      input.symbol,
      input.clientOrderId,
    );
    const result = verifiedResult(queried.data);
    if (result.reason !== "QUERY_FAILED") return result;
    try {
      const canceled = await cancel(
        input.credentials,
        input.symbol,
        input.clientOrderId,
      );
      const canceledResult = verifiedResult(canceled.data);
      if (
        canceledResult.reason === "CONFIRMED_NO_FILL" ||
        canceledResult.reason === "VALID_WORKING_ORDER"
      )
        return {
          ...canceledResult,
          reason: "CANCELED_UNKNOWN_EXCHANGE_STATE",
        };
      return canceledResult;
    } catch (error) {
      if (exchangeErrorCode(error) === -2013)
        return {
          resolved: true,
          status: "CANCELED",
          exchangeOrderId: null,
          response: { exchangeCode: -2013 },
          reason: "ORDER_NOT_FOUND",
        };
      return result;
    }
  } catch (error) {
    if (exchangeErrorCode(error) === -2013) {
      const nowMs = Number.isFinite(input.nowMs)
        ? Number(input.nowMs)
        : Date.now();
      const visibilityGraceMs = Math.max(
        0,
        Math.trunc(
          Number.isFinite(input.visibilityGraceMs)
            ? Number(input.visibilityGraceMs)
            : UNKNOWN_ORDER_VISIBILITY_GRACE_MS,
        ),
      );
      const createdAtMs = Number(input.createdAtMs);
      const ageMs = Number.isFinite(createdAtMs)
        ? Math.max(0, nowMs - createdAtMs)
        : visibilityGraceMs;
      if (ageMs < visibilityGraceMs)
        return {
          resolved: false,
          status: "EXECUTION_UNKNOWN",
          exchangeOrderId: null,
          response: {
            exchangeCode: -2013,
            ageMs,
            visibilityGraceMs,
          },
          reason: "ORDER_VISIBILITY_GRACE",
        };
      try {
        const canceled = await cancel(
          input.credentials,
          input.symbol,
          input.clientOrderId,
        );
        const canceledResult = verifiedResult(canceled.data);
        if (
          canceledResult.reason === "CONFIRMED_NO_FILL" ||
          canceledResult.reason === "VALID_WORKING_ORDER"
        )
          return {
            ...canceledResult,
            response: {
              ...canceledResult.response,
              queryExchangeCode: -2013,
              ageMs,
              visibilityGraceMs,
            },
            reason: "CANCELED_UNKNOWN_EXCHANGE_STATE",
          };
        return canceledResult;
      } catch (cancelError) {
        if (exchangeErrorCode(cancelError) === -2013)
          return {
            resolved: true,
            status: "CANCELED",
            exchangeOrderId: null,
            response: {
              queryExchangeCode: -2013,
              cancelExchangeCode: -2013,
              ageMs,
              visibilityGraceMs,
            },
            reason: "ORDER_NOT_FOUND",
          };
        return {
          resolved: false,
          status: "EXECUTION_UNKNOWN",
          exchangeOrderId: null,
          response: {
            queryExchangeCode: -2013,
            ageMs,
            visibilityGraceMs,
            cancelError:
              cancelError instanceof Error
                ? cancelError.message
                : "未知撤单错误",
          },
          reason: "QUERY_FAILED",
        };
      }
    }
    return {
      resolved: false,
      status: "EXECUTION_UNKNOWN",
      exchangeOrderId: null,
      response: {
        error: error instanceof Error ? error.message : "未知核对错误",
      },
      reason: "QUERY_FAILED",
    };
  }
}
