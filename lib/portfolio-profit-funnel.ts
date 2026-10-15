export type PortfolioProfitRecord = {
  grossRealizedPnl: number;
  accountingPnl: number;
  netRealizedPnl: number | null;
  exactNetAvailable: boolean;
  tradeDetailsAvailable: boolean;
  exitCommission: number | null;
  entryCommissionAllocated: number | null;
  commissionAsset: string | null;
  fundingIncome: number | null;
  fundingAsset: string | null;
};

export type PortfolioProfitFunnel = {
  grossRealizedPnl: number;
  knownTradingCosts: number;
  knownFundingPnl: number;
  accountedRealizedPnl: number;
  exactCohortGrossRealizedPnl: number;
  exactCohortTradingCosts: number;
  exactCohortFundingPnl: number;
  exactNetRealizedPnl: number;
  pendingEstimatedRealizedPnl: number;
  unrealizedPnl: number | null;
  portfolioPnl: number | null;
  accountEquity: number | null;
  realizedRecords: number;
  exactNetRecords: number;
  pendingNetRecords: number;
  exactNetCoveragePercent: number;
  resultBasis: "EXACT_NET" | "MIXED_ESTIMATE" | "UNAVAILABLE";
  realizedProfitOffsetPercent: number | null;
  status:
    | "PROFIT_RETAINED"
    | "PROFIT_PARTLY_OFFSET"
    | "PROFIT_FULLY_OFFSET"
    | "NET_LOSS"
    | "BREAKEVEN"
    | "UNAVAILABLE";
};

export function buildPortfolioProfitFunnel(input: {
  realizedRecords: PortfolioProfitRecord[];
  unrealizedPnl: number | null;
  accountEquity: number | null;
}): PortfolioProfitFunnel {
  const records = input.realizedRecords.map(normalizeRecord);
  const grossRealizedPnl = sum(records.map((record) => record.grossRealizedPnl));
  const accountedRealizedPnl = sum(records.map((record) => record.accountingPnl));
  const knownTradingCosts = sum(records.map((record) => {
    if (!record.tradeDetailsAvailable || record.commissionAsset !== "USDT")
      return 0;
    return finite(record.exitCommission) + finite(record.entryCommissionAllocated);
  }));
  const knownFundingPnl = sum(records.map((record) =>
    record.fundingAsset === "USDT" ? finite(record.fundingIncome) : 0
  ));
  const exactRecords = records.filter((record) =>
    record.exactNetAvailable && record.netRealizedPnl !== null
  );
  const pendingRecords = records.filter((record) =>
    !record.exactNetAvailable || record.netRealizedPnl === null
  );
  const exactCohortGrossRealizedPnl = sum(
    exactRecords.map((record) => record.grossRealizedPnl),
  );
  const exactCohortTradingCosts = sum(exactRecords.map((record) => {
    if (!record.tradeDetailsAvailable || record.commissionAsset !== "USDT")
      return 0;
    return finite(record.exitCommission) +
      finite(record.entryCommissionAllocated);
  }));
  const exactCohortFundingPnl = sum(exactRecords.map((record) =>
    record.fundingAsset === "USDT" ? finite(record.fundingIncome) : 0
  ));
  const exactNetRealizedPnl = sum(
    exactRecords.map((record) => finite(record.netRealizedPnl)),
  );
  const pendingEstimatedRealizedPnl = sum(
    pendingRecords.map((record) => record.accountingPnl),
  );
  const exactNetRecords = exactRecords.length;
  const pendingNetRecords = records.length - exactNetRecords;
  const exactNetCoveragePercent = records.length
    ? exactNetRecords / records.length * 100
    : 100;
  const unrealizedPnl = nullableFinite(input.unrealizedPnl);
  const accountEquity = nullableFinite(input.accountEquity);
  const portfolioPnl = unrealizedPnl === null
    ? null
    : accountedRealizedPnl + unrealizedPnl;
  const resultBasis = portfolioPnl === null
    ? "UNAVAILABLE" as const
    : pendingNetRecords > 0
      ? "MIXED_ESTIMATE" as const
      : "EXACT_NET" as const;
  const realizedProfitOffsetPercent = accountedRealizedPnl > 0 && unrealizedPnl !== null && unrealizedPnl < 0
    ? Math.abs(unrealizedPnl) / accountedRealizedPnl * 100
    : null;

  return {
    grossRealizedPnl,
    knownTradingCosts,
    knownFundingPnl,
    accountedRealizedPnl,
    exactCohortGrossRealizedPnl,
    exactCohortTradingCosts,
    exactCohortFundingPnl,
    exactNetRealizedPnl,
    pendingEstimatedRealizedPnl,
    unrealizedPnl,
    portfolioPnl,
    accountEquity,
    realizedRecords: records.length,
    exactNetRecords,
    pendingNetRecords,
    exactNetCoveragePercent,
    resultBasis,
    realizedProfitOffsetPercent,
    status: portfolioStatus({
      accountedRealizedPnl,
      unrealizedPnl,
      portfolioPnl,
    }),
  };
}

function portfolioStatus(input: {
  accountedRealizedPnl: number;
  unrealizedPnl: number | null;
  portfolioPnl: number | null;
}): PortfolioProfitFunnel["status"] {
  if (input.unrealizedPnl === null || input.portfolioPnl === null)
    return "UNAVAILABLE";
  if (Math.abs(input.portfolioPnl) <= 1e-12) return "BREAKEVEN";
  if (input.accountedRealizedPnl > 0 && input.unrealizedPnl < 0)
    return input.portfolioPnl > 0
      ? "PROFIT_PARTLY_OFFSET"
      : "PROFIT_FULLY_OFFSET";
  if (input.portfolioPnl < 0) return "NET_LOSS";
  return "PROFIT_RETAINED";
}

function normalizeRecord(record: PortfolioProfitRecord): PortfolioProfitRecord {
  return {
    grossRealizedPnl: finite(record.grossRealizedPnl),
    accountingPnl: finite(record.accountingPnl),
    netRealizedPnl: nullableFinite(record.netRealizedPnl),
    exactNetAvailable: record.exactNetAvailable === true,
    tradeDetailsAvailable: record.tradeDetailsAvailable === true,
    exitCommission: nullableFinite(record.exitCommission),
    entryCommissionAllocated: nullableFinite(record.entryCommissionAllocated),
    commissionAsset: record.commissionAsset?.trim().toUpperCase() || null,
    fundingIncome: nullableFinite(record.fundingIncome),
    fundingAsset: record.fundingAsset?.trim().toUpperCase() || null,
  };
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + finite(value), 0);
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableFinite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
