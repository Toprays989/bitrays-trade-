export function alignOrderQuantityUp(
  value: number,
  minimum: number,
  step: number,
) {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(step) ||
    minimum <= 0 ||
    step <= 0
  )
    return Number.NaN;
  const required = Math.max(value, minimum);
  const ticks = Math.ceil(required / step - 1e-10);
  return Number((ticks * step).toPrecision(15));
}

export function alignOrderQuantityDown(value: number, step: number) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    return Number.NaN;
  const ticks = Math.floor(value / step + 1e-10);
  return Number((ticks * step).toPrecision(15));
}

export function quantityStepTolerance(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 1e-12;
  return Math.max(step * 1e-8, Number.EPSILON * 32);
}

export function orderQuantityTicks(value: number, step: number) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    return Number.NaN;
  const ticks = Math.round(value / step);
  if (!Number.isSafeInteger(ticks)) return Number.NaN;
  return ticks;
}

export function orderQuantityFromTicks(ticks: number, step: number) {
  if (!Number.isSafeInteger(ticks) || ticks < 0 || !Number.isFinite(step) || step <= 0)
    return Number.NaN;
  return Number((ticks * step).toPrecision(15));
}

export const AUTOMATED_ORDER_QUANTITY_MULTIPLIER_MIN = 1;
export const AUTOMATED_ORDER_QUANTITY_MULTIPLIER_MAX = 5;

export function normalizeAutomatedOrderQuantityMultiplier(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return AUTOMATED_ORDER_QUANTITY_MULTIPLIER_MIN;
  return Math.min(
    AUTOMATED_ORDER_QUANTITY_MULTIPLIER_MAX,
    Math.max(AUTOMATED_ORDER_QUANTITY_MULTIPLIER_MIN, Math.trunc(numeric)),
  );
}

/**
 * Expands an already exchange-aligned minimum quantity by an integer strategy
 * multiplier without reintroducing floating-point step errors.
 */
export function automatedOrderQuantityFromMinimum(
  minimumQuantity: number,
  step: number,
  multiplier: unknown,
) {
  const minimumTicks = orderQuantityTicks(minimumQuantity, step);
  const normalizedMultiplier = normalizeAutomatedOrderQuantityMultiplier(
    multiplier,
  );
  if (!Number.isSafeInteger(minimumTicks) || minimumTicks <= 0)
    return Number.NaN;
  const multipliedTicks = minimumTicks * normalizedMultiplier;
  if (!Number.isSafeInteger(multipliedTicks)) return Number.NaN;
  return orderQuantityFromTicks(multipliedTicks, step);
}

export function subtractOrderQuantity(
  positionQuantity: number,
  reductionQuantity: number,
  step: number,
) {
  const positionTicks = orderQuantityTicks(positionQuantity, step);
  const reductionTicks = orderQuantityTicks(reductionQuantity, step);
  if (!Number.isFinite(positionTicks) || !Number.isFinite(reductionTicks))
    return Number.NaN;
  return orderQuantityFromTicks(
    Math.max(0, positionTicks - reductionTicks),
    step,
  );
}

export function canonicalizeOrderQuantity(value: number, step: number) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    return Number.NaN;
  const ticks = orderQuantityTicks(value, step);
  if (!Number.isFinite(ticks)) return Number.NaN;
  const nearest = orderQuantityFromTicks(ticks, step);
  return Math.abs(value - nearest) <= quantityStepTolerance(step)
    ? nearest
    : value;
}

export function isOrderQuantityLessThanOrEqual(
  value: number,
  maximum: number,
  step: number,
) {
  if (!Number.isFinite(value) || !Number.isFinite(maximum)) return false;
  return value <= maximum + quantityStepTolerance(step);
}

export function normalizeReduceQuantity(input: {
  requestedQuantity: number;
  positionQuantity: number;
  minimum: number;
  step: number;
}) {
  const { requestedQuantity, positionQuantity, minimum, step } = input;
  if (
    !Number.isFinite(requestedQuantity) ||
    requestedQuantity <= 0 ||
    !Number.isFinite(positionQuantity) ||
    positionQuantity <= 0 ||
    !Number.isFinite(minimum) ||
    minimum <= 0 ||
    !Number.isFinite(step) ||
    step <= 0
  )
    return Number.NaN;

  const canonicalPosition = canonicalizeOrderQuantity(positionQuantity, step);
  const alignedPosition = alignOrderQuantityDown(canonicalPosition, step);
  const effectiveMinimum = alignOrderQuantityUp(minimum, minimum, step);
  if (
    !Number.isFinite(alignedPosition) ||
    alignedPosition < effectiveMinimum - step * 1e-8
  )
    return Number.NaN;

  const requestsFullPosition =
    requestedQuantity >= canonicalPosition - quantityStepTolerance(step);
  let normalized = requestsFullPosition
    ? alignedPosition
    : alignOrderQuantityDown(
        Math.min(requestedQuantity, alignedPosition),
        step,
      );
  if (
    !Number.isFinite(normalized) ||
    normalized < effectiveMinimum - step * 1e-8
  )
    return Number.NaN;

  const remaining = Number(
    (alignedPosition - normalized).toPrecision(15),
  );
  if (
    remaining > step * 1e-8 &&
    remaining < effectiveMinimum - step * 1e-8
  )
    normalized = alignedPosition;

  return Number(normalized.toPrecision(15));
}

/**
 * Evidence deterioration is deliberately a partial de-risk, never an
 * accidental full close. If Binance quantity rules cannot leave an
 * independently tradable remainder, the caller must wait for the explicit
 * full-exit evidence or the configured hard protection instead.
 */
export function normalizePartialReduceQuantity(input: {
  requestedQuantity: number;
  positionQuantity: number;
  minimum: number;
  step: number;
}) {
  const normalized = normalizeReduceQuantity(input);
  if (!Number.isFinite(normalized) || normalized <= 0) return Number.NaN;
  const alignedPosition = alignOrderQuantityDown(
    canonicalizeOrderQuantity(input.positionQuantity, input.step),
    input.step,
  );
  if (
    !Number.isFinite(alignedPosition) ||
    normalized >= alignedPosition - quantityStepTolerance(input.step)
  ) return Number.NaN;
  return normalized;
}

/**
 * Prevents an automatic partial reduction from submitting an order or leaving
 * a remainder whose mark-value is below the exchange MIN_NOTIONAL rule.
 * Once protection has triggered, an unsplittable small position is exited in
 * full instead of repeatedly retrying an order Binance cannot execute.
 */
export function promoteReduceQuantityForMinNotional(input: {
  normalizedCloseQuantity: number;
  positionQuantity: number;
  markPrice: number;
  minNotionalUsdt: number;
  step: number;
}) {
  const {
    normalizedCloseQuantity,
    positionQuantity,
    markPrice,
    minNotionalUsdt,
    step,
  } = input;
  if (
    !Number.isFinite(normalizedCloseQuantity) ||
    normalizedCloseQuantity <= 0 ||
    !Number.isFinite(positionQuantity) ||
    positionQuantity <= 0 ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0 ||
    !Number.isFinite(step) ||
    step <= 0
  ) return Number.NaN;

  const alignedPosition = alignOrderQuantityDown(
    canonicalizeOrderQuantity(positionQuantity, step),
    step,
  );
  const alignedClose = alignOrderQuantityDown(
    Math.min(normalizedCloseQuantity, alignedPosition),
    step,
  );
  if (
    !Number.isFinite(alignedPosition) ||
    alignedPosition <= 0 ||
    !Number.isFinite(alignedClose) ||
    alignedClose <= 0
  ) return Number.NaN;
  if (
    alignedClose >= alignedPosition - quantityStepTolerance(step) ||
    !Number.isFinite(minNotionalUsdt) ||
    minNotionalUsdt <= 0
  ) return alignedClose;

  const remainingQuantity = subtractOrderQuantity(
    alignedPosition,
    alignedClose,
    step,
  );
  if (!Number.isFinite(remainingQuantity)) return Number.NaN;

  const closeNotionalUsdt = alignedClose * markPrice;
  const remainingNotionalUsdt = remainingQuantity * markPrice;
  const belowMinimum = (notional: number) =>
    notional < minNotionalUsdt - 1e-10;
  if (
    belowMinimum(closeNotionalUsdt) ||
    (
      remainingQuantity > quantityStepTolerance(step) &&
      belowMinimum(remainingNotionalUsdt)
    )
  ) return alignedPosition;

  return alignedClose;
}

export type MinimumNotionalExitPolicy = {
  version: 1;
  mode: "STAGED" | "SINGLE_FULL_EXIT";
  referencePrice: number | null;
  minNotionalUsdt: number | null;
  stagedThresholdUsdt: number | null;
  positionNotionalUsdt: number | null;
  plannedExitLegCount: number;
  reason: "STAGED_EXIT_EXECUTABLE" | "MIN_NOTIONAL_UNSPLITTABLE" | "RULE_UNAVAILABLE";
};

/**
 * Resolves whether an automatic position can be split before a risk plan is
 * persisted. One extra minimum-notional unit is reserved so the final
 * remainder remains independently executable after the configured exit legs.
 */
export function resolveMinimumNotionalExitPolicy(input: {
  positionQuantity: number;
  referencePrice: number;
  minNotionalUsdt: number;
  plannedExitLegCount: number;
}): MinimumNotionalExitPolicy {
  const plannedExitLegCount = Math.max(
    1,
    Math.trunc(Number(input.plannedExitLegCount) || 1),
  );
  const ruleAvailable =
    Number.isFinite(input.positionQuantity) &&
    input.positionQuantity > 0 &&
    Number.isFinite(input.referencePrice) &&
    input.referencePrice > 0 &&
    Number.isFinite(input.minNotionalUsdt) &&
    input.minNotionalUsdt > 0;
  if (!ruleAvailable)
    return {
      version: 1,
      mode: "STAGED",
      referencePrice: null,
      minNotionalUsdt: null,
      stagedThresholdUsdt: null,
      positionNotionalUsdt: null,
      plannedExitLegCount,
      reason: "RULE_UNAVAILABLE",
    };

  const positionNotionalUsdt = input.positionQuantity * input.referencePrice;
  const stagedThresholdUsdt =
    input.minNotionalUsdt * (plannedExitLegCount + 1);
  const staged =
    positionNotionalUsdt >= stagedThresholdUsdt - 1e-10;
  return {
    version: 1,
    mode: staged ? "STAGED" : "SINGLE_FULL_EXIT",
    referencePrice: input.referencePrice,
    minNotionalUsdt: input.minNotionalUsdt,
    stagedThresholdUsdt,
    positionNotionalUsdt,
    plannedExitLegCount,
    reason: staged
      ? "STAGED_EXIT_EXECUTABLE"
      : "MIN_NOTIONAL_UNSPLITTABLE",
  };
}

export function effectiveMinimumOrderQuantity(
  minimum: number,
  step: number,
  minNotionalUsdt: number,
  price: number,
) {
  if (!Number.isFinite(minNotionalUsdt) || minNotionalUsdt <= 0)
    return alignOrderQuantityUp(minimum, minimum, step);
  const notionalQuantity = Number.isFinite(price) && price > 0
    ? minNotionalUsdt / price
    : minimum;
  return alignOrderQuantityUp(notionalQuantity, minimum, step);
}

/**
 * Market orders submitted exactly at Binance's minimum notional can be
 * rejected when the executable price moves between validation and matching.
 * Keep the buffer deliberately small: it is an execution allowance, not a
 * strategy sizing signal.
 */
export const MARKET_MIN_NOTIONAL_BUFFER_PERCENT = 2;

export function effectiveMarketMinimumOrderQuantity(
  minimum: number,
  step: number,
  minNotionalUsdt: number,
  price: number,
  bufferPercent = MARKET_MIN_NOTIONAL_BUFFER_PERCENT,
) {
  const exactMinimum = effectiveMinimumOrderQuantity(
    minimum,
    step,
    minNotionalUsdt,
    price,
  );
  if (
    !Number.isFinite(exactMinimum) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(minNotionalUsdt) ||
    minNotionalUsdt <= 0
  ) return exactMinimum;
  const safeBufferPercent =
    Number.isFinite(bufferPercent) && bufferPercent > 0
      ? bufferPercent
      : 0;
  const bufferedNotional =
    minNotionalUsdt * (1 + safeBufferPercent / 100);
  if (exactMinimum * price >= bufferedNotional - 1e-10)
    return exactMinimum;
  return effectiveMinimumOrderQuantity(
    minimum,
    step,
    bufferedNotional,
    price,
  );
}
