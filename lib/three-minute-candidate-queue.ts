export const THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY = 12;
export const THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH = 5;
export const THREE_MINUTE_CANDIDATE_DISCOVERY_BATCH = 9;
// A market scan is a cheap WebSocket mark-price pass. Only the strongest
// symbols proceed to multi-interval candle loading, so a larger rotation does
// not multiply Binance REST weight.
export const THREE_MINUTE_MARKET_SCAN_BATCH = 64;

export function planThreeMinuteCandidateQueueAdmission(queuedCount: number) {
  const normalizedQueuedCount = Number.isFinite(queuedCount)
    ? Math.max(0, Math.trunc(queuedCount))
    : 0;
  const availableSlots = Math.max(
    0,
    THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY - normalizedQueuedCount,
  );
  return Object.freeze({
    queuedCount: normalizedQueuedCount,
    availableSlots,
    admissionLimit: Math.min(
      THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH,
      availableSlots,
    ),
    full: availableSlots === 0,
  });
}
