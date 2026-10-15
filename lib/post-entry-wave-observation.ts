export type PostEntryWaveState =
  | "NORMAL_RANGE"
  | "UPSIDE_BREAKOUT"
  | "SUPPORT_BREAK"
  | "UNAVAILABLE";

export type PositionWaveSide = "LONG" | "SHORT";

/**
 * 用同一套状态含义观察多空仓位：
 * - UPSIDE_BREAKOUT 表示“顺持仓方向突破”，并不固定代表价格上涨；
 * - SUPPORT_BREAK 表示“逆持仓方向失效”，空仓对应上破入场阻力。
 *
 * 保留原状态名称是为了兼容已落库样本和状态机，方向解释在这里统一。
 */
export function observePositionWaveStructure(input: {
  positionSide: PositionWaveSide;
  latestClosed5mPrice: number | null | undefined;
  favorableBoundary: number | null | undefined;
  invalidationBoundary: number | null | undefined;
}) {
  const close = finitePositive(input.latestClosed5mPrice);
  const favorableBoundary = finitePositive(input.favorableBoundary);
  const invalidationBoundary = finitePositive(input.invalidationBoundary);
  if (
    close === null ||
    favorableBoundary === null ||
    invalidationBoundary === null
  )
    return {
      state: "UNAVAILABLE" as const,
      supportIntact: null,
      priorHighBroken: null,
      summary: "入场结构边界或最新5分钟收盘价不足，暂不判断波段结构。",
    };

  if (input.positionSide === "SHORT") {
    const resistanceIntact = close <= invalidationBoundary;
    const continuationBroken = close < favorableBoundary;
    if (!resistanceIntact)
      return {
        state: "SUPPORT_BREAK" as const,
        supportIntact: resistanceIntact,
        priorHighBroken: continuationBroken,
        summary: `5分钟收盘 ${format(close)} 已上破空仓失效阻力 ${format(invalidationBoundary)}，原空头波段假设需要复核。`,
      };
    if (continuationBroken)
      return {
        state: "UPSIDE_BREAKOUT" as const,
        supportIntact: resistanceIntact,
        priorHighBroken: continuationBroken,
        summary: `5分钟收盘 ${format(close)} 已跌破空仓延续边界 ${format(favorableBoundary)}，进入空头波段延续观察。`,
      };
    return {
      state: "NORMAL_RANGE" as const,
      supportIntact: resistanceIntact,
      priorHighBroken: continuationBroken,
      summary: `5分钟收盘仍在空仓延续边界 ${format(favorableBoundary)} 与失效阻力 ${format(invalidationBoundary)} 之间，属于正常区间波动。`,
    };
  }

  return observeLongWaveStructure({
    latestClosed5mPrice: close,
    entrySupport: favorableBoundary,
    entryPriorHigh: invalidationBoundary,
  });
}

export function observeLongWaveStructure(input: {
  latestClosed5mPrice: number | null | undefined;
  entrySupport: number | null | undefined;
  entryPriorHigh: number | null | undefined;
}) {
  const close = finitePositive(input.latestClosed5mPrice);
  const support = finitePositive(input.entrySupport);
  const priorHigh = finitePositive(input.entryPriorHigh);
  if (close === null || support === null || priorHigh === null)
    return {
      state: "UNAVAILABLE" as const,
      supportIntact: null,
      priorHighBroken: null,
      summary: "入场支撑、前高或最新5分钟收盘价不足，暂不判断波段结构。",
    };
  const supportIntact = close >= support;
  const priorHighBroken = close > priorHigh;
  if (!supportIntact)
    return {
      state: "SUPPORT_BREAK" as const,
      supportIntact,
      priorHighBroken,
      summary: `5分钟收盘 ${format(close)} 已跌破入场支撑 ${format(support)}，原波段假设需要复核。`,
    };
  if (priorHighBroken)
    return {
      state: "UPSIDE_BREAKOUT" as const,
      supportIntact,
      priorHighBroken,
      summary: `5分钟收盘 ${format(close)} 已突破入场前高 ${format(priorHigh)}，进入波段延续观察。`,
    };
  return {
    state: "NORMAL_RANGE" as const,
    supportIntact,
    priorHighBroken,
    summary: `5分钟收盘仍在支撑 ${format(support)} 与前高 ${format(priorHigh)} 之间，属于正常区间波动。`,
  };
}

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function format(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
