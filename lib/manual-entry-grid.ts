export type ManualGridDirection = "LONG" | "SHORT";

export type ManualGridLevelState = {
  index: number;
  price: number;
  triggerCount: number;
  state: "ARMED" | "WAIT_REARM";
};

export type ManualGridTrigger = {
  index: number;
  levelPrice: number;
  triggerPrice: number;
  direction: ManualGridDirection;
  triggerCount: number;
};

export type ManualGridMarketOrderRequest = {
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: ManualGridDirection;
  orderType: "MARKET";
  quantity: number;
  clientOrderId: string;
  triggerLevelPrice: number;
  triggerPrice: number;
  triggerCount: number;
};

export type ManualGridAdditionIntent = {
  positionId: number;
  basePositionVersion: number;
  clientOrderId: string;
  symbol: string;
  positionSide: ManualGridDirection;
  quantity: number;
  status: "PENDING";
  source: "MANUAL_GRID";
};

export function shouldBlockManualGridTrigger(input: {
  existingPositionCount: number;
  existingExecutionUnknownCount?: number;
}) {
  if (!Number.isInteger(input.existingPositionCount) || input.existingPositionCount < 0) {
    throw new Error("existingPositionCount must be a non-negative integer");
  }
  const unknown = input.existingExecutionUnknownCount ?? 0;
  if (!Number.isInteger(unknown) || unknown < 0 || unknown > input.existingPositionCount) {
    throw new Error("existingExecutionUnknownCount is invalid");
  }
  return {
    blocked: unknown > 0,
    mode: input.existingPositionCount === 0
      ? "OPEN_NEW_POSITION"
      : unknown > 0
        ? "BLOCK_RECONCILIATION"
        : "ADD_TO_EXISTING_POSITION",
    reason: unknown > 0
      ? "EXECUTION_UNKNOWN_POSITION_REQUIRES_RECONCILIATION"
      : null,
  } as const;
}

export type ManualGridTickResult = {
  levels: ManualGridLevelState[];
  triggers: ManualGridTrigger[];
};

export function allocateManualGridQuantity(input: {
  totalQuantity: number;
  levelCount: number;
  quantityStep: number;
}): number[] {
  finitePositive(input.totalQuantity, "totalQuantity");
  finitePositive(input.quantityStep, "quantityStep");
  if (!Number.isInteger(input.levelCount) || input.levelCount < 1 || input.levelCount > 100) {
    throw new Error("levelCount must be an integer between 1 and 100");
  }

  const units = Math.floor(input.totalQuantity / input.quantityStep + 1e-9);
  const baseUnits = Math.floor(units / input.levelCount);
  if (baseUnits < 1) throw new Error("totalQuantity is too small for the grid");
  const remainder = units - baseUnits * input.levelCount;
  const roundQuantity = (value: number) => Number(value.toFixed(12));
  return Array.from({ length: input.levelCount }, (_, index) =>
    roundQuantity((baseUnits + (index === input.levelCount - 1 ? remainder : 0)) * input.quantityStep),
  );
}

export function buildManualGridMarketOrderRequest(input: {
  planId: number;
  symbol: string;
  direction: ManualGridDirection;
  quantity: number;
  trigger: ManualGridTrigger;
}): ManualGridMarketOrderRequest {
  if (!Number.isInteger(input.planId) || input.planId <= 0) throw new Error("planId must be a positive integer");
  if (!/^[A-Z0-9_]{2,20}$/.test(input.symbol)) throw new Error("symbol is invalid");
  finitePositive(input.quantity, "quantity");
  if (input.trigger.direction !== input.direction) throw new Error("trigger direction mismatch");
  const clientOrderId = `mgrid_${input.planId}_${input.trigger.index}_${input.trigger.triggerCount}`;
  return {
    symbol: input.symbol,
    side: input.direction === "LONG" ? "BUY" : "SELL",
    positionSide: input.direction,
    orderType: "MARKET",
    quantity: input.quantity,
    clientOrderId: clientOrderId.slice(0, 36),
    triggerLevelPrice: input.trigger.levelPrice,
    triggerPrice: input.trigger.triggerPrice,
    triggerCount: input.trigger.triggerCount,
  };
}

export function buildManualGridAdditionIntent(input: {
  positionId: number;
  positionVersion: number;
  order: ManualGridMarketOrderRequest;
}): ManualGridAdditionIntent {
  if (!Number.isInteger(input.positionId) || input.positionId <= 0) throw new Error("positionId must be a positive integer");
  if (!Number.isInteger(input.positionVersion) || input.positionVersion < 1) throw new Error("positionVersion must be a positive integer");
  if (input.order.orderType !== "MARKET") throw new Error("manual grid additions must use market orders");
  return {
    positionId: input.positionId,
    basePositionVersion: input.positionVersion,
    clientOrderId: input.order.clientOrderId,
    symbol: input.order.symbol,
    positionSide: input.order.positionSide,
    quantity: input.order.quantity,
    status: "PENDING",
    source: "MANUAL_GRID",
  };
}

const finitePositive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
};

export function buildManualGridLevels(input: {
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
}): ManualGridLevelState[] {
  finitePositive(input.lowerPrice, "lowerPrice");
  finitePositive(input.upperPrice, "upperPrice");
  if (input.upperPrice <= input.lowerPrice) {
    throw new Error("upperPrice must be greater than lowerPrice");
  }
  if (!Number.isInteger(input.gridCount) || input.gridCount < 2 || input.gridCount > 100) {
    throw new Error("gridCount must be an integer between 2 and 100");
  }

  const step = (input.upperPrice - input.lowerPrice) / (input.gridCount - 1);
  return Array.from({ length: input.gridCount }, (_, index) => ({
    index,
    price: input.lowerPrice + step * index,
    triggerCount: 0,
    state: "ARMED" as const,
  }));
}

function rearmThreshold(levelPrice: number, direction: ManualGridDirection, hysteresisBps: number) {
  return direction === "LONG"
    ? levelPrice * (1 + hysteresisBps / 10_000)
    : levelPrice * (1 - hysteresisBps / 10_000);
}

/**
 * Evaluates one monotonic price transition. A level fires only on a crossing,
 * then must leave the level by the hysteresis distance before it can fire again.
 */
export function evaluateManualGridTick(input: {
  direction: ManualGridDirection;
  previousPrice: number | null;
  currentPrice: number;
  levels: ManualGridLevelState[];
  hysteresisBps?: number;
}): ManualGridTickResult {
  finitePositive(input.currentPrice, "currentPrice");
  if (input.previousPrice !== null) finitePositive(input.previousPrice, "previousPrice");
  const hysteresisBps = input.hysteresisBps ?? 5;
  if (!Number.isFinite(hysteresisBps) || hysteresisBps < 0 || hysteresisBps > 1_000) {
    throw new Error("hysteresisBps must be between 0 and 1000");
  }

  const levels = input.levels.map((level) => ({ ...level }));
  const triggers: ManualGridTrigger[] = [];
  if (input.previousPrice === null) return { levels, triggers };

  for (const level of levels) {
    if (level.state === "WAIT_REARM") {
      const threshold = rearmThreshold(level.price, input.direction, hysteresisBps);
      const rearmed = input.direction === "LONG"
        ? input.currentPrice >= threshold
        : input.currentPrice <= threshold;
      if (rearmed) level.state = "ARMED";
    }
  }

  const crossed = levels
    .filter((level) => {
      if (level.state !== "ARMED") return false;
      return input.direction === "LONG"
        ? input.previousPrice! > level.price && input.currentPrice <= level.price
        : input.previousPrice! < level.price && input.currentPrice >= level.price;
    })
    .sort((a, b) => input.direction === "LONG" ? b.price - a.price : a.price - b.price);

  for (const level of crossed) {
    level.triggerCount += 1;
    level.state = "WAIT_REARM";
    triggers.push({
      index: level.index,
      levelPrice: level.price,
      triggerPrice: input.currentPrice,
      direction: input.direction,
      triggerCount: level.triggerCount,
    });
  }

  return { levels, triggers };
}
