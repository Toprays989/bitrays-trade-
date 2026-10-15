import type { AnalysisStep } from "./liquidation-trend-analysis.ts";

export type ConsensusEvidenceState =
  | "SUPPORTS_LONG"
  | "CONFLICTS_LONG"
  | "PENDING"
  | "UNAVAILABLE";

export type ConsensusEvidenceFamily =
  | "PRICE_LOCATION_72H"
  | "TREND_1H"
  | "STRUCTURE_30M"
  | "LIQUIDITY_RECOVERY_5M"
  | "ENTRY_VOLUME_3M"
  | "LIQUIDATION_CLUSTER"
  | "LARGE_TRADER_POSITIONING";

export type ConsensusEvidence = {
  family: ConsensusEvidenceFamily;
  state: ConsensusEvidenceState;
  code: string;
  message: string;
};

export type LiquidationConsensusShadow = {
  version: 1;
  verdict:
    | "STRICT_CONSENSUS"
    | "RECOVERY_CONSENSUS"
    | "MIXED"
    | "CONFLICT"
    | "INCOMPLETE";
  supportCount: number;
  conflictCount: number;
  pendingCount: number;
  unavailableCount: number;
  independentFamilyCount: 7;
  orderAffecting: false;
  summary: string;
  evidence: ConsensusEvidence[];
};

export function buildLiquidationConsensusShadow(input: {
  steps: AnalysisStep[];
  liquidationClusterEventCount: number;
  minimumLiquidationClusterEvents: number;
  largeTraderStatus?:
    | "SUPPORTS_LONG"
    | "CONFLICTS_LONG"
    | "NEUTRAL"
    | "UNAVAILABLE"
    | null;
}): LiquidationConsensusShadow {
  const evidence: ConsensusEvidence[] = [
    fromStep(
      "PRICE_LOCATION_72H",
      input.steps.find((step) => step.stage === "POSITION"),
    ),
    fromStep(
      "TREND_1H",
      input.steps.find((step) => step.stage === "TREND_1H"),
    ),
    fromStep(
      "STRUCTURE_30M",
      input.steps.find((step) => step.stage === "STRUCTURE_30M"),
    ),
    fromLocalRecovery(input.steps),
    fromStep(
      "ENTRY_VOLUME_3M",
      input.steps.find((step) => step.stage === "ENTRY_3M"),
    ),
    {
      family: "LIQUIDATION_CLUSTER",
      state:
        input.liquidationClusterEventCount >=
            input.minimumLiquidationClusterEvents
          ? "SUPPORTS_LONG"
          : "PENDING",
      code:
        input.liquidationClusterEventCount >=
            input.minimumLiquidationClusterEvents
          ? "LIQUIDATION_CLUSTER_CONFIRMED"
          : "LIQUIDATION_CLUSTER_PENDING",
      message: `连续爆仓唯一事件 ${input.liquidationClusterEventCount}/${input.minimumLiquidationClusterEvents}`,
    },
    fromLargeTrader(input.largeTraderStatus),
  ];
  const supportCount = countState(evidence, "SUPPORTS_LONG");
  const conflictCount = countState(evidence, "CONFLICTS_LONG");
  const pendingCount = countState(evidence, "PENDING");
  const unavailableCount = countState(evidence, "UNAVAILABLE");
  const localExecutionFamilies = new Set<ConsensusEvidenceFamily>([
    "PRICE_LOCATION_72H",
    "LIQUIDITY_RECOVERY_5M",
    "ENTRY_VOLUME_3M",
    "LIQUIDATION_CLUSTER",
    "LARGE_TRADER_POSITIONING",
  ]);
  const localExecutionReady = evidence
    .filter((item) => localExecutionFamilies.has(item.family))
    .every((item) => item.state === "SUPPORTS_LONG");
  const higherTimeframe = evidence.filter((item) =>
    item.family === "TREND_1H" || item.family === "STRUCTURE_30M"
  );
  const higherTimeframeAllSupport = higherTimeframe.every(
    (item) => item.state === "SUPPORTS_LONG",
  );
  const higherTimeframeRecoveryRequired = higherTimeframe.some(
    (item) =>
      item.code === "TREND_1H_RECOVERY_REQUIRED" ||
      item.code === "STRUCTURE_30M_RECOVERY_REQUIRED",
  );
  const hardConflict = evidence.some(
    (item) =>
      localExecutionFamilies.has(item.family) &&
      item.state === "CONFLICTS_LONG",
  );
  const verdict = hardConflict
    ? "CONFLICT" as const
    : localExecutionReady && higherTimeframeAllSupport
      ? "STRICT_CONSENSUS" as const
      : localExecutionReady && higherTimeframeRecoveryRequired
        ? "RECOVERY_CONSENSUS" as const
        : conflictCount > 0
          ? "MIXED" as const
          : supportCount === 0 && unavailableCount > 0
            ? "INCOMPLETE" as const
            : "MIXED" as const;
  return {
    version: 1,
    verdict,
    supportCount,
    conflictCount,
    pendingCount,
    unavailableCount,
    independentFamilyCount: 7,
    orderAffecting: false,
    summary: summaryFor(verdict, supportCount, conflictCount, pendingCount),
    evidence,
  };
}

function fromStep(
  family: ConsensusEvidenceFamily,
  step: AnalysisStep | undefined,
): ConsensusEvidence {
  if (!step)
    return {
      family,
      state: "UNAVAILABLE",
      code: "NOT_EVALUATED",
      message: "主决策在更早的硬条件结束，本证据尚未计算",
    };
  const recoveryRequired =
    step.code === "TREND_1H_RECOVERY_REQUIRED" ||
    step.code === "STRUCTURE_30M_RECOVERY_REQUIRED";
  return {
    family,
    state: recoveryRequired
      ? "PENDING"
      : step.outcome === "PASSED"
        ? "SUPPORTS_LONG"
        : step.outcome === "REJECTED"
          ? "CONFLICTS_LONG"
          : "PENDING",
    code: step.code,
    message: step.message,
  };
}

function fromLocalRecovery(steps: AnalysisStep[]): ConsensusEvidence {
  const sweep = steps.find((step) => step.stage === "LIQUIDITY_SWEEP_5M");
  const reclaim = steps.find((step) => step.stage === "RECLAIM_5M");
  if (reclaim) return fromStep("LIQUIDITY_RECOVERY_5M", reclaim);
  if (sweep?.outcome === "REJECTED")
    return fromStep("LIQUIDITY_RECOVERY_5M", sweep);
  if (sweep?.outcome === "PASSED")
    return {
      family: "LIQUIDITY_RECOVERY_5M",
      state: "PENDING",
      code: "RECLAIM_5M_PENDING",
      message: "扫盘已确认，等待5分钟局部收复确认",
    };
  return fromStep("LIQUIDITY_RECOVERY_5M", sweep);
}

function fromLargeTrader(
  status:
    | "SUPPORTS_LONG"
    | "CONFLICTS_LONG"
    | "NEUTRAL"
    | "UNAVAILABLE"
    | null
    | undefined,
): ConsensusEvidence {
  return {
    family: "LARGE_TRADER_POSITIONING",
    state: status === "SUPPORTS_LONG"
      ? "SUPPORTS_LONG"
      : status === "CONFLICTS_LONG"
        ? "CONFLICTS_LONG"
        : status === "NEUTRAL"
          ? "PENDING"
          : "UNAVAILABLE",
    code: status ? `LARGE_TRADER_${status}` : "LARGE_TRADER_NOT_EVALUATED",
    message: status
      ? `大户聚合持仓状态：${status}`
      : "尚未到达大户聚合确认阶段",
  };
}

function countState(
  evidence: ConsensusEvidence[],
  state: ConsensusEvidenceState,
) {
  return evidence.filter((item) => item.state === state).length;
}

function summaryFor(
  verdict: LiquidationConsensusShadow["verdict"],
  supportCount: number,
  conflictCount: number,
  pendingCount: number,
) {
  const counts = `${supportCount}/7 支持、${conflictCount} 冲突、${pendingCount} 等待`;
  if (verdict === "STRICT_CONSENSUS")
    return `七类异构证据形成严格共识；${counts}`;
  if (verdict === "RECOVERY_CONSENSUS")
    return `高周期破位后由局部收复形成恢复共识；${counts}`;
  if (verdict === "CONFLICT")
    return `关键执行证据存在冲突；${counts}`;
  if (verdict === "INCOMPLETE")
    return `证据不足，不能形成共识；${counts}`;
  return `证据分歧或仍在等待；${counts}`;
}
