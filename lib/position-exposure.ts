export type ExposurePosition = {
  accountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  markPrice: number;
};

export function findExistingOpenSymbolPosition<
  T extends { symbol: string; quantity: number },
>(
  positions: readonly T[],
  symbol: string,
) {
  const normalizedSymbol = symbol.trim().toUpperCase();
  return positions.find(
    (position) =>
      position.symbol.trim().toUpperCase() === normalizedSymbol &&
      Number.isFinite(Number(position.quantity)) &&
      Number(position.quantity) > 0,
  ) ?? null;
}

/**
 * New-entry conflict rules must follow the account's actual Binance position
 * mode. In hedge mode the opposite leg is independent, while opening another
 * position on the same leg still belongs to the explicit add-position flow.
 * In one-way mode any open leg on the symbol blocks a new entry.
 */
export function findBlockingOpenSymbolPosition<
  T extends {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    quantity: number;
  },
>(
  positions: readonly T[],
  input: {
    symbol: string;
    targetPositionSide: "LONG" | "SHORT";
    positionMode: "ONE_WAY" | "HEDGE";
  },
) {
  const normalizedSymbol = input.symbol.trim().toUpperCase();
  return positions.find((position) => {
    if (position.symbol.trim().toUpperCase() !== normalizedSymbol) return false;
    if (!Number.isFinite(Number(position.quantity)) || Number(position.quantity) <= 0)
      return false;
    return input.positionMode === "ONE_WAY" ||
      position.positionSide === input.targetPositionSide;
  }) ?? null;
}

export function summarizePositionExposure(positions: ExposurePosition[]) {
  const groups = new Map<string, {
    accountId: string;
    symbol: string;
    longNotional: number;
    shortNotional: number;
  }>();
  for (const position of positions) {
    const notional = Number(position.quantity) * Number(position.markPrice);
    if (!Number.isFinite(notional) || notional <= 0) continue;
    const key = `${position.accountId}:${position.symbol}`;
    const group = groups.get(key) ?? {
      accountId: position.accountId,
      symbol: position.symbol,
      longNotional: 0,
      shortNotional: 0,
    };
    if (position.positionSide === "LONG") group.longNotional += notional;
    else group.shortNotional += notional;
    groups.set(key, group);
  }
  const rows = [...groups.values()].map((group) => {
    const grossNotional = group.longNotional + group.shortNotional;
    const signedNetNotional = group.longNotional - group.shortNotional;
    const overlappingNotional = Math.min(group.longNotional, group.shortNotional) * 2;
    return {
      ...group,
      grossNotional,
      signedNetNotional,
      netNotional: Math.abs(signedNetNotional),
      overlappingNotional,
      overlapPercent: grossNotional > 0
        ? (overlappingNotional / grossNotional) * 100
        : 0,
      isTwoSided: group.longNotional > 0 && group.shortNotional > 0,
    };
  });
  return {
    rows,
    grossNotional: rows.reduce((sum, row) => sum + row.grossNotional, 0),
    netNotional: rows.reduce((sum, row) => sum + row.netNotional, 0),
    overlappingNotional: rows.reduce(
      (sum, row) => sum + row.overlappingNotional,
      0,
    ),
    twoSided: rows.filter((row) => row.isTwoSided),
  };
}
