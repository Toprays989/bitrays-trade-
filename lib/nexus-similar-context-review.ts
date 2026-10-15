import type { NexusLearningLane } from "./nexus-learning-cycle.ts";
import type {
  NexusEvidenceDimension,
  NexusEvidenceReliabilityMemory,
} from "./nexus-evidence-reliability-memory.ts";

export const NEXUS_SIMILAR_CONTEXT_REVIEW_VERSION =
  "nexus-similar-context-review-v1" as const;

export type NexusSimilarContextComparison = {
  evidenceDimension: NexusEvidenceDimension;
  sourceMarketContextKey: string;
  relation: "EXACT" | "SIMILAR";
  similarity: number;
  comparableDimensions: number;
  matchingDimensions: string[];
  differingDimensions: string[];
  signal: NexusEvidenceReliabilityMemory["signal"];
  independentCycles: number;
  resolvedCycles: number;
  supportedCycles: number;
  contradictedCycles: number;
  inconclusiveCycles: number;
  exactNetPnlUsdt: number;
  summary: string;
};

export type NexusSimilarContextReview = {
  version: typeof NEXUS_SIMILAR_CONTEXT_REVIEW_VERSION;
  brainKey: string;
  configVersion: number;
  direction: "LONG" | "SHORT";
  learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
  targetMarketContextKey: string;
  status:
    | "EXACT_CONTEXT_AVAILABLE"
    | "SIMILAR_CONTEXT_AVAILABLE"
    | "INSUFFICIENT_HISTORY";
  comparisons: NexusSimilarContextComparison[];
  exactContextCount: number;
  similarContextCount: number;
  displayValue: string;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

/**
 * 从同一大脑、发布版本、方向和学习通道的历史记忆中，查找与当前环境
 * 完全一致或足够相似的证据结果。UNKNOWN 维度不计为相同，防止缺数据
 * 被错误当成历史共识。本结果只供复盘解释，不参与订单准入或实盘改参。
 */
export function buildNexusSimilarContextReview(input: {
  target: {
    brainKey: string;
    configVersion: number;
    direction: "LONG" | "SHORT";
    learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
    marketContextKey: string;
  };
  memories: NexusEvidenceReliabilityMemory[];
  minimumComparableDimensions?: number;
  minimumSimilarity?: number;
  limit?: number;
}): NexusSimilarContextReview {
  const minimumComparableDimensions = Math.max(
    3,
    integer(input.minimumComparableDimensions ?? 3),
  );
  const minimumSimilarity = clamp(input.minimumSimilarity ?? 0.6, 0.5, 1);
  const limit = Math.max(1, Math.min(15, integer(input.limit ?? 8)));
  const targetContext = parseMarketContext(input.target.marketContextKey);

  const comparisons = input.memories
    .filter(
      (memory) =>
        memory.brainKey === input.target.brainKey &&
        memory.configVersion === input.target.configVersion &&
        memory.direction === input.target.direction &&
        memory.learningLane === input.target.learningLane,
    )
    .map((memory) => comparison(targetContext, memory))
    .filter(
      (item): item is NexusSimilarContextComparison =>
        item !== null &&
        item.comparableDimensions >= minimumComparableDimensions &&
        item.similarity >= minimumSimilarity,
    )
    .sort(
      (left, right) =>
        relationRank(left.relation) - relationRank(right.relation) ||
        right.similarity - left.similarity ||
        right.resolvedCycles - left.resolvedCycles ||
        right.independentCycles - left.independentCycles ||
        left.evidenceDimension.localeCompare(right.evidenceDimension) ||
        left.sourceMarketContextKey.localeCompare(right.sourceMarketContextKey),
    )
    .slice(0, limit);

  const exactContextCount = comparisons.filter(
    (item) => item.relation === "EXACT",
  ).length;
  const similarContextCount = comparisons.length - exactContextCount;
  const status = exactContextCount > 0
    ? "EXACT_CONTEXT_AVAILABLE" as const
    : similarContextCount > 0
      ? "SIMILAR_CONTEXT_AVAILABLE" as const
      : "INSUFFICIENT_HISTORY" as const;
  const strongest = comparisons[0] ?? null;

  return {
    version: NEXUS_SIMILAR_CONTEXT_REVIEW_VERSION,
    brainKey: input.target.brainKey,
    configVersion: input.target.configVersion,
    direction: input.target.direction,
    learningLane: input.target.learningLane,
    targetMarketContextKey: input.target.marketContextKey,
    status,
    comparisons,
    exactContextCount,
    similarContextCount,
    displayValue:
      status === "EXACT_CONTEXT_AVAILABLE"
        ? `${exactContextCount} 条完全一致 / ${similarContextCount} 条相似`
        : status === "SIMILAR_CONTEXT_AVAILABLE"
          ? `${similarContextCount} 条相似`
          : "暂无可靠相似环境",
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    summary: strongest
      ? `当前环境找到 ${exactContextCount} 条完全一致、${similarContextCount} 条相似证据记忆；` +
        `最相关的是${evidenceLabel(strongest.evidenceDimension)}，` +
        `相似度 ${(strongest.similarity * 100).toFixed(0)}%，历史结论为${signalLabel(strongest.signal)}。` +
        "只供运营复盘当前判断，不直接放行、拒绝订单或修改实盘参数。"
      : `当前环境尚无满足最少 ${minimumComparableDimensions} 个有效维度、` +
        `${(minimumSimilarity * 100).toFixed(0)}% 相似度的同版本同方向历史记忆；` +
        "继续采集完整周期，不用缺失数据推断共识。",
  };
}

function comparison(
  target: Map<string, string>,
  memory: NexusEvidenceReliabilityMemory,
): NexusSimilarContextComparison | null {
  const source = parseMarketContext(memory.marketContextKey);
  const matchingDimensions: string[] = [];
  const differingDimensions: string[] = [];
  for (const dimension of CONTEXT_DIMENSIONS) {
    const targetValue = target.get(dimension);
    const sourceValue = source.get(dimension);
    if (!known(targetValue) || !known(sourceValue)) continue;
    if (targetValue === sourceValue) matchingDimensions.push(dimension);
    else differingDimensions.push(dimension);
  }
  const comparableDimensions =
    matchingDimensions.length + differingDimensions.length;
  if (comparableDimensions === 0) return null;
  const similarity = round(matchingDimensions.length / comparableDimensions);
  const relation =
    clean(memory.marketContextKey) === cleanContextKey(target) &&
      differingDimensions.length === 0
      ? "EXACT" as const
      : "SIMILAR" as const;
  return {
    evidenceDimension: memory.evidenceDimension,
    sourceMarketContextKey: memory.marketContextKey,
    relation,
    similarity,
    comparableDimensions,
    matchingDimensions,
    differingDimensions,
    signal: memory.signal,
    independentCycles: memory.independentCycles,
    resolvedCycles: memory.resolvedCycles,
    supportedCycles: memory.supportedCycles,
    contradictedCycles: memory.contradictedCycles,
    inconclusiveCycles: memory.inconclusiveCycles,
    exactNetPnlUsdt: memory.exactNetPnlUsdt,
    summary:
      `${relation === "EXACT" ? "完全一致" : "相似"}环境；` +
      `有效维度 ${comparableDimensions}，匹配 ${matchingDimensions.length}，` +
      `差异 ${differingDimensions.length}；${evidenceLabel(memory.evidenceDimension)}` +
      `历史结论${signalLabel(memory.signal)}，可判定周期 ${memory.resolvedCycles}。`,
  };
}

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

function relationRank(value: NexusSimilarContextComparison["relation"]) {
  return value === "EXACT" ? 0 : 1;
}

function evidenceLabel(value: NexusEvidenceDimension) {
  if (value === "WAVE_DIRECTION") return "波段方向证据";
  if (value === "ENTRY_TIMING") return "入场时机证据";
  if (value === "POSITION_MANAGEMENT") return "持仓管理证据";
  if (value === "FUNDING_VOLUME") return "费率与成交量证据";
  return "入场量价时序证据";
}

function signalLabel(value: NexusEvidenceReliabilityMemory["signal"]) {
  if (value === "SUPPORTED_BY_HISTORY") return "多数支持";
  if (value === "CONTRADICTED_BY_HISTORY") return "多数反证";
  if (value === "MIXED_HISTORY") return "结果分歧";
  return "样本不足";
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

function clean(value: unknown) {
  return String(value ?? "").trim();
}
