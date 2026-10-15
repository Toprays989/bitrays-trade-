import type { LiquidationTrendConfig } from "./liquidation-trend-config";

export const NEXUS_EXPERIENCE_CONSUMPTION_VERSION =
  "nexus-experience-consumption-v1" as const;
export const NEXUS_EXPERIENCE_MIN_EXACT_SAMPLES = 5;

export type ReviewedLearningExperience = {
  learningKey: string;
  decision: string;
  promotionStatus: string;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  eligibility: string;
  manualIntervention: boolean;
  detailJson: string;
  reviewedAtMs?: number | null;
};

export function buildNexusExperienceParameterSuggestions(input: {
  config: LiquidationTrendConfig;
  experiences: ReviewedLearningExperience[];
  failedCandidates?: Array<{
    parameterName: string;
    suggestedValue: unknown;
    failedAtMs?: number | null;
  }>;
  minimumSamples?: number;
}) {
  const minimumSamples = Math.max(
    3,
    Math.trunc(
      Number.isFinite(input.minimumSamples)
        ? Number(input.minimumSamples)
        : NEXUS_EXPERIENCE_MIN_EXACT_SAMPLES,
    ),
  );
  const eligible = input.experiences.flatMap((experience) => {
    const detail = recordFromJson(experience.detailJson);
    const feedback = record(detail.feedback);
    if (
      experience.decision !== "CONFIRMED" ||
      experience.promotionStatus !== "PROMOTED" ||
      experience.exactNetAvailable !== true ||
      !Number.isFinite(experience.exactNetPnlUsdt) ||
      experience.eligibility !== "ELIGIBLE" ||
      experience.manualIntervention === true ||
      feedback.aggregateLearningEligible !== true
    ) return [];
    return [{
      learningKey: experience.learningKey,
      pnl: Number(experience.exactNetPnlUsdt),
      positive: stringArray(feedback.positiveEvidence),
      corrective: stringArray(feedback.correctiveEvidence),
      reviewedAtMs: Number(experience.reviewedAtMs ?? 0),
    }];
  });
  if (eligible.length < minimumSamples) return [];

  const candidates = [
    candidate({
      key: "DIRECTION_CONTRADICTED",
      tags: ["WAVE_DIRECTION_CONTRADICTED"],
      parameterName: "trend.volumeRatio3m",
      label: "3分钟成交量确认",
      currentValue: input.config.trend.volumeRatio3m,
      suggestedValue: round(
        Math.min(10, input.config.trend.volumeRatio3m + 0.1),
        2,
      ),
      action: "TIGHTEN",
      explanation: "方向被后续量价结构否定，先小幅提高真实成交量确认门槛",
      requireNegativeNet: true,
    }),
    candidate({
      key: "ENTRY_TOO_EARLY",
      tags: ["ENTRY_TIMING_TOO_EARLY"],
      parameterName: "trend.volumeRatio3m",
      label: "入场时机成交量确认",
      currentValue: input.config.trend.volumeRatio3m,
      suggestedValue: round(
        Math.min(10, input.config.trend.volumeRatio3m + 0.1),
        2,
      ),
      action: "TIGHTEN",
      explanation: "方向后来成立但入场偏早，等待更明确的量能进入再触发",
      requireNegativeNet: true,
    }),
    candidate({
      key: "ENTRY_CHASED",
      tags: ["ENTRY_TIMING_CHASED"],
      parameterName: "trend.maxEntryDistanceAtr",
      label: "最大入场距离",
      currentValue: input.config.trend.maxEntryDistanceAtr,
      suggestedValue: round(
        Math.max(0.1, input.config.trend.maxEntryDistanceAtr * 0.9),
        2,
      ),
      action: "TIGHTEN",
      explanation: "已确认样本反复出现追价，缩短允许的ATR入场距离",
      requireNegativeNet: true,
    }),
    input.config.risk.positionManagement?.tailWaveExitEnabled === true
      ? candidate({
          key: "TRAILING_EXIT_PATH_EARLY",
          tags: [
            "TRAILING_STOP_PATH_EARLY",
            "POSITION_MANAGEMENT_CONTRADICTED",
          ],
          matchAll: true,
          parameterName:
            "risk.positionManagement.tailWaveObservationMinutes",
          label: "尾仓二次波段观察期",
          currentValue:
            input.config.risk.positionManagement
              .tailWaveObservationMinutes,
          suggestedValue: Math.min(
            30,
            input.config.risk.positionManagement
              .tailWaveObservationMinutes + 5,
          ),
          action: "LOOSEN",
          explanation:
            "移动止损退出后原方向仍延续，仅延长已启用尾仓的观察期；止损样本不会放宽移动保护",
          requireNegativeNet: false,
        })
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  if (!candidates.length) return [];
  candidates.sort(
    (left, right) =>
      right.priority - left.priority ||
      right.sampleCount - left.sampleCount ||
      left.parameterName.localeCompare(right.parameterName),
  );
  // One candidate version changes one parameter. This preserves causal
  // attribution and makes a failed live validation reversible.
  return [candidates[0]];

  function candidate(options: {
    key: string;
    tags: string[];
    matchAll?: boolean;
    parameterName: string;
    label: string;
    currentValue: number;
    suggestedValue: number;
    action: "TIGHTEN" | "LOOSEN";
    explanation: string;
    requireNegativeNet: boolean;
  }) {
    if (options.currentValue === options.suggestedValue) return null;
    const matched = eligible.filter((experience) =>
      options.matchAll
        ? options.tags.every((tag) => experience.corrective.includes(tag))
        : options.tags.some((tag) => experience.corrective.includes(tag))
    );
    if (matched.length < minimumSamples) return null;
    const failedCandidate = (input.failedCandidates ?? []).find(
      (failed) =>
        failed.parameterName === options.parameterName &&
        JSON.stringify(failed.suggestedValue) ===
          JSON.stringify(options.suggestedValue),
    );
    if (failedCandidate) {
      const failedAtMs = Number(failedCandidate.failedAtMs ?? 0);
      if (
        failedAtMs <= 0 ||
        matched.filter((experience) => experience.reviewedAtMs > failedAtMs)
            .length < minimumSamples
      ) return null;
    }
    const totalPnl = matched.reduce((sum, experience) => sum + experience.pnl, 0);
    const losses = matched.filter((experience) => experience.pnl < 0).length;
    if (options.requireNegativeNet && totalPnl >= 0) return null;
    const supportRate = matched.length / eligible.length;
    if (supportRate < 0.35) return null;
    const priority =
      Math.abs(Math.min(0, totalPnl)) * 100 +
      matched.length * 10 +
      supportRate;
    return {
      parameterName: options.parameterName,
      label: options.label,
      currentValue: options.currentValue,
      suggestedValue: options.suggestedValue,
      action: options.action,
      confidence: round(
        Math.min(0.9, matched.length / Math.max(minimumSamples * 2, 1)),
        2,
      ),
      reason:
        `${matched.length}/${eligible.length} 笔运营确认、费用后精确、因果完整的同版本经验支持该结论，` +
        `组内净收益 ${totalPnl.toFixed(4)} USDT、亏损 ${losses} 笔；${options.explanation}。` +
        "只生成单变量草稿，人工确认后进入小规模实盘验证；恶化自动回退。",
      experienceConsumption: {
        version: NEXUS_EXPERIENCE_CONSUMPTION_VERSION,
        diagnosis: options.key,
        sourceLearningKeys: matched.map((experience) => experience.learningKey),
        exactSampleCount: matched.length,
        totalExactNetPnlUsdt: round(totalPnl, 8),
        lossCount: losses,
        supportRate: round(supportRate, 4),
        oneVariableOnly: true as const,
        automaticPublishAllowed: false as const,
      },
      priority,
      sampleCount: matched.length,
    };
  }
}

function recordFromJson(value: string) {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function round(value: number, precision: number) {
  const scale = 10 ** precision;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
