export type OrderTradeAccounting = {
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  quantity?: number;
  price?: number;
  quoteQuantity?: number;
};

export type ReductionSettlement = {
  version: 2;
  source: "BINANCE_USER_TRADES" | "LOCAL_PRICE_FALLBACK";
  grossRealizedPnl: number;
  exitCommission: number | null;
  entryCommissionAllocated: number | null;
  commissionAsset: string | null;
  netRealizedPnl: number | null;
  exactNetAvailable: boolean;
  fundingIncome: number | null;
  fundingAsset: string | null;
  fundingAttribution:
    | "NOT_REQUESTED_PARTIAL"
    | "SYSTEM_UNIQUE_POSITION"
    | "OVERLAPPING_POSITION"
    | "UNAVAILABLE";
  exitFillCount: number;
  entryFillCount: number;
  entryQuantityBasis?: number | null;
  exitAveragePrice?: number | null;
  exitQuantityBasis?: number | null;
  tradeDetailsStatus?: "AVAILABLE" | "PENDING" | "UNAVAILABLE";
};

export function buildReductionSettlement(input: {
  localGrossRealizedPnl: number;
  executedQuantity: number;
  entryOrderQuantity: number | null;
  entryTrades: OrderTradeAccounting[];
  exitTrades: OrderTradeAccounting[];
  fundingIncome?: number | null;
  fundingAsset?: string | null;
  fundingAttribution?: ReductionSettlement["fundingAttribution"];
}): ReductionSettlement {
  const exitGross = input.exitTrades.length ? input.exitTrades.reduce((sum, trade) => sum + trade.realizedPnl, 0) : input.localGrossRealizedPnl;
  const exitQuantityBasis = input.exitTrades.reduce(
    (sum, trade) =>
      sum +
      (Number.isFinite(Number(trade.quantity)) && Number(trade.quantity) > 0
        ? Number(trade.quantity)
        : 0),
    0,
  );
  const exitQuoteBasis = input.exitTrades.reduce((sum, trade) => {
    const quoteQuantity = Number(trade.quoteQuantity);
    if (Number.isFinite(quoteQuantity) && quoteQuantity > 0)
      return sum + quoteQuantity;
    const price = Number(trade.price);
    const quantity = Number(trade.quantity);
    return Number.isFinite(price) && price > 0 && Number.isFinite(quantity) && quantity > 0
      ? sum + price * quantity
      : sum;
  }, 0);
  const exitAveragePrice =
    exitQuantityBasis > 0 && exitQuoteBasis > 0
      ? exitQuoteBasis / exitQuantityBasis
      : null;
  const exitFees = summarizeCommission(input.exitTrades);
  const entryFees = summarizeCommission(input.entryTrades);
  const entryFilledQuantity = input.entryTrades.reduce(
    (sum, trade) =>
      sum +
      (
          Number.isFinite(Number(trade.quantity)) &&
            Number(trade.quantity) > 0
        ? Number(trade.quantity)
        : 0
      ),
    0,
  );
  const entryQuantityBasis = entryFilledQuantity > 0
    ? entryFilledQuantity
    : input.entryOrderQuantity && input.entryOrderQuantity > 0
      ? input.entryOrderQuantity
      : null;
  const allocationRatio = entryQuantityBasis !== null
    ? Math.min(
        1,
        Math.max(0, input.executedQuantity / entryQuantityBasis),
      )
    : null;
  const entryCommissionAllocated = allocationRatio !== null && entryFees.total !== null ? entryFees.total * allocationRatio : null;
  const feeAssets = new Set([exitFees.asset, entryFees.asset].filter((asset): asset is string => Boolean(asset)));
  const commissionAsset = feeAssets.size === 1 ? [...feeAssets][0] : null;
  const exitCommission = exitFees.total;
  const fundingAttribution = input.fundingAttribution ?? "NOT_REQUESTED_PARTIAL";
  const fundingIncome = Number.isFinite(input.fundingIncome)
    ? Number(input.fundingIncome)
    : null;
  const fundingAsset = input.fundingAsset ?? null;
  const tradeFeesExact = input.exitTrades.length > 0 && exitCommission !== null &&
    entryCommissionAllocated !== null && commissionAsset === "USDT";
  const fundingExact = fundingAttribution === "NOT_REQUESTED_PARTIAL" ||
    (fundingAttribution === "SYSTEM_UNIQUE_POSITION" &&
      fundingIncome !== null && fundingAsset === "USDT");
  const exactNetAvailable = tradeFeesExact && fundingExact;
  const tradeNet = tradeFeesExact
    ? exitGross - exitCommission! - entryCommissionAllocated!
    : null;
  const netRealizedPnl = tradeNet === null
    ? null
    : fundingAttribution === "NOT_REQUESTED_PARTIAL"
      ? tradeNet
      : fundingAttribution === "SYSTEM_UNIQUE_POSITION" &&
          fundingIncome !== null
        ? tradeNet + fundingIncome
        : null;
  return {
    version: 2,
    source: input.exitTrades.length ? "BINANCE_USER_TRADES" : "LOCAL_PRICE_FALLBACK",
    grossRealizedPnl: exitGross,
    exitCommission,
    entryCommissionAllocated,
    commissionAsset,
    netRealizedPnl,
    exactNetAvailable,
    fundingIncome,
    fundingAsset,
    fundingAttribution,
    exitFillCount: input.exitTrades.length,
    entryFillCount: input.entryTrades.length,
    entryQuantityBasis,
    exitAveragePrice,
    exitQuantityBasis: exitQuantityBasis > 0 ? exitQuantityBasis : null,
    tradeDetailsStatus: tradeFeesExact ? "AVAILABLE" : "PENDING",
  };
}

export function attachReductionSettlement(response: unknown, settlement: ReductionSettlement) {
  const base = response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : { exchangeResponse: response };
  return { ...base, nexusSettlement: settlement };
}

export function reductionAccountingPnl(input: { realizedPnl: number; responseJson?: string | null }) {
  const settlement = parseSettlement(input.responseJson);
  const exactNetAvailable = Boolean(settlement?.exactNetAvailable);
  const tradeDetailsAvailable =
    settlement?.exitCommission !== null &&
    settlement?.exitCommission !== undefined &&
    settlement?.entryCommissionAllocated !== null &&
    settlement?.entryCommissionAllocated !== undefined &&
    settlement?.commissionAsset === "USDT";
  const feeAdjustedPnl = tradeDetailsAvailable
    ? (settlement?.grossRealizedPnl ?? input.realizedPnl) -
      settlement!.exitCommission! -
      settlement!.entryCommissionAllocated!
    : null;
  const settlementStatus =
    exactNetAvailable
      ? "EXACT_NET"
      : settlement?.tradeDetailsStatus === "UNAVAILABLE"
        ? "TRADE_DETAILS_UNAVAILABLE"
      : !tradeDetailsAvailable
        ? "TRADE_DETAILS_PENDING"
        : settlement?.fundingAttribution === "OVERLAPPING_POSITION"
          ? "FUNDING_SHARED"
          : "FUNDING_PENDING";
  return {
    pnl:
      exactNetAvailable && settlement?.netRealizedPnl !== null
        ? settlement!.netRealizedPnl
        : settlement?.grossRealizedPnl ?? input.realizedPnl,
    grossRealizedPnl: settlement?.grossRealizedPnl ?? input.realizedPnl,
    netRealizedPnl: settlement?.netRealizedPnl ?? null,
    exactNetAvailable,
    tradeDetailsAvailable,
    feeAdjustedPnl,
    settlementStatus,
    commissionAsset: settlement?.commissionAsset ?? null,
    exitCommission: settlement?.exitCommission ?? null,
    entryCommissionAllocated: settlement?.entryCommissionAllocated ?? null,
    fundingIncome: settlement?.fundingIncome ?? null,
    fundingAsset: settlement?.fundingAsset ?? null,
    fundingAttribution: settlement?.fundingAttribution ?? null,
  };
}

function summarizeCommission(trades: OrderTradeAccounting[]) {
  if (!trades.length) return { total: null, asset: null };
  const assets = new Set(trades.map((trade) => trade.commissionAsset));
  if (assets.size !== 1) return { total: null, asset: null };
  return { total: trades.reduce((sum, trade) => sum + trade.commission, 0), asset: [...assets][0] || null };
}

function parseSettlement(value?: string | null): ReductionSettlement | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { nexusSettlement?: unknown };
    if (!parsed.nexusSettlement || typeof parsed.nexusSettlement !== "object" || Array.isArray(parsed.nexusSettlement)) return null;
    const candidate = parsed.nexusSettlement as Partial<ReductionSettlement>;
    if (![1, 2].includes(Number(candidate.version)) || !Number.isFinite(candidate.grossRealizedPnl) || typeof candidate.exactNetAvailable !== "boolean") return null;
    if (Number(candidate.version) === 1) {
      return {
        ...(candidate as unknown as ReductionSettlement),
        version: 2,
        exactNetAvailable: false,
        fundingIncome: null,
        fundingAsset: null,
        fundingAttribution: "UNAVAILABLE",
        tradeDetailsStatus: "UNAVAILABLE",
      };
    }
    return {
      ...(candidate as ReductionSettlement),
      tradeDetailsStatus: candidate.tradeDetailsStatus ?? (
          candidate.exitCommission !== null &&
            candidate.exitCommission !== undefined &&
            candidate.entryCommissionAllocated !== null &&
            candidate.entryCommissionAllocated !== undefined &&
            candidate.commissionAsset === "USDT"
          ? "AVAILABLE"
          : "PENDING"
        ),
    };
  } catch { return null; }
}
