export function pruneFuturesDataRequestEvents(
  events,
  now,
  windowMs,
) {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 300_000;
  while (events.length && events[0] <= safeNow - safeWindowMs) events.shift();
  return events.length;
}

export function reserveFuturesDataRequest(events, options) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : 300_000;
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : 1;
  pruneFuturesDataRequestEvents(events, now, windowMs);
  if (events.length >= limit) {
    return {
      allowed: false,
      used: events.length,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((events[0] + windowMs - now) / 1_000)),
    };
  }
  events.push(now);
  return {
    allowed: true,
    used: events.length,
    remaining: Math.max(0, limit - events.length),
    retryAfterSeconds: 0,
  };
}
