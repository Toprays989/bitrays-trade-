import type { NexusAnalysisExpiryOutcome } from "./nexus-analysis-expiry";

type UnknownRecord = Record<string, unknown>;

export type NexusPriorLifecycleMemory = {
  version: "nexus-prior-lifecycle-memory-v1";
  sourceTraceId: string;
  sourceState: string;
  sourceResultCode: string;
  sourceEventAt: string;
  sourceCompletedAt: string | null;
  expiryOutcome: NexusAnalysisExpiryOutcome;
  contextOnly: true;
  freshPriceReused: false;
  orderAffecting: false;
  summary: string;
};

export type NexusPriorLifecycleProgress = {
  version: "nexus-prior-lifecycle-progress-v1";
  sourceTraceId: string;
  expectedAction: NexusAnalysisExpiryOutcome["nextAction"];
  status:
    | "WAITING_SECOND_LIQUIDATION"
    | "SECOND_LIQUIDATION_REACHED"
    | "NEW_STRUCTURE_STILL_INVALID"
    | "NEW_STRUCTURE_UNDER_REVIEW"
    | "FRESH_LIFECYCLE_REARMED";
  liquidationEventCount: number;
  eyeVerdict: string;
  contextOnly: true;
  orderAffecting: false;
  summary: string;
};

export type NexusPriorAwareLiquidationCount = {
  version: "nexus-prior-aware-liquidation-count-v1";
  currentLifecycleEventCount: number;
  priorLifecycleEventCount: number;
  contextEventCount: number;
  effectiveEventCount: number;
  priorMemoryApplied: boolean;
  summary: string;
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function validDate(value: unknown) {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function isExpiryOutcome(
  value: unknown,
): value is NexusAnalysisExpiryOutcome {
  const outcome = asRecord(value);
  return (
    outcome.version === "nexus-analysis-expiry-v1" &&
    typeof outcome.symbol === "string" &&
    typeof outcome.summary === "string" &&
    Array.isArray(outcome.pathStates) &&
    Array.isArray(outcome.missingEvidence) &&
    Number.isFinite(Number(outcome.liquidationEventCount)) &&
    [
      "WAIT_SECOND_LIQUIDATION",
      "WAIT_FRESH_SIGNAL_AFTER_INVALIDATION",
      "REARM_ON_FRESH_SIGNAL",
    ].includes(String(outcome.nextAction))
  );
}

function finiteCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export function effectiveNexusPriorAwareLiquidationCount(input: {
  memory: unknown;
  currentLifecycleEventCount: number;
}): NexusPriorAwareLiquidationCount {
  const memory = asRecord(input.memory);
  const expiryOutcome = asRecord(memory.expiryOutcome);
  const currentLifecycleEventCount = finiteCount(
    input.currentLifecycleEventCount,
  );
  const priorMemoryApplied =
    memory.version === "nexus-prior-lifecycle-memory-v1" &&
    memory.contextOnly === true &&
    memory.orderAffecting === false &&
    typeof memory.sourceTraceId === "string" &&
    memory.sourceTraceId.length > 0 &&
    expiryOutcome.nextAction === "WAIT_SECOND_LIQUIDATION" &&
    currentLifecycleEventCount > 0;
  const priorLifecycleEventCount = priorMemoryApplied
    ? finiteCount(expiryOutcome.liquidationEventCount)
    : 0;
  const contextEventCount =
    priorLifecycleEventCount + currentLifecycleEventCount;
  // Historical lifecycle evidence is available to learning and operations,
  // but current authorization must be derived from the current lifecycle only.
  const effectiveEventCount = currentLifecycleEventCount;
  return {
    version: "nexus-prior-aware-liquidation-count-v1",
    currentLifecycleEventCount,
    priorLifecycleEventCount,
    contextEventCount,
    effectiveEventCount,
    priorMemoryApplied,
    summary: priorMemoryApplied
      ? `上一生命周期 ${priorLifecycleEventCount} 次仅作学习背景；本轮 ${currentLifecycleEventCount} 次新鲜同向爆仓独立参与当前授权；背景累计 ${contextEventCount} 次`
      : `本轮新鲜同向爆仓 ${currentLifecycleEventCount} 次；未叠加上一生命周期`,
  };
}

export function buildNexusPriorLifecycleMemory(input: {
  sourceTraceId: string;
  sourceState: string;
  sourceResultCode: string | null;
  sourceEventAt: Date | string | number;
  sourceCompletedAt: Date | string | number | null;
  entryEvidence: unknown;
}): NexusPriorLifecycleMemory | null {
  const evidence = asRecord(input.entryEvidence);
  const expiryOutcome = evidence.analysisExpiryOutcome;
  const sourceEventAt = validDate(input.sourceEventAt);
  if (
    !input.sourceTraceId ||
    input.sourceState !== "EXPIRED" ||
    input.sourceResultCode !== "ANALYSIS_EXPIRED" ||
    !sourceEventAt ||
    !isExpiryOutcome(expiryOutcome)
  )
    return null;
  const sourceCompletedAt = validDate(input.sourceCompletedAt);
  return {
    version: "nexus-prior-lifecycle-memory-v1",
    sourceTraceId: input.sourceTraceId,
    sourceState: input.sourceState,
    sourceResultCode: input.sourceResultCode,
    sourceEventAt,
    sourceCompletedAt,
    expiryOutcome,
    contextOnly: true,
    freshPriceReused: false,
    orderAffecting: false,
    summary:
      `继承上一生命周期结论：${expiryOutcome.summary}；` +
      "旧爆仓次数、价格、盘口和K线均不参与本轮授权；本轮必须使用新鲜事实重新判断",
  };
}

export function advanceNexusPriorLifecycleMemory(input: {
  memory: unknown;
  liquidationEventCount: number;
  eyeVerdict: string;
}): NexusPriorLifecycleProgress | null {
  const memory = asRecord(input.memory);
  const expiryOutcome = asRecord(memory.expiryOutcome);
  const sourceTraceId = String(memory.sourceTraceId ?? "");
  const expectedAction = String(expiryOutcome.nextAction);
  if (
    memory.version !== "nexus-prior-lifecycle-memory-v1" ||
    memory.contextOnly !== true ||
    memory.orderAffecting !== false ||
    !sourceTraceId ||
    ![
      "WAIT_SECOND_LIQUIDATION",
      "WAIT_FRESH_SIGNAL_AFTER_INVALIDATION",
      "REARM_ON_FRESH_SIGNAL",
    ].includes(expectedAction)
  )
    return null;
  const liquidationEventCount = Number.isFinite(
    Number(input.liquidationEventCount),
  )
    ? Math.max(0, Math.trunc(Number(input.liquidationEventCount)))
    : 0;
  const eyeVerdict = String(input.eyeVerdict || "UNKNOWN");
  let status: NexusPriorLifecycleProgress["status"];
  let summary: string;
  if (expectedAction === "WAIT_SECOND_LIQUIDATION") {
    const requiredLiquidationEventCount = Math.max(
      1,
      finiteCount(expiryOutcome.requiredLiquidationEventCount) || 2,
    );
    const reached =
      liquidationEventCount >= requiredLiquidationEventCount;
    status = reached
      ? "SECOND_LIQUIDATION_REACHED"
      : "WAITING_SECOND_LIQUIDATION";
    summary = reached
      ? `上一轮要求的 ${requiredLiquidationEventCount} 次同向爆仓已经满足，当前累计 ${liquidationEventCount} 次；转入本轮新鲜结构判断`
      : `当前累计 ${liquidationEventCount} 次同向爆仓，尚未达到上一轮策略配置的 ${requiredLiquidationEventCount} 次触发`;
  } else if (expectedAction === "WAIT_FRESH_SIGNAL_AFTER_INVALIDATION") {
    const stillInvalid = eyeVerdict === "BLOCKED";
    status = stillInvalid
      ? "NEW_STRUCTURE_STILL_INVALID"
      : "NEW_STRUCTURE_UNDER_REVIEW";
    summary = stillInvalid
      ? "新鲜信号已经到达，但当前结构仍然失效，不继承旧结论下单"
      : "新鲜信号已经到达，旧失效结论仅作背景，本轮结构正在重新判断";
  } else {
    status = "FRESH_LIFECYCLE_REARMED";
    summary = "下一次新鲜同向爆仓已建立独立生命周期，旧结论仅作背景";
  }
  return {
    version: "nexus-prior-lifecycle-progress-v1",
    sourceTraceId,
    expectedAction:
      expectedAction as NexusAnalysisExpiryOutcome["nextAction"],
    status,
    liquidationEventCount,
    eyeVerdict,
    contextOnly: true,
    orderAffecting: false,
    summary,
  };
}
