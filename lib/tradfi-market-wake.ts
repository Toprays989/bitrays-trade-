export type TradfiWakeCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
};

export type TradfiHighPositionWake = {
  version: 1;
  wake: boolean;
  code:
    | "READY"
    | "INSUFFICIENT_72H_HISTORY"
    | "NOT_AT_72H_HIGH"
    | "VOLUME_NOT_EXPANDED"
    | "CLOSED_STRUCTURE_NOT_WEAKENING";
  symbol: string;
  direction: "SHORT";
  eventAt: number | null;
  referencePrice: number | null;
  high72h: number | null;
  low72h: number | null;
  position72hPercent: number | null;
  relativeVolume5m: number | null;
  requiredHighPosition72hPercent: number;
  requiredRelativeVolume5m: number;
  bearishClose: boolean;
  lowerClose: boolean;
  upperRejection: boolean;
  lowerHigh: boolean;
  summary: string;
};

/**
 * TradFi market adapter only decides whether a symbol deserves immediate
 * attention.  It does not approve an order.  The shared NEXUS brain still
 * owns direction confirmation, execution and the complete risk lifecycle.
 */
export function evaluateTradfiHighPositionWake(input: {
  symbol: string;
  candles1h: TradfiWakeCandle[];
  candles5m: TradfiWakeCandle[];
  highPosition72hPercent?: number;
  minimumRelativeVolume5m?: number;
}): TradfiHighPositionWake {
  const symbol = input.symbol.trim().toUpperCase();
  const requiredHighPosition72hPercent = clamp(
    input.highPosition72hPercent ?? 85,
    50,
    100,
  );
  const requiredRelativeVolume5m = clamp(
    input.minimumRelativeVolume5m ?? 1.2,
    1,
    10,
  );
  const hourly = validCandles(input.candles1h).slice(-72);
  const fiveMinute = validCandles(input.candles5m).slice(-21);
  if (hourly.length < 72 || fiveMinute.length < 21)
    return emptyResult(
      "INSUFFICIENT_72H_HISTORY",
      "72小时或5分钟闭合行情不足，继续等待",
    );

  const latest = fiveMinute.at(-1)!;
  const previous = fiveMinute.at(-2)!;
  const high72h = Math.max(...hourly.map((row) => row.high), latest.close);
  const low72h = Math.min(...hourly.map((row) => row.low), latest.close);
  const range72h = high72h - low72h;
  const position72hPercent = range72h > 0
    ? ((latest.close - low72h) / range72h) * 100
    : null;
  const baselineVolumes = fiveMinute
    .slice(0, -1)
    .map(volumeValue)
    .filter((value) => value > 0);
  const baselineVolume = baselineVolumes.length
    ? baselineVolumes.reduce((sum, value) => sum + value, 0) /
      baselineVolumes.length
    : 0;
  const currentVolume = volumeValue(latest);
  const relativeVolume5m = baselineVolume > 0
    ? currentVolume / baselineVolume
    : null;
  const bearishClose = latest.close < latest.open;
  const lowerClose = latest.close < previous.close;
  const body = Math.abs(latest.close - latest.open);
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  const upperRejection = upperWick >= Math.max(body, latest.close * 0.0002);
  const lowerHigh = latest.high <= previous.high;
  const eventAt = latest.openTime + 5 * 60_000 - 1;

  if (
    position72hPercent === null ||
    position72hPercent < requiredHighPosition72hPercent
  )
    return result(
      "NOT_AT_72H_HIGH",
      `72小时位置 ${format(position72hPercent)}%，尚未进入高位观察区`,
    );
  if (
    relativeVolume5m === null ||
    relativeVolume5m < requiredRelativeVolume5m
  )
    return result(
      "VOLUME_NOT_EXPANDED",
      `5分钟真实成交量 ${format(relativeVolume5m)} 倍，尚未达到放量阈值`,
    );
  if (!(bearishClose && lowerClose && (upperRejection || lowerHigh)))
    return result(
      "CLOSED_STRUCTURE_NOT_WEAKENING",
      "价格处于高位，但闭合5分钟结构尚未出现放量转弱",
    );
  return result(
    "READY",
    `72小时高位 ${format(position72hPercent)}%，5分钟成交量 ${format(relativeVolume5m)} 倍并出现闭合转弱，唤醒原 NEXUS 大脑`,
    true,
  );

  function result(
    code: TradfiHighPositionWake["code"],
    summary: string,
    wake = false,
  ): TradfiHighPositionWake {
    return {
      version: 1,
      wake,
      code,
      symbol,
      direction: "SHORT",
      eventAt: typeof eventAt === "number" ? eventAt : null,
      referencePrice: latest?.close ?? null,
      high72h: typeof high72h === "number" ? high72h : null,
      low72h: typeof low72h === "number" ? low72h : null,
      position72hPercent:
        typeof position72hPercent === "number" ? position72hPercent : null,
      relativeVolume5m:
        typeof relativeVolume5m === "number" ? relativeVolume5m : null,
      requiredHighPosition72hPercent,
      requiredRelativeVolume5m,
      bearishClose: Boolean(bearishClose),
      lowerClose: Boolean(lowerClose),
      upperRejection: Boolean(upperRejection),
      lowerHigh: Boolean(lowerHigh),
      summary,
    };
  }

  function emptyResult(
    code: TradfiHighPositionWake["code"],
    summary: string,
  ): TradfiHighPositionWake {
    return {
      version: 1,
      wake: false,
      code,
      symbol,
      direction: "SHORT",
      eventAt: null,
      referencePrice: null,
      high72h: null,
      low72h: null,
      position72hPercent: null,
      relativeVolume5m: null,
      requiredHighPosition72hPercent,
      requiredRelativeVolume5m,
      bearishClose: false,
      lowerClose: false,
      upperRejection: false,
      lowerHigh: false,
      summary,
    };
  }
}

function validCandles(rows: TradfiWakeCandle[]) {
  return rows.filter(
    (row) =>
      Number.isFinite(row.openTime) &&
      row.openTime > 0 &&
      positive(row.open) &&
      positive(row.high) &&
      positive(row.low) &&
      positive(row.close) &&
      row.high >= row.low,
  );
}

function volumeValue(row: TradfiWakeCandle) {
  const quoteVolume = Number(row.quoteVolume);
  if (Number.isFinite(quoteVolume) && quoteVolume > 0) return quoteVolume;
  const volume = Number(row.volume);
  return Number.isFinite(volume) && volume > 0 ? volume : 0;
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function format(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}
