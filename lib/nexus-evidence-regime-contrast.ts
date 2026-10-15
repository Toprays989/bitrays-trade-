import type { NexusLearningLane } from "./nexus-learning-cycle.ts";
import type {
  NexusEvidenceDimension,
  NexusEvidenceReliabilityMemory,
} from "./nexus-evidence-reliability-memory.ts";

export const NEXUS_EVIDENCE_REGIME_CONTRAST_VERSION =
  "nexus-evidence-regime-contrast-v1" as const;

type EvidencePolarity = "SUPPORTED" | "CONTRADICTED" | "MIXED";

export type NexusEvidenceRegimeContrastItem = {
  evidenceDimension: NexusEvidenceDimension;
  status:
    | "REGIME_DEPENDENT"
    | "STABLE_ACROSS_CONTEXTS"
    | "MIXED_ACROSS_CONTEXTS"
    | "CURRENT_CONTEXT_INSUFFICIENT"
    | "COMPARISON_INSUFFICIENT";
  basisRelation: "EXACT" | "SIMILAR" | "NONE";
  basisMarketContextKey: string | null;
  basisSimilarity: number | null;
  basisResolvedCycles: number;
  basisSupportRate: number | null;
  basisPolarity: EvidencePolarity | null;
  comparisonContexts: number;
  oppositeContexts: number;
  largestSupportRateGap: number | null;
  strongestOppositeContextKey: string | null;
  changedDimensions: string[];
  summary: string;
};

export type NexusEvidenceRegimeContrast = {
  version: typeof NEXUS_EVIDENCE_REGIME_CONTRAST_VERSION;
  brainKey: string;
  configVersion: number;
  direction: "LONG" | "SHORT";
  learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
  targetMarketContextKey: string;
  status:
    | "REGIME_DEPENDENCE_FOUND"
    | "STABLE_EVIDENCE_FOUND"
    | "MIXED_EVIDENCE"
    | "INSUFFICIENT_HISTORY";
  items: NexusEvidenceRegimeContrastItem[];
  regimeDependentDimensions: number;
  stableDimensions: number;
  mixedDimensions: number;
  insufficientDimensions: number;
  displayValue: string;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

/**
 * 对照同一大脑、同一发布版本、同一方向和同一学习通道下，不同市场环境
 * 中的证据可靠性。只有已经达到独立可判定样本门槛的历史记忆才参与对照；
 * UNKNOWN 维度不制造相似关系。本结果只回答“证据是否依赖市场环境”，
 * 不参与订单准入、仓位动作或实盘参数修改。
 */
export function buildNexusEvidenceRegimeContrast(input: {
  target: {
    brainKey: string;
    configVersion: number;
    direction: "LONG" | "SHORT";
    learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
    marketContextKey: string;
  };
  memories: NexusEvidenceReliabilityMemory[];
  minimumResolvedCycles?: number;
  minimumComparableDimensions?: number;
  minimumBasisSimilarity?: number;
  stableSupportRateGap?: number;
}): NexusEvidenceRegimeContrast {
  const minimumResolvedCycles = Math.max(
    3,
    integer(input.minimumResolvedCycles ?? 3),
  );
  const minimumComparableDimensions = Math.max(
    3,
    integer(input.minimumComparableDimensions ?? 3),
  );
  const minimumBasisSimilarity = clamp(
    input.minimumBasisSimilarity ?? 0.6,
    0.5,
    1,
  );
  const stableSupportRateGap = clamp(
    input.stableSupportRateGap ?? 0.2,
    0.05,
    0.4,
  );
  const targetContext = parseMarketContext(input.target.marketContextKey);
  const isolated = input.memories.filter(
    (memory) =>
      memory.brainKey === input.target.brainKey &&
      memory.configVersion === input.target.configVersion &&
      memory.direction === input.target.direction &&
      memory.learningLane === input.target.learningLane &&
      memory.resolvedCycles >= minimumResolvedCycles &&
      memory.signal !== "INSUFFICIENT_HISTORY",
  );

  const items = EVIDENCE_DIMENSIONS.map((evidenceDimension) =>
    contrastDimension({
      evidenceDimension,
      targetContext,
      targetMarketContextKey: input.target.marketContextKey,
      memories: isolated.filter(
        (memory) => memory.evidenceDimension === evidenceDimension,
      ),
      minimumComparableDimensions,
      minimumBasisSimilarity,
      stableSupportRateGap,
    })
  );
  const regimeDependentDimensions = countStatus(items, "REGIME_DEPENDENT");
  const stableDimensions = countStatus(items, "STABLE_ACROSS_CONTEXTS");
  const mixedDimensions = countStatus(items, "MIXED_ACROSS_CONTEXTS");
  const insufficientDimensions = items.length - regimeDependentDimensions -
    stableDimensions - mixedDimensions;
  const status = regimeDependentDimensions > 0
    ? "REGIME_DEPENDENCE_FOUND" as const
    : stableDimensions > 0
      ? "STABLE_EVIDENCE_FOUND" as const
      : mixedDimensions > 0
        ? "MIXED_EVIDENCE" as const
        : "INSUFFICIENT_HISTORY" as const;
  const sensitiveLabels = items
    .filter((item) => item.status === "REGIME_DEPENDENT")
    .map((item) => evidenceLabel(item.evidenceDimension));

  return {
    version: NEXUS_EVIDENCE_REGIME_CONTRAST_VERSION,
    brainKey: input.target.brainKey,
    configVersion: input.target.configVersion,
    direction: input.target.direction,
    learningLane: input.target.learningLane,
    targetMarketContextKey: input.target.marketContextKey,
    status,
    items,
    regimeDependentDimensions,
    stableDimensions,
    mixedDimensions,
    insufficientDimensions,
    displayValue:
      `环境敏感 ${regimeDependentDimensions} / 稳定 ${stableDimensions} / ` +
      `待积累 ${insufficientDimensions}`,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    summary: regimeDependentDimensions > 0
      ? `发现 ${regimeDependentDimensions} 类证据随市场环境改变：` +
        `${sensitiveLabels.join("、")}。必须结合当前环境解释，不能把其他行情中的历史结论直接套用；` +
        "该对照只进入学习和运营解释，不放行、拒绝订单或自动改参。"
      : stableDimensions > 0
        ? `已有 ${stableDimensions} 类证据在可比市场环境中方向一致，` +
          `${mixedDimensions} 类仍有分歧；只作为历史稳定性说明，不参与订单或自动改参。`
        : "当前版本同方向的跨环境独立样本不足，继续采集完整周期，不用零散结果推断证据稳定性。",
  };
}

function contrastDimension(input: {
  evidenceDimension: NexusEvidenceDimension;
  targetContext: Map<string, string>;
  targetMarketContextKey: string;
  memories: NexusEvidenceReliabilityMemory[];
  minimumComparableDimensions: number;
  minimumBasisSimilarity: number;
  stableSupportRateGap: number;
}): NexusEvidenceRegimeContrastItem {
  const candidates = input.memories
    .map((memory) => ({
      memory,
      ...contextRelation(input.targetContext, memory.marketContextKey),
    }))
    .filter(
      (item) => item.comparableDimensions >= input.minimumComparableDimensions,
    )
    .sort(
      (left, right) =>
        relationRank(left.relation) - relationRank(right.relation) ||
        right.similarity - left.similarity ||
        right.memory.resolvedCycles - left.memory.resolvedCycles ||
        left.memory.marketContextKey.localeCompare(
          right.memory.marketContextKey,
        ),
    );
  const basis = candidates.find(
    (item) =>
      item.relation === "EXACT" ||
      item.similarity >= input.minimumBasisSimilarity,
  );
  if (!basis)
    return emptyItem(
      input.evidenceDimension,
      "CURRENT_CONTEXT_INSUFFICIENT",
      `当前环境没有达到相似度和独立样本门槛的${evidenceLabel(input.evidenceDimension)}历史依据。`,
    );

  const basisSupportRate = supportRate(basis.memory);
  const basisPolarity = polarity(basisSupportRate);
  const comparisons = candidates.filter(
    (item) => item.memory.marketContextKey !== basis.memory.marketContextKey,
  );
  if (comparisons.length === 0)
    return {
      ...basisFields(input.evidenceDimension, basis, basisSupportRate, basisPolarity),
      status: "COMPARISON_INSUFFICIENT",
      comparisonContexts: 0,
      oppositeContexts: 0,
      largestSupportRateGap: null,
      strongestOppositeContextKey: null,
      changedDimensions: [],
      summary:
        `${evidenceLabel(input.evidenceDimension)}在当前环境已有依据，` +
        "但尚无另一个达到门槛的可比市场环境，暂不能判断是否具有环境依赖。",
    };

  const contrasted = comparisons.map((item) => {
    const rate = supportRate(item.memory);
    return {
      ...item,
      rate,
      polarity: polarity(rate),
      gap: round(Math.abs(rate - basisSupportRate)),
    };
  }).sort(
    (left, right) =>
      Number(isOpposite(left.polarity, basisPolarity)) -
        Number(isOpposite(right.polarity, basisPolarity)) === 0
        ? right.gap - left.gap ||
          right.memory.resolvedCycles - left.memory.resolvedCycles ||
          left.memory.marketContextKey.localeCompare(
            right.memory.marketContextKey,
          )
        : Number(isOpposite(right.polarity, basisPolarity)) -
          Number(isOpposite(left.polarity, basisPolarity)),
  );
  const opposite = contrasted.filter((item) =>
    isOpposite(item.polarity, basisPolarity)
  );
  const largestGap = contrasted[0]?.gap ?? 0;
  const regimeDependent = opposite.length > 0;
  const stable = !regimeDependent &&
    basisPolarity !== "MIXED" &&
    contrasted.every((item) => item.polarity === basisPolarity) &&
    largestGap <= input.stableSupportRateGap;
  const status = regimeDependent
    ? "REGIME_DEPENDENT" as const
    : stable
      ? "STABLE_ACROSS_CONTEXTS" as const
      : "MIXED_ACROSS_CONTEXTS" as const;
  const strongestOpposite = opposite[0] ?? null;
  const changedDimensions = strongestOpposite?.differingDimensions ?? [];

  return {
    ...basisFields(input.evidenceDimension, basis, basisSupportRate, basisPolarity),
    status,
    comparisonContexts: contrasted.length,
    oppositeContexts: opposite.length,
    largestSupportRateGap: largestGap,
    strongestOppositeContextKey:
      strongestOpposite?.memory.marketContextKey ?? null,
    changedDimensions,
    summary: regimeDependent
      ? `${evidenceLabel(input.evidenceDimension)}存在环境反转：当前依据支持率 ` +
        `${percent(basisSupportRate)}，另有 ${opposite.length} 个环境方向相反；` +
        `主要环境差异为${changedDimensions.join("、") || "已记录维度组合"}。`
      : stable
        ? `${evidenceLabel(input.evidenceDimension)}在 ${contrasted.length + 1} 个可比环境中方向一致，` +
          `最大支持率差 ${percent(largestGap)}。`
        : `${evidenceLabel(input.evidenceDimension)}跨环境结果仍有分歧，` +
          `但尚未形成方向相反的可靠结论。`,
  };
}

function basisFields(
  evidenceDimension: NexusEvidenceDimension,
  basis: {
    memory: NexusEvidenceReliabilityMemory;
    relation: "EXACT" | "SIMILAR";
    similarity: number;
  },
  basisSupportRate: number,
  basisPolarity: EvidencePolarity,
) {
  return {
    evidenceDimension,
    basisRelation: basis.relation,
    basisMarketContextKey: basis.memory.marketContextKey,
    basisSimilarity: basis.similarity,
    basisResolvedCycles: basis.memory.resolvedCycles,
    basisSupportRate,
    basisPolarity,
  } as const;
}

function emptyItem(
  evidenceDimension: NexusEvidenceDimension,
  status: "CURRENT_CONTEXT_INSUFFICIENT",
  summary: string,
): NexusEvidenceRegimeContrastItem {
  return {
    evidenceDimension,
    status,
    basisRelation: "NONE",
    basisMarketContextKey: null,
    basisSimilarity: null,
    basisResolvedCycles: 0,
    basisSupportRate: null,
    basisPolarity: null,
    comparisonContexts: 0,
    oppositeContexts: 0,
    largestSupportRateGap: null,
    strongestOppositeContextKey: null,
    changedDimensions: [],
    summary,
  };
}

function contextRelation(
  target: Map<string, string>,
  sourceKey: string,
) {
  const source = parseMarketContext(sourceKey);
  const matchingDimensions: string[] = [];
  const differingDimensions: string[] = [];
  for (const dimension of CONTEXT_DIMENSIONS) {
    const targetValue = target.get(dimension);
    const sourceValue = source.get(dimension);
    if (!known(targetValue) || !known(sourceValue)) continue;
    if (targetValue === sourceValue) matchingDimensions.push(dimension);
    else differingDimensions.push(dimension);
  }
  const comparableDimensions = matchingDimensions.length +
    differingDimensions.length;
  const similarity = comparableDimensions > 0
    ? round(matchingDimensions.length / comparableDimensions)
    : 0;
  return {
    relation: differingDimensions.length === 0 &&
        clean(sourceKey) === cleanContextKey(target)
      ? "EXACT" as const
      : "SIMILAR" as const,
    similarity,
    comparableDimensions,
    matchingDimensions,
    differingDimensions,
  };
}

function supportRate(memory: NexusEvidenceReliabilityMemory) {
  return memory.resolvedCycles > 0
    ? round(memory.supportedCycles / memory.resolvedCycles)
    : 0.5;
}

function polarity(rate: number): EvidencePolarity {
  if (rate >= 2 / 3) return "SUPPORTED";
  if (rate <= 1 / 3) return "CONTRADICTED";
  return "MIXED";
}

function isOpposite(left: EvidencePolarity, right: EvidencePolarity) {
  return (left === "SUPPORTED" && right === "CONTRADICTED") ||
    (left === "CONTRADICTED" && right === "SUPPORTED");
}

function countStatus(
  items: NexusEvidenceRegimeContrastItem[],
  status: NexusEvidenceRegimeContrastItem["status"],
) {
  return items.filter((item) => item.status === status).length;
}

const EVIDENCE_DIMENSIONS: NexusEvidenceDimension[] = [
  "WAVE_DIRECTION",
  "ENTRY_TIMING",
  "POSITION_MANAGEMENT",
  "FUNDING_VOLUME",
  "ENTRY_VOLUME_TIMING",
];
const CONTEXT_DIMENSIONS = ["TREND", "VOL", "LIQ", "FLOW", "STRESS", "TEMP"];

function parseMarketContext(value: unknown) {
  const result = new Map<string, string>();
  for (const segment of clean(value).split("|")) {
    const split = segment.indexOf("_");
    if (split <= 0) continue;
    const dimension = segment.slice(0, split).trim().toUpperCase();
    const state = segment.slice(split + 1).trim().toUpperCase();
    if (CONTEXT_DIMENSIONS.includes(dimension) && state)
      result.set(dimension, state);
  }
  return result;
}

function cleanContextKey(context: Map<string, string>) {
  return CONTEXT_DIMENSIONS
    .filter((dimension) => context.has(dimension))
    .map((dimension) => `${dimension}_${context.get(dimension)}`)
    .join("|");
}

function known(value: string | undefined) {
  return Boolean(value && value !== "UNKNOWN" && value !== "UNAVAILABLE");
}

function relationRank(value: "EXACT" | "SIMILAR") {
  return value === "EXACT" ? 0 : 1;
}

function evidenceLabel(value: NexusEvidenceDimension) {
  if (value === "WAVE_DIRECTION") return "波段方向证据";
  if (value === "ENTRY_TIMING") return "入场时机证据";
  if (value === "POSITION_MANAGEMENT") return "持仓管理证据";
  if (value === "FUNDING_VOLUME") return "费率与成交量证据";
  return "入场量价时序证据";
}

function integer(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function clamp(value: unknown, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(maximum, Math.max(minimum, numeric))
    : minimum;
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function percent(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}
