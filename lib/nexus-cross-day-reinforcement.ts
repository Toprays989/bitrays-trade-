import type {
  NexusDailyReinforcement,
  NexusLearningLane,
} from "./nexus-learning-cycle.ts";

export const NEXUS_CROSS_DAY_REINFORCEMENT_VERSION =
  "nexus-cross-day-reinforcement-v1" as const;

export type NexusCrossDayReinforcement = {
  version: typeof NEXUS_CROSS_DAY_REINFORCEMENT_VERSION;
  marketContextKey: string;
  learningLane: NexusLearningLane;
  independentDays: number;
  minimumIndependentDays: number;
  asOfTradingDay: string;
  firstEvidenceTradingDay: string;
  lastEvidenceTradingDay: string;
  evidenceAgeDays: number;
  maximumEvidenceAgeDays: number;
  eligibleCycles: number;
  exactNetPnlUsdt: number;
  profitableDays: number;
  losingDays: number;
  flatDays: number;
  dayWinRate: number;
  averageDailyNetPnlUsdt: number;
  longestProfitableDayStreak: number;
  longestLosingDayStreak: number;
  maximumDailySequenceDrawdownUsdt: number;
  directionalConsistency: number;
  memoryConfidence: number;
  memoryFresh: boolean;
  memoryState: "ACTIVE" | "STALE" | "MIXED" | "INSUFFICIENT";
  signal:
    | "POSITIVE_REINFORCEMENT"
    | "CORRECTIVE_FEEDBACK"
    | "MIXED_OBSERVATION"
    | "AWAITING_INDEPENDENT_DAYS";
  memoryReady: boolean;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
  summary: string;
};

/**
 * 将已经完成单日独立样本门槛的结果，再按市场环境跨交易日复核。
 * 该层只形成长期记忆，防止某一天的偶然收益或亏损被误当稳定规律；
 * 不参与订单准入，也不能自动修改实盘参数。
 */
export function buildNexusCrossDayReinforcement(input: {
  daily: NexusDailyReinforcement[];
  minimumIndependentDays?: number;
  asOfTradingDay?: string;
  maximumEvidenceAgeDays?: number;
}): NexusCrossDayReinforcement[] {
  const minimumIndependentDays = Math.max(
    2,
    integer(input.minimumIndependentDays ?? 3),
  );
  const maximumEvidenceAgeDays = Math.max(
    1,
    integer(input.maximumEvidenceAgeDays ?? 14),
  );
  const latestAvailableTradingDay = input.daily
    .map((item) => validTradingDay(item.tradingDay))
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? "1970-01-01";
  const asOfTradingDay =
    validTradingDay(input.asOfTradingDay) ?? latestAvailableTradingDay;
  const groups = new Map<string, Map<string, NexusDailyReinforcement>>();
  for (const item of input.daily) {
    if (item.signal === "AWAITING_INDEPENDENT_SAMPLES") continue;
    const key = `${item.learningLane}:${item.marketContextKey}`;
    const byDay = groups.get(key) ?? new Map();
    const existing = byDay.get(item.tradingDay);
    if (!existing || item.eligibleCycles > existing.eligibleCycles)
      byDay.set(item.tradingDay, item);
    groups.set(key, byDay);
  }

  return [...groups.entries()]
    .map(([key, byDay]): NexusCrossDayReinforcement => {
      const split = key.indexOf(":");
      const learningLane = key.slice(0, split) as NexusLearningLane;
      const marketContextKey = key.slice(split + 1);
      const days = [...byDay.values()].sort((left, right) =>
        left.tradingDay.localeCompare(right.tradingDay)
      );
      const outcomes = days.map((item) => item.exactNetPnlUsdt);
      const exactNetPnlUsdt = rounded(sum(outcomes));
      const profitableDays = outcomes.filter((value) => value > 0).length;
      const losingDays = outcomes.filter((value) => value < 0).length;
      const flatDays = outcomes.length - profitableDays - losingDays;
      const decisiveDays = profitableDays + losingDays;
      const positiveDays = days.filter(
        (item) => item.signal === "POSITIVE_REINFORCEMENT",
      ).length;
      const correctiveDays = days.filter(
        (item) => item.signal === "CORRECTIVE_FEEDBACK",
      ).length;
      const enoughDays = days.length >= minimumIndependentDays;
      const signal = !enoughDays
        ? "AWAITING_INDEPENDENT_DAYS" as const
        : exactNetPnlUsdt > 0 &&
            profitableDays > losingDays &&
            positiveDays > correctiveDays
          ? "POSITIVE_REINFORCEMENT" as const
          : exactNetPnlUsdt < 0 ||
              losingDays > profitableDays ||
              correctiveDays > positiveDays
            ? "CORRECTIVE_FEEDBACK" as const
            : "MIXED_OBSERVATION" as const;
      const firstEvidenceTradingDay = days[0]?.tradingDay ?? "1970-01-01";
      const lastEvidenceTradingDay = days.at(-1)?.tradingDay ?? "1970-01-01";
      const evidenceAgeDays = Math.max(
        0,
        tradingDayDistance(lastEvidenceTradingDay, asOfTradingDay) ??
          maximumEvidenceAgeDays + 1,
      );
      const memoryFresh = evidenceAgeDays <= maximumEvidenceAgeDays;
      const supportingDays = signal === "POSITIVE_REINFORCEMENT"
        ? profitableDays
        : signal === "CORRECTIVE_FEEDBACK"
          ? losingDays
          : Math.max(profitableDays, losingDays);
      const directionalConsistency = rounded(
        decisiveDays ? supportingDays / decisiveDays : 0,
      );
      const recencyConfidence = rounded(
        Math.max(0, 1 - evidenceAgeDays / (maximumEvidenceAgeDays + 1)),
      );
      const memoryConfidence = rounded(
        Math.min(1, days.length / minimumIndependentDays) *
          directionalConsistency * recencyConfidence,
      );
      const dayWinRate = rounded(
        decisiveDays ? profitableDays / decisiveDays : 0,
      );
      const averageDailyNetPnlUsdt = days.length
        ? rounded(exactNetPnlUsdt / days.length)
        : 0;
      const longestProfitableDayStreak = longestStreak(
        outcomes,
        (value) => value > 0,
      );
      const longestLosingDayStreak = longestStreak(
        outcomes,
        (value) => value < 0,
      );
      const maximumDailySequenceDrawdownUsdt = rounded(
        maximumDrawdown(outcomes),
      );
      const memoryReady =
        enoughDays &&
        memoryFresh &&
        signal !== "MIXED_OBSERVATION" &&
        directionalConsistency >= 2 / 3;
      const memoryState = !enoughDays
        ? "INSUFFICIENT" as const
        : !memoryFresh
          ? "STALE" as const
          : signal === "MIXED_OBSERVATION" || directionalConsistency < 2 / 3
            ? "MIXED" as const
            : "ACTIVE" as const;
      return {
        version: NEXUS_CROSS_DAY_REINFORCEMENT_VERSION,
        marketContextKey,
        learningLane,
        independentDays: days.length,
        minimumIndependentDays,
        asOfTradingDay,
        firstEvidenceTradingDay,
        lastEvidenceTradingDay,
        evidenceAgeDays,
        maximumEvidenceAgeDays,
        eligibleCycles: days.reduce(
          (total, item) => total + item.eligibleCycles,
          0,
        ),
        exactNetPnlUsdt,
        profitableDays,
        losingDays,
        flatDays,
        dayWinRate,
        averageDailyNetPnlUsdt,
        longestProfitableDayStreak,
        longestLosingDayStreak,
        maximumDailySequenceDrawdownUsdt,
        directionalConsistency,
        memoryConfidence,
        memoryFresh,
        memoryState,
        signal,
        memoryReady,
        orderAffecting: false,
        liveConfigMutationAllowed: false,
        summary:
          `${marketContextKey} 已跨 ${days.length}/${minimumIndependentDays} 个独立交易日、` +
          `${days.reduce((total, item) => total + item.eligibleCycles, 0)} 个完整周期复核；` +
          `交易日胜率 ${percent(dayWinRate)}，日均净结果 ${averageDailyNetPnlUsdt.toFixed(4)} USDT，` +
          `最长连续盈利日 ${longestProfitableDayStreak}、连续亏损日 ${longestLosingDayStreak}，` +
          `跨日最大回撤 ${maximumDailySequenceDrawdownUsdt.toFixed(4)} USDT；` +
          `最近证据 ${lastEvidenceTradingDay}，距当前 ${evidenceAgeDays} 天，` +
          `方向一致性 ${percent(directionalConsistency)}，记忆置信度 ${percent(memoryConfidence)}。` +
          (memoryReady
            ? signal === "POSITIVE_REINFORCEMENT"
              ? "允许写入跨日正向记忆，但不直接改变实盘参数。"
              : "允许写入跨日纠偏记忆，但不直接改变实盘参数。"
            : memoryState === "STALE"
              ? "记忆已经过期，仅保留历史复盘，不向当前市场外推。"
              : "继续采集，不把单日结果外推为稳定规律。"),
      };
    })
    .sort(
      (left, right) =>
        right.independentDays - left.independentDays ||
        right.eligibleCycles - left.eligibleCycles ||
        left.marketContextKey.localeCompare(right.marketContextKey),
    );
}

function integer(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

function sum(values: number[]) {
  return values.reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0,
  );
}

function longestStreak(
  values: number[],
  matches: (value: number) => boolean,
) {
  let current = 0;
  let longest = 0;
  for (const value of values) {
    current = matches(value) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function maximumDrawdown(values: number[]) {
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum;
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function rounded(value: number, digits = 8) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function validTradingDay(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? text : null;
}

function tradingDayDistance(from: string, to: string) {
  const left = validTradingDay(from);
  const right = validTradingDay(to);
  if (!left || !right) return null;
  return Math.floor(
    (Date.parse(`${right}T00:00:00.000Z`) -
      Date.parse(`${left}T00:00:00.000Z`)) /
      86_400_000,
  );
}
