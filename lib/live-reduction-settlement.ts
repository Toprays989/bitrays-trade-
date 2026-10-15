import {
  getBinanceLiveFundingIncomeRange,
  getBinanceLiveOrderTrades,
} from "./binance-usdm-live";
import { buildReductionSettlement } from "./live-reduction-accounting";
import type { FinalPositionFundingContext } from "./live-position-funding";

export {
  attachReductionSettlement,
  buildReductionSettlement,
  reductionAccountingPnl,
  type ReductionSettlement,
} from "./live-reduction-accounting";

export async function resolveReductionSettlement(input: {
  credentials: { apiKey: string; secretKey: string };
  symbol: string;
  exitOrderId: string | number;
  entryOrderId: string | number | null;
  additionalEntryOrders?: Array<{
    orderId: string | number;
    quantity: number | null;
  }>;
  localGrossRealizedPnl: number;
  executedQuantity: number;
  entryOrderQuantity: number | null;
  finalPositionFunding: FinalPositionFundingContext | null;
}) {
  const entryOrders = uniqueEntryOrders([
    ...(input.entryOrderId === null
      ? []
      : [{
          orderId: input.entryOrderId,
          quantity: input.entryOrderQuantity,
        }]),
    ...(input.additionalEntryOrders ?? []),
  ]);
  const [exitResult, ...entryResults] = await Promise.allSettled([
    loadOrderTradesWithConsistencyRetry(input.credentials, input.symbol, input.exitOrderId),
    ...entryOrders.map((entry) =>
      loadOrderTradesWithConsistencyRetry(
        input.credentials,
        input.symbol,
        entry.orderId,
      )
    ),
  ]);
  const exitTrades = exitResult.status === "fulfilled" ? exitResult.value : [];
  const allEntryOrdersResolved =
    entryOrders.length > 0 &&
    entryResults.length === entryOrders.length &&
    entryResults.every(
      (result) => result.status === "fulfilled" && result.value.length > 0,
    );
  const entryTrades = allEntryOrdersResolved
    ? entryResults.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      )
    : [];
  const entryOrderQuantity = entryOrders.reduce(
    (sum, entry) =>
      sum +
      (
          Number.isFinite(Number(entry.quantity)) &&
            Number(entry.quantity) > 0
        ? Number(entry.quantity)
        : 0
      ),
    0,
  );
  const funding = await resolveFundingSettlement(
    input.credentials,
    input.symbol,
    input.finalPositionFunding,
    exitTrades,
  );
  return buildReductionSettlement({
    localGrossRealizedPnl: input.localGrossRealizedPnl,
    executedQuantity: input.executedQuantity,
    entryOrderQuantity:
      entryOrderQuantity > 0 ? entryOrderQuantity : input.entryOrderQuantity,
    exitTrades,
    entryTrades,
    ...funding,
  });
}

function uniqueEntryOrders(
  rows: Array<{ orderId: string | number; quantity: number | null }>,
) {
  const unique = new Map<
    string,
    { orderId: string | number; quantity: number | null }
  >();
  for (const row of rows) {
    const key = String(row.orderId).trim();
    if (!key || unique.has(key)) continue;
    unique.set(key, row);
  }
  return [...unique.values()];
}

async function resolveFundingSettlement(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  context: FinalPositionFundingContext | null,
  exitTrades: Array<{ time?: number }>,
) {
  if (!context)
    return {
      fundingIncome: null,
      fundingAsset: null,
      fundingAttribution: "NOT_REQUESTED_PARTIAL" as const,
    };
  if (context.attribution !== "SYSTEM_UNIQUE_POSITION")
    return {
      fundingIncome: null,
      fundingAsset: null,
      fundingAttribution: context.attribution,
    };
  const fillClosedAt = exitTrades.reduce(
    (latest, trade) =>
      Number.isFinite(trade.time) ? Math.max(latest, Number(trade.time)) : latest,
    0,
  );
  const closedAtMs = Math.max(
    context.openedAtMs,
    fillClosedAt || context.closedAtMs,
  );
  try {
    const rows = await getBinanceLiveFundingIncomeRange(
      credentials,
      symbol,
      context.openedAtMs,
      closedAtMs,
    );
    const assets = new Set(rows.map((row) => row.asset));
    const fundingAsset = assets.size === 1
      ? [...assets][0]!
      : assets.size === 0 && symbol.trim().toUpperCase().endsWith("USDT")
        ? "USDT"
        : null;
    if (fundingAsset === null)
      return {
        fundingIncome: null,
        fundingAsset: null,
        fundingAttribution: "UNAVAILABLE" as const,
      };
    return {
      fundingIncome: rows.reduce((sum, row) => sum + row.income, 0),
      fundingAsset,
      fundingAttribution: "SYSTEM_UNIQUE_POSITION" as const,
    };
  } catch {
    return {
      fundingIncome: null,
      fundingAsset: null,
      fundingAttribution: "UNAVAILABLE" as const,
    };
  }
}

async function loadOrderTradesWithConsistencyRetry(
  credentials: { apiKey: string; secretKey: string },
  symbol: string,
  orderId: string | number,
) {
  const first = await getBinanceLiveOrderTrades(credentials, symbol, orderId);
  if (first.length) return first;
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  return getBinanceLiveOrderTrades(credentials, symbol, orderId);
}
