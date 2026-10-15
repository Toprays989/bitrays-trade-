import {
  evaluateProfitReductionExecution,
} from "./profit-reduction-execution-guard.ts";

export type TakeProfitExecutionGuard = {
  eligible: boolean;
  executableRoePercent: number | null;
  grossPnlUsdt: number | null;
  estimatedCostUsdt: number | null;
  estimatedFundingCostUsdt: number | null;
  estimatedNetPnlUsdt: number | null;
  minimumNetPnlUsdt: number | null;
  netProfitToCostRatio: number | null;
  mergeRecommended: boolean;
  reason: string;
};

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * A mark-price trigger is only an observation. Before a take-profit market
 * reduction is submitted, verify that the current executable side of the
 * book still satisfies the configured ROE level and remains profitable after
 * a conservative round-trip fee and exit-slippage allowance.
 */
export function evaluateTakeProfitExecution(input: {
  positionSide: "LONG" | "SHORT";
  entryPrice: number;
  executablePrice: number;
  leverage: number;
  quantity: number;
  triggerRoePercent: number;
  estimatedRoundTripCostRate?: number;
  estimatedFundingCostRate?: number;
  exitSlippageBufferRate?: number;
  minimumNetProfitToCostRatio?: number;
  minimumAbsoluteNetPnlUsdt?: number;
}): TakeProfitExecutionGuard {
  const entryPrice = finitePositive(input.entryPrice);
  const executablePrice = finitePositive(input.executablePrice);
  const leverage = finitePositive(input.leverage);
  const quantity = finitePositive(input.quantity);
  const triggerRoePercent = Number(input.triggerRoePercent);
  if (
    entryPrice === null ||
    executablePrice === null ||
    leverage === null ||
    quantity === null ||
    !Number.isFinite(triggerRoePercent)
  )
    return {
      eligible: false,
      executableRoePercent: null,
      grossPnlUsdt: null,
      estimatedCostUsdt: null,
      estimatedFundingCostUsdt: null,
      estimatedNetPnlUsdt: null,
      minimumNetPnlUsdt: null,
      netProfitToCostRatio: null,
      mergeRecommended: false,
      reason: "止盈执行复核缺少有效仓位或盘口数据",
    };

  const priceMove = input.positionSide === "LONG"
    ? (executablePrice - entryPrice) / entryPrice
    : (entryPrice - executablePrice) / entryPrice;
  const executableRoePercent = priceMove * leverage * 100;
  const economics = evaluateProfitReductionExecution({
    positionSide: input.positionSide,
    entryPrice,
    executablePrice,
    quantity,
    estimatedRoundTripCostRate: input.estimatedRoundTripCostRate,
    estimatedFundingCostRate: input.estimatedFundingCostRate,
    exitSlippageBufferRate: input.exitSlippageBufferRate,
    minimumNetProfitToCostRatio: input.minimumNetProfitToCostRatio,
    minimumAbsoluteNetPnlUsdt: input.minimumAbsoluteNetPnlUsdt,
  });
  const thresholdMet = executableRoePercent + 1e-9 >= triggerRoePercent;
  const economicsMet = economics.eligible;
  const eligible = thresholdMet && economicsMet;
  const mergeRecommended = thresholdMet && !economicsMet;

  return {
    eligible,
    executableRoePercent,
    grossPnlUsdt: economics.grossPnlUsdt,
    estimatedCostUsdt: economics.estimatedCostUsdt,
    estimatedFundingCostUsdt: economics.estimatedFundingCostUsdt,
    estimatedNetPnlUsdt: economics.estimatedNetPnlUsdt,
    minimumNetPnlUsdt: economics.minimumNetPnlUsdt,
    netProfitToCostRatio: economics.netProfitToCostRatio,
    mergeRecommended,
    reason: eligible
      ? "盘口可成交价满足止盈档位，预计净收益也覆盖交易成本安全垫"
      : !thresholdMet
        ? `盘口可成交ROE ${executableRoePercent.toFixed(2)}% 已低于止盈档位 ${triggerRoePercent.toFixed(2)}%`
        : `${economics.reason}；本档保留并合并到后续止盈档`,
  };
}

export function takeProfitFillConsumesGrid(input: {
  positionSide: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  quantity: number;
  triggerRoePercent: number;
}) {
  return evaluateTakeProfitExecution({
    ...input,
    executablePrice: input.exitPrice,
    estimatedRoundTripCostRate: 0,
    exitSlippageBufferRate: 0,
    minimumNetProfitToCostRatio: 0,
    minimumAbsoluteNetPnlUsdt: 0,
  });
}
