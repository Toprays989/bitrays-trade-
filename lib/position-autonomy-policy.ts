export type PositionAutonomyDecision =
  | {
      action: "AUTONOMOUS_CLOSE";
      reason:
        | "LIQUIDATION_PROXIMITY"
        | "CONFIGURED_STOP"
        | "TAKE_PROFIT"
        | "TRAILING_PROTECTION"
        | "STRUCTURE_INVALIDATION";
      severity: "CRITICAL" | "WARNING";
    }
  | {
      action: "MONITOR";
      reason: "NO_ACTION";
      severity: "INFO";
    };

/**
 * Explicit position protection parameters are executable instructions.
 * Structure invalidation reaches this policy only after the analysis layer,
 * causal evidence gate and explicit EXECUTE mode have all authorized it.
 */
export function decidePositionAutonomy(input: {
  liquidationPriceAvailable: boolean;
  liquidationGuardHit: boolean;
  configuredStopHit: boolean;
  takeProfitHit: boolean;
  trailingProtectionHit: boolean;
  structureInvalidated: boolean;
}): PositionAutonomyDecision {
  if (input.liquidationGuardHit)
    return {
      action: "AUTONOMOUS_CLOSE",
      reason: "LIQUIDATION_PROXIMITY",
      severity: "CRITICAL",
    };
  if (input.configuredStopHit)
    return {
      action: "AUTONOMOUS_CLOSE",
      reason: "CONFIGURED_STOP",
      severity: "WARNING",
    };
  if (input.takeProfitHit)
    return {
      action: "AUTONOMOUS_CLOSE",
      reason: "TAKE_PROFIT",
      severity: "WARNING",
    };
  if (input.trailingProtectionHit)
    return {
      action: "AUTONOMOUS_CLOSE",
      reason: "TRAILING_PROTECTION",
      severity: "WARNING",
    };
  if (input.structureInvalidated)
    return {
      action: "AUTONOMOUS_CLOSE",
      reason: "STRUCTURE_INVALIDATION",
      severity: "WARNING",
    };
  // Binance may legitimately return a zero liquidation price when account-level
  // collateral is ample. That only disables the liquidation-distance guard; it
  // must never block manual reduction or hide the independent protection gates.
  return { action: "MONITOR", reason: "NO_ACTION", severity: "INFO" };
}
