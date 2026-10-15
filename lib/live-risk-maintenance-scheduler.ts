export const LIVE_RISK_MAINTENANCE_LANES = [
  "REJECTED_SIGNAL_EVIDENCE",
  "ENTRY_MARKET_POSITION",
  "ENTRY_STRUCTURE",
  "ENTRY_STRUCTURE_REASSESSMENT",
  "STRATEGY_REDUCTION_EVENTS",
  "STRATEGY_TRACE_SETTLEMENT",
  "STRATEGY_LEARNING_REFRESH",
  "CLOSED_POSITION_ADDITION",
  "ACTUAL_POSITION_REPAIR_QUEUE",
  "ACTUAL_POSITION_EVIDENCE",
  "REJECTED_SIGNAL_BACKFILL",
] as const;

export type LiveRiskMaintenanceLane =
  (typeof LIVE_RISK_MAINTENANCE_LANES)[number];

export function selectNextLiveRiskMaintenanceLane(input: {
  due: boolean;
  cursor: number;
}) {
  const laneCount = LIVE_RISK_MAINTENANCE_LANES.length;
  const cursor = Number.isFinite(input.cursor)
    ? Math.abs(Math.trunc(input.cursor)) % laneCount
    : 0;
  if (!input.due)
    return {
      lane: null as LiveRiskMaintenanceLane | null,
      nextCursor: cursor,
      laneCount,
    };

  return {
    lane: LIVE_RISK_MAINTENANCE_LANES[cursor],
    nextCursor: (cursor + 1) % laneCount,
    laneCount,
  };
}
