import { buildRiskGrid } from "./risk-grid.ts";

export type RebalancedRiskLevel = {
  triggerPercent: number;
  closePercent: number;
  closeQuantity: number;
};

type RiskPlanRecord = Record<string, unknown>;

export function normalizeRiskProtectionMode(
  plan: RiskPlanRecord,
  trailingStopPercent: number,
) {
  const explicitMode = plan.dynamicProfitProtectionEnabled;
  const dynamicProfitProtectionEnabled =
    explicitMode === true ||
    (
      explicitMode !== false &&
      Number.isFinite(Number(trailingStopPercent)) &&
      Number(trailingStopPercent) > 0
    );
  const staleFixedStopCount =
    dynamicProfitProtectionEnabled && Array.isArray(plan.stopLosses)
      ? plan.stopLosses.length
      : 0;
  return {
    plan: {
      ...plan,
      calculationMode: "ROE",
      dynamicProfitProtectionEnabled,
      stopLosses: dynamicProfitProtectionEnabled
        ? []
        : plan.stopLosses,
    },
    changed:
      explicitMode !== dynamicProfitProtectionEnabled ||
      staleFixedStopCount > 0,
    staleFixedStopCount,
    source:
      explicitMode === true
        ? "EXPLICIT_DYNAMIC"
        : explicitMode === false
          ? "EXPLICIT_FIXED"
          : dynamicProfitProtectionEnabled
            ? "LEGACY_TRAILING"
            : "LEGACY_FIXED",
  } as const;
}

function validLevels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (level): level is { triggerPercent: number } =>
      Boolean(level) &&
      typeof level === "object" &&
      Number.isFinite(
        Number((level as { triggerPercent?: unknown }).triggerPercent),
      ) &&
      Number((level as { triggerPercent?: unknown }).triggerPercent) > 0,
  );
}

function rebalanceLevels(
  value: unknown,
  quantity: number,
  minOrderQty: number,
  quantityStep: number,
  completedIndexes: unknown,
) {
  const completed = new Set(
    Array.isArray(completedIndexes)
      ? completedIndexes.filter(
          (index): index is number =>
            Number.isInteger(index) && Number(index) >= 0,
        )
      : [],
  );
  const levels = validLevels(value).filter((_, index) => !completed.has(index));
  if (!levels.length) {
    return {
      levels: [] as RebalancedRiskLevel[],
      requestedGrids: 0,
      actualGrids: 0,
      reduced: false,
    };
  }
  const triggers = levels.map((level) => Number(level.triggerPercent));
  const grid = buildRiskGrid(
    {
      startPercent: triggers[0],
      endPercent: triggers.at(-1) ?? triggers[0],
      requestedGrids: levels.length,
    },
    quantity,
    minOrderQty,
    quantityStep,
  );
  // Rebalancing owns quantities only. The ROE triggers are part of the
  // position's bound trading decision and must not be regenerated as an
  // evenly-spaced range. For example, 4/8/15 must remain 4/8/15 instead of
  // silently becoming 4/9.5/15 after a quantity reconciliation.
  const preservedLevels = grid.actualGrids >= levels.length
    ? levels
    : grid.actualGrids === 1
      ? [levels.at(-1)!]
      : Array.from({ length: grid.actualGrids }, (_, index) =>
          levels[
            Math.round(
              (index * (levels.length - 1)) / (grid.actualGrids - 1),
            )
          ]
        );
  return {
    levels: grid.levels.map((level, index) => ({
      ...level,
      triggerPercent: Number(preservedLevels[index].triggerPercent),
    })),
    requestedGrids: levels.length,
    actualGrids: grid.actualGrids,
    reduced: grid.reduced,
  };
}

export function rebalanceRiskPlan(
  plan: RiskPlanRecord,
  quantity: number,
  minOrderQty: number,
  quantityStep: number,
  progress: RiskPlanRecord = {},
  trailingStopPercent?: number,
) {
  const progressedTakeProfitIndexes = [
    ...(Array.isArray(progress.takeProfits) ? progress.takeProfits : []),
    ...Object.entries(
      progress.takeProfitQuantities &&
        typeof progress.takeProfitQuantities === "object" &&
        !Array.isArray(progress.takeProfitQuantities)
        ? progress.takeProfitQuantities as Record<string, unknown>
        : {},
    )
      .filter(
        ([index, quantity]) =>
          /^\d+$/.test(index) &&
          Number.isFinite(Number(quantity)) &&
          Number(quantity) > 0,
      )
      .map(([index]) => Number(index)),
  ];
  const takeProfits = rebalanceLevels(
    plan.takeProfits,
    quantity,
    minOrderQty,
    quantityStep,
    progressedTakeProfitIndexes,
  );
  // Plans created before the explicit mode flag used a positive trailing
  // callback as the source of truth. Preserve that legacy selection whenever
  // an existing position is resized or reconciled.
  const normalizedMode = normalizeRiskProtectionMode(
    plan,
    Number(trailingStopPercent),
  );
  const dynamicProfitProtectionEnabled =
    normalizedMode.plan.dynamicProfitProtectionEnabled;
  const stopLosses = dynamicProfitProtectionEnabled
    ? {
      levels: [] as RebalancedRiskLevel[],
      requestedGrids: 0,
      actualGrids: 0,
      reduced: false,
    }
    : rebalanceLevels(
      plan.stopLosses,
      quantity,
      minOrderQty,
      quantityStep,
      progress.stopLosses,
    );
  return {
    plan: {
      ...plan,
      calculationMode: "ROE",
      dynamicProfitProtectionEnabled,
      takeProfits: takeProfits.levels,
      stopLosses: stopLosses.levels,
    },
    takeProfitGrids: {
      requested: takeProfits.requestedGrids,
      actual: takeProfits.actualGrids,
      reduced: takeProfits.reduced,
    },
    stopLossGrids: {
      requested: stopLosses.requestedGrids,
      actual: stopLosses.actualGrids,
      reduced: stopLosses.reduced,
    },
  };
}
