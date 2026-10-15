export type StrategyFunnelTrace = {
  traceId: string;
  databaseId: number | null;
  approvedAtMs: number | null;
};

export type StrategyFunnelOrder = {
  traceDatabaseId: number | null;
  orderType?: "MARKET" | "LIMIT" | string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  hasPosition: boolean;
};

export type StrategyFunnelWaitBreakdown = {
  total: number;
  bookFreshness: number;
  analysisClockPaused: number;
  degradedContext: number;
  upstreamFetch: number;
};

export function buildStrategyFunnelWaitBreakdown(
  events: Array<{ traceId: string; eventType: string }>,
): StrategyFunnelWaitBreakdown {
  const traceIds = (eventType: string) => new Set(
    events
      .filter((event) => event.eventType === eventType)
      .map((event) => event.traceId),
  );
  const bookFreshness = traceIds("NEXUS_BOOK_EYE_STALE");
  const analysisClockPaused = traceIds("ANALYSIS_MARKET_DATA_CLOCK_PAUSED");
  const degradedContext = traceIds("NEXUS_ANALYSIS_DATA_DEGRADED");
  const upstreamFetch = traceIds("ANALYSIS_MARKET_DATA_WAIT");
  return {
    total: new Set([
      ...bookFreshness,
      ...analysisClockPaused,
      ...degradedContext,
      ...upstreamFetch,
    ]).size,
    bookFreshness: bookFreshness.size,
    analysisClockPaused: analysisClockPaused.size,
    degradedContext: degradedContext.size,
    upstreamFetch: upstreamFetch.size,
  };
}

export function buildStrategyFunnelCohort(input: {
  confirmedTraceIds: string[];
  executionAuthorizedTraceIds: string[];
  traces: StrategyFunnelTrace[];
  orders: StrategyFunnelOrder[];
}) {
  const traceById = new Map(input.traces.map((trace) => [trace.traceId, trace]));
  const ordersByTraceDatabaseId = new Map<number, StrategyFunnelOrder[]>();
  for (const order of input.orders) {
    if (!order.traceDatabaseId) continue;
    const rows = ordersByTraceDatabaseId.get(order.traceDatabaseId) ?? [];
    rows.push(order);
    ordersByTraceDatabaseId.set(order.traceDatabaseId, rows);
  }

  let filled = 0;
  let canceled = 0;
  let working = 0;
  let noOrder = 0;
  let submitted = 0;
  let orderAttempts = 0;
  let retryAttempts = 0;
  const confirmationToFirstOrderMs: number[] = [];
  const firstOrderToTerminalMs: number[] = [];
  const marketOrderToTerminalMs: number[] = [];
  const limitOrderToTerminalMs: number[] = [];

  for (const traceId of new Set(input.executionAuthorizedTraceIds)) {
    const trace = traceById.get(traceId);
    const orders = trace?.databaseId
      ? [...(ordersByTraceDatabaseId.get(trace.databaseId) ?? [])].sort(
          (left, right) => left.createdAtMs - right.createdAtMs,
        )
      : [];
    orderAttempts += orders.length;
    retryAttempts += Math.max(0, orders.length - 1);
    if (orders.length === 0) {
      noOrder += 1;
      continue;
    }
    submitted += 1;
    const firstOrder = orders[0];
    recordTypedTerminalLatency(
      orders,
      marketOrderToTerminalMs,
      limitOrderToTerminalMs,
    );
    if (
      trace?.approvedAtMs !== null &&
      trace?.approvedAtMs !== undefined &&
      firstOrder.createdAtMs >= trace.approvedAtMs
    )
      confirmationToFirstOrderMs.push(
        firstOrder.createdAtMs - trace.approvedAtMs,
      );
    if (orders.some(orderHasExecution)) {
      filled += 1;
      recordTerminalLatency(orders, firstOrderToTerminalMs);
      continue;
    }
    if (orders.some((order) => orderIsWorking(order.status))) {
      working += 1;
      continue;
    }
    canceled += 1;
    recordTerminalLatency(orders, firstOrderToTerminalMs);
  }

  const confirmed = new Set(input.confirmedTraceIds).size;
  const authorized = new Set(input.executionAuthorizedTraceIds).size;
  return {
    confirmed,
    authorized,
    submitted,
    filled,
    canceled,
    working,
    noOrder,
    orderAttempts,
    retryAttempts,
    conversionPercent: authorized > 0 ? filled / authorized * 100 : 0,
    confirmationToOrderP50Ms: percentile(confirmationToFirstOrderMs, 0.5),
    confirmationToOrderP90Ms: percentile(confirmationToFirstOrderMs, 0.9),
    orderToTerminalP50Ms: percentile(firstOrderToTerminalMs, 0.5),
    orderToTerminalP90Ms: percentile(firstOrderToTerminalMs, 0.9),
    marketOrderToTerminalP50Ms: percentile(marketOrderToTerminalMs, 0.5),
    marketOrderToTerminalP90Ms: percentile(marketOrderToTerminalMs, 0.9),
    limitOrderToTerminalP50Ms: percentile(limitOrderToTerminalMs, 0.5),
    limitOrderToTerminalP90Ms: percentile(limitOrderToTerminalMs, 0.9),
  };
}

function recordTypedTerminalLatency(
  orders: StrategyFunnelOrder[],
  marketTarget: number[],
  limitTarget: number[],
) {
  for (const order of orders) {
    if (
      !order.hasPosition &&
      !["SUBMITTED", "FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(
        order.status,
      )
    ) continue;
    const duration = order.updatedAtMs - order.createdAtMs;
    if (duration < 0) continue;
    if (order.orderType === "MARKET") marketTarget.push(duration);
    if (order.orderType === "LIMIT") limitTarget.push(duration);
  }
}

function recordTerminalLatency(
  orders: StrategyFunnelOrder[],
  target: number[],
) {
  const terminalOrders = orders.filter((order) =>
    order.hasPosition || [
      "SUBMITTED",
      "FILLED",
      "CANCELED",
      "EXPIRED",
      "REJECTED",
    ].includes(order.status)
  );
  if (terminalOrders.length === 0) return;
  const startedAt = Math.min(...orders.map((order) => order.createdAtMs));
  const terminalAt = Math.max(
    ...terminalOrders.map((order) => order.updatedAtMs),
  );
  if (terminalAt >= startedAt) target.push(terminalAt - startedAt);
}

function orderHasExecution(order: StrategyFunnelOrder) {
  return order.hasPosition || [
    "SUBMITTED",
    "PARTIALLY_FILLED",
    "FILLED",
  ].includes(order.status);
}

function orderIsWorking(status: string) {
  return [
    "PENDING",
    "NEW",
    "CANCEL_PENDING",
    "EXECUTION_UNKNOWN",
  ].includes(status);
}

function percentile(values: number[], ratio: number) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (rows.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(rows.length - 1, Math.ceil(rows.length * ratio) - 1),
  );
  return rows[index];
}
