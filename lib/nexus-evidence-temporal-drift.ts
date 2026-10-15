import type {
  NexusLearningCycle,
  NexusLearningLane,
} from "./nexus-learning-cycle.ts";
import {
  NEXUS_EVIDENCE_DIMENSIONS,
  nexusEvidenceVerdict,
  type NexusEvidenceDimension,
} from "./nexus-evidence-reliability-memory.ts";

export const NEXUS_EVIDENCE_TEMPORAL_DRIFT_VERSION =
  "nexus-evidence-temporal-drift-v1" as const;

type ResolvedVerdict = "SUPPORTED" | "CONTRADICTED";

export type NexusEvidenceTemporalDriftItem = {
  evidenceDimension: NexusEvidenceDimension;
  status:
    | "RECENTLY_WEAKENED"
    | "RECENTLY_RECOVERED"
    | "STABLE_SUPPORTED"
    | "STABLE_CONTRADICTED"
    | "RECENTLY_MIXED"
    | "INSUFFICIENT_HISTORY";
  baselineResolvedCycles: number;
  recentResolvedCycles: number;
  baselineSupportRate: number | null;
  recentSupportRate: number | null;
  supportRateChange: number | null;
  baselineExactNetPnlUsdt: number;
  recentExactNetPnlUsdt: number;
  baselineFrom: string | null;
  baselineTo: string | null;
  recentFrom: string | null;
  recentTo: string | null;
  summary: string;
};

export type NexusEvidenceTemporalDrift = {
  version: typeof NEXUS_EVIDENCE_TEMPORAL_DRIFT_VERSION;
  brainKey: string;
  configVersion: number;
  direction: "LONG" | "SHORT";
  learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
  marketContextKey: string;
  status:
    | "RECENT_WEAKENING_DETECTED"
    | "RECENT_RECOVERY_DETECTED"
    | "RECENTLY_STABLE"
    | "MIXED_OR_INSUFFICIENT";
  items: NexusEvidenceTemporalDriftItem[];
  weakenedDimensions: number;
  recoveredDimensions: number;
  stableDimensions: number;
  mixedDimensions: number;
  insufficientDimensions: number;
  displayValue: string;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

/**
 * 在完全相同的市场环境内，按真实时间比较较早窗口与近期窗口，识别
 * “以前有效、近期失效”和“以前失效、近期恢复”。不同市场环境不在
 * 这里混合，防止环境切换被误判成证据漂移。本结果只供学习与运营解释。
 */
export function buildNexusEvidenceTemporalDrift(input: {
  target: {
    brainKey: string;
    configVersion: number;
    direction: "LONG" | "SHORT";
    learningLane: Exclude<NexusLearningLane, "OBSERVATION">;
    marketContextKey: string;
  };
  samples: Array<{
    cycle: NexusLearningCycle;
    observedAt: Date | string | number;
    marketContextKey?: string | null;
  }>;
  minimumResolvedCyclesPerWindow?: number;
  windowSize?: number;
  materialSupportRateChange?: number;
}): NexusEvidenceTemporalDrift {
  const minimumResolvedCyclesPerWindow = Math.max(
    3,
    integer(input.minimumResolvedCyclesPerWindow ?? 3),
  );
  const windowSize = Math.max(
    minimumResolvedCyclesPerWindow,
    Math.min(20, integer(input.windowSize ?? 5)),
  );
  const materialSupportRateChange = clamp(
    input.materialSupportRateChange ?? 0.4,
    0.25,
    0.75,
  );
  const targetContextKnown = fullyKnownMarketContext(
    input.target.marketContextKey,
  );
  const isolated = deduplicate(
    input.samples.filter((sample) => {
      const cycle = sample.cycle;
      const direction = cycle.memoryCase?.direction;
      const retrospective = cycle.retrospective;
      const exactNetPnlUsdt = Number(cycle.exactNetPnlUsdt);
      return targetContextKnown &&
        cycle.feedback.aggregateLearningEligible &&
        cycle.learningLane !== "OBSERVATION" &&
        retrospective?.status === "COMPLETE" &&
        retrospective.causalAttributionReady === true &&
        Number.isFinite(exactNetPnlUsdt) &&
        cycle.brainKey === input.target.brainKey &&
        cycle.configVersion === input.target.configVersion &&
        direction === input.target.direction &&
        cycle.learningLane === input.target.learningLane &&
        clean(sample.marketContextKey) ===
          clean(input.target.marketContextKey) &&
        validTimestamp(sample.observedAt) !== null;
    }),
  );

  const items = NEXUS_EVIDENCE_DIMENSIONS.map((evidenceDimension) =>
    temporalItem({
      evidenceDimension,
      samples: isolated,
      minimumResolvedCyclesPerWindow,
      windowSize,
      materialSupportRateChange,
    })
  );
  const weakenedDimensions = countStatus(items, "RECENTLY_WEAKENED");
  const recoveredDimensions = countStatus(items, "RECENTLY_RECOVERED");
  const stableDimensions = countStatus(items, "STABLE_SUPPORTED") +
    countStatus(items, "STABLE_CONTRADICTED");
  const mixedDimensions = countStatus(items, "RECENTLY_MIXED");
  const insufficientDimensions = countStatus(items, "INSUFFICIENT_HISTORY");
  const status = weakenedDimensions > 0
    ? "RECENT_WEAKENING_DETECTED" as const
    : recoveredDimensions > 0
      ? "RECENT_RECOVERY_DETECTED" as const
      : stableDimensions > 0
        ? "RECENTLY_STABLE" as const
        : "MIXED_OR_INSUFFICIENT" as const;
  const weakenedLabels = items
    .filter((item) => item.status === "RECENTLY_WEAKENED")
    .map((item) => evidenceLabel(item.evidenceDimension));
  const recoveredLabels = items
    .filter((item) => item.status === "RECENTLY_RECOVERED")
    .map((item) => evidenceLabel(item.evidenceDimension));

  return {
    version: NEXUS_EVIDENCE_TEMPORAL_DRIFT_VERSION,
    brainKey: input.target.brainKey,
    configVersion: input.target.configVersion,
    direction: input.target.direction,
    learningLane: input.target.learningLane,
    marketContextKey: input.target.marketContextKey,
    status,
    items,
    weakenedDimensions,
    recoveredDimensions,
    stableDimensions,
    mixedDimensions,
    insufficientDimensions,
    displayValue:
      `近期减弱 ${weakenedDimensions} / 恢复 ${recoveredDimensions} / ` +
      `稳定 ${stableDimensions}`,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    summary: weakenedDimensions > 0
      ? `相同市场环境中发现 ${weakenedDimensions} 类证据近期减弱：` +
        `${weakenedLabels.join("、")}。保留历史但降低运营解释优先级；` +
        "该结论不直接拒单、平仓或自动改参。"
      : recoveredDimensions > 0
        ? `相同市场环境中发现 ${recoveredDimensions} 类证据近期恢复：` +
          `${recoveredLabels.join("、")}。继续观察独立周期确认，不直接放行订单或自动改参。`
        : stableDimensions > 0
          ? `相同市场环境内已有 ${stableDimensions} 类证据在早期与近期窗口方向一致；` +
            "只作为时效稳定性说明，不参与订单和仓位动作。"
          : "相同市场环境内尚不足以形成不重叠的早期与近期窗口，继续采集完整周期。",
  };
}

function temporalItem(input: {
  evidenceDimension: NexusEvidenceDimension;
  samples: Array<{
    cycle: NexusLearningCycle;
    observedAt: Date | string | number;
    marketContextKey?: string | null;
  }>;
  minimumResolvedCyclesPerWindow: number;
  windowSize: number;
  materialSupportRateChange: number;
}): NexusEvidenceTemporalDriftItem {
  const resolved = input.samples
    .map((sample) => ({
      sample,
      verdict: nexusEvidenceVerdict(
        input.evidenceDimension,
        sample.cycle.retrospective!.hypotheses,
      ),
      timestamp: validTimestamp(sample.observedAt)!,
    }))
    .filter(
      (item): item is typeof item & { verdict: ResolvedVerdict } =>
        item.verdict === "SUPPORTED" || item.verdict === "CONTRADICTED",
    )
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        clean(left.sample.cycle.learningKey).localeCompare(
          clean(right.sample.cycle.learningKey),
        ),
    );
  if (resolved.length < input.minimumResolvedCyclesPerWindow * 2)
    return insufficientItem(
      input.evidenceDimension,
      resolved.length,
      input.minimumResolvedCyclesPerWindow,
    );

  const balancedWindowSize = Math.min(
    input.windowSize,
    Math.floor(resolved.length / 2),
  );
  const recent = resolved.slice(-balancedWindowSize);
  const baseline = resolved.slice(
    resolved.length - balancedWindowSize * 2,
    resolved.length - recent.length,
  );
  if (
    recent.length < input.minimumResolvedCyclesPerWindow ||
    baseline.length < input.minimumResolvedCyclesPerWindow
  )
    return insufficientItem(
      input.evidenceDimension,
      resolved.length,
      input.minimumResolvedCyclesPerWindow,
    );

  const baselineSupportRate = supportRate(baseline);
  const recentSupportRate = supportRate(recent);
  const supportRateChange = round(recentSupportRate - baselineSupportRate);
  const weakened =
    supportRateChange <= -input.materialSupportRateChange &&
    baselineSupportRate >= 2 / 3 &&
    recentSupportRate < 2 / 3;
  const recovered =
    supportRateChange >= input.materialSupportRateChange &&
    baselineSupportRate <= 1 / 3 &&
    recentSupportRate > 1 / 3;
  const stableSupported = baselineSupportRate >= 2 / 3 &&
    recentSupportRate >= 2 / 3 &&
    Math.abs(supportRateChange) < input.materialSupportRateChange;
  const stableContradicted = baselineSupportRate <= 1 / 3 &&
    recentSupportRate <= 1 / 3 &&
    Math.abs(supportRateChange) < input.materialSupportRateChange;
  const status = weakened
    ? "RECENTLY_WEAKENED" as const
    : recovered
      ? "RECENTLY_RECOVERED" as const
      : stableSupported
        ? "STABLE_SUPPORTED" as const
        : stableContradicted
          ? "STABLE_CONTRADICTED" as const
          : "RECENTLY_MIXED" as const;
  const baselineExactNetPnlUsdt = netPnl(baseline);
  const recentExactNetPnlUsdt = netPnl(recent);
  const window = (rows: typeof resolved) => ({
    from: iso(rows[0]?.timestamp),
    to: iso(rows.at(-1)?.timestamp),
  });
  const baselineWindow = window(baseline);
  const recentWindow = window(recent);

  return {
    evidenceDimension: input.evidenceDimension,
    status,
    baselineResolvedCycles: baseline.length,
    recentResolvedCycles: recent.length,
    baselineSupportRate,
    recentSupportRate,
    supportRateChange,
    baselineExactNetPnlUsdt,
    recentExactNetPnlUsdt,
    baselineFrom: baselineWindow.from,
    baselineTo: baselineWindow.to,
    recentFrom: recentWindow.from,
    recentTo: recentWindow.to,
    summary:
      `${evidenceLabel(input.evidenceDimension)}：早期 ${baseline.length} 个周期支持率 ` +
      `${percent(baselineSupportRate)}、净结果 ${signed(baselineExactNetPnlUsdt)} USDT；` +
      `近期 ${recent.length} 个周期支持率 ${percent(recentSupportRate)}、` +
      `净结果 ${signed(recentExactNetPnlUsdt)} USDT；${statusLabel(status)}。`,
  };
}

function deduplicate(
  samples: Array<{
    cycle: NexusLearningCycle;
    observedAt: Date | string | number;
    marketContextKey?: string | null;
  }>,
) {
  const byLearningKey = new Map<string, (typeof samples)[number]>();
  for (const sample of samples) {
    const learningKey = clean(sample.cycle.learningKey) || [
      sample.cycle.brainKey,
      sample.cycle.configVersion,
      sample.cycle.traceId,
      sample.cycle.path,
    ].join(":");
    const existing = byLearningKey.get(learningKey);
    if (
      !existing ||
      (validTimestamp(sample.observedAt) ?? 0) >
        (validTimestamp(existing.observedAt) ?? 0)
    ) byLearningKey.set(learningKey, sample);
  }
  return [...byLearningKey.values()];
}

function insufficientItem(
  evidenceDimension: NexusEvidenceDimension,
  resolvedCycles: number,
  minimumPerWindow: number,
): NexusEvidenceTemporalDriftItem {
  return {
    evidenceDimension,
    status: "INSUFFICIENT_HISTORY",
    baselineResolvedCycles: Math.min(resolvedCycles, minimumPerWindow),
    recentResolvedCycles: Math.max(0, resolvedCycles - minimumPerWindow),
    baselineSupportRate: null,
    recentSupportRate: null,
    supportRateChange: null,
    baselineExactNetPnlUsdt: 0,
    recentExactNetPnlUsdt: 0,
    baselineFrom: null,
    baselineTo: null,
    recentFrom: null,
    recentTo: null,
    summary:
      `${evidenceLabel(evidenceDimension)}只有 ${resolvedCycles} 个可判定周期；` +
      `至少需要两个互不重叠、各 ${minimumPerWindow} 个周期的时间窗口。`,
  };
}

function supportRate(
  values: Array<{ verdict: ResolvedVerdict }>,
) {
  return round(
    values.filter((item) => item.verdict === "SUPPORTED").length /
      values.length,
  );
}

function netPnl(
  values: Array<{ sample: { cycle: NexusLearningCycle } }>,
) {
  return round(
    values.reduce(
      (total, item) =>
        total + (Number(item.sample.cycle.exactNetPnlUsdt) || 0),
      0,
    ),
  );
}

function countStatus(
  items: NexusEvidenceTemporalDriftItem[],
  status: NexusEvidenceTemporalDriftItem["status"],
) {
  return items.filter((item) => item.status === status).length;
}

function evidenceLabel(value: NexusEvidenceDimension) {
  if (value === "WAVE_DIRECTION") return "波段方向证据";
  if (value === "ENTRY_TIMING") return "入场时机证据";
  if (value === "POSITION_MANAGEMENT") return "持仓管理证据";
  if (value === "FUNDING_VOLUME") return "费率与成交量证据";
  return "入场量价时序证据";
}

function statusLabel(value: NexusEvidenceTemporalDriftItem["status"]) {
  if (value === "RECENTLY_WEAKENED") return "近期明显减弱";
  if (value === "RECENTLY_RECOVERED") return "近期明显恢复";
  if (value === "STABLE_SUPPORTED") return "持续得到支持";
  if (value === "STABLE_CONTRADICTED") return "持续受到反证";
  return "近期结果混合";
}

function validTimestamp(value: Date | string | number) {
  const parsed = value instanceof Date
    ? value.getTime()
    : new Date(value).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function fullyKnownMarketContext(value: unknown) {
  const expected = ["TREND", "VOL", "LIQ", "FLOW", "STRESS", "TEMP"];
  const parsed = new Map<string, string>();
  for (const segment of clean(value).split("|")) {
    const split = segment.indexOf("_");
    if (split <= 0) continue;
    parsed.set(
      segment.slice(0, split).trim().toUpperCase(),
      segment.slice(split + 1).trim().toUpperCase(),
    );
  }
  return expected.every((dimension) => {
    const state = parsed.get(dimension);
    return Boolean(state && state !== "UNKNOWN" && state !== "UNAVAILABLE");
  });
}

function iso(value: number | undefined) {
  return Number.isFinite(value) ? new Date(value!).toISOString() : null;
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

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(4)}`;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}
