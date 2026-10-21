export type ProtectionVolatilityDay = {
  dayStartMs: number;
  low: number;
  high: number;
  first?: number;
  last?: number;
  sampleCount?: number;
  rangePercent?: number;
};

export type ProtectionVolatilityProfile = {
  windowDays: number;
  sampleDays: number;
  complete: boolean;
  averageRangePercent: number | null;
  medianRangePercent: number | null;
  p75RangePercent: number | null;
  maximumRangePercent: number | null;
  averageDownDayRangePercent: number | null;
  averageCloseChangePercent: number | null;
};

function finitePositive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function pricePercentFromRoe(roePercent: number, leverage: number) {
  const roe = Number(roePercent);
  const lev = Number(leverage);
  if (!Number.isFinite(roe) || !Number.isFinite(lev) || lev <= 0) return null;
  return roe / lev;
}

export function buildProtectionVolatilityProfile(input: {
  days: readonly ProtectionVolatilityDay[];
  windowDays?: number;
  minimumSamplesPerDay?: number;
}): ProtectionVolatilityProfile {
  const windowDays = Math.max(1, Math.floor(Number(input.windowDays) || 7));
  const minimumSamplesPerDay = Math.max(1, Math.floor(Number(input.minimumSamplesPerDay) || 20));
  const valid = input.days
    .map((day) => {
      const low = finitePositive(day.low);
      const high = finitePositive(day.high);
      const first = finitePositive(day.first);
      const last = finitePositive(day.last);
      const sampleCount = Math.max(0, Math.floor(Number(day.sampleCount) || 0));
      if (low === null || high === null || high < low || sampleCount < minimumSamplesPerDay) return null;
      return {
        rangePercent: ((high - low) / low) * 100,
        closeChangePercent: first && last ? ((last - first) / first) * 100 : null,
      };
    })
    .filter((day): day is { rangePercent: number; closeChangePercent: number | null } => day !== null)
    .slice(-windowDays);
  const ranges = valid.map((day) => day.rangePercent);
  const downDayRanges = valid.filter((day) => (day.closeChangePercent ?? 0) < 0).map((day) => day.rangePercent);
  const changes = valid.map((day) => day.closeChangePercent).filter((value): value is number => value !== null);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    windowDays,
    sampleDays: valid.length,
    complete: valid.length >= windowDays,
    averageRangePercent: average(ranges),
    medianRangePercent: percentile(ranges, 0.5),
    p75RangePercent: percentile(ranges, 0.75),
    maximumRangePercent: ranges.length ? Math.max(...ranges) : null,
    averageDownDayRangePercent: average(downDayRanges),
    averageCloseChangePercent: average(changes),
  };
}
