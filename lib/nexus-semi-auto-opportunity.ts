import type {
  NexusBtcRelationshipResult,
} from "./nexus-btc-relationship";
import type {
  NexusMarketRegime,
  NexusMarketRegimeResult,
} from "./nexus-market-regime";

export const NEXUS_SEMI_AUTO_ANALYSIS_VERSION =
  "nexus-semi-auto-opportunity-v1" as const;

export type SemiAutoDirection = "LONG" | "SHORT";
export type SemiAutoVerdict =
  | "EXECUTABLE"
  | "WAIT"
  | "REJECTED"
  | "INSUFFICIENT";

export type SemiAutoIntervalEvidence = {
  interval: "1m" | "5m" | "15m" | "1h";
  regime: NexusMarketRegime;
  reason: string;
  fastEma: number | null;
  slowEma: number | null;
};

export type SemiAutoOpportunityDecision = {
  version: typeof NEXUS_SEMI_AUTO_ANALYSIS_VERSION;
  verdict: SemiAutoVerdict;
  summary: string;
  supportingEvidence: string[];
  counterEvidence: string[];
  missingEvidence: string[];
  invalidation: string[];
  alignedIntervals: number;
  opposingIntervals: number;
};

export function decideSemiAutoOpportunity(input: {
  direction: SemiAutoDirection;
  strategyDirection: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  markAgeMs: number;
  markTransportLatencyMs?: number;
  intervals: SemiAutoIntervalEvidence[];
  btc15m: NexusMarketRegimeResult;
  btc1h: NexusMarketRegimeResult;
  relationship: Pick<
    NexusBtcRelationshipResult,
    "state" | "relativeVolume" | "fastCorrelation" | "beta" | "reason"
  >;
  minimumIndependentRelativeVolume?: number;
}): SemiAutoOpportunityDecision {
  const support: string[] = [];
  const counter: string[] = [];
  const missing: string[] = [];
  const invalidation: string[] = [];
  const alignedRegime =
    input.direction === "LONG" ? "BULLISH" : "BEARISH";
  const opposingRegime =
    input.direction === "LONG" ? "BEARISH" : "BULLISH";
  const intervalMap = new Map(
    input.intervals.map((item) => [item.interval, item]),
  );
  const aligned = input.intervals.filter(
    (item) => item.regime === alignedRegime,
  );
  const opposing = input.intervals.filter(
    (item) => item.regime === opposingRegime,
  );
  const result = (
    verdict: SemiAutoVerdict,
    summary: string,
  ): SemiAutoOpportunityDecision => ({
    version: NEXUS_SEMI_AUTO_ANALYSIS_VERSION,
    verdict,
    summary,
    supportingEvidence: support,
    counterEvidence: counter,
    missingEvidence: missing,
    invalidation,
    alignedIntervals: aligned.length,
    opposingIntervals: opposing.length,
  });

  if (
    (input.direction === "LONG" && input.strategyDirection === "SHORT_ONLY") ||
    (input.direction === "SHORT" && input.strategyDirection === "LONG_ONLY")
  ) {
    counter.push("运营方向与所选大脑的已发布方向配置冲突");
    return result("REJECTED", "所选大脑不允许执行该方向");
  }
  const transportLatencyMs =
    input.markTransportLatencyMs ?? input.markAgeMs;
  if (
    !Number.isFinite(input.markAgeMs) ||
    input.markAgeMs > 1_500 ||
    !Number.isFinite(transportLatencyMs) ||
    transportLatencyMs > 500
  ) {
    missing.push("传输延迟500ms以内且快照不超过1500ms的WebSocket标记价格");
    return result(
      "INSUFFICIENT",
      "行情延迟超过开仓底线，禁止使用旧价格制定计划",
    );
  }
  if (
    input.intervals.length !== 4 ||
    input.intervals.some((item) => item.regime === "INSUFFICIENT")
  ) {
    missing.push("完整的1/5/15/60分钟闭合K线趋势");
    return result("INSUFFICIENT", "多周期行情证据不完整");
  }

  for (const item of aligned)
    support.push(`${item.interval} ${item.reason}`);
  for (const item of opposing)
    counter.push(`${item.interval} ${item.reason}`);
  for (const item of input.intervals.filter(
    (item) => item.regime === "TRANSITION" || item.regime === "RANGE",
  ))
    counter.push(`${item.interval} ${item.reason}`);

  const highTimeframeOpposed =
    intervalMap.get("1h")?.regime === opposingRegime ||
    (intervalMap.get("15m")?.regime === opposingRegime &&
      intervalMap.get("5m")?.regime === opposingRegime);
  if (highTimeframeOpposed) {
    invalidation.push("15分钟与1小时结构重新转为运营方向后才可重算");
    return result(
      "REJECTED",
      "目标币高周期结构与运营方向冲突，不建议逆势开仓",
    );
  }

  const relationship = input.relationship.state;
  const btcAligned =
    input.btc15m.regime === alignedRegime ||
    input.btc1h.regime === alignedRegime;
  const btcOpposed =
    input.btc15m.regime === opposingRegime &&
    input.btc1h.regime === opposingRegime;
  if (
    relationship === "BTC_FOLLOWING" ||
    relationship === "BTC_AMPLIFIED"
  ) {
    if (btcOpposed) {
      counter.push("目标币跟随BTC，但BTC 15分钟与1小时方向相反");
      invalidation.push("等待BTC至少一个高周期重新同向");
      return result(
        "REJECTED",
        "大盘联动方向冲突，当前计划的逆向选择风险过高",
      );
    }
    if (btcAligned)
      support.push("BTC联动关系稳定，且至少一个高周期方向一致");
  } else if (relationship === "INDEPENDENT_VOLUME_DRIVEN") {
    const threshold = Math.max(
      1,
      input.minimumIndependentRelativeVolume ?? 1.5,
    );
    if ((input.relationship.relativeVolume ?? 0) < threshold) {
      counter.push("独立行情相对成交量不足");
      return result("WAIT", "独立行情尚未获得持续成交量确认");
    }
    support.push(
      `目标币脱离BTC并放量，相对成交量 ${(input.relationship.relativeVolume ?? 0).toFixed(2)}×`,
    );
  } else if (relationship === "REGIME_TRANSITION") {
    counter.push("目标币与BTC联动关系正在切换");
    return result("WAIT", "联动关系未稳定，等待下一根闭合K线");
  } else if (relationship === "DECOUPLED_WEAK") {
    counter.push("目标币弱脱钩且没有独立放量证据");
    return result("WAIT", "当前波动更像噪音，不足以支持开仓");
  } else {
    missing.push("BTC联动或独立行情证据");
    return result("INSUFFICIENT", "BTC关联证据不足");
  }

  if (
    aligned.length >= 3 &&
    intervalMap.get("15m")?.regime === alignedRegime
  ) {
    invalidation.push(
      input.direction === "LONG"
        ? "5分钟收盘跌回快慢均线下方"
        : "5分钟收盘升回快慢均线上方",
    );
    invalidation.push("行情延迟超过500ms或BTC联动方向反转");
    return result(
      "EXECUTABLE",
      "运营假设得到多周期趋势与资金联动证据支持，可进入人工确认",
    );
  }

  missing.push("至少3个周期同向，且15分钟趋势同向");
  invalidation.push("若15分钟先转为反向趋势，本次机会作废");
  return result("WAIT", "方向有部分证据，但尚未达到可执行条件");
}

export function semiAutoScenarioEstimate(input: {
  notionalUsdt: number;
  leverage: number;
  stopLossRoePercent: number;
  takeProfitSteps: Array<{ profitPercent: number; closePercent: number }>;
  roundTripFeeRate?: number;
}) {
  const notional = Math.max(0, input.notionalUsdt);
  const leverage = Math.max(1, input.leverage);
  const feeRate = Math.max(0, input.roundTripFeeRate ?? 0.001);
  const fee = notional * feeRate;
  const stopLossGross =
    (notional * Math.max(0, input.stopLossRoePercent)) /
    leverage /
    100;
  const profitScenarios = input.takeProfitSteps.map((step) => {
    const gross =
      (notional * Math.max(0, step.profitPercent)) /
      leverage /
      100;
    return {
      roePercent: step.profitPercent,
      closePercent: step.closePercent,
      grossPnlUsdt: gross,
      estimatedNetPnlUsdt:
        gross - fee * Math.min(1, Math.max(0, step.closePercent) / 100),
    };
  });
  return {
    estimatedRoundTripFeeUsdt: fee,
    stopLossGrossUsdt: stopLossGross,
    stopLossNetUsdt: stopLossGross + fee,
    profitScenarios,
  };
}
