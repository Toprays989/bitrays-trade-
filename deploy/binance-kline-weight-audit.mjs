const KLINE_PATHS = new Set([
  "/fapi/v1/klines",
  "/fapi/v1/markPriceKlines",
]);

const MINUTE_MS = 60_000;
const DEFAULT_EVALUATION_MINUTES = 5;
const DEFAULT_TOTAL_WEIGHT_THRESHOLD = 400;
const DEFAULT_KLINE_REQUEST_THRESHOLD = 80;

function percent(numerator, denominator) {
  if (!(denominator > 0)) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function requestIdentity(event) {
  if (typeof event.requestKey === "string" && event.requestKey)
    return event.requestKey;
  const symbol = typeof event.symbol === "string" ? event.symbol : "*";
  const interval = typeof event.interval === "string" ? event.interval : "*";
  return `${event.pathname}:${symbol}:${interval}`;
}

function consecutiveTailCount(values, predicate) {
  let count = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (!predicate(values[index])) break;
    count += 1;
  }
  return count;
}

/**
 * Audit real upstream K-line usage without changing scheduler behavior.
 *
 * Review is requested only for the four approved evidence thresholds:
 * five complete high-weight minutes, five complete >80 K-line request minutes,
 * a recent 418/429, or duplicate identical upstream K-line requests. Cache hits
 * are absent because they consume no Binance request weight.
 */
export function summarizeBinanceKlineWeightAudit({
  events,
  rateLimitEvents = [],
  observationWeight,
  observationLimit,
  now = Date.now(),
  startedAt = 0,
  activeWindowMs = MINUTE_MS,
  evaluationMinutes = DEFAULT_EVALUATION_MINUTES,
  totalWeightThreshold = DEFAULT_TOTAL_WEIGHT_THRESHOLD,
  klineRequestThreshold = DEFAULT_KLINE_REQUEST_THRESHOLD,
}) {
  const safeLimit = Math.max(1, Number(observationLimit) || 1);
  const safeObservationWeight = Math.max(0, Number(observationWeight) || 0);
  const safeEvaluationMinutes = Math.max(1, Math.trunc(evaluationMinutes));
  const evaluationWindowMs = safeEvaluationMinutes * MINUTE_MS;
  const allEvents = (Array.isArray(events) ? events : []).filter((event) =>
    event && Number(event.at) > now - evaluationWindowMs - MINUTE_MS &&
    Number(event.at) <= now
  );
  const activeKlineEvents = allEvents.filter((event) =>
    Number(event.at) > now - activeWindowMs && KLINE_PATHS.has(event.pathname)
  );
  const activeEstimatedWeight = activeKlineEvents.reduce(
    (sum, event) => sum + Math.max(0, Number(event.weight) || 0),
    0,
  );

  const currentMinuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const firstCompleteMinuteStart =
    currentMinuteStart - safeEvaluationMinutes * MINUTE_MS;
  const completeMinutes = Array.from(
    { length: safeEvaluationMinutes },
    (_, index) => {
      const startMs = firstCompleteMinuteStart + index * MINUTE_MS;
      const endMs = startMs + MINUTE_MS;
      const bucketEvents = allEvents.filter((event) =>
        Number(event.at) >= startMs && Number(event.at) < endMs
      );
      const klineEvents = bucketEvents.filter((event) =>
        KLINE_PATHS.has(event.pathname)
      );
      return {
        startMs,
        endMs,
        totalWeight: bucketEvents.reduce(
          (sum, event) => sum + Math.max(0, Number(event.weight) || 0),
          0,
        ),
        klineUpstreamRequests: klineEvents.length,
        klineWeight: klineEvents.reduce(
          (sum, event) => sum + Math.max(0, Number(event.weight) || 0),
          0,
        ),
      };
    },
  );
  const completeWindowObserved = Number(startedAt) > 0 &&
    Number(startedAt) <= firstCompleteMinuteStart;
  const continuousHighWeightMinutes = completeWindowObserved
    ? consecutiveTailCount(
        completeMinutes,
        (item) => item.totalWeight > totalWeightThreshold,
      )
    : 0;
  const continuousHighKlineMinutes = completeWindowObserved
    ? consecutiveTailCount(
        completeMinutes,
        (item) => item.klineUpstreamRequests > klineRequestThreshold,
      )
    : 0;

  const completedKlineEvents = allEvents.filter((event) =>
    Number(event.at) >= firstCompleteMinuteStart &&
    Number(event.at) < currentMinuteStart &&
    KLINE_PATHS.has(event.pathname)
  );
  const identityCounts = new Map();
  for (const event of completedKlineEvents) {
    const minute = Math.floor(Number(event.at) / MINUTE_MS);
    const identity = `${minute}:${requestIdentity(event)}`;
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }
  const duplicateRequestGroups = [...identityCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([identity, count]) => ({ identity, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 20);
  const recentRateLimits = (Array.isArray(rateLimitEvents)
    ? rateLimitEvents
    : [])
    .filter((event) =>
      event && Number(event.at) > now - evaluationWindowMs &&
      [418, 429].includes(Number(event.status))
    );

  const reasons = [];
  if (continuousHighWeightMinutes >= safeEvaluationMinutes)
    reasons.push("TOTAL_WEIGHT_OVER_THRESHOLD_FOR_FIVE_MINUTES");
  if (continuousHighKlineMinutes >= safeEvaluationMinutes)
    reasons.push("KLINE_UPSTREAM_OVER_80_PER_MINUTE_FOR_FIVE_MINUTES");
  if (recentRateLimits.length)
    reasons.push("BINANCE_OR_LOCAL_RATE_LIMIT_OBSERVED");
  if (duplicateRequestGroups.length)
    reasons.push("DUPLICATE_IDENTICAL_KLINE_UPSTREAM_REQUEST");
  const scheduleReviewRequired = reasons.length > 0;
  return {
    version: "binance-kline-weight-audit-v2",
    activeWindowMs,
    evaluationWindowMs,
    evaluationMinutes: safeEvaluationMinutes,
    completeWindowObserved,
    upstreamRequests: activeKlineEvents.length,
    estimatedWeight: activeEstimatedWeight,
    observationWeight: safeObservationWeight,
    observationLimit: safeLimit,
    klineSharePercent: percent(activeEstimatedWeight, safeObservationWeight),
    observationUtilizationPercent: percent(safeObservationWeight, safeLimit),
    totalWeightThreshold,
    klineRequestThreshold,
    continuousHighWeightMinutes,
    continuousHighKlineMinutes,
    recentRateLimitCount: recentRateLimits.length,
    recent429Count: recentRateLimits.filter((event) => Number(event.status) === 429).length,
    recent418Count: recentRateLimits.filter((event) => Number(event.status) === 418).length,
    duplicateRequestGroupCount: duplicateRequestGroups.length,
    duplicateRequestGroups,
    completeMinutes,
    status: scheduleReviewRequired ? "REVIEW_REQUIRED" : "WITHIN_BUDGET",
    reviewReasons: reasons,
    scheduleReviewRequired,
    schedulerChangedAutomatically: false,
    monitorOnly: true,
    basis: "UPSTREAM_ONLY_AFTER_SHARED_CACHE",
  };
}
