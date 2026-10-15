export function buildManualOrderRiskAdvisory(input: {
  entryPrice: number;
  quantity: number;
  leverage: number;
  stopLossRoePercents: number[];
  trailingEnabled: boolean;
  accountUsableEquityUsdt: number;
  currentCommittedMarginUsdt: number;
  sameSymbolMarginUsdt: number;
}) {
  const entryPrice = positive(input.entryPrice);
  const quantity = positive(input.quantity);
  const leverage = positive(input.leverage);
  const initialMarginUsdt = leverage > 0
    ? entryPrice * quantity / leverage
    : 0;
  const usableEquityUsdt = positive(input.accountUsableEquityUsdt);
  const projectedMarginUtilizationPercent = usableEquityUsdt > 0
    ? (positive(input.currentCommittedMarginUsdt) + initialMarginUsdt) /
      usableEquityUsdt * 100
    : null;
  const projectedSymbolMarginPercent = usableEquityUsdt > 0
    ? (positive(input.sameSymbolMarginUsdt) + initialMarginUsdt) /
      usableEquityUsdt * 100
    : null;
  const deepestStopRoePercent = input.stopLossRoePercents
    .map(positive)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  const plannedMaximumLossUsdt = deepestStopRoePercent > 0
    ? initialMarginUsdt * deepestStopRoePercent / 100
    : null;
  const warnings: string[] = [];
  if (input.trailingEnabled && deepestStopRoePercent <= 0)
    warnings.push("移动止损启动前没有固定止损保护");
  else if (deepestStopRoePercent <= 0)
    warnings.push("本单没有可计算的固定止损保护");
  if (
    projectedMarginUtilizationPercent !== null &&
    projectedMarginUtilizationPercent >= 80
  )
    warnings.push(
      `提交后预计保证金使用率 ${projectedMarginUtilizationPercent.toFixed(1)}%`,
    );
  const level = warnings.length > 0 ? "WARNING" as const : "INFO" as const;
  return {
    version: 1 as const,
    orderAffecting: false as const,
    operatorConfirmationRequired: true as const,
    level,
    initialMarginUsdt: round(initialMarginUsdt),
    plannedMaximumLossUsdt:
      plannedMaximumLossUsdt === null ? null : round(plannedMaximumLossUsdt),
    projectedMarginUtilizationPercent:
      projectedMarginUtilizationPercent === null
        ? null
        : round(projectedMarginUtilizationPercent),
    projectedSymbolMarginPercent:
      projectedSymbolMarginPercent === null
        ? null
        : round(projectedSymbolMarginPercent),
    warnings,
    summary: warnings.length
      ? `${warnings.join("；")}。这是人工风险提示，请人工确认后决定是否提交。`
      : "当前人工委托的保证金与固定止损损失可计算；请人工确认后提交。",
  };
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function round(value: number) {
  return Number(value.toFixed(8));
}
