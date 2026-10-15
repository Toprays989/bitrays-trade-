import {
  ENTRY_EXECUTION_SHADOW_VERSION,
  evaluateEntryExecutionShadow,
  type EntryExecutionShadow,
  type EntryExecutionShadowCheckpoint,
} from "./entry-execution-shadow.ts";

export const EXECUTION_SHADOW_BRAIN_EVIDENCE_VERSION =
  "nexus-execution-shadow-brain-evidence-v1" as const;

export type ExecutionShadowFinding =
  | "COLLECTING"
  | "SHADOW_ENTRY_PRICE_BETTER"
  | "ACTUAL_ENTRY_PRICE_BETTER"
  | "AVOIDED_ADVERSE_PATH"
  | "MISSED_FAVORABLE_PATH"
  | "NO_CLEAR_DIFFERENCE";

export type ExecutionShadowBrainEvidence = {
  version: typeof EXECUTION_SHADOW_BRAIN_EVIDENCE_VERSION;
  evidenceRole: "AUXILIARY_EXECUTION_TIMING_CONTEXT";
  evidenceScope: "ENTRY_EXECUTION_ONLY";
  observationOnly: true;
  decisionAuthority: "NONE";
  orderAffecting: false;
  directionAffecting: false;
  quantityAffecting: false;
  parameterAffecting: false;
  traceId: string;
  modelVersion: typeof ENTRY_EXECUTION_SHADOW_VERSION;
  activationMode: "SHADOW" | "LIVE";
  status: "COLLECTING" | "PARTIAL" | "COMPLETE";
  finding: ExecutionShadowFinding;
  estimatedRoundTripCostRoePercent: number;
  checkpoints: EntryExecutionShadowCheckpoint[];
  explanation: string;
};

export type ExecutionShadowBrainSummaryInput = {
  traceId: string;
  independenceKey: string;
  strategyId: number | null;
  configVersion: number | null;
  createdAtMs: number;
  evidence: ExecutionShadowBrainEvidence | null;
};

/**
 * Convert the frozen entry quote and its later price path into an auxiliary
 * fact. This is deliberately unable to approve/reject an order or mutate a
 * strategy. It only describes whether execution timing helped after the
 * existing brain had already made its decision.
 */
export function buildExecutionShadowBrainEvidence(input: {
  traceId: string;
  positionSide: "LONG" | "SHORT";
  actualEntryPrice: number;
  rawShadow: unknown;
  samples: Array<{ minuteOffset: number; markPrice: number | null }>;
}): ExecutionShadowBrainEvidence | null {
  const shadow = entryExecutionShadowFromUnknown(input.rawShadow);
  if (!shadow) return null;
  const checkpoints = evaluateEntryExecutionShadow({
    positionSide: input.positionSide,
    leverage: shadow.leverage,
    actualEntryPrice: input.actualEntryPrice,
    shadow,
    samples: input.samples,
  });
  const observed = checkpoints.filter(
    (point) => point.status !== "INSUFFICIENT",
  );
  const status = observed.length === checkpoints.length
    ? "COMPLETE" as const
    : observed.length > 0
      ? "PARTIAL" as const
      : "COLLECTING" as const;
  const latest = observed.at(-1) ?? null;
  const estimatedCost = Math.max(0.2, shadow.leverage * 0.08);
  const finding = findingFromCheckpoint(latest, estimatedCost);
  return {
    version: EXECUTION_SHADOW_BRAIN_EVIDENCE_VERSION,
    evidenceRole: "AUXILIARY_EXECUTION_TIMING_CONTEXT",
    evidenceScope: "ENTRY_EXECUTION_ONLY",
    observationOnly: true,
    decisionAuthority: "NONE",
    orderAffecting: false,
    directionAffecting: false,
    quantityAffecting: false,
    parameterAffecting: false,
    traceId: input.traceId,
    modelVersion: ENTRY_EXECUTION_SHADOW_VERSION,
    activationMode: shadow.activationMode,
    status,
    finding,
    estimatedRoundTripCostRoePercent: round(estimatedCost),
    checkpoints,
    explanation: findingExplanation(finding),
  };
}

export function summarizeExecutionShadowBrainEvidence(
  inputs: ExecutionShadowBrainSummaryInput[],
  minimumIndependentWaves = 30,
  minimumHoldoutWaves = 9,
) {
  const valid = inputs.filter(
    (item): item is ExecutionShadowBrainSummaryInput & {
      evidence: ExecutionShadowBrainEvidence;
    } => item.evidence !== null,
  );
  const groups = new Map<string, typeof valid>();
  for (const item of valid) {
    const key = `${item.strategyId ?? "none"}:${item.configVersion ?? "none"}:${item.independenceKey}`;
    const current = groups.get(key) ?? [];
    current.push(item);
    groups.set(key, current);
  }
  const waves = [...groups.entries()].map(([key, rows]) => ({
    key,
    createdAtMs: Math.max(...rows.map((row) => row.createdAtMs)),
    rows,
  })).sort((left, right) => left.createdAtMs - right.createdAtMs);
  const holdoutCount = Math.min(
    waves.length,
    Math.floor(waves.length * 0.3),
  );
  const horizons = ([5, 30, 60] as const).map((minute) => {
    const wavePoints = waves.flatMap((wave) => {
      const points = wave.rows.flatMap((row) => {
        const point = row.evidence.checkpoints.find(
          (candidate) => candidate.minute === minute,
        );
        return point && point.status !== "INSUFFICIENT" ? [point] : [];
      });
      if (!points.length) return [];
      return [{
        actualNet: average(points.map((point) => point.actualRoePercent)) -
          average(wave.rows.map(
            (row) => row.evidence.estimatedRoundTripCostRoePercent,
          )),
        shadowNet: average(points.map(
          (point) => point.shadowOpportunityRoePercent,
        )) - average(wave.rows.map(
          (row) => row.evidence.estimatedRoundTripCostRoePercent,
        )),
        filledRate: points.filter((point) => point.status === "FILLED").length /
          points.length,
      }];
    });
    return {
      minute,
      independentWaves: wavePoints.length,
      actualAverageNetRoePercent: nullableAverage(
        wavePoints.map((point) => point.actualNet),
      ),
      shadowAverageNetRoePerOpportunityPercent: nullableAverage(
        wavePoints.map((point) => point.shadowNet),
      ),
      averageNetAdvantageRoePercent: nullableAverage(
        wavePoints.map((point) => point.shadowNet - point.actualNet),
      ),
      shadowFillRate: nullableAverage(
        wavePoints.map((point) => point.filledRate),
      ),
    };
  });
  const findings = Object.fromEntries(
    [
      "SHADOW_ENTRY_PRICE_BETTER",
      "ACTUAL_ENTRY_PRICE_BETTER",
      "AVOIDED_ADVERSE_PATH",
      "MISSED_FAVORABLE_PATH",
      "NO_CLEAR_DIFFERENCE",
      "COLLECTING",
    ].map((finding) => [
      finding,
      valid.filter((item) => item.evidence.finding === finding).length,
    ]),
  ) as Record<ExecutionShadowFinding, number>;
  const reviewReady =
    waves.length >= minimumIndependentWaves &&
    holdoutCount >= minimumHoldoutWaves;
  return {
    version: EXECUTION_SHADOW_BRAIN_EVIDENCE_VERSION,
    evidenceRole: "AUXILIARY_EXECUTION_TIMING_CONTEXT" as const,
    observationOnly: true as const,
    decisionAuthority: "NONE" as const,
    orderAffecting: false as const,
    directionAffecting: false as const,
    quantityAffecting: false as const,
    parameterAffecting: false as const,
    rawTraces: valid.length,
    independentWaves: waves.length,
    completeTraces: valid.filter(
      (item) => item.evidence.status === "COMPLETE",
    ).length,
    holdoutWaves: holdoutCount,
    minimumIndependentWaves,
    minimumHoldoutWaves,
    status: reviewReady ? "REVIEW_READY" as const : "COLLECTING" as const,
    findings,
    horizons,
    summary: reviewReady
      ? `影子执行已有 ${waves.length} 个独立波段并保留 ${holdoutCount} 个近期留出波段，可供人工复核；它只补充成交时机证据，不改变方向大脑。`
      : `影子执行已有 ${waves.length}/${minimumIndependentWaves} 个独立波段，近期留出 ${holdoutCount}/${minimumHoldoutWaves}；继续采集，不参与放行、否决或自动调参。`,
  };
}

export function entryExecutionShadowFromUnknown(
  value: unknown,
): EntryExecutionShadow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.version !== ENTRY_EXECUTION_SHADOW_VERSION ||
    !["SHADOW", "LIVE"].includes(String(item.activationMode)) ||
    !["MARKET", "LIMIT"].includes(String(item.adaptiveOrderType)) ||
    !(Number(item.leverage) > 0) ||
    !(Number(item.adaptiveRequestedPrice) > 0)
  ) return null;
  return item as unknown as EntryExecutionShadow;
}

function findingFromCheckpoint(
  point: EntryExecutionShadowCheckpoint | null,
  costBuffer: number,
): ExecutionShadowFinding {
  if (!point) return "COLLECTING";
  const actual = point.actualRoePercent;
  if (actual === null) return "COLLECTING";
  if (point.status === "NOT_FILLED") {
    if (actual < -costBuffer) return "AVOIDED_ADVERSE_PATH";
    if (actual > costBuffer) return "MISSED_FAVORABLE_PATH";
    return "NO_CLEAR_DIFFERENCE";
  }
  const advantage = point.advantageRoePercent;
  if (advantage !== null && advantage > costBuffer)
    return "SHADOW_ENTRY_PRICE_BETTER";
  if (advantage !== null && advantage < -costBuffer)
    return "ACTUAL_ENTRY_PRICE_BETTER";
  return "NO_CLEAR_DIFFERENCE";
}

function findingExplanation(finding: ExecutionShadowFinding) {
  return {
    COLLECTING: "等待5/30/60分钟真实价格路径，仅记录影子报价，不形成结论。",
    SHADOW_ENTRY_PRICE_BETTER: "同一方向下，影子成交价相对真实成交价的净ROE改善已超过估算交易成本；仅说明成交时机，不证明方向正确。",
    ACTUAL_ENTRY_PRICE_BETTER: "同一方向下，真实成交路径优于影子报价；保留现有委托作为对照依据。",
    AVOIDED_ADVERSE_PATH: "影子限价未成交，而真实订单后续净ROE为负；记录为可能避免追价的执行证据。",
    MISSED_FAVORABLE_PATH: "影子限价未成交，而真实订单后续净ROE为正；记录为等待造成的机会成本。",
    NO_CLEAR_DIFFERENCE: "真实与影子路径差异尚未覆盖估算交易成本，不能据此调整委托。",
  }[finding];
}

function average(values: Array<number | null>) {
  const valid = values.filter((value): value is number =>
    value !== null && Number.isFinite(value));
  return valid.length
    ? valid.reduce((sum, value) => sum + value, 0) / valid.length
    : 0;
}

function nullableAverage(values: number[]) {
  return values.length
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
