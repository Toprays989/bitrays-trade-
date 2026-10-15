import type { NexusLearningEligibility } from "./nexus-learning-cycle.ts";

export const NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION =
  "nexus-brain-collaboration-memory-v1" as const;

export type NexusBrainMemoryCase = {
  version: typeof NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION;
  accountId: string;
  brainKey: string;
  configVersion: number;
  traceId: string;
  symbol: string;
  direction: "LONG" | "SHORT" | "UNKNOWN";
  decisionPath: string;
  marketContextKey: string;
  probabilityDecisionPath: string;
  probabilityMarketContextKey: string;
  volatilityRegime: string;
  liquidityRegime: string;
  liquidationDirection: string;
  position24hPercent: number | null;
  position72hPercent: number | null;
  relativeVolume: number | null;
  liquidationNotionalUsdt: number | null;
  exactNetPnlUsdt: number | null;
  exactNetRoePercent: number | null;
  observedPnlUsdt: number | null;
  observedPnlBasis:
    | "NET_EXACT"
    | "GROSS_BEFORE_UNSETTLED_COSTS"
    | "EXIT_REASON_ONLY"
    | "UNAVAILABLE";
  terminalExitReasons: string[];
  fastLearningStatus: "LEARNED" | "PARTIAL" | "UNAVAILABLE";
  eligibility: NexusLearningEligibility;
  completedAt: string | null;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
};

export type NexusBrainCollaborationReference = {
  sourceTraceId: string;
  sourceBrainKey: string;
  sourceConfigVersion: number;
  scope: "OWN_BRAIN" | "PEER_BRAIN_REFERENCE";
  parameterLearningEligible: boolean;
  exactCategoricalMatches: string[];
  categoricalMismatches: string[];
  normalizedNumericDistance: number | null;
  exactNetPnlUsdt: number | null;
  observedPnlUsdt: number | null;
  observedPnlBasis: NexusBrainMemoryCase["observedPnlBasis"];
  summary: string;
};

export type NexusBrainCollaborationMemory = {
  version: typeof NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION;
  targetTraceId: string;
  independentBrainBoundary: true;
  sharedFactsAllowed: true;
  peerCasesReferenceOnly: true;
  selectionPolicy: "OWN_FIRST_PEER_BRAIN_DIVERSIFIED";
  peerBrainCount: number;
  peerConsensus: "POSITIVE" | "NEGATIVE" | "MIXED" | "INSUFFICIENT";
  peerOutcomeVotes: {
    positive: number;
    negative: number;
    flat: number;
    incomplete: number;
  };
  references: NexusBrainCollaborationReference[];
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

/**
 * Keep the learning memory tied to facts that were actually captured at entry.
 * Older traces stored these measurements under different, sometimes nested,
 * evidence keys. Resolving the aliases here prevents a real volume observation
 * from being downgraded to "missing" without changing its temporal verdict.
 */
export function resolveNexusBrainMemoryMarketMeasures(
  entryEvidence: Record<string, unknown>,
) {
  const volumeTiming = record(entryEvidence.nexusVolumeTiming);
  return {
    relativeVolume: firstFinite([
      entryEvidence.volumeRatio3m,
      entryEvidence.relativeVolume,
      volumeTiming.currentExecutionVolumeRatio,
      volumeTiming.currentContextVolumeRatio,
      volumeTiming.historicalImpulseVolumeRatio,
    ]),
    liquidationNotionalUsdt: firstFinite([
      entryEvidence.liquidationNotional,
      entryEvidence.windowLiquidationNotional,
      entryEvidence.singleLiquidationNotional,
      entryEvidence.marketClusterNotional,
      entryEvidence.symbolLiquidationNotional,
    ]),
  };
}

/**
 * 多大脑只共享事实和历史案例。只有同一大脑、同一发布版本的完整样本
 * 才能进入本大脑参数学习；其他大脑永远只是参考，不参与下单授权。
 */
export function buildNexusBrainCollaborationMemory(input: {
  target: NexusBrainMemoryCase;
  candidates: NexusBrainMemoryCase[];
  limit?: number;
}): NexusBrainCollaborationMemory {
  const limit = Math.max(1, Math.min(10, integer(input.limit, 5)));
  const ranked = input.candidates
    .filter((candidate) =>
      candidate.version === NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION &&
      candidate.accountId === input.target.accountId &&
      candidate.traceId !== input.target.traceId &&
      candidate.direction === input.target.direction &&
      candidate.direction !== "UNKNOWN"
    )
    .map((candidate) => compareMemoryCases(input.target, candidate))
    .sort(compareReferences);
  const ownRanked = ranked.filter((item) => item.scope === "OWN_BRAIN");
  const peerRanked = ranked.filter(
    (item) => item.scope === "PEER_BRAIN_REFERENCE",
  );
  const peerBestByBrain = bestReferencePerPeerBrain(peerRanked);
  const ownLimit = peerBestByBrain.length
    ? Math.min(ownRanked.length, Math.max(1, Math.floor(limit / 2)))
    : Math.min(ownRanked.length, limit);
  const references = [
    ...ownRanked.slice(0, ownLimit),
    ...peerBestByBrain.slice(0, Math.max(0, limit - ownLimit)),
  ];
  const own = references.filter((item) => item.scope === "OWN_BRAIN").length;
  const peers = references.length - own;
  const peerOutcomeVotes = summarizePeerOutcomes(references);
  const peerBrainCount = new Set(
    references
      .filter((item) => item.scope === "PEER_BRAIN_REFERENCE")
      .map((item) => item.sourceBrainKey),
  ).size;
  const peerConsensus = peerOutcomeConsensus(peerOutcomeVotes, peerBrainCount);
  return {
    version: NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION,
    targetTraceId: input.target.traceId,
    independentBrainBoundary: true,
    sharedFactsAllowed: true,
    peerCasesReferenceOnly: true,
    selectionPolicy: "OWN_FIRST_PEER_BRAIN_DIVERSIFIED",
    peerBrainCount,
    peerConsensus,
    peerOutcomeVotes,
    references,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    summary: references.length
      ? `找到 ${references.length} 个同方向相似周期：本大脑 ${own} 个、其他 ${peerBrainCount} 个大脑参考 ${peers} 个；跨脑结果 ${peerConsensusLabel(peerConsensus)}，仅描述当时波段并供复盘，不参与本脑参数学习或订单授权。`
      : "暂无满足账户、方向和数据边界的相似周期；本大脑继续独立积累。",
  };
}

function bestReferencePerPeerBrain(
  references: NexusBrainCollaborationReference[],
) {
  const selected = new Map<string, NexusBrainCollaborationReference>();
  for (const reference of references) {
    if (!selected.has(reference.sourceBrainKey))
      selected.set(reference.sourceBrainKey, reference);
  }
  return [...selected.values()].sort(compareReferences);
}

function summarizePeerOutcomes(
  references: NexusBrainCollaborationReference[],
) {
  const result = { positive: 0, negative: 0, flat: 0, incomplete: 0 };
  for (const reference of references) {
    if (reference.scope !== "PEER_BRAIN_REFERENCE") continue;
    const observedPnl = reference.exactNetPnlUsdt ??
      reference.observedPnlUsdt;
    if (observedPnl === null) result.incomplete += 1;
    else if (observedPnl > 0) result.positive += 1;
    else if (observedPnl < 0) result.negative += 1;
    else result.flat += 1;
  }
  return result;
}

function peerOutcomeConsensus(
  votes: ReturnType<typeof summarizePeerOutcomes>,
  peerBrainCount: number,
): NexusBrainCollaborationMemory["peerConsensus"] {
  const completed = votes.positive + votes.negative + votes.flat;
  if (peerBrainCount < 2 || completed < 2) return "INSUFFICIENT";
  if (votes.positive === completed) return "POSITIVE";
  if (votes.negative === completed) return "NEGATIVE";
  return "MIXED";
}

function peerConsensusLabel(
  value: NexusBrainCollaborationMemory["peerConsensus"],
) {
  if (value === "POSITIVE") return "一致正向";
  if (value === "NEGATIVE") return "一致负向";
  if (value === "MIXED") return "存在分歧";
  return "样本不足";
}

export function createNexusBrainMemoryCase(input: {
  accountId: string;
  brainKey: string;
  configVersion: number;
  traceId: string;
  symbol?: string | null;
  direction?: string | null;
  decisionPath?: string | null;
  marketContextKey?: string | null;
  probabilityDecisionPath?: string | null;
  probabilityMarketContextKey?: string | null;
  volatilityRegime?: string | null;
  liquidityRegime?: string | null;
  liquidationDirection?: string | null;
  position24hPercent?: number | null;
  position72hPercent?: number | null;
  relativeVolume?: number | null;
  liquidationNotionalUsdt?: number | null;
  exactNetPnlUsdt?: number | null;
  exactNetRoePercent?: number | null;
  observedPnlUsdt?: number | null;
  observedPnlBasis?: NexusBrainMemoryCase["observedPnlBasis"];
  terminalExitReasons?: Iterable<string>;
  fastLearningStatus?: NexusBrainMemoryCase["fastLearningStatus"];
  eligibility: NexusLearningEligibility;
  completedAt?: Date | string | number | null;
}): NexusBrainMemoryCase {
  return {
    version: NEXUS_BRAIN_COLLABORATION_MEMORY_VERSION,
    accountId: clean(input.accountId),
    brainKey: clean(input.brainKey),
    configVersion: integer(input.configVersion, 0),
    traceId: clean(input.traceId),
    symbol: clean(input.symbol).toUpperCase(),
    direction: normalizeDirection(input.direction),
    decisionPath: clean(input.decisionPath) || "UNKNOWN",
    marketContextKey: clean(input.marketContextKey) || "UNKNOWN",
    probabilityDecisionPath:
      clean(input.probabilityDecisionPath ?? input.decisionPath) || "UNKNOWN",
    probabilityMarketContextKey:
      clean(input.probabilityMarketContextKey ?? input.marketContextKey) ||
      "UNKNOWN",
    volatilityRegime: clean(input.volatilityRegime) || "UNKNOWN",
    liquidityRegime: clean(input.liquidityRegime) || "UNKNOWN",
    liquidationDirection: clean(input.liquidationDirection) || "UNKNOWN",
    position24hPercent: finiteOrNull(input.position24hPercent),
    position72hPercent: finiteOrNull(input.position72hPercent),
    relativeVolume: finiteOrNull(input.relativeVolume),
    liquidationNotionalUsdt: finiteOrNull(input.liquidationNotionalUsdt),
    exactNetPnlUsdt: finiteOrNull(input.exactNetPnlUsdt),
    exactNetRoePercent: finiteOrNull(input.exactNetRoePercent),
    observedPnlUsdt: finiteOrNull(
      input.observedPnlUsdt ?? input.exactNetPnlUsdt,
    ),
    observedPnlBasis: normalizeObservedPnlBasis(input.observedPnlBasis),
    terminalExitReasons: [...new Set(
      [...(input.terminalExitReasons ?? [])].map(clean).filter(Boolean),
    )],
    fastLearningStatus:
      input.fastLearningStatus === "LEARNED" ||
        input.fastLearningStatus === "PARTIAL"
        ? input.fastLearningStatus
        : "UNAVAILABLE",
    eligibility: input.eligibility,
    completedAt: isoOrNull(input.completedAt),
    orderAffecting: false,
    liveConfigMutationAllowed: false,
  };
}

function compareMemoryCases(
  target: NexusBrainMemoryCase,
  candidate: NexusBrainMemoryCase,
): NexusBrainCollaborationReference {
  const categorical: Array<[string, string, string]> = [
    ["SYMBOL", target.symbol, candidate.symbol],
    ["DECISION_PATH", target.decisionPath, candidate.decisionPath],
    ["MARKET_CONTEXT", target.marketContextKey, candidate.marketContextKey],
    ["VOLATILITY", target.volatilityRegime, candidate.volatilityRegime],
    ["LIQUIDITY", target.liquidityRegime, candidate.liquidityRegime],
    [
      "LIQUIDATION_DIRECTION",
      target.liquidationDirection,
      candidate.liquidationDirection,
    ],
  ];
  const comparable = categorical.filter(
    ([, left, right]) => left !== "UNKNOWN" && right !== "UNKNOWN",
  );
  const exactCategoricalMatches = comparable
    .filter(([, left, right]) => left === right)
    .map(([name]) => name);
  const categoricalMismatches = comparable
    .filter(([, left, right]) => left !== right)
    .map(([name]) => name);
  const distances = [
    normalizedDistance(target.position24hPercent, candidate.position24hPercent, 100),
    normalizedDistance(target.position72hPercent, candidate.position72hPercent, 100),
    normalizedDistance(target.relativeVolume, candidate.relativeVolume, 5),
    logDistance(
      target.liquidationNotionalUsdt,
      candidate.liquidationNotionalUsdt,
    ),
  ].filter((value): value is number => value !== null);
  const normalizedNumericDistance = distances.length
    ? round(distances.reduce((sum, value) => sum + value, 0) / distances.length)
    : null;
  const ownBrain = target.brainKey === candidate.brainKey;
  const sameVersion = target.configVersion === candidate.configVersion;
  return {
    sourceTraceId: candidate.traceId,
    sourceBrainKey: candidate.brainKey,
    sourceConfigVersion: candidate.configVersion,
    scope: ownBrain ? "OWN_BRAIN" : "PEER_BRAIN_REFERENCE",
    parameterLearningEligible:
      ownBrain && sameVersion && candidate.eligibility === "ELIGIBLE",
    exactCategoricalMatches,
    categoricalMismatches,
    normalizedNumericDistance,
    exactNetPnlUsdt: finiteOrNull(candidate.exactNetPnlUsdt),
    observedPnlUsdt:
      finiteOrNull(candidate.observedPnlUsdt) ?? candidate.exactNetPnlUsdt,
    observedPnlBasis: normalizeObservedPnlBasis(
      candidate.observedPnlBasis,
    ),
    summary: (ownBrain
      ? sameVersion
        ? "同一大脑同一版本案例，可按其原始学习资格使用。"
        : "同一大脑不同版本案例，仅作版本对照。"
      : "其他大脑案例仅供参考，不能改变本大脑参数、状态或订单。") +
      (finiteOrNull(candidate.exactNetPnlUsdt) !== null
        ? " 结果为费用后精确净收益。"
        : finiteOrNull(candidate.observedPnlUsdt) !== null
          ? " 结果为费用待补齐前的快速观察值，不进入参数学习。"
          : " 暂无可用盈亏数值。"),
  };
}

function normalizeObservedPnlBasis(
  value: unknown,
): NexusBrainMemoryCase["observedPnlBasis"] {
  return value === "NET_EXACT" ||
      value === "GROSS_BEFORE_UNSETTLED_COSTS" ||
      value === "EXIT_REASON_ONLY"
    ? value
    : "UNAVAILABLE";
}

function firstFinite(values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compareReferences(
  left: NexusBrainCollaborationReference,
  right: NexusBrainCollaborationReference,
) {
  if (left.scope !== right.scope)
    return left.scope === "OWN_BRAIN" ? -1 : 1;
  if (left.exactCategoricalMatches.length !== right.exactCategoricalMatches.length)
    return right.exactCategoricalMatches.length - left.exactCategoricalMatches.length;
  if (left.categoricalMismatches.length !== right.categoricalMismatches.length)
    return left.categoricalMismatches.length - right.categoricalMismatches.length;
  const leftDistance = left.normalizedNumericDistance ?? Number.POSITIVE_INFINITY;
  const rightDistance = right.normalizedNumericDistance ?? Number.POSITIVE_INFINITY;
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  return left.sourceTraceId.localeCompare(right.sourceTraceId);
}

function normalizedDistance(left: number | null, right: number | null, scale: number) {
  return left === null || right === null
    ? null
    : Math.min(1, Math.abs(left - right) / scale);
}

function logDistance(left: number | null, right: number | null) {
  return left === null || right === null || left < 0 || right < 0
    ? null
    : Math.min(1, Math.abs(Math.log1p(left) - Math.log1p(right)) / 10);
}

function normalizeDirection(value: unknown): NexusBrainMemoryCase["direction"] {
  const normalized = clean(value).toUpperCase();
  return normalized === "LONG" || normalized === "SHORT"
    ? normalized
    : "UNKNOWN";
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isoOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function integer(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : fallback;
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}
