const CHINA_STANDARD_TIME_OFFSET_MS = 8 * 60 * 60 * 1_000;

export function chinaTradingDayWindow(nowMs = Date.now()) {
  const shifted = new Date(nowMs + CHINA_STANDARD_TIME_OFFSET_MS);
  const startedAtMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - CHINA_STANDARD_TIME_OFFSET_MS;
  return {
    startedAt: new Date(startedAtMs),
    nextStartedAt: new Date(startedAtMs + 24 * 60 * 60 * 1_000),
  };
}

export function chinaTradingHourWindow(nowMs = Date.now()) {
  const shifted = new Date(nowMs + CHINA_STANDARD_TIME_OFFSET_MS);
  const startedAtMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    shifted.getUTCHours(),
  ) - CHINA_STANDARD_TIME_OFFSET_MS;
  return {
    startedAt: new Date(startedAtMs),
    nextStartedAt: new Date(startedAtMs + 60 * 60 * 1_000),
  };
}

export function chinaTradingMonthStartedAt(nowMs = Date.now()) {
  const shifted = new Date(nowMs + CHINA_STANDARD_TIME_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) -
      CHINA_STANDARD_TIME_OFFSET_MS,
  );
}
