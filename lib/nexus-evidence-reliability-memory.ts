import type {
  NexusLearningCycle,
  NexusLearningLane,
} from "./nexus-learning-cycle.ts";

export const NEXUS_EVIDENCE_RELIABILITY_MEMORY_VERSION =
  "nexus-evidence-reliability-memory-v1" as const;

export type NexusEvidenceDimension =
  | "WAVE_DIRECTION"
  | "ENTRY_TIMING"
  | "POSITION_MANAGEMENT"
  | "FUNDING_VOLUME"
  | "ENTRY_VOLUME_TIMING";

export type NexusEvidenceReliabilityMemory = {
  version: typeof NEXUS_EVIDENCE_RELIABILITY_MEMORY_VERSION;
  brainKey: string;
  configVersion: number;
  direction: "LONG" | "SHORT";
  learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
  marketContextKey: string;
  evidenceDimension: NexusEvidenceDimension;
  independentCycles: number;
  resolvedCycles: number;
  supportedCycles: number;
  contradictedCycles: number;
  inconclusiveCycles: number;
  duplicateCyclesIgnored: number;
  exactNetPnlUsdt: number;
  winningCycles: number;
  losingCycles: number;
  signal:
    | "SUPPORTED_BY_HISTORY"
    | "CONTRADICTED_BY_HISTORY"
    | "MIXED_HISTORY"
    | "INSUFFICIENT_HISTORY";
  independentSampleThreshold: number;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

type EvidenceVerdict = "SUPPORTED" | "CONTRADICTED" | "INCONCLUSIVE";

/**
 * 把完整交易周期反推为“这类证据在当时环境中是否可靠”的记忆。
 *
 * 该记忆严格按大脑、发布版本、方向、正式/探针通道和市场环境隔离。
 * 它只进入复盘与运营建议，绝不直接授权订单、改变状态机或修改参数。
 */
export function buildNexusEvidenceReliabilityMemory(input: {
  samples: Array<{
    cycle: NexusLearningCycle;
    marketContextKey?: string | null;
  }>;
  independentSampleThreshold?: number;
}): NexusEvidenceReliabilityMemory[] {
  const independentSampleThreshold = Math.max(
    3,
    integer(input.independentSampleThreshold ?? 5),
  );
  const groups = new Map<
    string,
    {
      brainKey: string;
      configVersion: number;
      direction: "LONG" | "SHORT";
      learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
      marketContextKey: string;
      evidenceDimension: NexusEvidenceDimension;
      cycles: Map<
        string,
        { verdict: EvidenceVerdict; exactNetPnlUsdt: number }
      >;
      duplicateCyclesIgnored: number;
    }
  >();

  for (const sample of input.samples) {
    const cycle = sample.cycle;
    const retrospective = cycle.retrospective;
    const direction = cycle.memoryCase?.direction;
    const exactNetPnlUsdt = Number(cycle.exactNetPnlUsdt);
    if (
      !cycle.feedback.aggregateLearningEligible ||
      cycle.learningLane === "OBSERVATION" ||
      retrospective?.status !== "COMPLETE" ||
      retrospective.causalAttributionReady !== true ||
      !Number.isFinite(exactNetPnlUsdt) ||
      (direction !== "LONG" && direction !== "SHORT")
    )
      continue;

    const marketContextKey = clean(sample.marketContextKey) ||
      cycle.memoryCase?.marketContextKey ||
      "MARKET_CONTEXT_UNAVAILABLE";
    const learningLane = cycle.learningLane;
    const learningKey = clean(cycle.learningKey) ||
      `${cycle.brainKey}:${cycle.configVersion}:${cycle.traceId}:${cycle.path}`;
    for (const evidenceDimension of NEXUS_EVIDENCE_DIMENSIONS) {
      const key = [
        cycle.brainKey,
        cycle.configVersion,
        direction,
        learningLane,
        marketContextKey,
        evidenceDimension,
      ].join(":");
      const group = groups.get(key) ?? {
        brainKey: cycle.brainKey,
        configVersion: cycle.configVersion,
        direction,
        learningLane,
        marketContextKey,
        evidenceDimension,
        cycles: new Map(),
        duplicateCyclesIgnored: 0,
      };
      if (group.cycles.has(learningKey)) group.duplicateCyclesIgnored += 1;
      else
        group.cycles.set(learningKey, {
          verdict: nexusEvidenceVerdict(
            evidenceDimension,
            retrospective.hypotheses,
          ),
          exactNetPnlUsdt,
        });
      groups.set(key, group);
    }
  }

  return [...groups.values()]
    .map((group): NexusEvidenceReliabilityMemory => {
      const cycles = [...group.cycles.values()];
      const supportedCycles = cycles.filter(
        (item) => item.verdict === "SUPPORTED",
      ).length;
      const contradictedCycles = cycles.filter(
        (item) => item.verdict === "CONTRADICTED",
      ).length;
      const inconclusiveCycles = cycles.length - supportedCycles -
        contradictedCycles;
      const resolvedCycles = supportedCycles + contradictedCycles;
      const enoughSamples = resolvedCycles >= independentSampleThreshold;
      const signal = !enoughSamples
        ? "INSUFFICIENT_HISTORY" as const
        : supportedCycles >= contradictedCycles * 2
          ? "SUPPORTED_BY_HISTORY" as const
          : contradictedCycles >= supportedCycles * 2
            ? "CONTRADICTED_BY_HISTORY" as const
            : "MIXED_HISTORY" as const;
      const exactNetPnlUsdt = round(
        cycles.reduce((total, item) => total + item.exactNetPnlUsdt, 0),
      );
      const laneLabel = group.learningLane === "EXPLORATION_PROBE"
        ? "探针"
        : "正式策略";
      return {
        version: NEXUS_EVIDENCE_RELIABILITY_MEMORY_VERSION,
        brainKey: group.brainKey,
        configVersion: group.configVersion,
        direction: group.direction,
        learningLane: group.learningLane,
        marketContextKey: group.marketContextKey,
        evidenceDimension: group.evidenceDimension,
        independentCycles: cycles.length,
        resolvedCycles,
        supportedCycles,
        contradictedCycles,
        inconclusiveCycles,
        duplicateCyclesIgnored: group.duplicateCyclesIgnored,
        exactNetPnlUsdt,
        winningCycles: cycles.filter((item) => item.exactNetPnlUsdt > 0).length,
        losingCycles: cycles.filter((item) => item.exactNetPnlUsdt < 0).length,
        signal,
        independentSampleThreshold,
        orderAffecting: false,
        liveConfigMutationAllowed: false,
        summary:
          `${laneLabel} · ${group.direction} · ${group.marketContextKey} · ` +
          `${evidenceLabel(group.evidenceDimension)}：独立周期 ${cycles.length}，` +
          `可判定 ${resolvedCycles}/${independentSampleThreshold}，支持 ${supportedCycles}、` +
          `反证 ${contradictedCycles}、不确定 ${inconclusiveCycles}，` +
          `对应完整周期净结果 ${signed(exactNetPnlUsdt)} USDT；` +
          `${signalLabel(signal)}。该结论只描述相同环境下的历史证据可靠性，不直接参与下单或改参。`,
      };
    })
    .sort(
      (left, right) =>
        left.brainKey.localeCompare(right.brainKey) ||
        right.configVersion - left.configVersion ||
        left.direction.localeCompare(right.direction) ||
        left.learningLane.localeCompare(right.learningLane) ||
        right.resolvedCycles - left.resolvedCycles ||
        left.marketContextKey.localeCompare(right.marketContextKey) ||
        left.evidenceDimension.localeCompare(right.evidenceDimension),
    );
}

export const NEXUS_EVIDENCE_DIMENSIONS: NexusEvidenceDimension[] = [
  "WAVE_DIRECTION",
  "ENTRY_TIMING",
  "POSITION_MANAGEMENT",
  "FUNDING_VOLUME",
  "ENTRY_VOLUME_TIMING",
];

export function nexusEvidenceVerdict(
  dimension: NexusEvidenceDimension,
  hypotheses: NonNullable<NexusLearningCycle["retrospective"]>["hypotheses"],
): EvidenceVerdict {
  if (dimension === "WAVE_DIRECTION")
    return hypotheses.waveDirection === "SUPPORTED"
      ? "SUPPORTED"
      : hypotheses.waveDirection === "CONTRADICTED"
        ? "CONTRADICTED"
        : "INCONCLUSIVE";
  if (dimension === "ENTRY_TIMING")
    return hypotheses.entryTiming === "SUPPORTED"
      ? "SUPPORTED"
      : hypotheses.entryTiming === "TOO_EARLY" ||
          hypotheses.entryTiming === "CHASED"
        ? "CONTRADICTED"
        : "INCONCLUSIVE";
  if (dimension === "POSITION_MANAGEMENT")
    return hypotheses.positionManagement === "SUPPORTED"
      ? "SUPPORTED"
      : hypotheses.positionManagement === "CONTRADICTED"
        ? "CONTRADICTED"
        : "INCONCLUSIVE";
  if (dimension === "FUNDING_VOLUME")
    return hypotheses.fundingVolume === "SUPPORTED"
      ? "SUPPORTED"
      : hypotheses.fundingVolume === "RISK_WARNED"
        ? "CONTRADICTED"
        : "INCONCLUSIVE";
  return hypotheses.entryVolumeTiming === "SUPPORTED"
    ? "SUPPORTED"
    : "INCONCLUSIVE";
}

function evidenceLabel(dimension: NexusEvidenceDimension) {
  if (dimension === "WAVE_DIRECTION") return "波段方向证据";
  if (dimension === "ENTRY_TIMING") return "入场时机证据";
  if (dimension === "POSITION_MANAGEMENT") return "持仓管理证据";
  if (dimension === "FUNDING_VOLUME") return "费率与成交量证据";
  return "入场量价时序证据";
}

function signalLabel(signal: NexusEvidenceReliabilityMemory["signal"]) {
  if (signal === "SUPPORTED_BY_HISTORY") return "历史证据多数支持";
  if (signal === "CONTRADICTED_BY_HISTORY") return "历史证据多数反证";
  if (signal === "MIXED_HISTORY") return "历史结果存在分歧";
  return "独立可判定样本不足";
}

function integer(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(4)}`;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}
