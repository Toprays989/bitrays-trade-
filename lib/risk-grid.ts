import {
  effectiveMinimumOrderQuantity,
  orderQuantityFromTicks,
  orderQuantityTicks,
  resolveMinimumNotionalExitPolicy,
} from "./order-quantity.ts";

export type RiskGridConfig = {
  startPercent: number;
  endPercent: number;
  requestedGrids: number;
};

export type ExecutableRiskLevel = {
  triggerPercent: number;
  closePercent: number;
  closeQuantity: number;
};

export function normalizeRiskLevelsForExecution(input: {
  levels: ExecutableRiskLevel[];
  totalQuantity: number;
  minQuantity: number;
  quantityStep: number;
  referencePrice: number;
  minNotionalUsdt: number;
}) {
  const step = Math.max(input.quantityStep, 0.00000001);
  const totalTicks = Math.max(0, orderQuantityTicks(input.totalQuantity, step));
  const exitPolicy = resolveMinimumNotionalExitPolicy({
    positionQuantity: input.totalQuantity,
    referencePrice: input.referencePrice,
    minNotionalUsdt: input.minNotionalUsdt,
    plannedExitLegCount: input.levels.length,
  });
  if (!input.levels.length || totalTicks <= 0)
    return { levels: [] as ExecutableRiskLevel[], exitPolicy };
  if (exitPolicy.mode === "SINGLE_FULL_EXIT")
    return {
      levels: [{
        triggerPercent: input.levels[0].triggerPercent,
        closePercent: 100,
        closeQuantity: orderQuantityFromTicks(totalTicks, step),
      }],
      exitPolicy,
    };

  const effectiveMinimum = effectiveMinimumOrderQuantity(
    input.minQuantity,
    step,
    input.minNotionalUsdt,
    input.referencePrice,
  );
  const minimumTicks = Math.max(
    1,
    Math.ceil(effectiveMinimum / step - 1e-10),
  );
  const levels: ExecutableRiskLevel[] = [];
  let remainingTicks = totalTicks;
  let carriedTicks = 0;
  for (let index = 0; index < input.levels.length && remainingTicks > 0; index += 1) {
    const level = input.levels[index];
    const last = index === input.levels.length - 1;
    const requestedTicks = last
      ? remainingTicks
      : Math.min(
          remainingTicks,
          Math.max(0, orderQuantityTicks(level.closeQuantity, step)),
        );
    carriedTicks = Math.min(remainingTicks, carriedTicks + requestedTicks);
    if (!last && carriedTicks < minimumTicks) continue;
    if (
      !last &&
      remainingTicks - carriedTicks > 0 &&
      remainingTicks - carriedTicks < minimumTicks
    ) carriedTicks = remainingTicks;
    const closeTicks = last ? remainingTicks : carriedTicks;
    if (closeTicks <= 0) continue;
    levels.push({
      triggerPercent: level.triggerPercent,
      closePercent: closeTicks >= remainingTicks
        ? 100
        : Number(((closeTicks / remainingTicks) * 100).toFixed(6)),
      closeQuantity: orderQuantityFromTicks(closeTicks, step),
    });
    remainingTicks -= closeTicks;
    carriedTicks = 0;
  }
  if (!levels.length)
    levels.push({
      triggerPercent: input.levels[0].triggerPercent,
      closePercent: 100,
      closeQuantity: orderQuantityFromTicks(totalTicks, step),
    });
  return { levels, exitPolicy };
}

export function buildRiskGrid(
  config: RiskGridConfig,
  totalQuantity: number,
  minQuantity: number,
  quantityStep: number,
  executionRule?: {
    referencePrice: number;
    minNotionalUsdt: number;
  },
) {
  const step = Math.max(quantityStep, 0.00000001);
  const exitPolicy = resolveMinimumNotionalExitPolicy({
    positionQuantity: totalQuantity,
    referencePrice: executionRule?.referencePrice ?? Number.NaN,
    minNotionalUsdt: executionRule?.minNotionalUsdt ?? Number.NaN,
    plannedExitLegCount: config.requestedGrids,
  });
  const effectiveMinimum = executionRule
    ? effectiveMinimumOrderQuantity(
        minQuantity,
        step,
        executionRule.minNotionalUsdt,
        executionRule.referencePrice,
      )
    : minQuantity;
  const minimum = Math.max(
    Number.isFinite(effectiveMinimum) ? effectiveMinimum : minQuantity,
    step,
  );
  const totalTicks = Math.max(0, orderQuantityTicks(totalQuantity, step));
  const minimumTicks = Math.max(1, Math.ceil(minimum / step - 1e-10));
  const alignedTotalQuantity = orderQuantityFromTicks(totalTicks, step);
  let grids = Math.max(
    1,
    Math.min(
      10,
      Math.trunc(config.requestedGrids || 1),
      Math.floor(totalTicks / minimumTicks),
    ),
  );
  if (exitPolicy.mode === "SINGLE_FULL_EXIT") grids = 1;
  if (config.endPercent <= config.startPercent) grids = 1;
  while (grids > 1 && Math.floor(totalTicks / grids) < minimumTicks)
    grids -= 1;
  while (grids > 1) {
    const triggers = Array.from({ length: grids }, (_, index) =>
      Number((config.startPercent +
        ((config.endPercent - config.startPercent) * index) / (grids - 1)).toFixed(4)),
    );
    if (new Set(triggers).size === grids) break;
    grids -= 1;
  }
  const baseTicks = grids > 1
    ? Math.floor(totalTicks / grids)
    : totalTicks;
  const levels = Array.from({ length: grids }, (_, index) => {
    const closeTicks = index === grids - 1
      ? Math.max(0, totalTicks - baseTicks * (grids - 1))
      : baseTicks;
    const remainingBeforeTicks = Math.max(
      totalTicks - baseTicks * index,
      closeTicks,
    );
    const closeQuantity = orderQuantityFromTicks(closeTicks, step);
    const triggerPercent = grids === 1
      ? exitPolicy.mode === "SINGLE_FULL_EXIT"
        ? config.startPercent
        : config.endPercent
      : config.startPercent +
        ((config.endPercent - config.startPercent) * index) / (grids - 1);
    return {
      triggerPercent: Number(triggerPercent.toFixed(4)),
      closePercent: index === grids - 1
        ? 100
        : Number(Math.min((closeTicks / remainingBeforeTicks) * 100, 100).toFixed(6)),
      closeQuantity,
    };
  });
  return {
    levels,
    actualGrids: grids,
    reduced: grids < config.requestedGrids,
    minimum,
    step,
    alignedTotalQuantity,
    exitPolicy,
  };
}
