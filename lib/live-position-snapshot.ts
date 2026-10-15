export type LivePositionRiskRow = {
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  leverage?: string;
};

export const LIVE_POSITION_LIQUIDATION_PRICE_STATUSES = [
  "AVAILABLE",
  "EXCHANGE_NOT_PROVIDED",
  "DIRECTION_INVALID",
  "MARK_PRICE_INVALID",
  "POSITION_NOT_FOUND",
  "UNKNOWN",
] as const;

export type LivePositionLiquidationPriceStatus =
  (typeof LIVE_POSITION_LIQUIDATION_PRICE_STATUSES)[number];

export type NormalizedLivePositionSnapshot = {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  hedgeMode: boolean;
  quantity: number;
  signedQuantity: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  liquidationPriceRaw: number | null;
  liquidationPriceStatus: LivePositionLiquidationPriceStatus;
  leverage: number;
};

export type DirectionalLiquidationPriceFact = {
  liquidationPrice: number;
  liquidationPriceRaw: number | null;
  liquidationPriceStatus: LivePositionLiquidationPriceStatus;
};

export function directionalLiquidationPriceFact(
  positionSide: "LONG" | "SHORT",
  markPrice: number,
  liquidationPrice: number,
): DirectionalLiquidationPriceFact {
  const raw = Number.isFinite(liquidationPrice) ? liquidationPrice : null;
  if (!Number.isFinite(markPrice) || markPrice <= 0)
    return {
      liquidationPrice: 0,
      liquidationPriceRaw: raw,
      liquidationPriceStatus: "MARK_PRICE_INVALID",
    };
  if (raw === null || raw <= 0)
    return {
      liquidationPrice: 0,
      liquidationPriceRaw: raw,
      liquidationPriceStatus: "EXCHANGE_NOT_PROVIDED",
    };
  if (
    (positionSide === "LONG" && raw >= markPrice) ||
    (positionSide === "SHORT" && raw <= markPrice)
  )
    return {
      liquidationPrice: 0,
      liquidationPriceRaw: raw,
      liquidationPriceStatus: "DIRECTION_INVALID",
    };
  return {
    liquidationPrice: raw,
    liquidationPriceRaw: raw,
    liquidationPriceStatus: "AVAILABLE",
  };
}

export function normalizeDirectionalLiquidationPrice(
  positionSide: "LONG" | "SHORT",
  markPrice: number,
  liquidationPrice: number,
) {
  return directionalLiquidationPriceFact(
    positionSide,
    markPrice,
    liquidationPrice,
  ).liquidationPrice;
}

export function normalizeLiveAccountPositionSnapshots(
  rows: LivePositionRiskRow[],
) {
  const hedgeMode = rows.some((item) => item.positionSide !== "BOTH");
  return rows
    .map((row): NormalizedLivePositionSnapshot | null => {
      const signedQuantity = Number(row.positionAmt);
      if (!Number.isFinite(signedQuantity) || Math.abs(signedQuantity) <= 0)
        return null;
      const positionSide = row.positionSide === "BOTH"
        ? signedQuantity > 0 ? "LONG" as const : "SHORT" as const
        : row.positionSide;
      const markPrice = Number(row.markPrice ?? 0);
      const liquidation = directionalLiquidationPriceFact(
        positionSide,
        markPrice,
        Number(row.liquidationPrice ?? 0),
      );
      return {
        symbol: row.symbol.trim().toUpperCase(),
        positionSide,
        hedgeMode,
        quantity: Math.abs(signedQuantity),
        signedQuantity,
        entryPrice: Number(row.entryPrice ?? 0),
        markPrice,
        ...liquidation,
        leverage: Number(row.leverage ?? 0),
      };
    })
    .filter(
      (position): position is NormalizedLivePositionSnapshot =>
        position !== null &&
        Boolean(position.symbol) &&
        /^[A-Z0-9]{1,30}$/.test(position.symbol) &&
        position.quantity > 0,
    );
}

export function normalizeLivePositionSnapshot(
  rows: LivePositionRiskRow[],
  symbol: string,
  positionSide: "LONG" | "SHORT",
) {
  const hedgeMode = rows.some((item) => item.positionSide !== "BOTH");
  const expectedSide = hedgeMode ? positionSide : "BOTH";
  const row = rows.find(
    (item) => item.symbol === symbol && item.positionSide === expectedSide,
  );
  const signedQuantity = Number(row?.positionAmt ?? 0);
  const directionMatches =
    hedgeMode ||
    (positionSide === "LONG" ? signedQuantity > 0 : signedQuantity < 0);
  const markPrice = Number(row?.markPrice ?? 0);
  const liquidation = directionMatches && row
    ? directionalLiquidationPriceFact(
        positionSide,
        markPrice,
        Number(row.liquidationPrice ?? 0),
      )
    : {
        liquidationPrice: 0,
        liquidationPriceRaw: null,
        liquidationPriceStatus: "POSITION_NOT_FOUND" as const,
      };
  return {
    hedgeMode,
    quantity: directionMatches ? Math.abs(signedQuantity) : 0,
    signedQuantity,
    entryPrice: Number(row?.entryPrice ?? 0),
    markPrice,
    ...liquidation,
    leverage: Number(row?.leverage ?? 0),
  };
}
