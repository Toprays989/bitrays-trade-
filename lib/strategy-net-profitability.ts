export type NetProfitabilityProfile = {
  sampleCount: number;
  wins: number;
  losses: number;
  breakEvens: number;
  totalNetPnlUsdt: number;
  averageNetPnlUsdt: number;
  averageWinUsdt: number | null;
  averageLossUsdt: number | null;
  profitFactor: number | null;
  decisiveWinRatePercent: number | null;
  breakEvenWinRatePercent: number | null;
  winRateEdgePercent: number | null;
  wilsonLowerWinRatePercent: number | null;
  positiveExpectancy: boolean;
  statisticallySupported: boolean;
};

export function empiricalNetProfitability(
  pnlValues: number[],
): NetProfitabilityProfile {
  const samples = pnlValues.filter(Number.isFinite);
  const wins = samples.filter((value) => value > 1e-8);
  const losses = samples.filter((value) => value < -1e-8);
  const breakEvens = samples.length - wins.length - losses.length;
  const totalNetPnlUsdt = sum(samples);
  const averageNetPnlUsdt = samples.length
    ? totalNetPnlUsdt / samples.length
    : 0;
  const totalWin = sum(wins);
  const totalLoss = Math.abs(sum(losses));
  const averageWinUsdt = wins.length ? totalWin / wins.length : null;
  const averageLossUsdt = losses.length ? totalLoss / losses.length : null;
  const profitFactor = totalLoss > 0
    ? totalWin / totalLoss
    : totalWin > 0
      ? Number.POSITIVE_INFINITY
      : null;
  const decisiveCount = wins.length + losses.length;
  const decisiveWinRatePercent = decisiveCount
    ? wins.length / decisiveCount * 100
    : null;
  const breakEvenWinRatePercent =
    averageWinUsdt !== null &&
      averageLossUsdt !== null &&
      averageWinUsdt + averageLossUsdt > 0
      ? averageLossUsdt / (averageWinUsdt + averageLossUsdt) * 100
      : null;
  const winRateEdgePercent =
    decisiveWinRatePercent !== null && breakEvenWinRatePercent !== null
      ? decisiveWinRatePercent - breakEvenWinRatePercent
      : null;
  const wilsonLowerWinRatePercent = decisiveCount
    ? wilsonLowerBound(wins.length, decisiveCount) * 100
    : null;
  const positiveExpectancy =
    samples.length > 0 &&
    averageNetPnlUsdt > 0 &&
    profitFactor !== null &&
    profitFactor > 1;
  const statisticallySupported =
    positiveExpectancy &&
    wilsonLowerWinRatePercent !== null &&
    breakEvenWinRatePercent !== null &&
    wilsonLowerWinRatePercent > breakEvenWinRatePercent;
  return {
    sampleCount: samples.length,
    wins: wins.length,
    losses: losses.length,
    breakEvens,
    totalNetPnlUsdt,
    averageNetPnlUsdt,
    averageWinUsdt,
    averageLossUsdt,
    profitFactor,
    decisiveWinRatePercent,
    breakEvenWinRatePercent,
    winRateEdgePercent,
    wilsonLowerWinRatePercent,
    positiveExpectancy,
    statisticallySupported,
  };
}

function wilsonLowerBound(successes: number, total: number) {
  if (total <= 0) return 0;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const z2 = z * z;
  return (
    proportion +
    z2 / (2 * total) -
    z *
      Math.sqrt(
        (proportion * (1 - proportion) + z2 / (4 * total)) / total,
      )
  ) / (1 + z2 / total);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
