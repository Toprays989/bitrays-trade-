export const NEXUS_OPPORTUNITY_LIFECYCLE_VERSION =
  "nexus-opportunity-lifecycle-v1" as const;

export type NexusOpportunityDecisionLane =
  | "CONFIRMED_ENTRY"
  | "EXPLORATION_PROBE"
  | "SHADOW_SKIP";

export type NexusOpportunityOutcome =
  | "TRADE_PROFIT"
  | "TRADE_LOSS"
  | "TRADE_BREAK_EVEN"
  | "SKIP_WOULD_PROFIT"
  | "SKIP_WOULD_LOSS"
  | "SKIP_INCONCLUSIVE"
  | "OPEN"
  | "UNKNOWN";

export type NexusLifecycleAttributionCode =
  | "DIRECTION_WRONG"
  | "ENTRY_TOO_EARLY"
  | "ENTRY_CHASED"
  | "PROFIT_GIVEBACK"
  | "POSITION_MANAGEMENT_CONTRADICTED"
  | "MISSED_OPPORTUNITY"
  | "CORRECT_FILTER"
  | "DATA_INCOMPLETE";

export type NexusOpportunityPathMetrics = {
  sampleCount: number;
  observedMinutes: number[];
  firstProfitMinute: number | null;
  maximumFavorableExcursionRoePercent: number | null;
  maximumAdverseExcursionRoePercent: number | null;
  minuteOfMaximumFavorableExcursion: number | null;
  peakGivebackRoePoints: number | null;
  capitalOccupancyMinutes: number | null;
};

export type NexusOpportunityLifecycleResult = {
  version: typeof NEXUS_OPPORTUNITY_LIFECYCLE_VERSION;
  decisionLane: NexusOpportunityDecisionLane;
  outcome: NexusOpportunityOutcome;
  terminal: {
    status: "OPEN" | "CLOSED" | "REJECTED";
    exactNetAvailable: boolean;
    exactNetPnlUsdt: number | null;
    finalExitReason: string | null;
  };
  pathMetrics: NexusOpportunityPathMetrics;
  attributionCodes: NexusLifecycleAttributionCode[];
  unresolvedAttributions: string[];
  summary: string;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
};

export type NexusOpportunityLifecycleSummary = {
  sampleCount: number;
  confirmedEntries: number;
  explorationProbes: number;
  shadowSkips: number;
  tradeProfits: number;
  tradeLosses: number;
  missedOpportunities: number;
  correctFilters: number;
  openOrUnknown: number;
  averageMfeRoePercent: number | null;
  averageMaeRoePercent: number | null;
  averagePeakGivebackRoePoints: number | null;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
};

type Checkpoint = {
  minuteOffset: number;
  roePercent?: number | null;
  mfeRoePercent?: number | null;
  maeRoePercent?: number | null;
};

/**
 * 用同一口径复盘实盘、最小学习探针和未下单影子路径。
 * 结果只进入学习记忆，不直接改变订单或生产参数。
 */
export function buildNexusOpportunityLifecycle(input: {
  decisionLane: NexusOpportunityDecisionLane;
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED";
  exactNetPnlUsdt?: number | null;
  exactNetAvailable?: boolean;
  causalAttributionReady: boolean;
  checkpoints: Checkpoint[];
  holdingDurationMinutes?: number | null;
  waveDirectionVerdict?: string | null;
  waveEntryTimingVerdict?: string | null;
  positionManagementStatus?: string | null;
  finalExitReason?: string | null;
}): NexusOpportunityLifecycleResult {
  const checkpoints = normalizeCheckpoints(input.checkpoints);
  const pathMetrics = buildPathMetrics(
    checkpoints,
    input.holdingDurationMinutes,
  );
  const exactNetPnl = finiteOrNull(input.exactNetPnlUsdt);
  const exactNetAvailable =
    input.exactNetAvailable === true && exactNetPnl !== null;
  const latestRoe = checkpoints.at(-1)?.roePercent ?? null;
  const outcome = classifyOutcome({
    decisionLane: input.decisionLane,
    terminalStatus: input.terminalStatus,
    exactNetAvailable,
    exactNetPnlUsdt: exactNetPnl,
    latestRoePercent: latestRoe,
  });
  const attributionCodes = classifyAttributions({
    outcome,
    causalAttributionReady: input.causalAttributionReady,
    waveDirectionVerdict: input.waveDirectionVerdict,
    waveEntryTimingVerdict: input.waveEntryTimingVerdict,
    positionManagementStatus: input.positionManagementStatus,
    peakGivebackRoePoints: pathMetrics.peakGivebackRoePoints,
  });
  const unresolvedAttributions = [
    input.causalAttributionReady ? null : "因果事实不完整，不能把结果倒灌为原因",
    input.terminalStatus === "OPEN" ? "仓位尚未结束，退出时机仍待验证" : null,
    "补仓是否有效必须由独立补仓事件与补仓后路径验证",
    "退出是否过早必须有平仓后的反事实价格路径才能判断",
  ].filter((value): value is string => Boolean(value));
  return {
    version: NEXUS_OPPORTUNITY_LIFECYCLE_VERSION,
    decisionLane: input.decisionLane,
    outcome,
    terminal: {
      status: input.terminalStatus,
      exactNetAvailable,
      exactNetPnlUsdt: exactNetAvailable ? exactNetPnl : null,
      finalExitReason: cleanOrNull(input.finalExitReason),
    },
    pathMetrics,
    attributionCodes,
    unresolvedAttributions,
    summary: lifecycleSummary(input.decisionLane, outcome, pathMetrics),
    orderAffecting: false,
    liveConfigMutationAllowed: false,
  };
}

export function summarizeNexusOpportunityLifecycles(
  rows: Array<NexusOpportunityLifecycleResult | null | undefined>,
): NexusOpportunityLifecycleSummary {
  const valid = rows.filter(
    (row): row is NexusOpportunityLifecycleResult =>
      row?.version === NEXUS_OPPORTUNITY_LIFECYCLE_VERSION,
  );
  const countLane = (lane: NexusOpportunityDecisionLane) =>
    valid.filter((row) => row.decisionLane === lane).length;
  const countOutcome = (outcome: NexusOpportunityOutcome) =>
    valid.filter((row) => row.outcome === outcome).length;
  return {
    sampleCount: valid.length,
    confirmedEntries: countLane("CONFIRMED_ENTRY"),
    explorationProbes: countLane("EXPLORATION_PROBE"),
    shadowSkips: countLane("SHADOW_SKIP"),
    tradeProfits: countOutcome("TRADE_PROFIT"),
    tradeLosses: countOutcome("TRADE_LOSS"),
    missedOpportunities: countOutcome("SKIP_WOULD_PROFIT"),
    correctFilters: countOutcome("SKIP_WOULD_LOSS"),
    openOrUnknown: valid.filter((row) =>
      ["OPEN", "UNKNOWN", "SKIP_INCONCLUSIVE"].includes(row.outcome)
    ).length,
    averageMfeRoePercent: average(
      valid.map(
        (row) => row.pathMetrics.maximumFavorableExcursionRoePercent,
      ),
    ),
    averageMaeRoePercent: average(
      valid.map((row) => row.pathMetrics.maximumAdverseExcursionRoePercent),
    ),
    averagePeakGivebackRoePoints: average(
      valid.map((row) => row.pathMetrics.peakGivebackRoePoints),
    ),
    orderAffecting: false,
    liveConfigMutationAllowed: false,
  };
}

function normalizeCheckpoints(checkpoints: Checkpoint[]) {
  return checkpoints
    .map((checkpoint) => ({
      minuteOffset: Math.max(0, Math.trunc(Number(checkpoint.minuteOffset))),
      roePercent: finiteOrNull(checkpoint.roePercent),
      mfeRoePercent: finiteOrNull(checkpoint.mfeRoePercent),
      maeRoePercent: finiteOrNull(checkpoint.maeRoePercent),
    }))
    .filter((checkpoint) => checkpoint.minuteOffset > 0)
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
}

function buildPathMetrics(
  checkpoints: ReturnType<typeof normalizeCheckpoints>,
  holdingDurationMinutes: unknown,
): NexusOpportunityPathMetrics {
  const roeRows = checkpoints.filter(
    (checkpoint) => checkpoint.roePercent !== null,
  );
  const mfeRows = checkpoints.filter(
    (checkpoint) => checkpoint.mfeRoePercent !== null,
  );
  const maeRows = checkpoints.filter(
    (checkpoint) => checkpoint.maeRoePercent !== null,
  );
  const maximumFavorable = mfeRows.length
    ? Math.max(...mfeRows.map((checkpoint) => checkpoint.mfeRoePercent!))
    : roeRows.length
      ? Math.max(...roeRows.map((checkpoint) => checkpoint.roePercent!))
      : null;
  const maximumAdverse = maeRows.length
    ? Math.min(...maeRows.map((checkpoint) => checkpoint.maeRoePercent!))
    : roeRows.length
      ? Math.min(...roeRows.map((checkpoint) => checkpoint.roePercent!))
      : null;
  const mfeMinute = maximumFavorable === null
    ? null
    : (mfeRows.length ? mfeRows : roeRows).find((checkpoint) =>
        (checkpoint.mfeRoePercent ?? checkpoint.roePercent) === maximumFavorable
      )?.minuteOffset ?? null;
  const latestRoe = roeRows.at(-1)?.roePercent ?? null;
  const holding = finiteOrNull(holdingDurationMinutes);
  return {
    sampleCount: checkpoints.length,
    observedMinutes: checkpoints.map((checkpoint) => checkpoint.minuteOffset),
    firstProfitMinute:
      roeRows.find((checkpoint) => checkpoint.roePercent! > 0)?.minuteOffset ??
      null,
    maximumFavorableExcursionRoePercent: maximumFavorable,
    maximumAdverseExcursionRoePercent: maximumAdverse,
    minuteOfMaximumFavorableExcursion: mfeMinute,
    peakGivebackRoePoints:
      maximumFavorable !== null && latestRoe !== null
        ? round(Math.max(0, maximumFavorable - latestRoe))
        : null,
    capitalOccupancyMinutes:
      holding !== null && holding >= 0
        ? round(holding)
        : checkpoints.at(-1)?.minuteOffset ?? null,
  };
}

function classifyOutcome(input: {
  decisionLane: NexusOpportunityDecisionLane;
  terminalStatus: "OPEN" | "CLOSED" | "REJECTED";
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  latestRoePercent: number | null;
}): NexusOpportunityOutcome {
  if (input.terminalStatus === "OPEN") return "OPEN";
  if (input.decisionLane === "SHADOW_SKIP") {
    if (input.latestRoePercent === null) return "SKIP_INCONCLUSIVE";
    if (input.latestRoePercent > 0.1) return "SKIP_WOULD_PROFIT";
    if (input.latestRoePercent < -0.1) return "SKIP_WOULD_LOSS";
    return "SKIP_INCONCLUSIVE";
  }
  if (!input.exactNetAvailable || input.exactNetPnlUsdt === null)
    return "UNKNOWN";
  if (input.exactNetPnlUsdt > 1e-8) return "TRADE_PROFIT";
  if (input.exactNetPnlUsdt < -1e-8) return "TRADE_LOSS";
  return "TRADE_BREAK_EVEN";
}

function classifyAttributions(input: {
  outcome: NexusOpportunityOutcome;
  causalAttributionReady: boolean;
  waveDirectionVerdict?: string | null;
  waveEntryTimingVerdict?: string | null;
  positionManagementStatus?: string | null;
  peakGivebackRoePoints: number | null;
}) {
  const codes: NexusLifecycleAttributionCode[] = [];
  if (!input.causalAttributionReady) codes.push("DATA_INCOMPLETE");
  if (input.waveDirectionVerdict === "INVALIDATED")
    codes.push("DIRECTION_WRONG");
  if (input.waveEntryTimingVerdict === "TOO_EARLY")
    codes.push("ENTRY_TOO_EARLY");
  if (input.waveEntryTimingVerdict === "CHASED") codes.push("ENTRY_CHASED");
  if (
    input.peakGivebackRoePoints !== null &&
    input.peakGivebackRoePoints >= 3
  ) codes.push("PROFIT_GIVEBACK");
  if (input.positionManagementStatus === "CONTRADICTED")
    codes.push("POSITION_MANAGEMENT_CONTRADICTED");
  if (input.outcome === "SKIP_WOULD_PROFIT") codes.push("MISSED_OPPORTUNITY");
  if (input.outcome === "SKIP_WOULD_LOSS") codes.push("CORRECT_FILTER");
  return [...new Set(codes)];
}

function lifecycleSummary(
  lane: NexusOpportunityDecisionLane,
  outcome: NexusOpportunityOutcome,
  metrics: NexusOpportunityPathMetrics,
) {
  const laneLabel = lane === "CONFIRMED_ENTRY"
    ? "确认实盘"
    : lane === "EXPLORATION_PROBE"
      ? "最小学习探针"
      : "未下单影子路径";
  const outcomeLabel: Record<NexusOpportunityOutcome, string> = {
    TRADE_PROFIT: "最终净盈利",
    TRADE_LOSS: "最终净亏损",
    TRADE_BREAK_EVEN: "最终接近盈亏平衡",
    SKIP_WOULD_PROFIT: "后续路径显示错过机会",
    SKIP_WOULD_LOSS: "后续路径证明过滤正确",
    SKIP_INCONCLUSIVE: "后续路径不足以评价跳过决定",
    OPEN: "周期仍在持仓或观察中",
    UNKNOWN: "终局净结果暂不可用",
  };
  return `${laneLabel}：${outcomeLabel[outcome]}；样本 ${metrics.sampleCount} 个，` +
    `MFE ${format(metrics.maximumFavorableExcursionRoePercent)}%，` +
    `MAE ${format(metrics.maximumAdverseExcursionRoePercent)}%，` +
    `峰值回吐 ${format(metrics.peakGivebackRoePoints)} 个ROE点。`;
}

function finiteOrNull(value: unknown) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function cleanOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function format(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

function average(values: Array<number | null>) {
  const finiteValues = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  return finiteValues.length
    ? round(
        finiteValues.reduce((sum, value) => sum + value, 0) /
          finiteValues.length,
      )
    : null;
}
