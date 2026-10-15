export type SimpleThreeMinuteEntryInput = Readonly<{
  markPrices: readonly number[];
  oneMinuteCandles: readonly Readonly<{ open: number; close: number }>[];
  currentMarkPrice: number;
}>;

export type SimpleThreeMinuteEntryResult = Readonly<{
  eligible: boolean;
  phase: "WAIT_2S_DECLINE" | "WAIT_1M_CANDLES" | "WAIT_RECOVERY" | "READY" | "EXPIRED";
  consecutiveTwoSecondDeclines: number;
  consecutiveBearishMinutes: number;
}>;

export function shouldExitSimpleThreeMinutePosition(input: Readonly<{
  openedAtMs: number;
  nowMs: number;
  entryPrice: number;
  markPrice: number;
}>): "HOLD" | "EXIT_PROFIT" | "EXIT_TIME" | "EXIT_ADVERSE" {
  if (!(input.entryPrice > 0) || !(input.markPrice > 0)) return "EXIT_ADVERSE";
  if (input.markPrice < input.entryPrice) return "EXIT_ADVERSE";
  if (input.nowMs - input.openedAtMs >= 180_000)
    return input.markPrice > input.entryPrice ? "EXIT_PROFIT" : "EXIT_TIME";
  return "HOLD";
}

/** Fixed, long-only entry rule for the isolated simple 3-minute strategy. */
export function evaluateSimpleThreeMinuteEntry(
  input: SimpleThreeMinuteEntryInput,
): SimpleThreeMinuteEntryResult {
  const prices = input.markPrices.filter((value) => Number.isFinite(value) && value > 0);
  let declines = 0;
  for (let index = prices.length - 1; index > 0; index -= 1) {
    if (prices[index]! < prices[index - 1]!) declines += 1;
    else break;
  }
  if (declines < 10)
    return { eligible: false, phase: "WAIT_2S_DECLINE", consecutiveTwoSecondDeclines: declines, consecutiveBearishMinutes: 0 };

  const candles = input.oneMinuteCandles.filter(
    (candle) => Number.isFinite(candle.open) && Number.isFinite(candle.close),
  );
  const current = candles.at(-1);
  let bearish = 0;
  const completed = current && input.currentMarkPrice > current.open
    ? candles.slice(0, -1)
    : candles;
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    if (completed[index]!.close < completed[index]!.open) bearish += 1;
    else break;
  }
  if (bearish < 2)
    return { eligible: false, phase: "WAIT_1M_CANDLES", consecutiveTwoSecondDeclines: declines, consecutiveBearishMinutes: bearish };
  if (bearish > 3)
    return { eligible: false, phase: "EXPIRED", consecutiveTwoSecondDeclines: declines, consecutiveBearishMinutes: bearish };

  const recovery = Boolean(current && input.currentMarkPrice > current.open);
  return {
    eligible: recovery,
    phase: recovery ? "READY" : "WAIT_RECOVERY",
    consecutiveTwoSecondDeclines: declines,
    consecutiveBearishMinutes: bearish,
  };
}
