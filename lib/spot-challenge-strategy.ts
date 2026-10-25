export type SpotChallengeSignal = {
  action: "BUY" | "HOLD";
  reason: string;
  quoteOrderUsdt: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  dayPositionPercent: number;
  weekPositionPercent: number;
  btcChangePercent: number;
};

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function position(price: number, low: number, high: number) {
  return high > low ? Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100)) : 50;
}

/** Conservative long-only entry plan. It never produces a short order. */
export function planSpotChallengeLongEntry(input: {
  capitalUsdt: number;
  riskUsedPercent: number;
  price: number;
  dayHigh: number;
  dayLow: number;
  threeDayHigh?: number;
  threeDayLow?: number;
  maxEntryPrice?: number;
  weekHigh: number;
  weekLow: number;
  btcChangePercent: number;
}) : SpotChallengeSignal {
  const price = finite(input.price);
  const dayPositionPercent = position(price, finite(input.threeDayLow ?? input.dayLow), finite(input.threeDayHigh ?? input.dayHigh));
  const weekPositionPercent = position(price, finite(input.weekLow), finite(input.weekHigh));
  const btcChangePercent = finite(input.btcChangePercent);
  const riskUsedPercent = Math.max(0, finite(input.riskUsedPercent));
  const availableBudget = Math.max(0, finite(input.capitalUsdt) * 0.65 - finite(input.capitalUsdt) * riskUsedPercent / 100);
  const quoteOrderUsdt = Math.max(0, Math.min(finite(input.capitalUsdt) * 0.15, availableBudget));
  const hold = (reason: string): SpotChallengeSignal => ({ action: "HOLD", reason, quoteOrderUsdt: 0, stopLossPercent: 0, takeProfitPercent: 0, dayPositionPercent, weekPositionPercent, btcChangePercent });
  if (!(price > 0) || quoteOrderUsdt <= 0) return hold("风险预算已用尽");
  if (finite(input.maxEntryPrice, 20) > 0 && price > finite(input.maxEntryPrice, 20)) return hold("资金保护：现货价格超过20 USDT");
  if (dayPositionPercent > 35 || weekPositionPercent > 55) return hold("价格未处于3日/周低位区");
  if (btcChangePercent < -2.5) return hold("BTC 联动弱势，暂缓做多");
  const stopLossPercent = Math.max(0.6, Math.min(2.2, 0.6 + dayPositionPercent / 100));
  const takeProfitPercent = Math.max(1.2, Math.min(4.5, 1.2 + (50 - dayPositionPercent) * 0.04));
  return { action: "BUY", reason: "白名单低位且 BTC 联动未转弱", quoteOrderUsdt, stopLossPercent, takeProfitPercent, dayPositionPercent, weekPositionPercent, btcChangePercent };
}
