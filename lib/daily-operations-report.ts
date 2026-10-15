import { strategyTraceIdFromClientOrderId } from "./strategy-order-attribution.ts";

export type DailyOperationsOrder = {
  id: number;
  accountId: string;
  clientOrderId: string;
  status: string;
  estimatedNotional: number;
  createdAtMs: number;
  countable?: boolean;
};

export type DailyOperationsTrace = {
  id: number;
  strategyId: number;
  configVersion: number;
};

export type DailyOperationsStrategy = {
  id: number;
  name: string;
};

export type DailyOperationsPosition = {
  id: number;
  sourceEventId: number;
  accountId: string;
  status: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  realizedPnl: number;
  exitReason: string | null;
  closedAtMs: number | null;
};

export type DailyOperationsReduction = {
  id: number;
  positionId: number;
  reason: string;
  accountingPnl: number;
  createdAtMs: number;
};

export type DailyOperationsReportRow = {
  key: string;
  sourceType: "STRATEGY" | "MANUAL";
  strategyId: number | null;
  strategyName: string;
  configVersion: number | null;
  accountId: string;
  orderCount: number;
  filledOrderCount: number;
  orderNotional: number;
  closeCount: number;
  automaticCloseCount: number;
  manualCloseCount: number;
  realizedPnl: number;
  automaticClosePnl: number;
  openPositionCount: number;
  unrealizedPnl: number;
};

export type DailyOperationsReport = {
  total: Omit<DailyOperationsReportRow, "key" | "strategyName" | "accountId">;
  rows: DailyOperationsReportRow[];
};

export type DailyOperationsReportOptions = {
  includeLedger?: boolean;
  includeCurrentExposure?: boolean;
};

const FILLED_ORDER_STATUSES = new Set(["FILLED", "SUBMITTED"]);
const AUTOMATIC_CLOSE_REASONS = new Set([
  "STOP_LOSS",
  "TAKE_PROFIT",
  "TRAILING_STOP",
  "TIME_EXIT",
]);

function emptyRow(
  key: string,
  sourceType: "STRATEGY" | "MANUAL",
  strategyId: number | null,
  strategyName: string,
  configVersion: number | null,
  accountId: string,
): DailyOperationsReportRow {
  return {
    key,
    sourceType,
    strategyId,
    strategyName,
    configVersion,
    accountId,
    orderCount: 0,
    filledOrderCount: 0,
    orderNotional: 0,
    closeCount: 0,
    automaticCloseCount: 0,
    manualCloseCount: 0,
    realizedPnl: 0,
    automaticClosePnl: 0,
    openPositionCount: 0,
    unrealizedPnl: 0,
  };
}

function positionUnrealizedPnl(position: DailyOperationsPosition) {
  const direction = position.positionSide === "SHORT" ? -1 : 1;
  return (position.markPrice - position.entryPrice) *
    position.quantity * direction;
}

export function isAutomaticCloseReason(reason: string | null | undefined) {
  return AUTOMATIC_CLOSE_REASONS.has(String(reason ?? "").toUpperCase());
}

export function buildDailyOperationsReport(input: {
  startedAtMs: number;
  endedAtMs: number;
  orders: DailyOperationsOrder[];
  traces: DailyOperationsTrace[];
  strategies: DailyOperationsStrategy[];
  positions: DailyOperationsPosition[];
  reductions: DailyOperationsReduction[];
}, options: DailyOperationsReportOptions = {}) {
  const includeLedger = options.includeLedger !== false;
  const includeCurrentExposure = options.includeCurrentExposure !== false;
  const orderById = new Map(input.orders.map((order) => [order.id, order]));
  const traceById = new Map(input.traces.map((trace) => [trace.id, trace]));
  const strategyById = new Map(
    input.strategies.map((strategy) => [strategy.id, strategy]),
  );
  const positionById = new Map(
    input.positions.map((position) => [position.id, position]),
  );
  const reductionsByPosition = new Map<number, DailyOperationsReduction[]>();
  for (const reduction of input.reductions) {
    const rows = reductionsByPosition.get(reduction.positionId) ?? [];
    rows.push(reduction);
    reductionsByPosition.set(reduction.positionId, rows);
  }
  const rows = new Map<string, DailyOperationsReportRow>();

  const sourceForOrder = (
    order: DailyOperationsOrder | undefined,
    fallbackAccountId?: string,
  ) => {
    const traceId = order
      ? strategyTraceIdFromClientOrderId(order.clientOrderId)
      : null;
    const trace = traceId === null ? null : traceById.get(traceId) ?? null;
    const strategy = trace ? strategyById.get(trace.strategyId) ?? null : null;
    if (!order || !trace || !strategy) {
      const accountId = order?.accountId ?? fallbackAccountId ?? "历史未归属";
      return {
        key: `MANUAL:${accountId}`,
        sourceType: "MANUAL" as const,
        strategyId: null,
        strategyName: "人工下单（含半自动确认）",
        configVersion: null,
        accountId,
      };
    }
    return {
      key: `STRATEGY:${order.accountId}:${strategy.id}:V${trace.configVersion}`,
      sourceType: "STRATEGY" as const,
      strategyId: strategy.id,
      strategyName: strategy.name,
      configVersion: trace.configVersion,
      accountId: order.accountId,
    };
  };

  const rowForOrder = (
    order: DailyOperationsOrder | undefined,
    fallbackAccountId?: string,
  ) => {
    const source = sourceForOrder(order, fallbackAccountId);
    const existing = rows.get(source.key);
    if (existing) return existing;
    const created = emptyRow(
      source.key,
      source.sourceType,
      source.strategyId,
      source.strategyName,
      source.configVersion,
      source.accountId,
    );
    rows.set(source.key, created);
    return created;
  };

  for (const order of includeLedger ? input.orders : []) {
    if (
      order.countable === false ||
      order.createdAtMs < input.startedAtMs ||
      order.createdAtMs >= input.endedAtMs
    ) continue;
    const row = rowForOrder(order);
    row.orderCount += 1;
    row.orderNotional += order.estimatedNotional;
    if (FILLED_ORDER_STATUSES.has(order.status)) row.filledOrderCount += 1;
  }

  for (const reduction of includeLedger ? input.reductions : []) {
    if (
      reduction.createdAtMs < input.startedAtMs ||
      reduction.createdAtMs >= input.endedAtMs
    ) continue;
    const position = positionById.get(reduction.positionId);
    const row = rowForOrder(
      position ? orderById.get(position.sourceEventId) : undefined,
      position?.accountId,
    );
    const automatic = isAutomaticCloseReason(reduction.reason);
    row.closeCount += 1;
    row.realizedPnl += reduction.accountingPnl;
    if (automatic) {
      row.automaticCloseCount += 1;
      row.automaticClosePnl += reduction.accountingPnl;
    } else {
      row.manualCloseCount += 1;
    }
  }

  // Some historical full closes predate the reduction ledger. Preserve them
  // once without double-counting positions that already have close legs.
  for (const position of includeLedger ? input.positions : []) {
    if (
      position.status !== "CLOSED" ||
      position.closedAtMs === null ||
      position.closedAtMs < input.startedAtMs ||
      position.closedAtMs >= input.endedAtMs ||
      (reductionsByPosition.get(position.id)?.length ?? 0) > 0
    ) continue;
    const row = rowForOrder(
      orderById.get(position.sourceEventId),
      position.accountId,
    );
    const automatic = isAutomaticCloseReason(position.exitReason);
    row.closeCount += 1;
    row.realizedPnl += position.realizedPnl;
    if (automatic) {
      row.automaticCloseCount += 1;
      row.automaticClosePnl += position.realizedPnl;
    } else {
      row.manualCloseCount += 1;
    }
  }

  // Current exposure is intentionally independent from the selected ledger
  // window. It answers the operational question: what remains open now, and
  // which strategy or manual entry owns that exposure?
  for (const position of includeCurrentExposure ? input.positions : []) {
    if (position.status === "CLOSED") continue;
    const row = rowForOrder(
      orderById.get(position.sourceEventId),
      position.accountId,
    );
    row.openPositionCount += 1;
    row.unrealizedPnl += positionUnrealizedPnl(position);
  }

  return dailyOperationsReportFromRows([...rows.values()]);
}

function dailyOperationsReportFromRows(inputRows: DailyOperationsReportRow[]) {
  const reportRows = [...inputRows].sort((left, right) => {
    if (left.sourceType !== right.sourceType)
      return left.sourceType === "STRATEGY" ? -1 : 1;
    if (left.strategyName !== right.strategyName)
      return left.strategyName.localeCompare(right.strategyName, "zh-CN");
    return (right.configVersion ?? 0) - (left.configVersion ?? 0);
  });
  const total = reportRows.reduce(
    (sum, row) => ({
      sourceType: "STRATEGY" as const,
      strategyId: null,
      configVersion: null,
      orderCount: sum.orderCount + row.orderCount,
      filledOrderCount: sum.filledOrderCount + row.filledOrderCount,
      orderNotional: sum.orderNotional + row.orderNotional,
      closeCount: sum.closeCount + row.closeCount,
      automaticCloseCount:
        sum.automaticCloseCount + row.automaticCloseCount,
      manualCloseCount: sum.manualCloseCount + row.manualCloseCount,
      realizedPnl: sum.realizedPnl + row.realizedPnl,
      automaticClosePnl:
        sum.automaticClosePnl + row.automaticClosePnl,
      openPositionCount: sum.openPositionCount + row.openPositionCount,
      unrealizedPnl: sum.unrealizedPnl + row.unrealizedPnl,
    }),
    {
      sourceType: "STRATEGY" as const,
      strategyId: null,
      configVersion: null,
      orderCount: 0,
      filledOrderCount: 0,
      orderNotional: 0,
      closeCount: 0,
      automaticCloseCount: 0,
      manualCloseCount: 0,
      realizedPnl: 0,
      automaticClosePnl: 0,
      openPositionCount: 0,
      unrealizedPnl: 0,
    },
  );
  return { total, rows: reportRows } satisfies DailyOperationsReport;
}

export function mergeDailyOperationsReportRows(
  rowGroups: readonly (readonly DailyOperationsReportRow[])[],
) {
  const merged = new Map<string, DailyOperationsReportRow>();
  for (const rows of rowGroups) {
    for (const row of rows) {
      const existing = merged.get(row.key);
      if (!existing) {
        merged.set(row.key, { ...row });
        continue;
      }
      existing.orderCount += row.orderCount;
      existing.filledOrderCount += row.filledOrderCount;
      existing.orderNotional += row.orderNotional;
      existing.closeCount += row.closeCount;
      existing.automaticCloseCount += row.automaticCloseCount;
      existing.manualCloseCount += row.manualCloseCount;
      existing.realizedPnl += row.realizedPnl;
      existing.automaticClosePnl += row.automaticClosePnl;
      existing.openPositionCount += row.openPositionCount;
      existing.unrealizedPnl += row.unrealizedPnl;
    }
  }
  return dailyOperationsReportFromRows([...merged.values()]);
}
