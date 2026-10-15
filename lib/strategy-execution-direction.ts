export type StrategyExecutionDirectionMode =
  | "FOLLOW_BRAIN"
  | "INVERSE_BRAIN";

export type BrainTradeDirection = "LONG" | "SHORT";

export type StrategyExecutionDirection = {
  mode: StrategyExecutionDirectionMode;
  brainDirection: BrainTradeDirection;
  tradeDirection: BrainTradeDirection;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  inverted: boolean;
  lane:
    | "FOLLOW_LONG"
    | "FOLLOW_SHORT"
    | "LONG_TO_SHORT"
    | "SHORT_TO_LONG";
  version: 1;
};

export function normalizeStrategyExecutionDirectionMode(
  value: unknown,
): StrategyExecutionDirectionMode {
  return value === "INVERSE_BRAIN" ? "INVERSE_BRAIN" : "FOLLOW_BRAIN";
}

/**
 * The market brain owns whether an opportunity is LONG or SHORT. This helper
 * is the only place where an experimental strategy may invert that approved
 * direction before an exchange intent is reserved. Risk plans then bind to
 * the returned real position side.
 */
export function resolveStrategyExecutionDirection(input: {
  mode?: unknown;
  brainDirection: BrainTradeDirection;
}): StrategyExecutionDirection {
  const mode = normalizeStrategyExecutionDirectionMode(input.mode);
  const inverted = mode === "INVERSE_BRAIN";
  const tradeDirection = inverted
    ? input.brainDirection === "LONG" ? "SHORT" : "LONG"
    : input.brainDirection;
  return {
    mode,
    brainDirection: input.brainDirection,
    tradeDirection,
    side: tradeDirection === "LONG" ? "BUY" : "SELL",
    positionSide: tradeDirection,
    inverted,
    lane: inverted
      ? input.brainDirection === "LONG"
        ? "LONG_TO_SHORT"
        : "SHORT_TO_LONG"
      : input.brainDirection === "LONG"
        ? "FOLLOW_LONG"
        : "FOLLOW_SHORT",
    version: 1,
  };
}

/**
 * Runtime-safe adapter for data loaded from JSON. Missing/ambiguous direction
 * is never interpreted as the opposite side and therefore cannot create an
 * inverse order.
 */
export function tryResolveStrategyExecutionDirection(input: {
  mode?: unknown;
  brainDirection?: unknown;
}) {
  if (input.brainDirection !== "LONG" && input.brainDirection !== "SHORT")
    return null;
  return resolveStrategyExecutionDirection({
    mode: input.mode,
    brainDirection: input.brainDirection,
  });
}

export function roeStopInvalidationPrice(input: {
  entryPrice: number;
  positionSide: BrainTradeDirection;
  stopLossRoePercent: number;
  leverage: number;
}) {
  const entryPrice = Number(input.entryPrice);
  const leverage = Math.max(1, Number(input.leverage));
  const stopLossRoePercent = Math.max(0, Number(input.stopLossRoePercent));
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return Number.NaN;
  const move = stopLossRoePercent / leverage / 100;
  return input.positionSide === "LONG"
    ? entryPrice * (1 - move)
    : entryPrice * (1 + move);
}
