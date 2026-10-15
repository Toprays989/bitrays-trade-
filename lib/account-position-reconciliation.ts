export const FULL_ACCOUNT_POSITION_RECONCILE_INTERVAL_MS =
  4 * 60 * 60 * 1_000;

export type AccountPositionQuantity = {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
};

export type AccountPositionDifference = AccountPositionQuantity & {
  localQuantity: number;
  exchangeQuantity: number;
  difference: number;
  kind: "MATCH" | "LOCAL_ONLY" | "EXCHANGE_ONLY" | "QUANTITY_MISMATCH";
};

function keyOf(position: Pick<AccountPositionQuantity, "symbol" | "positionSide">) {
  return `${position.symbol.trim().toUpperCase()}:${position.positionSide}`;
}

function normalizedQuantity(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function accountPositionQuantityDifferences(input: {
  local: AccountPositionQuantity[];
  exchange: AccountPositionQuantity[];
}) {
  const local = new Map<string, AccountPositionQuantity>();
  const exchange = new Map<string, AccountPositionQuantity>();
  for (const position of input.local) {
    const key = keyOf(position);
    const current = local.get(key);
    local.set(key, {
      symbol: position.symbol.trim().toUpperCase(),
      positionSide: position.positionSide,
      quantity:
        normalizedQuantity(current?.quantity ?? 0) +
        normalizedQuantity(position.quantity),
    });
  }
  for (const position of input.exchange) {
    const key = keyOf(position);
    const current = exchange.get(key);
    exchange.set(key, {
      symbol: position.symbol.trim().toUpperCase(),
      positionSide: position.positionSide,
      quantity:
        normalizedQuantity(current?.quantity ?? 0) +
        normalizedQuantity(position.quantity),
    });
  }
  const keys = [...new Set([...local.keys(), ...exchange.keys()])].sort();
  return keys.map((key): AccountPositionDifference => {
    const localPosition = local.get(key);
    const exchangePosition = exchange.get(key);
    const symbol = localPosition?.symbol ?? exchangePosition!.symbol;
    const positionSide =
      localPosition?.positionSide ?? exchangePosition!.positionSide;
    const localQuantity = normalizedQuantity(localPosition?.quantity ?? 0);
    const exchangeQuantity = normalizedQuantity(
      exchangePosition?.quantity ?? 0,
    );
    const difference = localQuantity - exchangeQuantity;
    const tolerance = Math.max(
      1e-8,
      localQuantity * 1e-8,
      exchangeQuantity * 1e-8,
    );
    const kind = Math.abs(difference) <= tolerance
      ? "MATCH"
      : localQuantity > 0 && exchangeQuantity <= tolerance
        ? "LOCAL_ONLY"
        : exchangeQuantity > 0 && localQuantity <= tolerance
          ? "EXCHANGE_ONLY"
          : "QUANTITY_MISMATCH";
    return {
      symbol,
      positionSide,
      quantity: exchangeQuantity,
      localQuantity,
      exchangeQuantity,
      difference,
      kind,
    };
  });
}

export function fourHourPositionReconciliationDue(input: {
  nowMs: number;
  lastCompletedAtMs: number | null;
}) {
  return (
    input.lastCompletedAtMs === null ||
    input.nowMs - input.lastCompletedAtMs >=
      FULL_ACCOUNT_POSITION_RECONCILE_INTERVAL_MS
  );
}
