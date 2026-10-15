const CRITICAL_TRADING_REQUESTS = new Set([
  "GET /fapi/v1/order",
  "POST /fapi/v1/order",
  "DELETE /fapi/v1/order",
  "POST /fapi/v1/leverage",
]);

const PROTECTIVE_CLOSE_REQUESTS = new Set([
  "GET /fapi/v1/time",
  "GET /fapi/v3/positionRisk",
  "GET /fapi/v1/order",
  "POST /fapi/v1/order",
  "DELETE /fapi/v1/order",
]);

const OBSERVATION_REQUESTS = new Set([
  "GET /fapi/v1/klines",
  "GET /fapi/v1/markPriceKlines",
  "GET /fapi/v1/ticker/24hr",
  "GET /fapi/v1/ticker/price",
  "GET /fapi/v1/premiumIndex",
  "GET /fapi/v1/exchangeInfo",
  "GET /futures/data/openInterestHist",
  "GET /futures/data/topLongShortPositionRatio",
  "GET /futures/data/topLongShortAccountRatio",
  "GET /futures/data/takerlongshortRatio",
]);

export function isCriticalTradingRequest(method, pathname) {
  return CRITICAL_TRADING_REQUESTS.has(
    `${String(method || "").toUpperCase()} ${pathname}`,
  );
}

export function isProtectiveCloseRequest(method, pathname) {
  return PROTECTIVE_CLOSE_REQUESTS.has(
    `${String(method || "").toUpperCase()} ${pathname}`,
  );
}

export function isObservationRequest(method, pathname) {
  return OBSERVATION_REQUESTS.has(
    `${String(method || "").toUpperCase()} ${pathname}`,
  );
}

export function restWeightBucket(method, pathname) {
  return isObservationRequest(method, pathname) ? "OBSERVATION" : "TRADING";
}

export function evaluatePartitionedRestWeightReservation({
  method,
  pathname,
  tradingUsedWeight,
  observationUsedWeight,
  totalLocalUsedWeight,
  observedUsedWeight,
  requestWeight,
  tradingAdmissionLimit,
  tradingHardLimit,
  observationLimit,
  globalObservationLimit,
  globalAdmissionLimit,
  globalHardLimit,
  projectObservationLimit = observationLimit,
  projectAdmissionLimit = tradingAdmissionLimit,
  projectHardLimit = tradingHardLimit,
  criticalOverride = false,
}) {
  const bucket = restWeightBucket(method, pathname);
  const critical = isCriticalTradingRequest(method, pathname);
  const safe = (value, fallback) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
  };
  const weight = safe(requestWeight, globalHardLimit + 1);
  const tradingUsed = safe(tradingUsedWeight, tradingHardLimit);
  const observationUsed = safe(observationUsedWeight, observationLimit);
  const localTotal = safe(
    totalLocalUsedWeight,
    tradingUsed + observationUsed,
  );
  const observed = safe(observedUsedWeight, 0);
  const partitionUsed = bucket === "OBSERVATION" ? observationUsed : tradingUsed;
  const partitionLimit = bucket === "OBSERVATION"
    ? observationLimit
    : criticalOverride || critical
      ? tradingHardLimit
      : tradingAdmissionLimit;
  const globalUsed = Math.max(localTotal, observed);
  const globalLimit = bucket === "OBSERVATION"
    ? globalObservationLimit
    : criticalOverride
      ? globalHardLimit
      : globalAdmissionLimit;
  const projectUsed = localTotal;
  const projectLimit = bucket === "OBSERVATION"
    ? projectObservationLimit
    : criticalOverride || critical
      ? projectHardLimit
      : projectAdmissionLimit;
  const partitionProjected = partitionUsed + weight;
  const globalProjected = globalUsed + weight;
  const projectProjected = projectUsed + weight;
  const partitionAllowed = partitionProjected <= partitionLimit;
  const globalAllowed = globalProjected <= globalLimit;
  const projectAllowed = projectProjected <= projectLimit;
  return {
    allowed: partitionAllowed && projectAllowed && globalAllowed,
    bucket,
    reason: !partitionAllowed
      ? `${bucket}_WEIGHT_LIMIT`
      : !projectAllowed
        ? "PROJECT_WEIGHT_RESERVE"
      : !globalAllowed
        ? "GLOBAL_IP_WEIGHT_LIMIT"
        : null,
    weight,
    partitionUsed,
    partitionProjected,
    partitionLimit,
    projectUsed,
    projectProjected,
    projectLimit,
    globalUsed,
    globalProjected,
    globalLimit,
  };
}

export function restWeightUsedForRequest({
  localUsedWeight,
  observedUsedWeight,
  criticalOverride = false,
}) {
  const local = Number(localUsedWeight);
  const safeLocal = Number.isFinite(local) && local >= 0 ? local : 0;
  // Binance's observed IP weight may include unrelated services sharing the
  // public IP.  A caller-proven reduce-only close must still respect this
  // project's hard limit, but unrelated traffic must not disable an emergency
  // close.  Actual Binance 418/429 responses remain authoritative and activate
  // the proxy backoff before any further request is attempted.
  return criticalOverride
    ? safeLocal
    : effectiveRestUsedWeight({ localUsedWeight, observedUsedWeight });
}

export function restWeightLimitForRequest({
  method,
  pathname,
  admissionLimit,
  hardLimit,
  criticalOverride = false,
}) {
  return criticalOverride || isCriticalTradingRequest(method, pathname)
    ? hardLimit
    : admissionLimit;
}

export function evaluateRestWeightReservation({
  method,
  pathname,
  admissionLimit,
  hardLimit,
  usedWeight,
  requestWeight,
  criticalOverride = false,
}) {
  const limit = restWeightLimitForRequest({
    method,
    pathname,
    admissionLimit,
    hardLimit,
    criticalOverride,
  });
  const numericUsed = Number(usedWeight);
  const numericWeight = Number(requestWeight);
  const used = Number.isFinite(numericUsed) && numericUsed >= 0
    ? numericUsed
    : hardLimit;
  const weight = Number.isFinite(numericWeight) && numericWeight > 0
    ? numericWeight
    : hardLimit + 1;
  const projected = used + weight;
  return {
    allowed: projected <= limit,
    limit,
    projected,
    used,
    weight,
  };
}

export function effectiveRestUsedWeight({
  localUsedWeight,
  observedUsedWeight,
}) {
  const local = Number(localUsedWeight);
  const observed = Number(observedUsedWeight);
  const safeLocal = Number.isFinite(local) && local >= 0 ? local : 0;
  const safeObserved = Number.isFinite(observed) && observed >= 0 ? observed : 0;
  return Math.max(safeLocal, safeObserved);
}
