export const SEMI_AUTO_CONFIRMATION_WINDOW_MS = 2 * 60_000;
export const SEMI_AUTO_MAX_REFERENCE_PRICE_DRIFT_RATIO = 0.01;

export type SemiAutoConfirmationStatus =
  | "PENDING_CONFIRMATION"
  | "EXPIRED"
  | "SUBMITTED"
  | "NOT_EXECUTABLE";

export type SemiAutoRiskLevel = {
  triggerPercent: number;
  closePercent: number;
  closeQuantity: number;
};

export type SemiAutoStoredPlan = {
  accountId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  cancelAfterMinutes: number | null;
  referencePrice: number;
  leverage: number;
  quantity: number;
  minOrderQty: number;
  quantityStep: number;
  takeProfitSteps: Array<{
    profitPercent: number;
    closePercent: number;
  }>;
  stopLossRoePercent: number;
  trailingActivationRoePercent: number;
  trailingGivebackRoePoints: number;
  entryStructureBaseline: unknown;
};

export function semiAutoConfirmationExpiresAt(
  analyzedAt: Date | string | number,
) {
  const timestamp =
    analyzedAt instanceof Date
      ? analyzedAt.getTime()
      : typeof analyzedAt === "number"
        ? analyzedAt
        : Date.parse(analyzedAt);
  if (!Number.isFinite(timestamp))
    throw new Error("半自动分析时间无效");
  return timestamp + SEMI_AUTO_CONFIRMATION_WINDOW_MS;
}

export function semiAutoConfirmationStatus(input: {
  analyzedAt: Date | string | number;
  verdict: string;
  liveOrderEventId: number | null;
  now?: number;
}): SemiAutoConfirmationStatus {
  if (input.liveOrderEventId) return "SUBMITTED";
  if (input.verdict !== "EXECUTABLE") return "NOT_EXECUTABLE";
  return (input.now ?? Date.now()) <
    semiAutoConfirmationExpiresAt(input.analyzedAt)
    ? "PENDING_CONFIRMATION"
    : "EXPIRED";
}

export function semiAutoReferencePriceDriftRatio(
  referencePrice: number,
  currentPrice: number,
) {
  if (
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  )
    return Number.POSITIVE_INFINITY;
  return Math.abs(currentPrice - referencePrice) / referencePrice;
}

export function parseSemiAutoStoredPlan(
  value: unknown,
): SemiAutoStoredPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const orderType =
    source.orderType === "MARKET" || source.orderType === "LIMIT"
      ? source.orderType
      : null;
  const direction =
    source.direction === "LONG" || source.direction === "SHORT"
      ? source.direction
      : null;
  const takeProfitSteps = Array.isArray(source.takeProfitSteps)
    ? source.takeProfitSteps
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return null;
          const row = item as Record<string, unknown>;
          const profitPercent = finiteNumber(row.profitPercent);
          const closePercent = finiteNumber(row.closePercent);
          return profitPercent !== null &&
            profitPercent > 0 &&
            closePercent !== null &&
            closePercent > 0 &&
            closePercent <= 100
            ? { profitPercent, closePercent }
            : null;
        })
        .filter(
          (
            item,
          ): item is {
            profitPercent: number;
            closePercent: number;
          } => item !== null,
        )
    : [];
  const parsed = {
    accountId:
      typeof source.accountId === "string" ? source.accountId.trim() : "",
    symbol: typeof source.symbol === "string" ? source.symbol.trim() : "",
    direction,
    orderType,
    limitPrice:
      source.limitPrice === null ? null : finiteNumber(source.limitPrice),
    cancelAfterMinutes:
      source.cancelAfterMinutes === null
        ? null
        : finiteNumber(source.cancelAfterMinutes),
    referencePrice: finiteNumber(source.referencePrice),
    leverage: finiteNumber(source.leverage),
    quantity: finiteNumber(source.quantity),
    minOrderQty: finiteNumber(source.minOrderQty),
    quantityStep: finiteNumber(source.quantityStep),
    takeProfitSteps,
    stopLossRoePercent: finiteNumber(source.stopLossRoePercent),
    trailingActivationRoePercent: finiteNumber(
      source.trailingActivationRoePercent,
    ),
    trailingGivebackRoePoints: finiteNumber(
      source.trailingGivebackRoePoints,
    ),
    entryStructureBaseline: source.entryStructureBaseline,
  };
  if (
    !parsed.accountId ||
    !/^[A-Z0-9]{5,20}$/.test(parsed.symbol) ||
    !parsed.direction ||
    !parsed.orderType ||
    parsed.referencePrice === null ||
    parsed.referencePrice <= 0 ||
    parsed.leverage === null ||
    !Number.isInteger(parsed.leverage) ||
    parsed.leverage < 1 ||
    parsed.quantity === null ||
    parsed.quantity <= 0 ||
    parsed.minOrderQty === null ||
    parsed.minOrderQty <= 0 ||
    parsed.quantityStep === null ||
    parsed.quantityStep <= 0 ||
    parsed.takeProfitSteps.length < 1 ||
    parsed.takeProfitSteps.length > 10 ||
    parsed.takeProfitSteps.some(
      (step, index) =>
        index > 0 &&
        step.profitPercent <=
          parsed.takeProfitSteps[index - 1].profitPercent,
    ) ||
    parsed.takeProfitSteps.reduce(
      (sum, step) => sum + step.closePercent,
      0,
    ) >
      100 + 1e-8 ||
    parsed.stopLossRoePercent === null ||
    parsed.stopLossRoePercent <= 0 ||
    parsed.trailingActivationRoePercent === null ||
    parsed.trailingActivationRoePercent < 0 ||
    parsed.trailingGivebackRoePoints === null ||
    parsed.trailingGivebackRoePoints < 0 ||
    !parsed.entryStructureBaseline ||
    typeof parsed.entryStructureBaseline !== "object" ||
    Array.isArray(parsed.entryStructureBaseline) ||
    (parsed.orderType === "MARKET" &&
      (parsed.limitPrice !== null ||
        parsed.cancelAfterMinutes !== null)) ||
    (parsed.orderType === "LIMIT" &&
      (parsed.limitPrice === null ||
        parsed.limitPrice <= 0 ||
        parsed.cancelAfterMinutes === null ||
        !Number.isInteger(parsed.cancelAfterMinutes) ||
        parsed.cancelAfterMinutes < 1 ||
        parsed.cancelAfterMinutes > 3))
  )
    return null;
  return parsed as SemiAutoStoredPlan;
}

export function buildSemiAutoRiskLevels(
  plan: Pick<
    SemiAutoStoredPlan,
    | "quantity"
    | "quantityStep"
    | "minOrderQty"
    | "takeProfitSteps"
    | "stopLossRoePercent"
    | "trailingGivebackRoePoints"
  >,
) {
  const takeProfits: SemiAutoRiskLevel[] = [];
  const quantityTicks = quantityToTicks(
    plan.quantity,
    plan.quantityStep,
  );
  const minimumTicks = Math.max(
    1,
    Math.ceil(plan.minOrderQty / plan.quantityStep - 1e-10),
  );
  if (
    !Number.isSafeInteger(quantityTicks) ||
    quantityTicks < minimumTicks
  )
    return {
      takeProfits: [],
      stopLosses: [],
    };
  const totalClosePercent = Math.min(
    100,
    plan.takeProfitSteps.reduce(
      (sum, step) => sum + step.closePercent,
      0,
    ),
  );
  let targetCloseTicks = Math.floor(
    (quantityTicks * totalClosePercent) / 100 + 1e-10,
  );
  const targetRemainderTicks = quantityTicks - targetCloseTicks;
  if (
    targetRemainderTicks > 0 &&
    targetRemainderTicks < minimumTicks
  )
    targetCloseTicks = quantityTicks;
  let allocatedTicks = 0;
  let cumulativeClosePercent = 0;
  for (let index = 0; index < plan.takeProfitSteps.length; index += 1) {
    const step = plan.takeProfitSteps[index];
    cumulativeClosePercent = Math.min(
      100,
      cumulativeClosePercent + step.closePercent,
    );
    const last = index === plan.takeProfitSteps.length - 1;
    const cumulativeTargetTicks = last
      ? targetCloseTicks
      : Math.floor(
          (quantityTicks * cumulativeClosePercent) / 100 + 1e-10,
        );
    const closeTicks = cumulativeTargetTicks - allocatedTicks;
    if (closeTicks < minimumTicks) continue;
    const remainingBeforeTicks = quantityTicks - allocatedTicks;
    const remainingAfterTicks = remainingBeforeTicks - closeTicks;
    takeProfits.push({
      triggerPercent: step.profitPercent,
      closePercent: remainingAfterTicks <= 0
        ? 100
        : Number(
            ((closeTicks / remainingBeforeTicks) * 100).toFixed(6),
          ),
      closeQuantity: ticksToQuantity(
        closeTicks,
        plan.quantityStep,
      ),
    });
    allocatedTicks = cumulativeTargetTicks;
    if (allocatedTicks >= targetCloseTicks) break;
  }
  if (!takeProfits.length) {
    takeProfits.push({
      triggerPercent: plan.takeProfitSteps[0]?.profitPercent ?? 1,
      closePercent: 100,
      closeQuantity: ticksToQuantity(
        quantityTicks,
        plan.quantityStep,
      ),
    });
  } else if (allocatedTicks < targetCloseTicks) {
    const tailTicks = targetCloseTicks - allocatedTicks;
    const last = takeProfits.at(-1)!;
    const lastTicks = quantityToTicks(
      last.closeQuantity,
      plan.quantityStep,
    );
    const mergedTicks = lastTicks + tailTicks;
    last.closeQuantity = ticksToQuantity(
      mergedTicks,
      plan.quantityStep,
    );
    const remainingBeforeTicks =
      quantityTicks - (allocatedTicks - lastTicks);
    last.closePercent =
      targetCloseTicks >= quantityTicks
        ? 100
        : Number(
            ((mergedTicks / remainingBeforeTicks) * 100).toFixed(6),
          );
  }
  return {
    takeProfits,
    stopLosses:
      plan.trailingGivebackRoePoints > 0
        ? []
        : [
            {
              triggerPercent: plan.stopLossRoePercent,
              closePercent: 100,
              closeQuantity: plan.quantity,
            },
          ],
  };
}

export function semiAutoSubmissionMismatch(
  plan: SemiAutoStoredPlan,
  input: {
    accountId: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    orderType: "MARKET" | "LIMIT";
    price: number | undefined;
    quantity: number;
    leverage: number;
    cancelAfterMinutes: number;
    takeProfitPlan: SemiAutoRiskLevel[];
    stopLossPlan: SemiAutoRiskLevel[];
    trailingActivationPercent: number;
    trailingStopPercent: number;
    entryStructureBaseline: unknown;
  },
) {
  const expectedRisk = buildSemiAutoRiskLevels(plan);
  const mismatches: string[] = [];
  if (input.accountId !== plan.accountId) mismatches.push("账户");
  if (input.symbol !== plan.symbol) mismatches.push("合约");
  if (input.direction !== plan.direction) mismatches.push("方向");
  if (input.orderType !== plan.orderType) mismatches.push("委托方式");
  if (!sameNumber(input.quantity, plan.quantity)) mismatches.push("数量");
  if (input.leverage !== plan.leverage) mismatches.push("杠杆");
  if (
    plan.orderType === "LIMIT" &&
    !sameNumber(input.price, plan.limitPrice)
  )
    mismatches.push("限价");
  if (
    plan.orderType === "LIMIT" &&
    input.cancelAfterMinutes !== plan.cancelAfterMinutes
  )
    mismatches.push("撤单时间");
  if (
    !sameRiskLevels(input.takeProfitPlan, expectedRisk.takeProfits)
  )
    mismatches.push("止盈计划");
  if (
    !sameRiskLevels(input.stopLossPlan, expectedRisk.stopLosses)
  )
    mismatches.push("止损计划");
  if (
    !sameNumber(
      input.trailingActivationPercent,
      plan.trailingActivationRoePercent,
    )
  )
    mismatches.push("移动止损启动值");
  if (
    !sameNumber(
      input.trailingStopPercent,
      plan.trailingGivebackRoePoints,
    )
  )
    mismatches.push("移动止损回撤值");
  if (
    stableJson(input.entryStructureBaseline) !==
    stableJson(plan.entryStructureBaseline)
  )
    mismatches.push("入场结构");
  return mismatches;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function quantityToTicks(value: number, step: number) {
  return Math.round(value / step);
}

function ticksToQuantity(ticks: number, step: number) {
  return Number((ticks * step).toPrecision(15));
}

function sameNumber(
  left: number | null | undefined,
  right: number | null | undefined,
) {
  if (left === null || left === undefined)
    return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return (
    Math.abs(left - right) <=
    Math.max(1e-12, Math.abs(left), Math.abs(right)) * 1e-10
  );
}

function sameRiskLevels(
  left: SemiAutoRiskLevel[],
  right: SemiAutoRiskLevel[],
) {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        sameNumber(item.triggerPercent, right[index]?.triggerPercent) &&
        sameNumber(item.closePercent, right[index]?.closePercent) &&
        sameNumber(item.closeQuantity, right[index]?.closeQuantity),
    )
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
