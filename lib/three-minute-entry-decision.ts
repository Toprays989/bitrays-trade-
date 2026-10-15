import {
  revalidateNexusConfirmedLongEntry,
  revalidateNexusConfirmedShortEntry,
} from "./liquidation-entry-revalidation.ts";

export const THREE_MINUTE_ENTRY_DECISION_VERSION =
  "three-minute-entry-decision-v3" as const;

export function decideThreeMinuteProbabilityEye(input: {
  probabilityEvidence: Record<string, unknown>;
  direction: "LONG" | "SHORT";
  minimumProbabilityPercent: number;
  minimumNetEdgeBps: number;
}) {
  const evidence = input.probabilityEvidence;
  const pLongPercent = finite(evidence.pLongPercent);
  const pShortPercent = finite(evidence.pShortPercent);
  const pWaitPercent = finite(evidence.pWaitPercent);
  const selectedProbabilityPercent = input.direction === "LONG"
    ? pLongPercent
    : pShortPercent;
  const breakEvenProbabilityPercent = finite(
    evidence.breakEvenProbabilityPercent,
  );
  const netEdgeBps = finite(evidence.netEdgeBps);
  const direction = evidence.direction === "LONG" ||
      evidence.direction === "SHORT"
    ? evidence.direction
    : input.direction;
  const factSnapshotId = String(evidence.factSnapshotId ?? "").trim();
  const missing = [
    !factSnapshotId ? "轮次事实快照" : null,
    evidence.dataQuality !== "READY" ? "新鲜概率事实" : null,
    pLongPercent === null ? "做多概率" : null,
    pShortPercent === null ? "做空概率" : null,
    selectedProbabilityPercent === null ? "方向概率" : null,
  ].filter((item): item is string => item !== null);
  const probabilityPassed = selectedProbabilityPercent !== null &&
    selectedProbabilityPercent >= input.minimumProbabilityPercent;
  const directionPassed = direction === input.direction;
  const confirmed = missing.length === 0 &&
    probabilityPassed &&
    directionPassed;
  return {
    version: THREE_MINUTE_ENTRY_DECISION_VERSION,
    verdict: confirmed ? "CONFIRMED" as const : "WAIT" as const,
    code: confirmed
      ? "THREE_MINUTE_DIRECT_PROBABILITY_CONFIRMED" as const
      : missing.length
        ? "THREE_MINUTE_PROBABILITY_FACTS_INCOMPLETE" as const
        : "THREE_MINUTE_DIRECT_PROBABILITY_BELOW_THRESHOLD" as const,
    selectedPath: "THREE_MINUTE_PROBABILITY" as const,
    direction: input.direction,
    pLongPercent,
    pShortPercent,
    pWaitPercent,
    selectedProbabilityPercent,
    breakEvenProbabilityPercent,
    netEdgeBps,
    eligibilityMode: "DIRECT_PROBABILITY" as const,
    factSnapshotId,
    missing,
    dataIntegrity: missing.length ? "INCOMPLETE" as const : "ALIGNED" as const,
    dataIntegritySummary: missing.length
      ? `3分钟策略事实不完整：${missing.join("、")}`
      : "3分钟策略事实快照完整",
    summary: confirmed
      ? `${input.direction === "LONG" ? "做多" : "做空"}概率 ${format(selectedProbabilityPercent)}% 达到策略门槛，直接确认执行；费用和净优势仅记录`
      : missing.length
        ? `3分钟概率事实不完整：${missing.join("、")}`
        : `方向概率未达到本策略参数，继续扫描`,
  };
}

export function resolveThreeMinuteEntryAnchors(input: {
  direction: "LONG" | "SHORT";
  approvedMarkPrice: number;
  atr5m: number;
  atrStopBuffer: number;
  priceTickSize: number;
}) {
  const markPrice = positive(input.approvedMarkPrice);
  const atr5m = positive(input.atr5m);
  const atrStopBuffer = positive(input.atrStopBuffer);
  const tick = positive(input.priceTickSize);
  if (markPrice === null || atr5m === null || atrStopBuffer === null || tick === null)
    return null;
  const confirmationLevel = alignNearest(markPrice, tick);
  const invalidBoundary = input.direction === "LONG"
    ? alignDown(confirmationLevel - atr5m * atrStopBuffer, tick)
    : alignUp(confirmationLevel + atr5m * atrStopBuffer, tick);
  if (confirmationLevel <= 0 || invalidBoundary <= 0) return null;
  if (
    input.direction === "LONG"
      ? invalidBoundary >= confirmationLevel
      : invalidBoundary <= confirmationLevel
  ) return null;
  return {
    direction: input.direction,
    confirmationLevel,
    invalidBoundary,
    source: "THREE_MINUTE_APPROVED_MARK_ATR_BOUNDARY" as const,
    derived: true as const,
  };
}

export function revalidateThreeMinuteEntry(input: {
  direction: "LONG" | "SHORT";
  executionMarkPrice: number;
  atr5m: number;
  confirmationLevel: number;
  invalidBoundary: number;
  maxEntryDistanceAtr: number;
  requireConfirmedEntryDistance?: boolean;
}) {
  if (input.direction === "LONG")
    return revalidateNexusConfirmedLongEntry({
      executionMarkPrice: input.executionMarkPrice,
      atr5m: input.atr5m,
      confirmationLevel: input.confirmationLevel,
      invalidBoundary: input.invalidBoundary,
      maxEntryDistanceAtr: input.maxEntryDistanceAtr,
      requireConfirmedEntryDistance: input.requireConfirmedEntryDistance,
    });
  const result = revalidateNexusConfirmedShortEntry({
    executionMarkPrice: input.executionMarkPrice,
    atr5m: input.atr5m,
    brokenSupport: input.confirmationLevel,
    maxEntryDistanceAtr: input.maxEntryDistanceAtr,
    requireConfirmedEntryDistance: input.requireConfirmedEntryDistance,
  });
  if (input.executionMarkPrice > input.invalidBoundary)
    return {
      eligible: false,
      code: "STRUCTURE_INVALIDATED" as const,
      entryDistanceAtr: result.entryDistanceAtr,
    };
  return result;
}

export function buildThreeMinuteRoundThesis(input: {
  traceId: string;
  symbol: string;
  eventTimeMs: number;
  direction: "LONG" | "SHORT";
  probabilityEvidence: Record<string, unknown>;
  entryOrderAnalysis: Record<string, unknown>;
  eyeDecision: Record<string, unknown>;
  timeExitSeconds?: number;
}) {
  const timeExitSeconds = positive(input.timeExitSeconds) ?? 180;
  const probability = finite(
    input.direction === "LONG"
      ? input.probabilityEvidence.pLongPercent
      : input.probabilityEvidence.pShortPercent,
  );
  const breakEven = finite(
    input.probabilityEvidence.breakEvenProbabilityPercent,
  );
  const netEdgeBps = finite(input.probabilityEvidence.netEdgeBps);
  const configuredMinimumProbabilityPercent = finite(
    input.probabilityEvidence.configuredMinimumProbabilityPercent,
  );
  const factSnapshotId = String(
    input.probabilityEvidence.factSnapshotId ?? "",
  ).trim();
  const checklist = [
    {
      code: "IMMUTABLE_ROUND_FACT_SNAPSHOT",
      required: true,
      passed: Boolean(factSnapshotId),
      observed: factSnapshotId || "未生成",
    },
    {
      code: "CONFIGURED_DIRECT_PROBABILITY",
      required: true,
      passed: probability !== null &&
        configuredMinimumProbabilityPercent !== null &&
        probability >= configuredMinimumProbabilityPercent,
      observed: `${format(probability)}% / 执行门槛 ${format(configuredMinimumProbabilityPercent)}%`,
    },
    {
      code: "STRATEGY_EYE_CONFIRMED",
      required: true,
      passed: input.eyeDecision.verdict === "CONFIRMED",
      observed: String(input.eyeDecision.code ?? "未确认"),
    },
  ];
  const status = checklist.every((item) => !item.required || item.passed)
    ? "CONFIRMED" as const
    : "INCOMPLETE" as const;
  return {
    schemaVersion: "three-minute-round-thesis-v2" as const,
    thesisId: `${input.symbol}:${Math.trunc(input.eventTimeMs)}:${input.traceId}`,
    objective: `EXECUTE_${timeExitSeconds}_SECOND_DIRECT_PROBABILITY`,
    direction: input.direction,
    setup: "THREE_MINUTE_PROBABILITY" as const,
    authorizationMode: "CONFIRMED_EYE" as const,
    status,
    statement:
      `冻结当前共享行情事实，直接选择概率达到策略门槛的一侧；费用和净优势仅记录，真实成交后由独立动态保护管理，${timeExitSeconds}秒兜底退出。`,
    confirmationChecklist: checklist,
    entryPlan: {
      mode: input.entryOrderAnalysis.mode === "CONFIRMED_MARKET"
        ? "CONFIRMED_MARKET" as const
        : "STRUCTURAL_RETEST_LIMIT" as const,
      analyzedEntryPrice: finite(input.entryOrderAnalysis.analyzedEntryPrice),
      confirmationLevel: finite(input.entryOrderAnalysis.confirmationLevel) ??
        finite(input.entryOrderAnalysis.brokenSupport),
      invalidBoundary: finite(input.entryOrderAnalysis.invalidBoundary),
    },
    invalidationRules: [
      "委托成交前超过本轮批准有效期即终止，不复用旧概率追单",
      "同一合约同一轮只允许一个方向和一个执行意图",
      "成交后盈利达到+2%锁住+2%保护线、达到+4%直接止盈；亏损达到-0.8%锁住止损线、达到-1.2%硬止损",
      `上述动态保护优先于${timeExitSeconds}秒ReduceOnly兜底退出`,
    ],
    profitValidation: {
      selectedProbabilityPercent: probability,
      breakEvenProbabilityPercent: breakEven,
      netEdgeBps,
      timeExitSeconds,
      observationSeconds: [...new Set([60, 120, 180, timeExitSeconds])],
    },
  };
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function alignNearest(value: number, tick: number) {
  return Number((Math.round(value / tick) * tick).toPrecision(15));
}

function alignDown(value: number, tick: number) {
  return Number((Math.floor((value + tick * 1e-8) / tick) * tick).toPrecision(15));
}

function alignUp(value: number, tick: number) {
  return Number((Math.ceil((value - tick * 1e-8) / tick) * tick).toPrecision(15));
}

function format(value: number | null) {
  return value === null ? "—" : Number(value.toFixed(3)).toString();
}
