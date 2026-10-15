import type { NexusUnifiedCandle } from "./nexus-unified-market-data.ts";
import { analyzeNexusMultiHourContext } from "./nexus-multi-hour-context.ts";
import { classifyNexusMarketRegimeFromCandles } from "./nexus-market-regime.ts";
import {
  alignOrderQuantityUp,
  automatedOrderQuantityFromMinimum,
  effectiveMinimumOrderQuantity,
  normalizeAutomatedOrderQuantityMultiplier,
} from "./order-quantity.ts";
import {
  PRIMARY_MARKET_QUOTE_VOLUME_24H_USDT,
  isPrimaryLiquidityMarket,
} from "./market-liquidity-priority.ts";

export const RELATIVE_STRENGTH_TREND_VERSION =
  "relative-strength-trend-v2" as const;

export const DEFAULT_RELATIVE_STRENGTH_CORE_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
] as const;

export type RelativeStrengthMarketGroup = "CRYPTO" | "TRADFI";

export type RelativeStrengthConfig = {
  enabled: boolean;
  minimumQuoteVolume24hUsdt: number;
  coreSymbols: string[];
  includeTradfi: boolean;
  maxCandidatesPerCycle: number;
  pairCooldownMinutes: number;
  minimumRelativeVolume5m: number;
  minimumSpread5mPercent: number;
  minimumSpread30mPercent: number;
  minimumSpread1hPercent: number;
  maximumEntryDistanceAtr: number;
  executionMode: "SHADOW" | "LIVE";
};

export const DEFAULT_RELATIVE_STRENGTH_CONFIG: RelativeStrengthConfig = {
  enabled: true,
  minimumQuoteVolume24hUsdt: PRIMARY_MARKET_QUOTE_VOLUME_24H_USDT,
  coreSymbols: [...DEFAULT_RELATIVE_STRENGTH_CORE_SYMBOLS],
  includeTradfi: false,
  maxCandidatesPerCycle: 8,
  pairCooldownMinutes: 90,
  minimumRelativeVolume5m: 1.4,
  minimumSpread5mPercent: 0.2,
  minimumSpread30mPercent: 0.45,
  minimumSpread1hPercent: 0.9,
  maximumEntryDistanceAtr: 0.35,
  executionMode: "LIVE",
};

export type RelativeStrengthUniverseRow = {
  symbol: string;
  quoteVolume24h: number | null;
  contractType: string;
  isActive: boolean;
};

export type RelativeStrengthUniverseMember = RelativeStrengthUniverseRow & {
  symbol: string;
  group: RelativeStrengthMarketGroup;
  inclusionReasons: Array<"CORE" | "HIGH_VOLUME" | "TRADFI">;
};

export function normalizeRelativeStrengthConfig(
  value: Partial<RelativeStrengthConfig> | null | undefined,
): RelativeStrengthConfig {
  const coreSymbols = Array.isArray(value?.coreSymbols)
    ? [...new Set(value!.coreSymbols.map(normalizeSymbol).filter(Boolean))]
    : [...DEFAULT_RELATIVE_STRENGTH_CORE_SYMBOLS];
  return {
    enabled: value?.enabled !== false,
    minimumQuoteVolume24hUsdt: positive(
      value?.minimumQuoteVolume24hUsdt,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.minimumQuoteVolume24hUsdt,
    ),
    coreSymbols: coreSymbols.length
      ? coreSymbols
      : [...DEFAULT_RELATIVE_STRENGTH_CORE_SYMBOLS],
    includeTradfi: typeof value?.includeTradfi === "boolean"
      ? value.includeTradfi
      : DEFAULT_RELATIVE_STRENGTH_CONFIG.includeTradfi,
    maxCandidatesPerCycle: integerBetween(
      value?.maxCandidatesPerCycle,
      4,
      24,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.maxCandidatesPerCycle,
    ),
    pairCooldownMinutes: integerBetween(
      value?.pairCooldownMinutes,
      1,
      1_440,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.pairCooldownMinutes,
    ),
    minimumRelativeVolume5m: between(
      value?.minimumRelativeVolume5m,
      1,
      5,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.minimumRelativeVolume5m,
    ),
    minimumSpread5mPercent: between(
      value?.minimumSpread5mPercent,
      0.01,
      10,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.minimumSpread5mPercent,
    ),
    minimumSpread30mPercent: between(
      value?.minimumSpread30mPercent,
      0.01,
      20,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.minimumSpread30mPercent,
    ),
    minimumSpread1hPercent: between(
      value?.minimumSpread1hPercent,
      0.01,
      30,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.minimumSpread1hPercent,
    ),
    maximumEntryDistanceAtr: between(
      value?.maximumEntryDistanceAtr,
      0.1,
      3,
      DEFAULT_RELATIVE_STRENGTH_CONFIG.maximumEntryDistanceAtr,
    ),
    executionMode: value?.executionMode === "SHADOW" ? "SHADOW" : "LIVE",
  };
}

export function validateRelativeStrengthConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "相对强弱策略参数无效";
  const config = value as Partial<RelativeStrengthConfig>;
  if (
    !Array.isArray(config.coreSymbols) ||
    config.coreSymbols.some((item) => !/^[A-Z0-9]{1,20}USDT$/.test(String(item)))
  ) return "固定主流币池包含无效合约";
  if (!Number.isFinite(Number(config.minimumQuoteVolume24hUsdt)) || Number(config.minimumQuoteVolume24hUsdt) < PRIMARY_MARKET_QUOTE_VOLUME_24H_USDT)
    return "自动扩展合约的24小时成交额门槛不得低于3亿 USDT";
  if (!Number.isInteger(Number(config.maxCandidatesPerCycle)) || Number(config.maxCandidatesPerCycle) < 4 || Number(config.maxCandidatesPerCycle) > 24)
    return "每轮候选扫描数量需为4至24";
  if (!Number.isInteger(Number(config.pairCooldownMinutes)) || Number(config.pairCooldownMinutes) < 1 || Number(config.pairCooldownMinutes) > 1_440)
    return "同组合冷却时间需为1至1440分钟";
  if (!Number.isFinite(Number(config.minimumRelativeVolume5m)) || Number(config.minimumRelativeVolume5m) < 1)
    return "5分钟真实成交量确认倍数不得低于1";
  if (!Number.isFinite(Number(config.minimumSpread5mPercent)) || Number(config.minimumSpread5mPercent) <= 0 ||
      !Number.isFinite(Number(config.minimumSpread30mPercent)) || Number(config.minimumSpread30mPercent) <= 0 ||
      !Number.isFinite(Number(config.minimumSpread1hPercent)) || Number(config.minimumSpread1hPercent) <= 0)
    return "强弱价差延续阈值必须大于0";
  if (!Number.isFinite(Number(config.maximumEntryDistanceAtr)) || Number(config.maximumEntryDistanceAtr) < 0.1)
    return "最大追价距离不得低于0.1 ATR";
  if (!['SHADOW', 'LIVE'].includes(String(config.executionMode)))
    return "相对强弱执行模式无效";
  return null;
}

export function buildRelativeStrengthUniverse(input: {
  rows: RelativeStrengthUniverseRow[];
  config: RelativeStrengthConfig;
}) {
  const core = new Set(input.config.coreSymbols.map(normalizeSymbol));
  return input.rows
    .filter((row) => row.isActive)
    .map((row): RelativeStrengthUniverseMember | null => {
      const symbol = normalizeSymbol(row.symbol);
      if (!symbol) return null;
      const tradfi = row.contractType === "TRADIFI_PERPETUAL";
      if (tradfi && !input.config.includeTradfi) return null;
      const reasons: RelativeStrengthUniverseMember["inclusionReasons"] = [];
      if (core.has(symbol)) reasons.push("CORE");
      const highVolume =
        isPrimaryLiquidityMarket(row.quoteVolume24h) &&
        Number(row.quoteVolume24h) >= input.config.minimumQuoteVolume24hUsdt;
      if (highVolume) reasons.push("HIGH_VOLUME");
      // TradFi participates in the pair strategy only while it is in the
      // primary-liquidity lane. Lower-volume TradFi remains available solely
      // to the dedicated TradFi timing adapter as a fallback.
      if (tradfi && highVolume) reasons.push("TRADFI");
      if (!reasons.length) return null;
      return {
        ...row,
        symbol,
        group: tradfi ? "TRADFI" : "CRYPTO",
        inclusionReasons: reasons,
      };
    })
    .filter((row): row is RelativeStrengthUniverseMember => row !== null)
    .sort((left, right) =>
      left.group.localeCompare(right.group) ||
      Number(right.inclusionReasons.includes("CORE")) - Number(left.inclusionReasons.includes("CORE")) ||
      (right.quoteVolume24h ?? 0) - (left.quoteVolume24h ?? 0) ||
      left.symbol.localeCompare(right.symbol)
    );
}

export function selectRelativeStrengthScanBatch(input: {
  universe: RelativeStrengthUniverseMember[];
  maxCandidates: number;
  cursor: number;
}) {
  if (!input.universe.length) return { rows: [], nextCursor: 0 };
  const start = Math.max(0, Math.trunc(input.cursor)) % input.universe.length;
  const count = Math.min(input.maxCandidates, input.universe.length);
  const rows = Array.from(
    { length: count },
    (_, index) => input.universe[(start + index) % input.universe.length],
  );
  return {
    rows,
    nextCursor: (start + rows.length) % input.universe.length,
  };
}

export type RelativeStrengthSymbolSnapshot = {
  symbol: string;
  group: RelativeStrengthMarketGroup;
  referencePrice: number;
  return5mPercent: number;
  return30mPercent: number;
  return1hPercent: number;
  return4hPercent: number | null;
  relativeVolume5m: number;
  atr5m: number;
  entryDistanceAtr: number;
  confirmationPrice: number;
  structure5m: "UP" | "DOWN" | "RANGE";
  structure30m: "UP" | "DOWN" | "RANGE";
  structure1h: "UP" | "DOWN" | "RANGE";
  multiHourContext: ReturnType<typeof analyzeNexusMultiHourContext>;
  entryRegime5m: Omit<
    ReturnType<typeof classifyNexusMarketRegimeFromCandles>,
    "orderAffecting"
  > & { orderAffecting: true };
  state: "STRONG" | "WEAK" | "MIXED";
  continuationConfirmed: boolean;
  reasons: string[];
  candle5mOpenTime: number;
  candle30mOpenTime: number;
  candle1hOpenTime: number;
  observedAtMs: number;
};

export function analyzeRelativeStrengthSymbol(input: {
  symbol: string;
  group: RelativeStrengthMarketGroup;
  trade5m: NexusUnifiedCandle[];
  trade30m: NexusUnifiedCandle[];
  trade1h: NexusUnifiedCandle[];
  config: RelativeStrengthConfig;
}): RelativeStrengthSymbolSnapshot | null {
  if (input.trade5m.length < 21 || input.trade30m.length < 2 || input.trade1h.length < 2) return null;
  const latest5m = input.trade5m.at(-1)!;
  const referencePrice = latest5m.close;
  const path5m = input.trade5m.slice(-4);
  const path30m = input.trade30m.slice(-4);
  const path1h = input.trade1h.slice(-4);
  const return5mPercent = pathReturnPercent(path5m);
  const return30mPercent = pathReturnPercent(path30m);
  const return1hPercent = pathReturnPercent(path1h);
  const structure5m = pathDirection(path5m);
  const structure30m = pathDirection(path30m);
  const structure1h = pathDirection(path1h);
  const multiHourContext = analyzeNexusMultiHourContext({
    candles1h: input.trade1h,
    candles15m: aggregateFiveMinuteCandlesTo15m(input.trade5m),
  });
  const entryRegime5m = {
    ...classifyNexusMarketRegimeFromCandles({
      candles: input.trade5m,
    }),
    orderAffecting: true as const,
  };
  const priorVolumes = input.trade5m.slice(-21, -1).map((row) => row.quoteVolume ?? row.volume).filter((value) => Number.isFinite(value) && value >= 0);
  const latestVolume = latest5m.quoteVolume ?? latest5m.volume;
  const averageVolume = priorVolumes.reduce((sum, value) => sum + value, 0) / Math.max(1, priorVolumes.length);
  const relativeVolume5m = averageVolume > 0 ? latestVolume / averageVolume : 0;
  const atr5m = averageTrueRange(input.trade5m.slice(-16));
  const strong = structure5m === "UP" && structure30m === "UP" && structure1h === "UP";
  const weak = structure5m === "DOWN" && structure30m === "DOWN" && structure1h === "DOWN";
  const state = strong ? "STRONG" : weak ? "WEAK" : "MIXED";
  const confirmationRows = path5m.slice(0, -1);
  const confirmationPrice = state === "WEAK"
    ? Math.min(...confirmationRows.map((row) => row.low))
    : state === "STRONG"
      ? Math.max(...confirmationRows.map((row) => row.high))
      : confirmationRows.reduce((sum, row) => sum + row.close, 0) /
        Math.max(1, confirmationRows.length);
  const directionalDistance = state === "STRONG"
    ? Math.max(0, referencePrice - confirmationPrice)
    : state === "WEAK"
      ? Math.max(0, confirmationPrice - referencePrice)
      : Math.abs(referencePrice - confirmationPrice);
  const entryDistanceAtr = atr5m > 0
    ? directionalDistance / atr5m
    : Number.POSITIVE_INFINITY;
  const volumeConfirmed = relativeVolume5m >= input.config.minimumRelativeVolume5m;
  const distanceConfirmed = entryDistanceAtr <= input.config.maximumEntryDistanceAtr;
  const macroAligned = state === "STRONG"
    ? multiHourContext.decisionRegime === "BULLISH"
    : state === "WEAK"
      ? multiHourContext.decisionRegime === "BEARISH"
      : false;
  const entryRegimeAligned = state === "STRONG"
    ? entryRegime5m.regime === "BULLISH"
    : state === "WEAK"
      ? entryRegime5m.regime === "BEARISH"
      : false;
  return {
    symbol: normalizeSymbol(input.symbol),
    group: input.group,
    referencePrice,
    return5mPercent,
    return30mPercent,
    return1hPercent,
    return4hPercent: multiHourContext.horizon4h.returnPercent,
    relativeVolume5m,
    atr5m,
    entryDistanceAtr,
    confirmationPrice,
    structure5m,
    structure30m,
    structure1h,
    multiHourContext,
    entryRegime5m,
    state,
    continuationConfirmed:
      state !== "MIXED" &&
      volumeConfirmed &&
      distanceConfirmed &&
      macroAligned &&
      entryRegimeAligned,
    reasons: [
      state === "MIXED" ? "多周期结构方向尚未一致" : `${state === "STRONG" ? "强" : "弱"}势在5m/30m/1h路径持续`,
      macroAligned
        ? "1/2/3/4小时整体阶段与本腿方向一致"
        : `1/2/3/4小时整体阶段为 ${multiHourContext.phase}，尚未支持本腿方向`,
      entryRegimeAligned
        ? "5分钟入场状态与本腿方向一致"
        : `5分钟入场状态为 ${entryRegime5m.regime}，等待闭合结构确认`,
      volumeConfirmed ? "5分钟真实成交量确认" : "5分钟真实成交量尚未确认",
      distanceConfirmed ? "成交位置未远离多根K线结构确认位" : "价格已远离多根K线结构确认位，禁止追市价",
    ],
    candle5mOpenTime: latest5m.openTime,
    candle30mOpenTime: input.trade30m.at(-1)!.openTime,
    candle1hOpenTime: input.trade1h.at(-1)!.openTime,
    observedAtMs: Date.now(),
  };
}

export type RelativeStrengthPairDecision = {
  status: "READY" | "WAIT";
  group: RelativeStrengthMarketGroup | null;
  strong: RelativeStrengthSymbolSnapshot | null;
  weak: RelativeStrengthSymbolSnapshot | null;
  spread5mPercent: number | null;
  spread30mPercent: number | null;
  spread1hPercent: number | null;
  spread4hPercent: number | null;
  reasons: string[];
};

export function selectRelativeStrengthPair(input: {
  snapshots: RelativeStrengthSymbolSnapshot[];
  config: RelativeStrengthConfig;
}): RelativeStrengthPairDecision {
  const candidates: Array<RelativeStrengthPairDecision & { continuation: number }> = [];
  for (const group of ["CRYPTO", "TRADFI"] as const) {
    const rows = input.snapshots.filter((row) => row.group === group && row.continuationConfirmed);
    const strong = rows.filter((row) => row.state === "STRONG").sort(compareStrong)[0] ?? null;
    const weak = rows.filter((row) => row.state === "WEAK").sort(compareWeak)[0] ?? null;
    if (!strong || !weak || strong.symbol === weak.symbol) continue;
    const spread5mPercent = strong.return5mPercent - weak.return5mPercent;
    const spread30mPercent = strong.return30mPercent - weak.return30mPercent;
    const spread1hPercent = strong.return1hPercent - weak.return1hPercent;
    const spread4hPercent =
      strong.return4hPercent !== null && weak.return4hPercent !== null
        ? strong.return4hPercent - weak.return4hPercent
        : null;
    const ready =
      spread5mPercent >= input.config.minimumSpread5mPercent &&
      spread30mPercent >= input.config.minimumSpread30mPercent &&
      spread1hPercent >= input.config.minimumSpread1hPercent;
    candidates.push({
      status: ready ? "READY" : "WAIT",
      group,
      strong,
      weak,
      spread5mPercent,
      spread30mPercent,
      spread1hPercent,
      spread4hPercent,
      continuation: spread5mPercent + spread30mPercent + spread1hPercent,
      reasons: ready
        ? ["强腿多周期持续走强", "弱腿多周期持续走弱", "价差在5m/30m/1h继续扩散", "两腿真实成交量与成交位置均已确认"]
        : ["已形成强弱关系，但价差延续尚未同时通过三个周期"],
    });
  }
  const best = candidates.sort((left, right) => Number(right.status === "READY") - Number(left.status === "READY") || right.continuation - left.continuation)[0];
  if (best) return {
    status: best.status,
    group: best.group,
    strong: best.strong,
    weak: best.weak,
    spread5mPercent: best.spread5mPercent,
    spread30mPercent: best.spread30mPercent,
    spread1hPercent: best.spread1hPercent,
    spread4hPercent: best.spread4hPercent,
    reasons: best.reasons,
  };
  return {
    status: "WAIT",
    group: null,
    strong: null,
    weak: null,
    spread5mPercent: null,
    spread30mPercent: null,
    spread1hPercent: null,
    spread4hPercent: null,
    reasons: ["同一市场组尚未同时出现已确认的强腿与弱腿"],
  };
}

export function relativeStrengthPairKey(input: { group: RelativeStrengthMarketGroup; strongSymbol: string; weakSymbol: string }) {
  return `${input.group}:${normalizeSymbol(input.strongSymbol)}:${normalizeSymbol(input.weakSymbol)}`;
}

export type RelativeStrengthLegSizingInput = {
  markPrice: number;
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
};

export type RelativeStrengthBalancedPairSizing = {
  targetNotionalUsdt: number;
  balanceDifferencePercent: number;
  minimumOrderQuantityMultiplier: number;
  sizingCapitalUsdt: number;
  equityAllocationPercent: number;
  equityTargetMarginPerLegUsdt: number;
  evidenceAdjustedTargetMarginPerLegUsdt: number;
  approvedTargetMarginPerLegUsdt: number;
  minimumPositionNotionalUsdt: number;
  strong: { quantity: number; notional: number; requiredMargin: number };
  weak: { quantity: number; notional: number; requiredMargin: number };
};

/**
 * Sizes both legs from the strategy-owned share of currently available
 * capital, then aligns them to one executable notional. The configured
 * minimum must be executable on both contracts and the complete pair must fit
 * the available capital. Coarse quantity steps that cannot preserve a neutral
 * pair are rejected instead of silently becoming a naked bet.
 */
export function buildBalancedMinimumPairSizing(input: {
  strong: RelativeStrengthLegSizingInput;
  weak: RelativeStrengthLegSizingInput;
  leverage: number;
  sizingCapitalUsdt: number;
  equityAllocationPercent: number;
  minimumPositionNotionalUsdt: number;
  maximumMarginPerLegUsdt: number;
  maximumBalanceDifferencePercent?: number;
  minimumOrderQuantityMultiplier?: number;
}): RelativeStrengthBalancedPairSizing | null {
  const leverage = Number(input.leverage);
  const sizingCapitalUsdt = Number(input.sizingCapitalUsdt);
  const equityAllocationPercent = Number(input.equityAllocationPercent);
  const minimumPositionNotionalUsdt = Number(
    input.minimumPositionNotionalUsdt,
  );
  const maximumMargin = Number(input.maximumMarginPerLegUsdt);
  const maximumDifference = Number.isFinite(input.maximumBalanceDifferencePercent)
    ? Math.max(0, Number(input.maximumBalanceDifferencePercent))
    : 10;
  if (
    !Number.isFinite(leverage) || leverage < 1 ||
    !Number.isFinite(sizingCapitalUsdt) || sizingCapitalUsdt <= 0 ||
    !Number.isFinite(equityAllocationPercent) ||
    equityAllocationPercent <= 0 || equityAllocationPercent > 100 ||
    !Number.isFinite(minimumPositionNotionalUsdt) ||
    minimumPositionNotionalUsdt <= 0 ||
    !Number.isFinite(maximumMargin) || maximumMargin <= 0
  )
    return null;
  const minimumOrderQuantityMultiplier =
    normalizeAutomatedOrderQuantityMultiplier(
      input.minimumOrderQuantityMultiplier,
    );
  const equityTargetMarginPerLegUsdt =
    sizingCapitalUsdt * equityAllocationPercent / 100;
  const evidenceAdjustedTargetMarginPerLegUsdt =
    equityTargetMarginPerLegUsdt * minimumOrderQuantityMultiplier;
  const approvedTargetMarginPerLegUsdt = Math.min(
    evidenceAdjustedTargetMarginPerLegUsdt,
    maximumMargin,
  );
  const approvedTargetNotionalUsdt =
    approvedTargetMarginPerLegUsdt * leverage;
  const strongMinimumNotionalUsdt = Math.max(
    input.strong.minNotionalUsdt,
    minimumPositionNotionalUsdt,
  );
  const weakMinimumNotionalUsdt = Math.max(
    input.weak.minNotionalUsdt,
    minimumPositionNotionalUsdt,
  );
  if (
    approvedTargetNotionalUsdt + 1e-10 < strongMinimumNotionalUsdt ||
    approvedTargetNotionalUsdt + 1e-10 < weakMinimumNotionalUsdt
  ) return null;
  const minimumStrong = minimumExecutable(
    input.strong,
    1,
    strongMinimumNotionalUsdt,
  );
  const minimumWeak = minimumExecutable(
    input.weak,
    1,
    weakMinimumNotionalUsdt,
  );
  if (!minimumStrong || !minimumWeak) return null;

  let targetNotionalUsdt = approvedTargetNotionalUsdt;
  let strong = minimumStrong;
  let weak = minimumWeak;
  for (let index = 0; index < 4; index += 1) {
    const nextStrong = sizeLegAtNotional(
      input.strong,
      targetNotionalUsdt,
      1,
      strongMinimumNotionalUsdt,
    );
    const nextWeak = sizeLegAtNotional(
      input.weak,
      targetNotionalUsdt,
      1,
      weakMinimumNotionalUsdt,
    );
    if (!nextStrong || !nextWeak) return null;
    strong = nextStrong;
    weak = nextWeak;
    const nextTarget = Math.max(strong.notional, weak.notional);
    if (Math.abs(nextTarget - targetNotionalUsdt) <= 1e-10) break;
    targetNotionalUsdt = nextTarget;
  }
  const maximumNotional = Math.max(strong.notional, weak.notional);
  const balanceDifferencePercent = maximumNotional > 0
    ? (Math.abs(strong.notional - weak.notional) / maximumNotional) * 100
    : Number.POSITIVE_INFINITY;
  const strongMargin = strong.notional / leverage;
  const weakMargin = weak.notional / leverage;
  if (
    balanceDifferencePercent > maximumDifference + 1e-10 ||
    strongMargin > maximumMargin + 1e-10 ||
    weakMargin > maximumMargin + 1e-10 ||
    strongMargin + weakMargin > sizingCapitalUsdt + 1e-10
  ) return null;
  return {
    targetNotionalUsdt: maximumNotional,
    balanceDifferencePercent,
    minimumOrderQuantityMultiplier,
    sizingCapitalUsdt,
    equityAllocationPercent,
    equityTargetMarginPerLegUsdt,
    evidenceAdjustedTargetMarginPerLegUsdt,
    approvedTargetMarginPerLegUsdt,
    minimumPositionNotionalUsdt,
    strong: { ...strong, requiredMargin: strongMargin },
    weak: { ...weak, requiredMargin: weakMargin },
  };
}

function aggregateFiveMinuteCandlesTo15m(
  rows: NexusUnifiedCandle[],
): NexusUnifiedCandle[] {
  const intervalMs = 15 * 60_000;
  const fiveMinuteMs = 5 * 60_000;
  const grouped = new Map<number, NexusUnifiedCandle[]>();
  for (const row of rows) {
    const bucket = Math.floor(row.openTime / intervalMs) * intervalMs;
    const group = grouped.get(bucket) ?? [];
    group.push(row);
    grouped.set(bucket, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([openTime, group]) => {
      const candles = [...group].sort(
        (left, right) => left.openTime - right.openTime,
      );
      if (
        candles.length !== 3 ||
        candles.some(
          (candle, index) =>
            candle.openTime !== openTime + index * fiveMinuteMs,
        )
      ) return [];
      return [{
        openTime,
        open: candles[0].open,
        high: Math.max(...candles.map((candle) => candle.high)),
        low: Math.min(...candles.map((candle) => candle.low)),
        close: candles.at(-1)!.close,
        volume: candles.reduce((sum, candle) => sum + candle.volume, 0),
        quoteVolume: candles.reduce(
          (sum, candle) => sum + (candle.quoteVolume ?? candle.volume),
          0,
        ),
      }];
    });
}

function compareStrong(left: RelativeStrengthSymbolSnapshot, right: RelativeStrengthSymbolSnapshot) {
  return right.return1hPercent - left.return1hPercent || right.return30mPercent - left.return30mPercent || right.return5mPercent - left.return5mPercent;
}

function minimumExecutable(
  input: RelativeStrengthLegSizingInput,
  multiplier = 1,
  minimumNotionalUsdt = input.minNotionalUsdt,
) {
  if (
    !Number.isFinite(input.markPrice) || input.markPrice <= 0 ||
    !Number.isFinite(input.minOrderQty) || input.minOrderQty <= 0 ||
    !Number.isFinite(input.quantityStep) || input.quantityStep <= 0 ||
    !Number.isFinite(input.minNotionalUsdt) || input.minNotionalUsdt <= 0 ||
    !Number.isFinite(minimumNotionalUsdt) || minimumNotionalUsdt <= 0
  ) return null;
  const exchangeMinimum = effectiveMinimumOrderQuantity(
    input.minOrderQty,
    input.quantityStep,
    Math.max(input.minNotionalUsdt, minimumNotionalUsdt),
    input.markPrice,
  );
  const quantity = automatedOrderQuantityFromMinimum(
    exchangeMinimum,
    input.quantityStep,
    multiplier,
  );
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return { quantity, notional: quantity * input.markPrice };
}

function sizeLegAtNotional(
  input: RelativeStrengthLegSizingInput,
  targetNotionalUsdt: number,
  multiplier = 1,
  minimumNotionalUsdt = input.minNotionalUsdt,
) {
  const minimum = minimumExecutable(
    input,
    multiplier,
    minimumNotionalUsdt,
  );
  if (!minimum || !Number.isFinite(targetNotionalUsdt) || targetNotionalUsdt <= 0)
    return null;
  const quantity = alignOrderQuantityUp(
    targetNotionalUsdt / input.markPrice,
    minimum.quantity,
    input.quantityStep,
  );
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return { quantity, notional: quantity * input.markPrice };
}

function compareWeak(left: RelativeStrengthSymbolSnapshot, right: RelativeStrengthSymbolSnapshot) {
  return left.return1hPercent - right.return1hPercent || left.return30mPercent - right.return30mPercent || left.return5mPercent - right.return5mPercent;
}

function averageTrueRange(rows: NexusUnifiedCandle[]) {
  if (rows.length < 2) return 0;
  const values: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    values.push(Math.max(row.high - row.low, Math.abs(row.high - previous.close), Math.abs(row.low - previous.close)));
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(current: number, prior: number) {
  return prior > 0 ? ((current - prior) / prior) * 100 : 0;
}

function pathReturnPercent(rows: NexusUnifiedCandle[]) {
  if (rows.length < 2) return 0;
  return percentChange(rows.at(-1)!.close, rows[0].close);
}

function pathDirection(rows: NexusUnifiedCandle[]): "UP" | "DOWN" | "RANGE" {
  if (rows.length < 3) return "RANGE";
  const closes = rows.map((row) => row.close);
  const first = closes[0];
  const latest = closes.at(-1)!;
  const average = closes.reduce((sum, value) => sum + value, 0) / closes.length;
  if (latest > first && latest > average) return "UP";
  if (latest < first && latest < average) return "DOWN";
  return "RANGE";
}

function normalizeSymbol(value: unknown) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{1,20}USDT$/.test(symbol) ? symbol : "";
}

function positive(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function between(value: unknown, minimum: number, maximum: number, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}

function integerBetween(value: unknown, minimum: number, maximum: number, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}
