export const CANCEL_ORDER_RECONCILIATION_VERSION =
  "cancel-order-reconciliation-v1" as const;

type ExchangeCallResult<T> = {
  data: T;
  latencyMs?: number;
  clockLatencyMs?: number;
  usedWeight?: number | null;
};

export type CancelOrderReconciliation<T> =
  | {
      state: "RESOLVED";
      source: "CANCEL" | "QUERY_AFTER_CANCEL_RACE";
      result: ExchangeCallResult<T>;
    }
  | {
      state: "WAIT";
      source: "CANCEL_AND_QUERY_NOT_YET_VISIBLE";
    };

export function exchangeOrderNotFound(error: unknown) {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = Number(candidate.code);
  const message = String(candidate.message ?? "");
  return code === -2011 || code === -2013 ||
    /unknown order sent|order does not exist/i.test(message);
}

/**
 * A limit order can fill between the last local/private-stream snapshot and
 * the cancellation request. Binance then answers the cancel with -2011 even
 * though the original order is already terminal. Resolve that race by looking
 * up the exact clientOrderId before the caller changes any local state.
 */
export async function cancelOrderWithImmediateReconciliation<T>(input: {
  cancel: () => Promise<ExchangeCallResult<T>>;
  query: () => Promise<ExchangeCallResult<T>>;
}): Promise<CancelOrderReconciliation<T>> {
  try {
    return {
      state: "RESOLVED",
      source: "CANCEL",
      result: await input.cancel(),
    };
  } catch (error) {
    if (!exchangeOrderNotFound(error)) throw error;
    try {
      return {
        state: "RESOLVED",
        source: "QUERY_AFTER_CANCEL_RACE",
        result: await input.query(),
      };
    } catch (queryError) {
      if (!exchangeOrderNotFound(queryError)) throw queryError;
      return {
        state: "WAIT",
        source: "CANCEL_AND_QUERY_NOT_YET_VISIBLE",
      };
    }
  }
}

export function exchangeOrderLifecycleTerminal(status: unknown) {
  return ["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(
    String(status ?? "").toUpperCase(),
  );
}
