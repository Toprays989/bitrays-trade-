function validPositionIds(value) {
  if (!Array.isArray(value)) return null;
  return new Set(
    value
      .map(Number)
      .filter((positionId) => Number.isInteger(positionId) && positionId > 0),
  );
}

export function synchronizeActivePositionCoverage(input) {
  const activePositionIds = validPositionIds(input.openPositionIds);
  if (activePositionIds === null)
    return Math.max(0, Number(input.fallbackTotal) || 0);

  for (const observations of [
    input.processedPositions,
    input.sampledPositions,
  ])
    for (const positionId of observations.keys())
      if (!activePositionIds.has(positionId)) observations.delete(positionId);

  return activePositionIds.size;
}
