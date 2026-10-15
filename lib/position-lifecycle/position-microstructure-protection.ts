import type {
  DynamicProfitProtection,
} from "../dynamic-profit-protection.ts";
import type {
  PositionMarketMicrostructure,
} from "./position-market-microstructure.ts";

export const POSITION_MICROSTRUCTURE_PROTECTION_VERSION =
  "position-microstructure-protection-v2" as const;

export function evaluatePositionMicrostructureProtection(input: {
  microstructure: PositionMarketMicrostructure;
  currentRoePercent: number;
  favorableRoePercent: number;
  causalEvidenceMode: DynamicProfitProtection["evidenceMode"];
  monitoringStartRoePercent?: number;
}) {
  const monitoringStartRoePercent = Math.max(
    0,
    finite(input.monitoringStartRoePercent, 1),
  );
  const monitoring = input.favorableRoePercent >= monitoringStartRoePercent;
  const five = input.microstructure.windows["5s"];
  const fifteen = input.microstructure.windows["15s"];
  const thirty = input.microstructure.windows["30s"];
  const enoughFiveSeconds = five.sampleCount >= 4;
  const enoughFifteenSeconds =
    fifteen.sampleCount >= 8 &&
    (input.microstructure.historyAgeMs ?? 0) >= 12_000;
  const localAdverseTurn =
    enoughFiveSeconds &&
    enoughFifteenSeconds &&
    five.direction === "ADVERSE" &&
    (
      ["ADVERSE", "MIXED"].includes(fifteen.direction) ||
      (
        (fifteen.givebackFromFavorableExtremePercent ?? 0) >= 0.01 &&
        (fifteen.givebackFromFavorableExtremePercent ?? 0) >=
        (fifteen.amplitudePercent ?? 0) * 0.35
      )
    );
  const peakToCurrentDrawdownRoePoints = Math.max(
    0,
    input.favorableRoePercent - input.currentRoePercent,
  );
  const returnedThroughEntry =
    monitoring && input.currentRoePercent <= 0;
  // A position that first earned the observation line and then surrendered
  // the whole move has reversed relative to its own entry, even when the
  // latest 5/15-second slice happens to look flat. This remains a confirming
  // fact: an existing causal weakening/invalidation is still required before
  // it can tighten protection or raise exit priority.
  const positionExcursionReversal =
    returnedThroughEntry &&
    peakToCurrentDrawdownRoePoints >= monitoringStartRoePercent;
  const adverseTurn = localAdverseTurn || positionExcursionReversal;
  const favorableContinuation =
    enoughFiveSeconds &&
    enoughFifteenSeconds &&
    five.direction === "FAVORABLE" &&
    fifteen.direction === "FAVORABLE";
  const fiveRate = amplitudeRate(five.amplitudePercent, 5);
  const fifteenRate = amplitudeRate(fifteen.amplitudePercent, 15);
  const volatilityExpanding =
    fiveRate !== null &&
    fifteenRate !== null &&
    fiveRate > fifteenRate * 1.25;
  const causalWeakening = [
    "WEAKENING",
    "HORIZON_EXPIRED",
    "INVALIDATED",
  ].includes(input.causalEvidenceMode);
  const lossExitUrgency =
    input.currentRoePercent < 0 &&
    input.causalEvidenceMode === "INVALIDATED";
  const earlyProtectionAuthorized =
    !lossExitUrgency && monitoring && adverseTurn && causalWeakening;
  const state = !monitoring
    ? "BELOW_MONITORING_LINE" as const
    : !enoughFifteenSeconds
      ? "WARMING" as const
      : favorableContinuation
        ? "FAVORABLE_CONTINUATION" as const
        : adverseTurn && volatilityExpanding
          ? "ADVERSE_ACCELERATION" as const
          : adverseTurn
            ? "REVERSAL_WARNING" as const
            : "RANGE_OR_MIXED" as const;
  return {
    version: POSITION_MICROSTRUCTURE_PROTECTION_VERSION,
    decisionRole: "CONFIRM_EXISTING_POSITION_EVIDENCE" as const,
    monitoringStartRoePercent,
    monitoring,
    state,
    adverseTurn,
    favorableContinuation,
    volatilityExpanding,
    localAdverseTurn,
    positionExcursionReversal,
    returnedThroughEntry,
    peakToCurrentDrawdownRoePoints,
    earlyProtectionAuthorized,
    lossExitUrgency,
    activationRoePercentOverride: earlyProtectionAuthorized
      ? monitoringStartRoePercent
      : null,
    reason: lossExitUrgency
      ? "持仓已跌破自身开仓中心，且原入场结构已经失效；提高既有结构退出优先级。"
      : earlyProtectionAuthorized
        ? positionExcursionReversal
          ? "持仓曾达到盈利观察线但已回撤穿过自身开仓中心，且既有因果证据同步转弱；允许提前启用只收紧保护。"
          : "持仓已达到盈利观察线，5秒与15秒转为不利，且既有因果证据同步转弱；允许提前启用只收紧利润保护。"
        : favorableContinuation
          ? "5秒与15秒仍沿持仓方向运行，不因正常波动提前退出。"
          : "秒级事实只用于确认既有持仓证据，不能单独产生平仓或反向订单。",
    windows: {
      "5s": five,
      "15s": fifteen,
      "30s": thirty,
    },
  };
}

function amplitudeRate(value: number | null, seconds: number) {
  return value === null || !Number.isFinite(value) ? null : value / seconds;
}

function finite(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
