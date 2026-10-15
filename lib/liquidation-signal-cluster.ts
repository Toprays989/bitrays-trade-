export type LiquidationSignalClusterRow = {
  eventAtMs: number;
  liquidationNotional?: number;
  liquidationPrice?: number;
  eventCount?: number;
};

export type LiquidationSignalFallback = {
  liquidationNotional: number;
  liquidationPrice: number;
  eventAtMs: number;
};

function finiteNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function summarizeLiquidationSignalCluster(
  rows: LiquidationSignalClusterRow[],
  fallback: LiquidationSignalFallback,
  maxClusterSpanMs: number,
  maxInterEventGapMs = maxClusterSpanMs,
) {
  const effectiveMaxSpanMs = Number.isFinite(maxClusterSpanMs)
    ? Math.max(10_000, maxClusterSpanMs)
    : 120_000;
  const effectiveMaxGapMs = Number.isFinite(maxInterEventGapMs)
    ? Math.min(
        effectiveMaxSpanMs,
        Math.max(1_000, maxInterEventGapMs),
      )
    : effectiveMaxSpanMs;
  const orderedRows = rows
    .filter((row) => Number.isFinite(row.eventAtMs))
    .sort((left, right) => left.eventAtMs - right.eventAtMs);

  if (!orderedRows.length) {
    return {
      clusterCount: 1,
      eventCount: 1,
      totalNotional: fallback.liquidationNotional,
      minLiquidationPrice: fallback.liquidationPrice,
      maxLiquidationPrice: fallback.liquidationPrice,
      firstEventAt: fallback.eventAtMs,
      lastEventAt: fallback.eventAtMs,
      clusterSpanMs: 0,
      maxClusterSpanMs: effectiveMaxSpanMs,
      excludedLateClusters: 0,
    };
  }

  const firstClusterAt = orderedRows[0].eventAtMs;
  const clusterRows: LiquidationSignalClusterRow[] = [];
  let previousEventAt = firstClusterAt;
  for (const row of orderedRows) {
    if (row.eventAtMs - firstClusterAt > effectiveMaxSpanMs) break;
    if (
      clusterRows.length > 0 &&
      row.eventAtMs - previousEventAt > effectiveMaxGapMs
    )
      break;
    clusterRows.push(row);
    previousEventAt = row.eventAtMs;
  }
  const prices = clusterRows
    .map((row) => finiteNumber(row.liquidationPrice, Number.NaN))
    .filter(Number.isFinite);
  const firstEventAt = clusterRows[0].eventAtMs;
  const lastEventAt = clusterRows[clusterRows.length - 1].eventAtMs;

  return {
    clusterCount: clusterRows.length,
    eventCount: clusterRows.reduce(
      (sum, row) =>
        sum + Math.max(1, Math.trunc(finiteNumber(row.eventCount, 1))),
      0,
    ),
    totalNotional: clusterRows.reduce(
      (sum, row) => sum + finiteNumber(row.liquidationNotional, 0),
      0,
    ),
    minLiquidationPrice: prices.length
      ? Math.min(...prices)
      : fallback.liquidationPrice,
    maxLiquidationPrice: prices.length
      ? Math.max(...prices)
      : fallback.liquidationPrice,
    firstEventAt,
    lastEventAt,
    clusterSpanMs: Math.max(0, lastEventAt - firstEventAt),
    maxClusterSpanMs: effectiveMaxSpanMs,
    maxInterEventGapMs: effectiveMaxGapMs,
    excludedLateClusters: orderedRows.length - clusterRows.length,
  };
}
