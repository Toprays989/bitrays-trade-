import type {
  PositionMarketMicrostructure,
} from "./position-market-microstructure.ts";

export const POSITION_ENTRY_PROBE_VERSION =
  "position-entry-probe-v1" as const;

export type PositionEntryProbeStatus =
  | "UNAVAILABLE"
  | "WARMING"
  | "WATCHING"
  | "FAILED"
  | "EXPIRED";

/**
 * 开仓后的短暂试探只消费开仓时冻结的失效边界和实时秒级价格事实。
 * 它不重放历史行情，也不覆盖已经确认仓位的止盈、移动保护或硬止损。
 */
export function evaluatePositionEntryProbe(input: {
  positionSide: "LONG" | "SHORT";
  openedAtMs: number;
  observedAtMs: number;
  invalidBoundary: number | null;
  microstructure: PositionMarketMicrostructure;
  minimumObservationSeconds?: number;
  maximumObservationSeconds?: number;
}) {
  const minimumObservationSeconds = boundedSeconds(
    input.minimumObservationSeconds,
    30,
  );
  const maximumObservationSeconds = Math.max(
    minimumObservationSeconds,
    boundedSeconds(input.maximumObservationSeconds, 90),
  );
  const elapsedSeconds = Math.max(
    0,
    (finite(input.observedAtMs) - finite(input.openedAtMs)) / 1_000,
  );
  const invalidBoundary = positive(input.invalidBoundary);
  const fifteen = input.microstructure.windows["15s"];
  const thirty = input.microstructure.windows["30s"];
  const enoughRealtimeFacts =
    fifteen.sampleCount >= 8 &&
    thirty.sampleCount >= 12 &&
    (input.microstructure.historyAgeMs ?? 0) >= 20_000;
  const beyondBoundary = invalidBoundary === null
    ? false
    : input.positionSide === "LONG"
      ? input.microstructure.markPrice < invalidBoundary
      : input.microstructure.markPrice > invalidBoundary;
  const sustainedAdverseFlow =
    fifteen.direction === "ADVERSE" &&
    ["ADVERSE", "MIXED"].includes(thirty.direction) &&
    (fifteen.adverseStepRatio ?? 0) >= 0.6;
  const currentLoss = input.microstructure.entryZone === "LOSS";

  const common = {
    version: POSITION_ENTRY_PROBE_VERSION,
    decisionRole: "ENTRY_PROBE_ONLY" as const,
    elapsedSeconds,
    minimumObservationSeconds,
    maximumObservationSeconds,
    invalidBoundary,
    enoughRealtimeFacts,
    beyondBoundary,
    sustainedAdverseFlow,
    currentLoss,
    exitAuthorized: false,
  };
  if (invalidBoundary === null)
    return {
      ...common,
      status: "UNAVAILABLE" as const,
      reason: "缺少开仓时冻结的失效边界；不把秒级波动单独当作试探失败。",
    };
  if (elapsedSeconds < minimumObservationSeconds)
    return {
      ...common,
      status: "WARMING" as const,
      reason: "开仓后秒级事实仍在积累，不因最初几秒的报价波动退出。",
    };
  if (elapsedSeconds > maximumObservationSeconds)
    return {
      ...common,
      status: "EXPIRED" as const,
      reason: "试探窗口已经结束；后续只由确认仓位的减险、移动保护与硬止损管理。",
    };
  if (!enoughRealtimeFacts)
    return {
      ...common,
      status: "WATCHING" as const,
      reason: "试探窗口内的秒级事实尚不足；保持仓位与既定硬止损，不作提前退出。",
    };
  if (beyondBoundary && currentLoss && sustainedAdverseFlow)
    return {
      ...common,
      status: "FAILED" as const,
      exitAuthorized: true,
      reason:
        "开仓后价格持续越过冻结失效边界，且15/30秒真实价格路径仍反向；本次试探失败，立即退出而不等待硬止损扩大。",
    };
  return {
    ...common,
    status: "WATCHING" as const,
    reason:
      "尚未同时满足越界、亏损和持续反向秒级路径；保留试探仓，继续等待确认或既定风险计划。",
  };
}

export function entryProbeInvalidBoundary(input: {
  positionSide: "LONG" | "SHORT";
  baseline: Record<string, unknown> | null | undefined;
  boundaryBufferAtr?: number;
}) {
  const baseline = input.baseline ?? {};
  const atr5m = positive(baseline.atr5m);
  const structuralLevel = positive(
    input.positionSide === "LONG"
      ? baseline.priorSupport
      : baseline.priorResistance,
  );
  if (atr5m === null || structuralLevel === null) return null;
  const boundaryBufferAtr = Math.max(
    0.05,
    finite(input.boundaryBufferAtr, 0.1),
  );
  return input.positionSide === "LONG"
    ? structuralLevel - atr5m * boundaryBufferAtr
    : structuralLevel + atr5m * boundaryBufferAtr;
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function boundedSeconds(value: unknown, fallback: number) {
  return Math.max(1, Math.min(300, finite(value, fallback)));
}
