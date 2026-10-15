export type ProfitReductionExecutionGuard = {
  eligible: boolean;
  grossPnlUsdt: number | null;
  estimatedCostUsdt: number | null;
  estimatedFundingCostUsdt: number | null;
  estimatedNetPnlUsdt: number | null;
  minimumNetPnlUsdt: number | null;
  netProfitToCostRatio: number | null;
  reason: string;
};

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Shared execution economics for profit-taking reductions.
 *
 * Entry and exit costs are allocated to the quantity being reduced. This
 * keeps take-profit grids and staged trailing reductions on the same
 * fee-aware basis without weakening mandatory stop or structure exits.
 */
export function evaluateProfitReductionExecution(input: {
  positionSide: "LONG" | "SHORT";
  entryPrice: number;
  executablePrice: number;
  quantity: number;
  estimatedRoundTripCostRate?: number;
  estimatedFundingCostRate?: number;
  exitSlippageBufferRate?: number;
  minimumNetProfitToCostRatio?: number;
  minimumAbsoluteNetPnlUsdt?: number;
}): ProfitReductionExecutionGuard {
  const entryPrice = finitePositive(input.entryPrice);
  const executablePrice = finitePositive(input.executablePrice);
  const quantity = finitePositive(input.quantity);
  if (entryPrice === null || executablePrice === null || quantity === null)
    return {
      eligible: false,
      grossPnlUsdt: null,
      estimatedCostUsdt: null,
      estimatedFundingCostUsdt: null,
      estimatedNetPnlUsdt: null,
      minimumNetPnlUsdt: null,
      netProfitToCostRatio: null,
      reason: "盈利减仓执行复核缺少有效仓位或盘口数据",
    };

  const grossPnlUsdt = input.positionSide === "LONG"
    ? (executablePrice - entryPrice) * quantity
    : (entryPrice - executablePrice) * quantity;
  const configuredRoundTripCostRate = Number(
    input.estimatedRoundTripCostRate,
  );
  const configuredSlippageBufferRate = Number(
    input.exitSlippageBufferRate,
  );
  const estimatedRoundTripCostRate = Math.max(
    0,
    Number.isFinite(configuredRoundTripCostRate)
      ? configuredRoundTripCostRate
      : 0.001,
  );
  const exitSlippageBufferRate = Math.max(
    0,
    Number.isFinite(configuredSlippageBufferRate)
      ? configuredSlippageBufferRate
      : 0.0002,
  );
  const configuredFundingCostRate = Number(
    input.estimatedFundingCostRate,
  );
  const estimatedFundingCostRate = Math.max(
    0,
    Number.isFinite(configuredFundingCostRate)
      ? configuredFundingCostRate
      : 0,
  );
  const estimatedFundingCostUsdt =
    entryPrice * quantity * estimatedFundingCostRate;
  const estimatedCostUsdt =
    entryPrice * quantity * estimatedRoundTripCostRate +
    executablePrice * quantity * exitSlippageBufferRate +
    estimatedFundingCostUsdt;
  const estimatedNetPnlUsdt = grossPnlUsdt - estimatedCostUsdt;
  const configuredMinimumNetProfitToCostRatio = Number(
    input.minimumNetProfitToCostRatio,
  );
  const minimumNetProfitToCostRatio = Math.max(
    0,
    Number.isFinite(configuredMinimumNetProfitToCostRatio)
      ? configuredMinimumNetProfitToCostRatio
      : 0.5,
  );
  const configuredMinimumAbsoluteNetPnlUsdt = Number(
    input.minimumAbsoluteNetPnlUsdt,
  );
  const minimumAbsoluteNetPnlUsdt = Math.max(
    0,
    Number.isFinite(configuredMinimumAbsoluteNetPnlUsdt)
      ? configuredMinimumAbsoluteNetPnlUsdt
      : 0.01,
  );
  const minimumNetPnlUsdt = Math.max(
    minimumAbsoluteNetPnlUsdt,
    estimatedCostUsdt * minimumNetProfitToCostRatio,
  );
  const netProfitToCostRatio = estimatedCostUsdt > 0
    ? estimatedNetPnlUsdt / estimatedCostUsdt
    : null;
  const eligible = estimatedNetPnlUsdt + 1e-12 >= minimumNetPnlUsdt;
  return {
    eligible,
    grossPnlUsdt,
    estimatedCostUsdt,
    estimatedFundingCostUsdt,
    estimatedNetPnlUsdt,
    minimumNetPnlUsdt,
    netProfitToCostRatio,
    reason: eligible
      ? "预计净收益覆盖交易成本安全垫"
      : `预计净收益 ${estimatedNetPnlUsdt.toFixed(6)} USDT 未达到成本安全垫 ${minimumNetPnlUsdt.toFixed(6)} USDT`,
  };
}
