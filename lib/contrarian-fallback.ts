import type { LiquidationTrendConfig } from "./liquidation-trend-config.ts";
import {
  NEXUS_BRAIN_SHADOW_SKIPPED_RESULT_CODE,
} from "./nexus-brain-shadow-counterfactual.ts";

export const CONTRARIAN_FALLBACK_MODEL_VERSION = "contrarian-fallback-v2";

export type TradeDirection = "LONG" | "SHORT";

export type ContrarianFallbackDecision =
  | {
      modelVersion: typeof CONTRARIAN_FALLBACK_MODEL_VERSION;
      eligible: true;
      originalDirection: TradeDirection;
      contrarianDirection: TradeDirection;
      probeNotionalUsdt: number;
      profitRoeBeforeHedge: number;
      branchPolicy: {
        ownership: "CONTRARIAN_PROBE";
        mayOpenOppositeHedgeAutomatically: false;
        mayAverageDown: false;
        profitAction: "PROTECT_AND_WAIT_FOR_INDEPENDENT_SIGNAL";
      };
      label: string;
      reason: string;
      evidenceCodes: string[];
    }
  | {
      modelVersion: typeof CONTRARIAN_FALLBACK_MODEL_VERSION;
      eligible: false;
      originalDirection: TradeDirection | null;
      contrarianDirection: null;
      probeNotionalUsdt: number | null;
      profitRoeBeforeHedge: number | null;
      label: string;
      reason: string;
      blockedReasons: string[];
    };

export const DIRECTIONAL_REJECTION_CODES = new Set([
  "TREND_1H_REJECTED",
  "STRUCTURE_30M_REJECTED",
]);

const SHORT_TRANSIENT_COOLDOWN_EXEMPT_CODES = new Set([
  "SHORT_LIVE_REST_CAPACITY_WAIT",
  "SHORT_LIVE_SIGNAL_EXPIRED",
  NEXUS_BRAIN_SHADOW_SKIPPED_RESULT_CODE,
]);

export function shouldBlockShortEntryCooldown(input: {
  strategyDirection: LiquidationTrendConfig["direction"];
  contrarianFallbackEnabled: boolean;
  nowMs: number;
  handoffValidityMs: number;
  recentTraces: Array<{
    state: string;
    resultCode: string | null;
    eventTime: Date | string | number | null;
  }>;
}) {
  const handoffAllowed =
    input.strategyDirection === "BOTH" &&
    input.contrarianFallbackEnabled;
  const blockingCodes: string[] = [];
  let exemptedDirectionalRejections = 0;
  let exemptedTransientRetries = 0;

  for (const trace of input.recentTraces) {
    const resultCode = String(trace.resultCode ?? "");
    const eventTimeMs =
      trace.eventTime instanceof Date
        ? trace.eventTime.getTime()
        : new Date(trace.eventTime ?? Number.NaN).getTime();
    const handoffAgeMs = input.nowMs - eventTimeMs;
    const isFreshHandoff =
      Number.isFinite(handoffAgeMs) &&
      handoffAgeMs >= 0 &&
      handoffAgeMs <= input.handoffValidityMs;
    const isDirectionalHandoff =
      handoffAllowed &&
      isFreshHandoff &&
      trace.state === "REJECTED" &&
      DIRECTIONAL_REJECTION_CODES.has(resultCode);
    const isTransientRetry =
      trace.state === "REJECTED" &&
      SHORT_TRANSIENT_COOLDOWN_EXEMPT_CODES.has(resultCode);
    if (isDirectionalHandoff) {
      exemptedDirectionalRejections += 1;
      continue;
    }
    if (isTransientRetry) {
      exemptedTransientRetries += 1;
      continue;
    }
    blockingCodes.push(resultCode || trace.state || "UNKNOWN_TRACE");
  }

  return {
    blocked: blockingCodes.length > 0,
    exemptedDirectionalRejections,
    exemptedTransientRetries,
    blockingCodes,
  };
}

export const shouldBlockContrarianHandoffCooldown =
  shouldBlockShortEntryCooldown;

const NEVER_CONTRARIAN_CODE_FRAGMENTS = [
  "STALE",
  "EXPIRED",
  "ACCOUNT",
  "CREDENTIAL",
  "AUTH",
  "CAPACITY",
  "DAILY",
  "MARGIN",
  "PENDING_ORDER",
  "EXTERNAL_POSITION",
  "SIZE_INVALID",
  "ORDER_REJECTED",
  "EXECUTION_UNKNOWN",
  "DIRECTION_CHANGED",
  "VERSION_RETIRED",
];

export function evaluateContrarianFallback(input: {
  config: LiquidationTrendConfig;
  rejectionCode: string | null | undefined;
  originalDirection: TradeDirection | null | undefined;
  signalAgeMs: number;
  oppositePositionOpen?: boolean;
  sameSymbolPositionOpen?: boolean;
  sameSymbolPendingOrder?: boolean;
  competingBranchClaimed?: boolean;
}): ContrarianFallbackDecision {
  const management = input.config.risk.positionManagement;
  const probeNotional = management?.contrarianProbeNotionalUsdt ?? null;
  const profitBeforeHedge =
    management?.contrarianProfitRoeBeforeHedge ?? null;
  const originalDirection = input.originalDirection ?? null;
  const rejectionCode = String(input.rejectionCode ?? "");
  const blockedReasons: string[] = [];

  if (!management?.contrarianFallbackEnabled)
    blockedReasons.push("CONTRARIAN_DISABLED");
  if (!originalDirection) blockedReasons.push("ORIGINAL_DIRECTION_MISSING");
  if (input.config.direction !== "BOTH")
    blockedReasons.push("CONTRARIAN_DIRECTION_NOT_ALLOWED");
  if (!DIRECTIONAL_REJECTION_CODES.has(rejectionCode))
    blockedReasons.push("REJECTION_NOT_DIRECTIONAL");
  if (
    NEVER_CONTRARIAN_CODE_FRAGMENTS.some((fragment) =>
      rejectionCode.includes(fragment),
    )
  )
    blockedReasons.push("REJECTION_UNSAFE_FOR_CONTRARIAN");
  if (!Number.isFinite(input.signalAgeMs) || input.signalAgeMs > 3_000)
    blockedReasons.push("SIGNAL_TOO_OLD");
  if (input.oppositePositionOpen)
    blockedReasons.push("OPPOSITE_POSITION_ALREADY_OPEN");
  if (input.sameSymbolPositionOpen)
    blockedReasons.push("SAME_SYMBOL_POSITION_ALREADY_OPEN");
  if (input.sameSymbolPendingOrder)
    blockedReasons.push("SAME_SYMBOL_PENDING_ORDER");
  if (input.competingBranchClaimed)
    blockedReasons.push("COMPETING_BRANCH_ALREADY_CLAIMED");
  if (!Number.isFinite(probeNotional) || Number(probeNotional) < 5)
    blockedReasons.push("PROBE_NOTIONAL_INVALID");
  if (!Number.isFinite(profitBeforeHedge) || Number(profitBeforeHedge) <= 0)
    blockedReasons.push("PROFIT_BEFORE_HEDGE_INVALID");

  if (blockedReasons.length || !originalDirection)
    return {
      modelVersion: CONTRARIAN_FALLBACK_MODEL_VERSION,
      eligible: false,
      originalDirection,
      contrarianDirection: null,
      probeNotionalUsdt: Number.isFinite(probeNotional)
        ? Number(probeNotional)
        : null,
      profitRoeBeforeHedge: Number.isFinite(profitBeforeHedge)
        ? Number(profitBeforeHedge)
        : null,
      label: "不允许反向试单",
      reason:
        "只有双向策略因趋势/结构方向不利而拒绝，且同合约没有仓位、挂单或其他执行分支时，才允许反向小额试单。",
      blockedReasons,
    };

  const contrarianDirection = originalDirection === "LONG" ? "SHORT" : "LONG";
  return {
    modelVersion: CONTRARIAN_FALLBACK_MODEL_VERSION,
    eligible: true,
    originalDirection,
    contrarianDirection,
    probeNotionalUsdt: Number(probeNotional),
    profitRoeBeforeHedge: Number(profitBeforeHedge),
    branchPolicy: {
      ownership: "CONTRARIAN_PROBE",
      mayOpenOppositeHedgeAutomatically: false,
      mayAverageDown: false,
      profitAction: "PROTECT_AND_WAIT_FOR_INDEPENDENT_SIGNAL",
    },
    label:
      contrarianDirection === "SHORT"
        ? "主策略不适合做多，允许小额试空"
        : "主策略不适合做空，允许小额试多",
    reason:
      `主方向被 ${rejectionCode} 拒绝，说明当前波段证据偏向反方向；` +
      `仅允许 ${Number(probeNotional).toFixed(2)} USDT 探针单；盈利达到 ${Number(profitBeforeHedge).toFixed(2)}% ROE 后保护利润，` +
      "不自动补另一方向，必须等待探针退出和新的独立信号。",
    evidenceCodes: [
      "PRIMARY_DIRECTION_REJECTED",
      rejectionCode,
      "STRATEGY_DIRECTION_BOTH",
      "FRESH_SIGNAL",
      "NO_EXISTING_OPPOSITE_POSITION",
      "NO_EXISTING_SAME_SYMBOL_POSITION",
      "NO_PENDING_ORDER",
      "NO_COMPETING_BRANCH",
    ],
  };
}
