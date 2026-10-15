import type { StrategyTriggerKind } from "./strategy-trigger-catalog.ts";

type UnknownRecord = Record<string, unknown>;

export const NEXUS_FINAL_ANALYSIS_SETTLEMENT_GRACE_MS = 30_000;

export type NexusAnalysisDecisionWindow = Readonly<{
  analysisExpiresAtMs: number;
  decisionExpiresAtMs: number;
  evaluatedAtMs: number;
  overdueMs: number;
  withinSettlementGrace: boolean;
  settlementGraceApplied: boolean;
}>;

/**
 * Keeps market-signal validity separate from request processing latency.
 * A trace may receive one final decision pass after its market deadline, but
 * only inside a bounded settlement window. The grace absorbs the monitor's
 * round-robin cadence; it is not a rolling signal renewal.
 */
export function resolveNexusAnalysisDecisionWindow(input: Readonly<{
  analysisExpiresAtMs: number;
  evaluatedAtMs: number;
  settlementGraceMs?: number;
}>): NexusAnalysisDecisionWindow {
  const analysisExpiresAtMs = Number(input.analysisExpiresAtMs);
  const evaluatedAtMs = Number(input.evaluatedAtMs);
  const settlementGraceMs = input.settlementGraceMs === undefined
    ? NEXUS_FINAL_ANALYSIS_SETTLEMENT_GRACE_MS
    : Math.max(0, Math.trunc(Number(input.settlementGraceMs)));
  if (
    !Number.isFinite(analysisExpiresAtMs) ||
    analysisExpiresAtMs <= 0 ||
    !Number.isFinite(evaluatedAtMs) ||
    evaluatedAtMs <= 0 ||
    !Number.isFinite(settlementGraceMs)
  ) throw new Error("大脑最终裁决时间窗口无效");

  const overdueMs = Math.max(0, evaluatedAtMs - analysisExpiresAtMs);
  const withinSettlementGrace = overdueMs <= settlementGraceMs;
  const settlementGraceApplied =
    evaluatedAtMs >= analysisExpiresAtMs && withinSettlementGrace;
  return Object.freeze({
    analysisExpiresAtMs,
    decisionExpiresAtMs: settlementGraceApplied
      ? evaluatedAtMs + 1
      : analysisExpiresAtMs,
    evaluatedAtMs,
    overdueMs,
    withinSettlementGrace,
    settlementGraceApplied,
  });
}

export type NexusAnalysisExpiryOutcome = {
  version: "nexus-analysis-expiry-v2";
  symbol: string;
  triggerKind: StrategyTriggerKind;
  eyeVerdict: string;
  eyeCode: string;
  pathStates: Array<{
    path: "SUPPORT_REVERSAL" | "TREND_BREAKOUT";
    state: string;
    missing: string[];
  }>;
  missingEvidence: string[];
  liquidationEventCount: number;
  requiredLiquidationEventCount: number;
  nextAction:
    | "WAIT_SECOND_LIQUIDATION"
    | "WAIT_FRESH_SIGNAL_AFTER_INVALIDATION"
    | "REARM_ON_FRESH_SIGNAL";
  summary: string;
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function finiteCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function pathState(
  path: "SUPPORT_REVERSAL" | "TREND_BREAKOUT",
  value: unknown,
) {
  const record = asRecord(value);
  return {
    path,
    state: String(record.state ?? "UNKNOWN"),
    missing: unique(strings(record.missing)),
  };
}

function pathLabel(path: NexusAnalysisExpiryOutcome["pathStates"][number]) {
  const label = path.path === "SUPPORT_REVERSAL" ? "反转路径" : "突破路径";
  if (path.state === "INVALIDATED") return `${label}已失效`;
  if (path.state === "READY_SHADOW") return `${label}证据已闭合`;
  if (path.missing.length)
    return `${label}仍等待${path.missing.join("、")}`;
  return `${label}处于${path.state}`;
}

export function summarizeNexusAnalysisExpiry(input: {
  symbol: string;
  triggerKind: StrategyTriggerKind;
  entryEvidence: unknown;
  requiredLiquidationEventCount: number;
}): NexusAnalysisExpiryOutcome {
  const evidence = asRecord(input.entryEvidence);
  const eye = asRecord(evidence.nexusMarketEyeDecision);
  if (input.triggerKind === "THREE_MINUTE_PROBABILITY") {
    const eyeCode = String(eye.code ?? "UNKNOWN");
    const reason = eyeCode === "THREE_MINUTE_DIRECT_PROBABILITY_BELOW_THRESHOLD"
      ? "方向概率未达到策略门槛"
      : eyeCode === "THREE_MINUTE_PROBABILITY_FACTS_INCOMPLETE"
        ? "概率事实不完整"
        : "本轮未形成有效入场授权";
    return {
      version: "nexus-analysis-expiry-v2",
      symbol: input.symbol,
      triggerKind: input.triggerKind,
      eyeVerdict: String(eye.verdict ?? "UNKNOWN"),
      eyeCode,
      pathStates: [],
      missingEvidence: unique(strings(eye.missing)),
      liquidationEventCount: 0,
      requiredLiquidationEventCount: Math.max(
        1,
        finiteCount(input.requiredLiquidationEventCount),
      ),
      nextAction: "REARM_ON_FRESH_SIGNAL",
      summary:
        `${input.symbol} 3分钟候选到期：${reason}；本轮直接丢弃，等待下一条新鲜候选，不复用旧价格追单`,
    };
  }
  const pathStates = [
    pathState("SUPPORT_REVERSAL", evidence.nexusPureStateMachine),
    pathState(
      "TREND_BREAKOUT",
      evidence.nexusTrendBreakoutStateMachine,
    ),
  ];
  const missingEvidence = unique([
    ...strings(eye.missing),
    ...pathStates.flatMap((path) => path.missing),
  ]);
  const liquidationEventCount = finiteCount(
    evidence.explorationLiquidationEventCount,
  );
  const requiredLiquidationEventCount = Math.max(
    1,
    finiteCount(input.requiredLiquidationEventCount),
  );
  const explorationPolicy = asRecord(evidence.explorationEntryPolicy);
  const qualifiedSingleOrAggregateProbe = [
    "STRONG_SINGLE_LIQUIDATION_PROBE",
    "AGGREGATE_LIQUIDATION_PROBE",
  ].includes(String(explorationPolicy.reasonCode ?? ""));
  const allPathsInvalidated = pathStates.every(
    (path) => path.state === "INVALIDATED",
  );
  const liquidationTriggered = input.triggerKind === "LIQUIDATION_WINDOW";
  const nextAction =
    liquidationTriggered &&
    liquidationEventCount < requiredLiquidationEventCount &&
    !qualifiedSingleOrAggregateProbe
      ? "WAIT_SECOND_LIQUIDATION"
      : eye.verdict === "BLOCKED" || allPathsInvalidated
        ? "WAIT_FRESH_SIGNAL_AFTER_INVALIDATION"
        : "REARM_ON_FRESH_SIGNAL";
  const actionLabel =
    nextAction === "WAIT_SECOND_LIQUIDATION"
      ? `当前同向爆仓 ${liquidationEventCount} 次；等待达到当前策略配置的 ${requiredLiquidationEventCount} 次新鲜同向爆仓后重新判断`
      : nextAction === "WAIT_FRESH_SIGNAL_AFTER_INVALIDATION"
        ? liquidationTriggered
          ? "当前结构已经失效；仅在新的爆仓和新价格结构出现后重新判断"
          : "当前结构已经失效；仅在本策略出现新的触发事实和价格结构后重新判断"
        : liquidationTriggered
          ? "本轮不追单；下一次新鲜同向爆仓将建立新生命周期并复用本轮历史"
          : "本轮不追单；下一次满足本策略触发条件的新鲜事实将建立新生命周期";
  const pathSummary = pathStates.map(pathLabel).join("；");
  return {
    version: "nexus-analysis-expiry-v2",
    symbol: input.symbol,
    triggerKind: input.triggerKind,
    eyeVerdict: String(eye.verdict ?? "UNKNOWN"),
    eyeCode: String(eye.code ?? "UNKNOWN"),
    pathStates,
    missingEvidence,
    liquidationEventCount,
    requiredLiquidationEventCount,
    nextAction,
    summary: `${input.symbol} 分析到期：${pathSummary}。${actionLabel}`,
  };
}
