const ACTIVE_POSITION_STATUSES = new Set(["OPEN", "EXECUTION_UNKNOWN"]);
const ACTIVE_ORDER_STATUSES = new Set([
  "PENDING",
  "SUBMITTED",
  "NEW",
  "PARTIALLY_FILLED",
  "CANCEL_PENDING",
  "EXECUTION_UNKNOWN",
]);

/**
 * @param {string} ownerEmail
 * @param {string} accountId
 * @param {string} symbol
 */
export function entryAnalysisOccupancyKey(
  ownerEmail,
  accountId,
  symbol,
  positionSide,
) {
  const parts = [
    String(ownerEmail).trim().toLowerCase(),
    String(accountId).trim().toLowerCase(),
    String(symbol).trim().toUpperCase(),
  ];
  if (positionSide === "LONG" || positionSide === "SHORT")
    parts.push(positionSide);
  return parts.join(":");
}

/**
 * Build a best-effort, local pre-analysis snapshot. This snapshot only avoids
 * spending candle/brain capacity on candidates that are obviously occupied.
 * It never replaces the authoritative Binance position/order reconciliation
 * immediately before submission.
 *
 * @param {{
 *   positions: Array<{
 *     ownerEmail: string,
 *     accountId: string,
 *     symbol: string,
 *     positionSide: "LONG" | "SHORT",
 *     status: string,
 *     quantity: number,
 *     updatedAt: Date | number,
 *   }>,
 *   orders: Array<{
 *     ownerEmail: string,
 *     accountId: string,
 *     symbol: string,
 *     positionSide: "LONG" | "SHORT",
 *     status: string,
 *     updatedAt: Date | number,
 *   }>,
 *   nowMs?: number,
 *   positionFreshnessMs?: number,
 *   orderFreshnessMs?: number,
 * }} input
 */
export function buildEntryAnalysisOccupancySnapshot(input) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const positionFreshnessMs = Math.max(
    Number(input.positionFreshnessMs) || 30_000,
    1,
  );
  const orderFreshnessMs = Math.max(
    Number(input.orderFreshnessMs) || 30 * 60_000,
    1,
  );
  const occupiedPositionKeys = new Set();
  const occupiedPositionSideKeys = new Set();
  const workingOrderKeys = new Set();
  const workingOrderSideKeys = new Set();

  for (const position of input.positions ?? []) {
    const updatedAtMs = toTimestamp(position.updatedAt);
    if (
      !ACTIVE_POSITION_STATUSES.has(position.status) ||
      !(Number(position.quantity) > 1e-12) ||
      !(updatedAtMs > 0) ||
      nowMs - updatedAtMs > positionFreshnessMs
    )
      continue;
    occupiedPositionKeys.add(
      entryAnalysisOccupancyKey(
        position.ownerEmail,
        position.accountId,
        position.symbol,
      ),
    );
    occupiedPositionSideKeys.add(
      entryAnalysisOccupancyKey(
        position.ownerEmail,
        position.accountId,
        position.symbol,
        position.positionSide,
      ),
    );
  }

  for (const order of input.orders ?? []) {
    const updatedAtMs = toTimestamp(order.updatedAt);
    if (
      !ACTIVE_ORDER_STATUSES.has(order.status) ||
      !(updatedAtMs > 0) ||
      nowMs - updatedAtMs > orderFreshnessMs
    )
      continue;
    workingOrderKeys.add(
      entryAnalysisOccupancyKey(order.ownerEmail, order.accountId, order.symbol),
    );
    workingOrderSideKeys.add(
      entryAnalysisOccupancyKey(
        order.ownerEmail,
        order.accountId,
        order.symbol,
        order.positionSide,
      ),
    );
  }

  return {
    occupiedPositionKeys,
    occupiedPositionSideKeys,
    workingOrderKeys,
    workingOrderSideKeys,
  };
}

/**
 * @param {{ occupiedPositionKeys: Set<string>, occupiedPositionSideKeys: Set<string>, workingOrderKeys: Set<string>, workingOrderSideKeys: Set<string> }} snapshot
 * @param {{ ownerEmail: string, accountId: string, symbol: string, positionSide: "LONG" | "SHORT", positionMode: "ONE_WAY" | "HEDGE" }} candidate
 */
export function entryAnalysisOccupancyReason(snapshot, candidate) {
  const key = entryAnalysisOccupancyKey(
    candidate.ownerEmail,
    candidate.accountId,
    candidate.symbol,
  );
  const sideKey = entryAnalysisOccupancyKey(
    candidate.ownerEmail,
    candidate.accountId,
    candidate.symbol,
    candidate.positionSide,
  );
  const occupiedPositionKeys = candidate.positionMode === "HEDGE"
    ? snapshot.occupiedPositionSideKeys
    : snapshot.occupiedPositionKeys;
  const workingOrderKeys = candidate.positionMode === "HEDGE"
    ? snapshot.workingOrderSideKeys
    : snapshot.workingOrderKeys;
  const occupancyKey = candidate.positionMode === "HEDGE" ? sideKey : key;
  if (occupiedPositionKeys.has(occupancyKey)) return "OPEN_POSITION";
  if (workingOrderKeys.has(occupancyKey)) return "WORKING_ORDER";
  return null;
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
