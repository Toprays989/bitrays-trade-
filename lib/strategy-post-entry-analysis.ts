import type { LiquidationTrendConfig } from "./liquidation-trend-config";
import { normalizeLargeTraderConfirmation } from "./liquidation-trend-config.ts";
import {
  evaluateLiquidationWaveThesis,
  type WaveThesisOutcome,
} from "./liquidation-wave-thesis.ts";
import {
  evaluateCapitalWithdrawalExitShadow,
  type CapitalExitShadow,
} from "./post-entry-capital-exit-shadow.ts";
import {
  evaluatePositionManagementDecisionOutcome,
  summarizePositionManagementDecisionOutcomes,
  type PositionManagementDecisionOutcome,
} from "./position-management-decision-outcome.ts";
import { empiricalNetProfitability } from "./strategy-net-profitability.ts";
import { strategyPayoffProfile } from "./strategy-payoff.ts";
import {
  attributeWaveDirectionAndEntryTiming,
  type WaveDirectionVerdict,
  type WaveEntryTimingVerdict,
} from "./strategy-wave-entry-attribution.ts";
import {
  evaluateDeeperLimitCounterfactual,
  type DeeperLimitCounterfactual,
} from "./strategy-entry-counterfactual.ts";
import {
  evaluateDelayedReclaimCounterfactual,
  type DelayedReclaimCounterfactual,
} from "./strategy-delayed-reclaim-counterfactual.ts";
import { compareEntryPolicies } from "./strategy-entry-policy-comparison.ts";
import {
  analyzePostEntryLongHold,
  type PostEntryLongHoldAnalysis,
} from "./post-entry-long-hold-analysis.ts";
import {
  entryLargeTraderPositioning,
  entryMarketRegime,
} from "./strategy-entry-observation-baseline.ts";
import { analyzeWaveSymbolSelection } from "./wave-symbol-selection-attribution.ts";
import { evaluateMovingProtectionReview } from "./moving-protection-review.ts";
import {
  buildNexusSentinelShadowEntryValidation,
  summarizeNexusSentinelShadowEntryValidations,
  type NexusSentinelShadowEntryValidation,
} from "./nexus-sentinel-shadow-entry-validation.ts";

export type PostEntrySample = {
  minuteOffset: number;
  markPrice?: number | null;
  entryPrice: number;
  roePercent?: number | null;
  mfeRoePercent?: number | null;
  maeRoePercent?: number | null;
  evidenceJson?: string;
  detail?: Record<string, unknown>;
};

export type PostEntrySuggestion = {
  parameterName: string;
  label: string;
  currentValue: unknown;
  suggestedValue: unknown;
  action: "KEEP" | "TIGHTEN" | "LOOSEN" | "OBSERVE";
  confidence: number;
  reason: string;
};

export type PostEntryAnalysis = {
  symbol: string | null;
  entryTriggerKind: string;
  decisionAtMs: number | null;
  observationMode: "ACTUAL_POSITION" | "REJECTED_COUNTERFACTUAL";
  rejectionCode: string | null;
  sampleCount: number;
  causalEvidenceSampleCount: number;
  causalEvidenceCoverageRatio: number | null;
  priceOnlySampleCount: number;
  incompleteCausalSampleCount: number;
  missingCausalDimensions: string[];
  causalAttributionReady: boolean;
  evidenceCompletenessSummary: string;
  latestMinute: number | null;
  latestRoePercent: number | null;
  bestRoePercent: number | null;
  worstRoePercent: number | null;
  positiveMinuteRatio: number | null;
  entrySlippagePercent: number | null;
  entryConfiguredOrderMode: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE" | null;
  entrySelectedOrderType: "MARKET" | "LIMIT" | null;
  entryAdaptiveDistanceAtr: number | null;
  entryAdaptiveThresholdAtr: number | null;
  entryPosition24hPercent: number | null;
  entryPosition72hPercent: number | null;
  entryVolumeRatio3m: number | null;
  entryDistanceAtr: number | null;
  entryConsensusVerdict:
    | "STRICT_CONSENSUS"
    | "RECOVERY_CONSENSUS"
    | "MIXED"
    | "CONFLICT"
    | "INCOMPLETE"
    | null;
  entryConsensusSupportCount: number | null;
  entryConsensusConflictCount: number | null;
  consensusRoe5mPercent: number | null;
  consensusRoe10mPercent: number | null;
  consensusRoe30mPercent: number | null;
  consensusRoe60mPercent: number | null;
  consensusContextSummary: string;
  entryLargeTraderStatus: "SUPPORTS_LONG" | "CONFLICTS_LONG" | "NEUTRAL" | "UNAVAILABLE" | null;
  entryLargeTraderConfirmationMode: "BROAD_LONG" | "CAPITAL_CONCENTRATION_LONG" | null;
  entryOpenInterestChangePercent: number | null;
  entryTopPositionRatioChangePercent: number | null;
  entryTopAccountRatioChangePercent: number | null;
  entryTakerBuySellRatio: number | null;
  entryLargeTraderEvidenceMode: "PRE_ENTRY" | "POST_FILL_BASELINE" | null;
  largeTraderContextSummary: string;
  entryLiquiditySweepStatus: "RECLAIMED" | "ACTIVE_CASCADE" | "UNCONFIRMED" | "DATA_STALE" | null;
  entrySweepDepthAtr: number | null;
  entryPriorRangeAtr: number | null;
  entryPriorRangeState: "COMPRESSED" | "BROAD" | "UNKNOWN" | null;
  liquiditySweepContextSummary: string;
  postBreakLocalRecoveryStatus: "QUALIFIED" | "REJECTED" | "INCOMPLETE" | null;
  postBreakLocalRecoveryOutcome: "TAKE_PROFIT_FIRST" | "STOP_LOSS_FIRST" | "AMBIGUOUS" | "NO_TRIGGER" | "NO_ENTRY" | null;
  postBreakLocalRecoveryEntryPrice: number | null;
  postBreakLocalRecoveryVolumeRatio3m: number | null;
  postBreakLocalRecoveryVolumeRatio5m: number | null;
  postBreakLocalRecoveryMfeRoePercent: number | null;
  postBreakLocalRecoveryMaeRoePercent: number | null;
  postBreakLocalRecoveryTakeProfitMinute: number | null;
  postBreakLocalRecoveryStopLossMinute: number | null;
  postBreakLocalRecoveryEstimatedGrossRoePercent: number | null;
  postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent: number | null;
  postBreakLocalRecoveryEstimatedExitMinute: number | null;
  postBreakLocalRecoveryEstimatedExitReason: "TAKE_PROFIT" | "TRAILING_STOP" | "STOP_LOSS" | "OPEN" | null;
  postBreakLocalRecoverySummary: string;
  entryLiquidationClusterCount: number | null;
  entryLiquidationEventCount: number | null;
  entryLiquidationClusterNotional: number | null;
  entryLiquidationClusterSpanMs: number | null;
  entrySymbolLiquidationSharePercent: number | null;
  entrySymbolContributionRank: number | null;
  liquidationClusterContextSummary: string;
  entryOpenPositionCount: number | null;
  entrySameMarketClusterOpenPositions: number | null;
  entryMarketClusterId: string | null;
  entryIndependentOpportunity: boolean | null;
  concurrentExposureSummary: string;
  finalRealizedPnl: number | null;
  finalPnlBasis: "NET_EXACT" | "GROSS_FALLBACK" | null;
  finalNetRoePercent: number | null;
  lifetimeBestRoePercent: number | null;
  holdingDurationMinutes: number | null;
  exitAttributionMode:
    | "AUTOMATED_ONLY"
    | "OPERATOR_INTERVENED"
    | "EXTERNAL_UNKNOWN"
    | "UNKNOWN";
  reductionReasonCounts: Record<string, number>;
  reductionAttributionCounts: Record<string, number>;
  finalExitReason: string | null;
  finalOutcome: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN" | "UNKNOWN";
  finalOutcomeSummary: string;
  entryMarketRegimeAtFill:
    | "FAVORABLE"
    | "NEUTRAL"
    | "ADVERSE"
    | "UNAVAILABLE"
    | null;
  entryMarketBaselineDelayMs: number | null;
  entryMarketRegimeChanged: boolean | null;
  entryMarketTransitionSummary: string;
  latestMarketRegime: "FAVORABLE" | "NEUTRAL" | "ADVERSE" | "UNAVAILABLE" | null;
  favorableMarketRatio: number | null;
  adverseMarketRatio: number | null;
  marketContextSummary: string;
  entryGlobalLiquidationTrend: string | null;
  latestGlobalLiquidationTrend: string | null;
  latestGlobalLiquidationSwing: string | null;
  globalLiquidationTrendChanged: boolean | null;
  globalLiquidationContextSummary: string;
  latestBreakdownStatus:
    | "STABLE"
    | "WATCH"
    | "BREAKDOWN_PRESSURE"
    | "UNAVAILABLE"
    | "NOT_APPLICABLE"
    | null;
  breakdownPressureRatio: number | null;
  breakdownWatchRatio: number | null;
  breakdownContextSummary: string;
  latestPostEntryLargeTraderStatus:
    | "SUPPORT_CONTINUES"
    | "CAPITAL_WITHDRAWAL"
    | "MIXED"
    | "UNAVAILABLE"
    | "NOT_APPLICABLE"
    | "NOT_SCHEDULED"
    | null;
  postEntryLargeTraderSupportRatio: number | null;
  postEntryLargeTraderWithdrawalRatio: number | null;
  postEntryLargeTraderContextSummary: string;
  longHoldAnalysis: PostEntryLongHoldAnalysis;
  capitalExitShadow: CapitalExitShadow;
  positionManagementDecisionOutcome: PositionManagementDecisionOutcome;
  waveThesisId: string | null;
  waveThesisStatus: "CONFIRMED" | "INCOMPLETE" | null;
  waveThesisOutcome: WaveThesisOutcome | null;
  waveThesisSummary: string;
  waveDirectionVerdict: WaveDirectionVerdict;
  waveEntryTimingVerdict: WaveEntryTimingVerdict;
  waveEntryAttributionSummary: string;
  deeperLimitCounterfactual: DeeperLimitCounterfactual;
  deeperLimitCounterfactual30m: DeeperLimitCounterfactual;
  deeperLimitCounterfactual60m: DeeperLimitCounterfactual;
  delayedReclaimCounterfactual: DelayedReclaimCounterfactual;
  delayedReclaimCounterfactual30m: DelayedReclaimCounterfactual;
  delayedReclaimCounterfactual60m: DelayedReclaimCounterfactual;
  sentinelShadowEntryValidation: NexusSentinelShadowEntryValidation;
  quality:
    | "INSUFFICIENT"
    | "GOOD"
    | "WEAK"
    | "LATE"
    | "GIVEBACK"
    | "MISSED_WIN"
    | "AVOIDED_LOSS"
    | "NO_TRIGGER"
    | "AMBIGUOUS";
  summary: string;
  suggestions: PostEntrySuggestion[];
};

export function analyzePostEntryPerformance(input: {
  config: LiquidationTrendConfig;
  symbol?: string | null;
  entryEvidence: Record<string, unknown>;
  samples: PostEntrySample[];
  decisionAtMs?: number | null;
  positionSide?: "LONG" | "SHORT";
  observationMode?: "ACTUAL_POSITION" | "REJECTED_COUNTERFACTUAL";
  rejectionCode?: string | null;
  finalRealizedPnl?: number | null;
  finalPnlExact?: boolean;
  finalNetRoePercent?: number | null;
  lifetimeBestRoePercent?: number | null;
  holdingDurationMinutes?: number | null;
  reductionReasons?: string[];
  reductionAttributions?: string[];
  finalExitReason?: string | null;
}): PostEntryAnalysis {
  const triggerIdentity = directRecord(input.entryEvidence.triggerIdentity);
  const entryTriggerKind =
    typeof triggerIdentity.triggerKind === "string" &&
    triggerIdentity.triggerKind.trim()
      ? triggerIdentity.triggerKind.trim()
      : "LIQUIDATION_WINDOW";
  const symbol =
    stringOrNull(input.symbol) ??
    stringOrNull(input.entryEvidence.symbol);
  const decisionAtMs = Number.isFinite(input.decisionAtMs)
    ? Number(input.decisionAtMs)
    : null;
  const observationMode = input.observationMode ?? "ACTUAL_POSITION";
  const rejectionCode = observationMode === "REJECTED_COUNTERFACTUAL"
    ? input.rejectionCode ?? null
    : null;
  const samples = input.samples
    .filter((sample) => Number.isFinite(sample.roePercent))
    .sort((a, b) => a.minuteOffset - b.minuteOffset);
  const sentinelShadowEntryValidation =
    buildNexusSentinelShadowEntryValidation({
      observationMode,
      triggerKind: entryTriggerKind,
      positionSide: input.positionSide,
      rejectionCode,
      firstTakeProfitRoePercent:
        input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0,
      stopLossRoePercent: input.config.risk.stopLossPercent,
      checkpoints: samples.map((sample) => {
        const detail = sample.detail ?? parseRecord(sample.evidenceJson);
        return {
          ...sample,
          firstTakeProfitMinute: finiteOrNull(
            detail.firstTakeProfitMinute,
          ),
          firstStopLossMinute: finiteOrNull(
            detail.firstStopLossMinute,
          ),
        };
      }),
    });
  const evidenceWindow = buildPostEntryEvidenceWindow({
    samples,
    observationMode,
    holdingDurationMinutes: input.holdingDurationMinutes,
  });
  const earlySamples = evidenceWindow.samples;
  const causalAttribution = evaluatePostEntryCausalAttribution({
    samples: earlySamples,
    observationMode,
  });
  const {
    causalEvidenceSampleCount,
    causalEvidenceCoverageRatio,
    priceOnlySampleCount,
    incompleteCausalSampleCount,
    missingCausalDimensions,
    causalAttributionReady,
  } = causalAttribution;
  const evidenceCompletenessSummary = !earlySamples.length
    ? "尚无持仓后样本"
    : causalAttributionReady
      ? `${causalEvidenceSampleCount}/${earlySamples.length} 个核心样本包含因果环境证据，且最新事实完整`
      : `${causalEvidenceSampleCount} 个完整因果样本、${incompleteCausalSampleCount} 个因果维度不完整样本、${priceOnlySampleCount} 个仅价格路径样本；缺失维度${missingCausalDimensions.length ? `：${missingCausalDimensions.join("、")}` : ""}不得解释为没有风险`;
  const latest = earlySamples.at(-1);
  const latestRoe = finiteOrNull(latest?.roePercent);
  const bestRoe = earlySamples.length
    ? Math.max(...earlySamples.map((sample) => finiteOr(sample.mfeRoePercent, finiteOr(sample.roePercent, 0))))
    : null;
  const worstRoe = earlySamples.length
    ? Math.min(...earlySamples.map((sample) => finiteOr(sample.maeRoePercent, Math.min(0, finiteOr(sample.roePercent, 0)))))
    : null;
  const positiveMinuteRatio = earlySamples.length
    ? earlySamples.filter((sample) => finiteOr(sample.roePercent, 0) > 0).length / earlySamples.length
    : null;
  const marketStatuses = earlySamples
    .map(sampleMarketRegime)
    .filter((status): status is "FAVORABLE" | "NEUTRAL" | "ADVERSE" =>
      status === "FAVORABLE" || status === "NEUTRAL" || status === "ADVERSE",
    );
  const latestMarketRegime = earlySamples.length
    ? sampleMarketRegime(earlySamples.at(-1)!)
    : null;
  const favorableMarketRatio = marketStatuses.length
    ? marketStatuses.filter((status) => status === "FAVORABLE").length / marketStatuses.length
    : null;
  const adverseMarketRatio = marketStatuses.length
    ? marketStatuses.filter((status) => status === "ADVERSE").length / marketStatuses.length
    : null;
  const marketContextSummary = !marketStatuses.length
    ? "暂无可用的大盘环境样本"
    : `大盘顺风 ${(favorableMarketRatio! * 100).toFixed(0)}% · 逆风 ${(adverseMarketRatio! * 100).toFixed(0)}% · 共 ${marketStatuses.length} 个环境样本`;
  const fillMarketStatusValue = String(
    entryMarketRegime(input.entryEvidence).status ?? "",
  );
  const entryMarketRegimeAtFill = [
    "FAVORABLE",
    "NEUTRAL",
    "ADVERSE",
    "UNAVAILABLE",
  ].includes(fillMarketStatusValue)
    ? fillMarketStatusValue as PostEntryAnalysis["entryMarketRegimeAtFill"]
    : null;
  const entryObservationBaseline = directRecord(
    input.entryEvidence.entryObservationBaseline,
  );
  const entryMarketBaselineDelayMs = finiteOrNull(
    entryObservationBaseline.delayFromFillMs,
  );
  const entryMarketRegimeChanged =
    entryMarketRegimeAtFill !== null &&
      entryMarketRegimeAtFill !== "UNAVAILABLE" &&
      latestMarketRegime !== null &&
      latestMarketRegime !== "UNAVAILABLE"
      ? entryMarketRegimeAtFill !== latestMarketRegime
      : null;
  const entryMarketTransitionSummary = entryMarketRegimeAtFill === null
    ? "该样本没有成交时大盘观察基线"
    : entryMarketRegimeAtFill === "UNAVAILABLE"
      ? "成交时大盘观察基线不可用，不据此归因"
      : latestMarketRegime === null || latestMarketRegime === "UNAVAILABLE"
        ? `成交后基线 ${entryMarketRegimeAtFill}，后续环境尚不足`
        : `成交后基线 ${entryMarketRegimeAtFill} → 最新 ${latestMarketRegime}` +
          (entryMarketBaselineDelayMs === null
            ? ""
            : ` · 基线延迟 ${entryMarketBaselineDelayMs}ms`);
  const marketContext: Pick<
    PostEntryAnalysis,
    | "entryMarketRegimeAtFill"
    | "entryMarketBaselineDelayMs"
    | "entryMarketRegimeChanged"
    | "entryMarketTransitionSummary"
    | "latestMarketRegime"
    | "favorableMarketRatio"
    | "adverseMarketRatio"
    | "marketContextSummary"
  > = {
    entryMarketRegimeAtFill,
    entryMarketBaselineDelayMs,
    entryMarketRegimeChanged,
    entryMarketTransitionSummary,
    latestMarketRegime,
    favorableMarketRatio,
    adverseMarketRatio,
    marketContextSummary,
  };
  const entryGlobalLiquidation = directRecord(
    input.entryEvidence.globalLiquidationContext,
  );
  const entryGlobalLiquidationTrend =
    stringOrNull(entryGlobalLiquidation.marketTrend);
  const latestGlobalLiquidation = [...earlySamples]
    .reverse()
    .map(sampleGlobalLiquidationContext)
    .find((value) => value !== null) ?? null;
  const latestGlobalLiquidationTrend =
    stringOrNull(latestGlobalLiquidation?.marketTrend);
  const latestGlobalLiquidationSwing =
    stringOrNull(latestGlobalLiquidation?.swingTrend);
  const globalLiquidationTrendChanged =
    entryGlobalLiquidationTrend && latestGlobalLiquidationTrend
      ? entryGlobalLiquidationTrend !== latestGlobalLiquidationTrend
      : null;
  const globalLiquidationContextSummary =
    entryGlobalLiquidationTrend && latestGlobalLiquidationTrend
      ? `入场 ${entryGlobalLiquidationTrend} · 最新 ${latestGlobalLiquidationTrend}/${latestGlobalLiquidationSwing ?? "短波段未知"}${globalLiquidationTrendChanged ? " · 背景已切换" : " · 背景延续"}`
      : "CoinGlass 全市场爆仓背景样本不足";
  const globalLiquidationContext = {
    entryGlobalLiquidationTrend,
    latestGlobalLiquidationTrend,
    latestGlobalLiquidationSwing,
    globalLiquidationTrendChanged,
    globalLiquidationContextSummary,
  };
  const breakdownStatuses = earlySamples
    .map(sampleBreakdownStatus)
    .filter((status): status is NonNullable<PostEntryAnalysis["latestBreakdownStatus"]> =>
      status !== null,
    );
  const latestBreakdownStatus = earlySamples.length
    ? sampleBreakdownStatus(earlySamples.at(-1)!)
    : null;
  const breakdownPressureRatio = breakdownStatuses.length
    ? breakdownStatuses.filter((status) => status === "BREAKDOWN_PRESSURE").length /
      breakdownStatuses.length
    : null;
  const breakdownWatchRatio = breakdownStatuses.length
    ? breakdownStatuses.filter(
        (status) => status === "WATCH" || status === "BREAKDOWN_PRESSURE",
      ).length / breakdownStatuses.length
    : null;
  const breakdownContextSummary = !breakdownStatuses.length
    ? "暂无入场后破位压力样本"
    : `最新 ${latestBreakdownStatus ?? "—"} · 破位杀盘确认 ${(breakdownPressureRatio! * 100).toFixed(0)}% · 观察状态 ${(breakdownWatchRatio! * 100).toFixed(0)}%`;
  const breakdownContext: Pick<
    PostEntryAnalysis,
    | "latestBreakdownStatus"
    | "breakdownPressureRatio"
    | "breakdownWatchRatio"
    | "breakdownContextSummary"
  > = {
    latestBreakdownStatus,
    breakdownPressureRatio,
    breakdownWatchRatio,
    breakdownContextSummary,
  };
  const postEntryLargeTraderStatuses = earlySamples
    .map(samplePostEntryLargeTraderStatus)
    .filter(
      (status): status is
        | "SUPPORT_CONTINUES"
        | "CAPITAL_WITHDRAWAL"
        | "MIXED" =>
        status === "SUPPORT_CONTINUES" ||
        status === "CAPITAL_WITHDRAWAL" ||
        status === "MIXED",
    );
  const latestPostEntryLargeTraderStatus = [...earlySamples]
    .reverse()
    .map(samplePostEntryLargeTraderStatus)
    .find((status) => status !== null && status !== "NOT_SCHEDULED") ?? null;
  const postEntryLargeTraderSupportRatio =
    postEntryLargeTraderStatuses.length
      ? postEntryLargeTraderStatuses.filter(
          (status) => status === "SUPPORT_CONTINUES",
        ).length / postEntryLargeTraderStatuses.length
      : null;
  const postEntryLargeTraderWithdrawalRatio =
    postEntryLargeTraderStatuses.length
      ? postEntryLargeTraderStatuses.filter(
          (status) => status === "CAPITAL_WITHDRAWAL",
        ).length / postEntryLargeTraderStatuses.length
      : null;
  const postEntryLargeTraderContextSummary =
    postEntryLargeTraderStatuses.length
      ? `5/30/60分钟聚合仓位：延续 ${((postEntryLargeTraderSupportRatio ?? 0) * 100).toFixed(0)}% · 撤退 ${((postEntryLargeTraderWithdrawalRatio ?? 0) * 100).toFixed(0)}% · ${postEntryLargeTraderStatuses.length}个有效样本`
      : "暂无持仓后5/30/60分钟大户聚合仓位样本";
  const postEntryLargeTraderContext: Pick<
    PostEntryAnalysis,
    | "latestPostEntryLargeTraderStatus"
    | "postEntryLargeTraderSupportRatio"
    | "postEntryLargeTraderWithdrawalRatio"
    | "postEntryLargeTraderContextSummary"
  > = {
    latestPostEntryLargeTraderStatus,
    postEntryLargeTraderSupportRatio,
    postEntryLargeTraderWithdrawalRatio,
    postEntryLargeTraderContextSummary,
  };
  const longHoldAnalysis = analyzePostEntryLongHold({
    samples,
    firstTakeProfitRoePercent:
      input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0,
    trailingActivationRoePercent:
      input.config.risk.trailingActivationPercent,
    trailingDrawdownRoePercent:
      input.config.risk.trailingDrawdownPercent,
  });
  const capitalExitShadow = evaluateCapitalWithdrawalExitShadow({
    samples: samples.map((sample) => ({
      minuteOffset: sample.minuteOffset,
      roePercent: finiteOrNull(sample.roePercent),
      largeTraderStatus: samplePostEntryLargeTraderStatus(sample),
    })),
    requiredEdgeRoePercent: Math.max(
      0.5,
      (input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.1,
    ),
  });
  const positionManagementDecisionOutcome =
    evaluatePositionManagementDecisionOutcome({
      samples: samples.map((sample) => ({
        minuteOffset: sample.minuteOffset,
        roePercent: finiteOrNull(sample.roePercent),
        causalEvidenceComplete:
          sampleHasCausalAttributionEvidence(sample),
        decision: samplePositionManagementDecision(sample),
      })),
      requiredEdgeRoePercent: Math.max(
        0.5,
        (input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.1,
      ),
    });
  const waveThesis = directRecord(input.entryEvidence.waveThesis);
  const waveThesisId =
    typeof waveThesis.thesisId === "string" && waveThesis.thesisId.trim()
      ? waveThesis.thesisId
      : null;
  const waveThesisStatus =
    waveThesis.status === "CONFIRMED" || waveThesis.status === "INCOMPLETE"
      ? waveThesis.status
      : null;
  const threeMinuteRoundThesis =
    waveThesis.schemaVersion === "three-minute-round-thesis-v1" ||
    waveThesis.setup === "THREE_MINUTE_PROBABILITY";
  const waveEvaluation =
    observationMode === "ACTUAL_POSITION" &&
      waveThesisStatus === "CONFIRMED" &&
      !threeMinuteRoundThesis
      ? evaluateLiquidationWaveThesis({
          sampleCount: earlySamples.length,
          latestRoePercent: latestRoe,
          bestRoePercent: bestRoe,
          positiveMinuteRatio,
          breakdownPressureRatio,
          largeTraderWithdrawalRatio:
            postEntryLargeTraderWithdrawalRatio,
          firstTakeProfitRoePercent:
            input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0,
        })
      : null;
  const waveThesisOutcome = waveEvaluation?.outcome ?? null;
  const waveThesisSummary = waveEvaluation?.summary ??
    (threeMinuteRoundThesis
      ? "3分钟概率轮次按费用后净期望、60/120/180秒及固定退出时点路径和真实终局单独复盘，不套用爆仓波段假设。"
      : waveThesisStatus === "INCOMPLETE"
      ? "入场波段假设的确认条件不完整，本样本不用于证明跟随逻辑。"
      : "该样本产生于波段假设证据链启用之前。");
  const waveThesisContext: Pick<
    PostEntryAnalysis,
    | "waveThesisId"
    | "waveThesisStatus"
    | "waveThesisOutcome"
    | "waveThesisSummary"
  > = {
    waveThesisId,
    waveThesisStatus,
    waveThesisOutcome,
    waveThesisSummary,
  };
  const referencePrice = nestedNumber(input.entryEvidence, "analyzedEntryPrice") ??
    nestedNumber(input.entryEvidence, "suggestedEntryPrice") ??
    nestedNumber(input.entryEvidence, "markPrice");
  const entryPrice = latest?.entryPrice;
  const rawSlippage = observationMode === "ACTUAL_POSITION" && referencePrice && entryPrice
    ? ((entryPrice - referencePrice) / referencePrice) * 100
    : null;
  const entrySlippagePercent = rawSlippage === null
    ? null
    : input.positionSide === "SHORT" ? -rawSlippage : rawSlippage;
  const analyzedEntryOrder = directRecord(
    input.entryEvidence.analyzedEntryOrder,
  );
  const requestedOrderMode = stringOrNull(analyzedEntryOrder.requestedMode);
  const selectedOrderType = stringOrNull(analyzedEntryOrder.selectedOrderType);
  const entryConfiguredOrderMode =
    requestedOrderMode === "MARKET" ||
      requestedOrderMode === "LIMIT_OFFSET" ||
      requestedOrderMode === "ADAPTIVE"
      ? requestedOrderMode
      : null;
  const entrySelectedOrderType =
    selectedOrderType === "MARKET" || selectedOrderType === "LIMIT"
      ? selectedOrderType
      : null;
  const entryAdaptiveDistanceAtr = finiteOrNull(
    analyzedEntryOrder.distanceAboveConfirmationAtr,
  );
  const entryAdaptiveThresholdAtr = finiteOrNull(
    analyzedEntryOrder.adaptiveMarketMaxDistanceAtr,
  );
  const entryExecutionContext: Pick<
    PostEntryAnalysis,
    | "entryConfiguredOrderMode"
    | "entrySelectedOrderType"
    | "entryAdaptiveDistanceAtr"
    | "entryAdaptiveThresholdAtr"
  > = {
    entryConfiguredOrderMode,
    entrySelectedOrderType,
    entryAdaptiveDistanceAtr,
    entryAdaptiveThresholdAtr,
  };
  const entryPosition24hPercent = boundedPositionPercent(
    input.entryEvidence,
    "position24hPercent",
  );
  const entryPosition72hPercent = boundedPositionPercent(
    input.entryEvidence,
    "position72hPercent",
  );
  const entryVolumeRatio3m = nestedNumber(input.entryEvidence, "volumeRatio3m");
  const entryDistanceAtr = nestedNumber(input.entryEvidence, "entryDistanceAtr");
  const consensus = consensusShadowFromEvidence(input.entryEvidence);
  const entryConsensusVerdict = consensus?.verdict ?? null;
  const entryConsensusSupportCount = consensus?.supportCount ?? null;
  const entryConsensusConflictCount = consensus?.conflictCount ?? null;
  const consensusRoe5mPercent = sampleRoeAt(samples, 5);
  const consensusRoe10mPercent = sampleRoeAt(samples, 10);
  const consensusRoe30mPercent = sampleRoeAt(samples, 30);
  const consensusRoe60mPercent = sampleRoeAt(samples, 60);
  const consensusContextSummary = consensus
    ? `${consensus.summary} · 后续ROE 5分钟 ${formatSigned(consensusRoe5mPercent)}% / 30分钟 ${formatSigned(consensusRoe30mPercent)}% / 60分钟 ${formatSigned(consensusRoe60mPercent)}%`
    : "该样本产生于异构证据共识影子启用之前";
  const consensusContext = {
    entryConsensusVerdict,
    entryConsensusSupportCount,
    entryConsensusConflictCount,
    consensusRoe5mPercent,
    consensusRoe10mPercent,
    consensusRoe30mPercent,
    consensusRoe60mPercent,
    consensusContextSummary,
  };
  const waveEntryAttribution = attributeWaveDirectionAndEntryTiming({
    sampleCount: earlySamples.length,
    bestEarlyRoePercent: bestRoe,
    worstEarlyRoePercent: worstRoe,
    positiveEarlyMinuteRatio: positiveMinuteRatio,
    roe30mPercent: consensusRoe30mPercent,
    waveThesisOutcome,
    firstTakeProfitRoePercent:
      input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0,
    stopLossRoePercent: input.config.risk.stopLossPercent,
    entryDistanceAtr,
    maxEntryDistanceAtr: input.config.trend.maxEntryDistanceAtr,
  });
  const waveEntryAttributionContext = {
    waveDirectionVerdict: waveEntryAttribution.directionVerdict,
    waveEntryTimingVerdict: waveEntryAttribution.timingVerdict,
    waveEntryAttributionSummary: waveEntryAttribution.summary,
  };
  const currentLimitOffsetPercent =
    input.config.execution.orderType !== "MARKET"
      ? input.config.execution.limitOffsetPercent
      : 0;
  const counterfactualExtraOffsetPercent = round(
    Math.max(
      0.05,
      Math.min(
        0.25,
        currentLimitOffsetPercent > 0
          ? currentLimitOffsetPercent * 0.5
          : 0.05,
      ),
    ),
    3,
  );
  const deeperLimitCounterfactual = observationMode === "ACTUAL_POSITION"
    ? evaluateDeeperLimitCounterfactual({
        positionSide: input.positionSide === "SHORT" ? "SHORT" : "LONG",
        actualEntryPrice: finiteOrNull(entryPrice),
        leverage: input.config.execution.leverage,
        extraOffsetPercent: counterfactualExtraOffsetPercent,
        samples,
        fillDeadlineMinute:
          input.config.execution.orderTtlSeconds >= 60
            ? input.config.execution.allowSecondOrder
              ? 2
              : 1
            : 0,
        latestEvaluationMinute: 10,
      })
    : {
        status: "INSUFFICIENT" as const,
        extraOffsetPercent: counterfactualExtraOffsetPercent,
        fillDeadlineMinute:
          input.config.execution.orderTtlSeconds >= 60
            ? input.config.execution.allowSecondOrder
              ? 2
              : 1
            : 0,
        candidateEntryPrice: null,
        fillMinute: null,
        evaluationMinute: null,
        actualRoePercent: null,
        candidateRoePercent: null,
        advantageRoePercent: null,
        summary: "拒绝信号没有实际成交价，不生成更深限价反事实。",
      };
  const deeperLimitCounterfactual30m =
    observationMode === "ACTUAL_POSITION"
      ? evaluateDeeperLimitCounterfactual({
          positionSide: input.positionSide === "SHORT" ? "SHORT" : "LONG",
          actualEntryPrice: finiteOrNull(entryPrice),
          leverage: input.config.execution.leverage,
          extraOffsetPercent: counterfactualExtraOffsetPercent,
          samples,
          fillDeadlineMinute:
            input.config.execution.orderTtlSeconds >= 60
              ? input.config.execution.allowSecondOrder
                ? 2
                : 1
              : 0,
          latestEvaluationMinute: 30,
        })
      : {
          status: "INSUFFICIENT" as const,
          extraOffsetPercent: counterfactualExtraOffsetPercent,
          fillDeadlineMinute:
            input.config.execution.orderTtlSeconds >= 60
              ? input.config.execution.allowSecondOrder
                ? 2
                : 1
              : 0,
          candidateEntryPrice: null,
          fillMinute: null,
          evaluationMinute: null,
          actualRoePercent: null,
          candidateRoePercent: null,
          advantageRoePercent: null,
          summary: "拒绝信号没有实际成交价，不生成30分钟更深限价反事实。",
        };
  const deeperLimitCounterfactual60m =
    observationMode === "ACTUAL_POSITION"
      ? evaluateDeeperLimitCounterfactual({
          positionSide: input.positionSide === "SHORT" ? "SHORT" : "LONG",
          actualEntryPrice: finiteOrNull(entryPrice),
          leverage: input.config.execution.leverage,
          extraOffsetPercent: counterfactualExtraOffsetPercent,
          samples,
          fillDeadlineMinute:
            input.config.execution.orderTtlSeconds >= 60
              ? input.config.execution.allowSecondOrder
                ? 2
                : 1
              : 0,
          latestEvaluationMinute: 60,
        })
      : {
          status: "INSUFFICIENT" as const,
          extraOffsetPercent: counterfactualExtraOffsetPercent,
          fillDeadlineMinute:
            input.config.execution.orderTtlSeconds >= 60
              ? input.config.execution.allowSecondOrder
                ? 2
                : 1
              : 0,
          candidateEntryPrice: null,
          fillMinute: null,
          evaluationMinute: null,
          actualRoePercent: null,
          candidateRoePercent: null,
          advantageRoePercent: null,
          summary: "拒绝信号没有实际成交价，不生成60分钟更深限价反事实。",
        };
  const delayedReclaimCounterfactual = observationMode === "ACTUAL_POSITION"
    ? evaluateDelayedReclaimCounterfactual({
        positionSide: input.positionSide === "SHORT" ? "SHORT" : "LONG",
        actualEntryPrice: finiteOrNull(entryPrice),
        leverage: input.config.execution.leverage,
        stopLossRoePercent: input.config.risk.stopLossPercent,
        samples,
        confirmationDeadlineMinute: 5,
        evaluationMinute: 10,
        requiredRecoveryFraction: 0.35,
      })
    : {
        status: "INSUFFICIENT" as const,
        adverseTriggerRoePercent: Math.max(
          0.5,
          input.config.risk.stopLossPercent * 0.25,
        ),
        requiredRecoveryFraction: 0.35,
        adverseMinute: null,
        confirmationMinute: null,
        candidateEntryPrice: null,
        evaluationMinute: null,
        actualRoePercent: null,
        candidateRoePercent: null,
        advantageRoePercent: null,
        summary: "拒绝信号没有实际成交价，不生成延迟收回反事实。",
      };
  const delayedReclaimCounterfactual30m =
    observationMode === "ACTUAL_POSITION"
      ? evaluateDelayedReclaimCounterfactual({
          positionSide: input.positionSide === "SHORT" ? "SHORT" : "LONG",
          actualEntryPrice: finiteOrNull(entryPrice),
          leverage: input.config.execution.leverage,
          stopLossRoePercent: input.config.risk.stopLossPercent,
          samples,
          confirmationDeadlineMinute: 5,
          evaluationMinute: 30,
          requiredRecoveryFraction: 0.35,
        })
      : {
          status: "INSUFFICIENT" as const,
          adverseTriggerRoePercent: Math.max(
            0.5,
            input.config.risk.stopLossPercent * 0.25,
          ),
          requiredRecoveryFraction: 0.35,
          adverseMinute: null,
          confirmationMinute: null,
          candidateEntryPrice: null,
          evaluationMinute: null,
          actualRoePercent: null,
          candidateRoePercent: null,
          advantageRoePercent: null,
          summary: "拒绝信号没有实际成交价，不生成30分钟延迟收回反事实。",
        };
  const delayedReclaimCounterfactual60m =
    observationMode === "ACTUAL_POSITION"
      ? evaluateDelayedReclaimCounterfactual({
          positionSide: input.positionSide === "SHORT" ? "SHORT" : "LONG",
          actualEntryPrice: finiteOrNull(entryPrice),
          leverage: input.config.execution.leverage,
          stopLossRoePercent: input.config.risk.stopLossPercent,
          samples,
          confirmationDeadlineMinute: 5,
          evaluationMinute: 60,
          requiredRecoveryFraction: 0.35,
        })
      : {
          status: "INSUFFICIENT" as const,
          adverseTriggerRoePercent: Math.max(
            0.5,
            input.config.risk.stopLossPercent * 0.25,
          ),
          requiredRecoveryFraction: 0.35,
          adverseMinute: null,
          confirmationMinute: null,
          candidateEntryPrice: null,
          evaluationMinute: null,
          actualRoePercent: null,
          candidateRoePercent: null,
          advantageRoePercent: null,
          summary: "拒绝信号没有实际成交价，不生成60分钟延迟收回反事实。",
        };
  const entryLargeTraderStatus = largeTraderStatus(input.entryEvidence);
  const entryLargeTraderConfirmationMode = largeTraderConfirmationMode(input.entryEvidence);
  const entryOpenInterestChangePercent = nestedNumber(
    input.entryEvidence,
    "openInterestChangePercent",
  );
  const entryTopPositionRatioChangePercent = nestedNumber(
    input.entryEvidence,
    "topPositionRatioChangePercent",
  );
  const entryTopAccountRatioChangePercent = nestedNumber(
    input.entryEvidence,
    "topAccountRatioChangePercent",
  );
  const entryTakerBuySellRatio = nestedNumber(
    input.entryEvidence,
    "takerBuySellRatio",
  );
  const entryLargeTraderEvidenceMode =
    Object.keys(directRecord(input.entryEvidence.largeTraderPositioning)).length
      ? "PRE_ENTRY" as const
      : Object.keys(
            directRecord(
              directRecord(input.entryEvidence.entryObservationBaseline)
                .largeTraderPositioning,
            ),
          ).length
        ? "POST_FILL_BASELINE" as const
        : null;
  const largeTraderContextSummary = entryLargeTraderStatus
    ? `大户聚合 ${entryLargeTraderStatus}${entryLargeTraderConfirmationMode ? ` / ${entryLargeTraderConfirmationMode}` : ""} · ${entryLargeTraderEvidenceMode === "POST_FILL_BASELINE" ? "成交后观察基线" : "入场前确认"} · OI ${formatSigned(entryOpenInterestChangePercent)}% · 持仓比 ${formatSigned(entryTopPositionRatioChangePercent)}% · 账户比 ${formatSigned(entryTopAccountRatioChangePercent)}% · 主动买卖比 ${formatNumber(entryTakerBuySellRatio)}`
    : "该样本产生于大户聚合确认启用之前";
  const largeTraderContext: Pick<
    PostEntryAnalysis,
    | "entryLargeTraderStatus"
    | "entryLargeTraderConfirmationMode"
    | "entryOpenInterestChangePercent"
    | "entryTopPositionRatioChangePercent"
    | "entryTopAccountRatioChangePercent"
    | "entryTakerBuySellRatio"
    | "entryLargeTraderEvidenceMode"
    | "largeTraderContextSummary"
  > = {
    entryLargeTraderStatus,
    entryLargeTraderConfirmationMode,
    entryOpenInterestChangePercent,
    entryTopPositionRatioChangePercent,
    entryTopAccountRatioChangePercent,
    entryTakerBuySellRatio,
    entryLargeTraderEvidenceMode,
    largeTraderContextSummary,
  };
  const entryLiquiditySweepStatus = liquiditySweepStatus(input.entryEvidence);
  const entrySweepDepthAtr = nestedNumber(input.entryEvidence, "sweepDepthAtr");
  const entryPriorRangeAtr = nestedNumber(input.entryEvidence, "priorRangeAtr");
  const entryPriorRangeState = liquiditySweepRangeState(input.entryEvidence);
  const liquiditySweepContextSummary = entryLiquiditySweepStatus
    ? `流动性扫盘 ${entryLiquiditySweepStatus} · 扫破 ${formatNumber(entrySweepDepthAtr)} ATR · 前区间 ${formatNumber(entryPriorRangeAtr)} ATR · ${entryPriorRangeState ?? "UNKNOWN"}`
    : "该样本产生于流动性扫盘确认启用之前";
  const liquiditySweepContext = {
    entryLiquiditySweepStatus,
    entrySweepDepthAtr,
    entryPriorRangeAtr,
    entryPriorRangeState,
    liquiditySweepContextSummary,
  };
  const postBreakRecovery = postBreakLocalRecovery(samples);
  const postBreakLocalRecoveryStatus = postBreakRecovery?.status ?? null;
  const postBreakLocalRecoveryOutcome = postBreakRecovery?.outcome ?? null;
  const postBreakLocalRecoveryEntryPrice = postBreakRecovery?.entryPrice ?? null;
  const postBreakLocalRecoveryVolumeRatio3m = postBreakRecovery?.volumeRatio3m ?? null;
  const postBreakLocalRecoveryVolumeRatio5m = postBreakRecovery?.volumeRatio5m ?? null;
  const postBreakLocalRecoveryMfeRoePercent = postBreakRecovery?.mfeRoePercent ?? null;
  const postBreakLocalRecoveryMaeRoePercent = postBreakRecovery?.maeRoePercent ?? null;
  const postBreakLocalRecoveryTakeProfitMinute = postBreakRecovery?.takeProfitMinute ?? null;
  const postBreakLocalRecoveryStopLossMinute = postBreakRecovery?.stopLossMinute ?? null;
  const postBreakLocalRecoveryEstimatedGrossRoePercent = postBreakRecovery?.estimatedGrossRoePercent ?? null;
  const postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent = postBreakRecovery?.estimatedObservedCloseGrossRoePercent ?? null;
  const postBreakLocalRecoveryEstimatedExitMinute = postBreakRecovery?.estimatedExitMinute ?? null;
  const postBreakLocalRecoveryEstimatedExitReason = postBreakRecovery?.estimatedExitReason ?? null;
  const postBreakLocalRecoverySummary = postBreakRecovery
    ? `破位后局部反转影子验证：${postBreakRecovery.status} / ${postBreakRecovery.outcome} · 3分钟量能 ${formatNumber(postBreakRecovery.volumeRatio3m)}× · 5分钟量能 ${formatNumber(postBreakRecovery.volumeRatio5m)}× · MFE ${formatSigned(postBreakRecovery.mfeRoePercent)}% · MAE ${formatSigned(postBreakRecovery.maeRoePercent)}% · 退出估算区间 ${formatSigned(postBreakRecovery.estimatedObservedCloseGrossRoePercent)}% 至 ${formatSigned(postBreakRecovery.estimatedGrossRoePercent)}% ROE / ${postBreakRecovery.estimatedExitReason ?? "—"} · ${postBreakRecovery.reason ?? "—"}`
    : "暂无破位后局部反转影子证据";
  const postBreakRecoveryContext = {
    postBreakLocalRecoveryStatus,
    postBreakLocalRecoveryOutcome,
    postBreakLocalRecoveryEntryPrice,
    postBreakLocalRecoveryVolumeRatio3m,
    postBreakLocalRecoveryVolumeRatio5m,
    postBreakLocalRecoveryMfeRoePercent,
    postBreakLocalRecoveryMaeRoePercent,
    postBreakLocalRecoveryTakeProfitMinute,
    postBreakLocalRecoveryStopLossMinute,
    postBreakLocalRecoveryEstimatedGrossRoePercent,
    postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent,
    postBreakLocalRecoveryEstimatedExitMinute,
    postBreakLocalRecoveryEstimatedExitReason,
    postBreakLocalRecoverySummary,
  };
  const entryLiquidationClusterCount = nestedNumber(input.entryEvidence, "clusterCount");
  const entryLiquidationEventCount = nestedNumber(input.entryEvidence, "eventCount");
  const entryLiquidationClusterNotional = nestedNumber(input.entryEvidence, "totalNotional");
  const entryLiquidationClusterSpanMs = nestedNumber(input.entryEvidence, "clusterSpanMs");
  const entrySymbolLiquidationSharePercent = finiteOrNull(
    input.entryEvidence.symbolLiquidationSharePercent,
  );
  const entrySymbolContributionRank = finiteOrNull(
    input.entryEvidence.symbolContributionRank,
  );
  const liquidationClusterContextSummary =
    entryTriggerKind !== "LIQUIDATION_WINDOW"
      ? "该策略由独立非爆仓事实触发，爆仓簇不参与本次入场归因"
      : entryLiquidationClusterCount === null
        ? "该样本产生于连续爆仓簇累计启用之前"
        : `连续爆仓 ${entryLiquidationClusterCount} 个时间簇 / ${entryLiquidationEventCount ?? entryLiquidationClusterCount} 个事件 · 累计 ${formatNumber(entryLiquidationClusterNotional)} USDT · 持续 ${formatNumber(entryLiquidationClusterSpanMs === null ? null : entryLiquidationClusterSpanMs / 1_000)} 秒` +
          (entrySymbolLiquidationSharePercent === null
            ? ""
            : ` · 本币种贡献 ${entrySymbolLiquidationSharePercent.toFixed(2)}% / 排名 ${entrySymbolContributionRank ?? "—"}`);
  const liquidationClusterContext = {
    entryLiquidationClusterCount,
    entryLiquidationEventCount,
    entryLiquidationClusterNotional,
    entryLiquidationClusterSpanMs,
    entrySymbolLiquidationSharePercent,
    entrySymbolContributionRank,
    liquidationClusterContextSummary,
  };
  const concurrentExposure = directRecord(
    input.entryEvidence.concurrentExposure,
  );
  const entryOpenPositionCount = finiteOrNull(
    concurrentExposure.openPositionCountAtEntry,
  );
  const entrySameMarketClusterOpenPositions = finiteOrNull(
    concurrentExposure.sameMarketClusterOpenPositions,
  );
  const entryMarketClusterId =
    typeof concurrentExposure.marketClusterId === "string" &&
    concurrentExposure.marketClusterId.trim()
      ? concurrentExposure.marketClusterId.trim()
      : null;
  const entryIndependentOpportunity =
    typeof concurrentExposure.independentOpportunity === "boolean"
      ? concurrentExposure.independentOpportunity
      : null;
  const concurrentExposureSummary =
    entryOpenPositionCount === null
      ? "该样本产生于并发波段暴露记录启用之前"
      : `入场时已有 ${entryOpenPositionCount} 个仓位 · 同一触发事实 ${entrySameMarketClusterOpenPositions ?? 0} 个 · ${entryIndependentOpportunity ? "独立机会" : "重复波段暴露"}`;
  const concurrentExposureContext = {
    entryOpenPositionCount,
    entrySameMarketClusterOpenPositions,
    entryMarketClusterId,
    entryIndependentOpportunity,
    concurrentExposureSummary,
  };
  const finalRealizedPnl = finiteOrNull(input.finalRealizedPnl);
  const finalPnlBasis = finalRealizedPnl === null
    ? null
    : input.finalPnlExact
      ? "NET_EXACT" as const
      : "GROSS_FALLBACK" as const;
  const finalExitReason = typeof input.finalExitReason === "string" && input.finalExitReason
    ? input.finalExitReason
    : null;
  const finalOutcome = observationMode === "REJECTED_COUNTERFACTUAL"
    ? "UNKNOWN" as const
    : finalRealizedPnl === null
      ? finalExitReason
        ? "UNKNOWN" as const
        : "OPEN" as const
      : finalPnlBasis === "NET_EXACT"
        ? finalRealizedPnl > 1e-8
          ? "WIN" as const
          : finalRealizedPnl < -1e-8
            ? "LOSS" as const
            : "BREAK_EVEN" as const
        : finalRealizedPnl < -1e-8
          // Fees can only make a gross loss worse, so this remains a reliable
          // loss even when the commission asset could not be converted.
          ? "LOSS" as const
          : "UNKNOWN" as const;
  const finalOutcomeSummary = finalOutcome === "WIN"
    ? `最终已实现盈利 +${finalRealizedPnl!.toFixed(4)} USDT${finalPnlBasis === "NET_EXACT" ? "（净，已计手续费与资金费）" : "（毛，交易成本待补）"}${finalExitReason ? ` · ${finalExitReason}` : ""}`
    : finalOutcome === "LOSS"
      ? `最终已实现亏损 ${finalRealizedPnl!.toFixed(4)} USDT${finalPnlBasis === "NET_EXACT" ? "（净，已计手续费与资金费）" : "（毛，交易成本待补）"}${finalExitReason ? ` · ${finalExitReason}` : ""}`
      : finalOutcome === "BREAK_EVEN"
        ? `最终接近盈亏平衡${finalExitReason ? ` · ${finalExitReason}` : ""}`
        : finalOutcome === "OPEN"
          ? "仓位尚未完整结束，最终盈亏待确认"
          : finalPnlBasis === "GROSS_FALLBACK" && finalRealizedPnl !== null
            ? `已实现毛盈亏 ${finalRealizedPnl >= 0 ? "+" : ""}${finalRealizedPnl.toFixed(4)} USDT，手续费或资金费未能完整归属，暂不作为净盈利样本`
            : "无法可靠取得最终已实现盈亏";
  const reductionReasonCounts = (input.reductionReasons ?? []).reduce<
    Record<string, number>
  >((counts, reason) => {
    const normalized = String(reason || "UNKNOWN").trim().toUpperCase();
    counts[normalized] = (counts[normalized] ?? 0) + 1;
    return counts;
  }, {});
  const reductionReasonNames = Object.keys(reductionReasonCounts);
  const reductionAttributionCounts = (input.reductionAttributions ?? []).reduce<
    Record<string, number>
  >((counts, attribution) => {
    const normalized = String(attribution || "UNKNOWN").trim().toUpperCase();
    counts[normalized] = (counts[normalized] ?? 0) + 1;
    return counts;
  }, {});
  const exitAttributionMode =
    finalExitReason === "EXTERNAL" ||
    reductionReasonNames.includes("EXTERNAL")
      ? "EXTERNAL_UNKNOWN" as const
      : finalExitReason === "MANUAL" ||
          reductionReasonNames.includes("MANUAL")
        ? "OPERATOR_INTERVENED" as const
        : finalExitReason === "STOP_LOSS" ||
            finalExitReason === "TAKE_PROFIT" ||
            finalExitReason === "TRAILING_STOP"
          ? reductionReasonNames.every((reason) =>
              reason === "STOP_LOSS" ||
              reason === "TAKE_PROFIT" ||
              reason === "TRAILING_STOP"
            )
            ? "AUTOMATED_ONLY" as const
            : "UNKNOWN" as const
          : "UNKNOWN" as const;
  const finalOutcomeContext = {
    finalRealizedPnl,
    finalPnlBasis,
    finalNetRoePercent: finiteOrNull(input.finalNetRoePercent),
    lifetimeBestRoePercent: finiteOrNull(input.lifetimeBestRoePercent),
    holdingDurationMinutes:
      finiteOrNull(input.holdingDurationMinutes) === null
        ? null
        : Math.max(0, finiteOrNull(input.holdingDurationMinutes)!),
    exitAttributionMode,
    reductionReasonCounts,
    reductionAttributionCounts,
    finalExitReason,
    finalOutcome,
    finalOutcomeSummary,
  };
  const suggestions: PostEntrySuggestion[] = [];

  if (earlySamples.length < 3) {
    suggestions.push({
      parameterName: "observationWindow",
      label: "继续观察",
      currentValue: earlySamples.length,
      suggestedValue: 3,
      action: "OBSERVE",
      confidence: 0.2,
      reason: "当前不足3个分钟样本，先记录真实波动，不根据单个瞬时价格修改参数。",
    });
    return {
      symbol,
      decisionAtMs,
      observationMode,
      rejectionCode,
      sampleCount: earlySamples.length,
      causalEvidenceSampleCount,
      causalEvidenceCoverageRatio,
      priceOnlySampleCount,
      incompleteCausalSampleCount,
      missingCausalDimensions,
      causalAttributionReady,
      evidenceCompletenessSummary,
      latestMinute: latest?.minuteOffset ?? null,
      latestRoePercent: latestRoe,
      bestRoePercent: bestRoe,
      worstRoePercent: worstRoe,
      positiveMinuteRatio,
      entrySlippagePercent,
      ...entryExecutionContext,
      entryPosition24hPercent,
      entryPosition72hPercent,
      entryVolumeRatio3m,
      entryDistanceAtr,
      ...consensusContext,
      ...largeTraderContext,
      ...liquiditySweepContext,
      ...postBreakRecoveryContext,
      entryTriggerKind,
      ...liquidationClusterContext,
      ...concurrentExposureContext,
      ...finalOutcomeContext,
      ...marketContext,
      ...globalLiquidationContext,
      ...breakdownContext,
      ...postEntryLargeTraderContext,
      longHoldAnalysis,
      capitalExitShadow,
      positionManagementDecisionOutcome,
      ...waveThesisContext,
      ...waveEntryAttributionContext,
      deeperLimitCounterfactual,
      deeperLimitCounterfactual30m,
      deeperLimitCounterfactual60m,
      delayedReclaimCounterfactual,
      delayedReclaimCounterfactual30m,
      delayedReclaimCounterfactual60m,
      sentinelShadowEntryValidation,
      quality: "INSUFFICIENT",
      summary: observationMode === "REJECTED_COUNTERFACTUAL"
        ? "拒绝决策后的反事实样本仍在积累，暂不能判断本次过滤质量。"
        : "持仓后样本仍在积累，暂不建议修改参数。",
      suggestions,
    };
  }

  if (observationMode === "REJECTED_COUNTERFACTUAL") {
    const firstTakeProfit = input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0;
    const stopLoss = input.config.risk.stopLossPercent;
    const takeProfitMinute = samples.find((sample) =>
      finiteOr(sample.mfeRoePercent, finiteOr(sample.roePercent, 0)) >= firstTakeProfit,
    )?.minuteOffset ?? null;
    const stopLossMinute = samples.find((sample) =>
      finiteOr(sample.maeRoePercent, Math.min(0, finiteOr(sample.roePercent, 0))) <= -stopLoss,
    )?.minuteOffset ?? null;
    const reachedTakeProfit = takeProfitMinute !== null;
    const reachedStopLoss = stopLossMinute !== null;
    const takeProfitFirst = reachedTakeProfit &&
      (!reachedStopLoss || takeProfitMinute! < stopLossMinute!);
    const stopLossFirst = reachedStopLoss &&
      (!reachedTakeProfit || stopLossMinute! < takeProfitMinute!);
    const quality = takeProfitFirst
      ? "MISSED_WIN" as const
      : stopLossFirst
        ? "AVOIDED_LOSS" as const
        : reachedTakeProfit && reachedStopLoss
          ? "AMBIGUOUS" as const
          : "NO_TRIGGER" as const;
    const rejectionLabel = input.rejectionCode || "当前过滤条件";
    suggestions.push({
      parameterName: "rejectedSignalControlGroup",
      label: "拒绝信号对照组",
      currentValue: rejectionLabel,
      suggestedValue: "WAIT_FOR_GROUP_EVIDENCE",
      action: "OBSERVE",
      confidence: quality === "AMBIGUOUS" || quality === "NO_TRIGGER" ? 0.3 : 0.45,
      reason: quality === "MISSED_WIN"
        ? `决策后第 ${takeProfitMinute} 分钟先达到首档 +${firstTakeProfit}% ROE${stopLossMinute === null ? "且未触及止损" : `，早于第 ${stopLossMinute} 分钟的止损`}；这是潜在错失机会，但单个样本不足以放宽 ${rejectionLabel}。`
        : quality === "AVOIDED_LOSS"
          ? `决策后第 ${stopLossMinute} 分钟先触及 -${stopLoss}% ROE${takeProfitMinute === null ? "且未达到首档止盈" : `，早于第 ${takeProfitMinute} 分钟的止盈`}，当前过滤避免了一次明确弱势样本。`
          : quality === "AMBIGUOUS"
            ? "决策后止盈与止损在同一分钟首次触及，1分钟K线不能确定分钟内先后顺序，本次只记录为路径不明确。"
            : `决策后观察窗口内既未达到首档 +${firstTakeProfit}% ROE，也未触及 -${stopLoss}% ROE；本次属于无触发样本，继续观察。`,
    });
    return {
      symbol,
      decisionAtMs,
      observationMode,
      rejectionCode,
      sampleCount: earlySamples.length,
      causalEvidenceSampleCount,
      causalEvidenceCoverageRatio,
      priceOnlySampleCount,
      incompleteCausalSampleCount,
      missingCausalDimensions,
      causalAttributionReady,
      evidenceCompletenessSummary,
      latestMinute: latest?.minuteOffset ?? null,
      latestRoePercent: latestRoe,
      bestRoePercent: bestRoe,
      worstRoePercent: worstRoe,
      positiveMinuteRatio,
      entrySlippagePercent: null,
      ...entryExecutionContext,
      entryPosition24hPercent,
      entryPosition72hPercent,
      entryVolumeRatio3m,
      entryDistanceAtr,
      ...consensusContext,
      ...largeTraderContext,
      ...liquiditySweepContext,
      ...postBreakRecoveryContext,
      entryTriggerKind,
      ...liquidationClusterContext,
      ...concurrentExposureContext,
      ...finalOutcomeContext,
      ...marketContext,
      ...globalLiquidationContext,
      ...breakdownContext,
      ...postEntryLargeTraderContext,
      longHoldAnalysis,
      capitalExitShadow,
      positionManagementDecisionOutcome,
      ...waveThesisContext,
      ...waveEntryAttributionContext,
      deeperLimitCounterfactual,
      deeperLimitCounterfactual30m,
      deeperLimitCounterfactual60m,
      delayedReclaimCounterfactual,
      delayedReclaimCounterfactual30m,
      delayedReclaimCounterfactual60m,
      sentinelShadowEntryValidation,
      quality,
      summary: quality === "MISSED_WIN"
        ? "本次拒绝后出现了清晰有利走势，记入潜在错失机会对照组。"
        : quality === "AVOIDED_LOSS"
          ? "本次拒绝后走势继续恶化，当前过滤发挥了保护作用。"
          : quality === "AMBIGUOUS"
            ? "本次拒绝后的价格路径不明确，不据此调整参数。"
            : "本次拒绝后未触发止盈或止损，记入无触发复盘样本。",
      suggestions,
    };
  }

  const stopLoss = input.config.risk.stopLossPercent;
  const clearlyWeak = (latestRoe ?? 0) <= -Math.max(0.5, stopLoss * 0.25) ||
    (positiveMinuteRatio ?? 0) < 0.34;
  const enteredLate = clearlyWeak && entryDistanceAtr !== null &&
    entryDistanceAtr >= input.config.trend.maxEntryDistanceAtr * 0.7;
  const firstTakeProfit = input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0;
  const trailingArmedGiveback = bestRoe !== null && latestRoe !== null &&
    bestRoe >= input.config.risk.trailingActivationPercent &&
    bestRoe - latestRoe >= input.config.risk.trailingDrawdownPercent;
  const meaningfulProfitThreshold = Math.max(
    0.5,
    Math.min(
      firstTakeProfit > 0 ? firstTakeProfit * 0.6 : Number.POSITIVE_INFINITY,
      input.config.risk.trailingActivationPercent > 0
        ? input.config.risk.trailingActivationPercent * 0.75
        : Number.POSITIVE_INFINITY,
    ),
  );
  const unprotectedProfitGiveback = bestRoe !== null && latestRoe !== null &&
    Number.isFinite(meaningfulProfitThreshold) &&
    bestRoe >= meaningfulProfitThreshold &&
    latestRoe <= 0 &&
    bestRoe - latestRoe >= input.config.risk.trailingDrawdownPercent;
  const giveback = trailingArmedGiveback || unprotectedProfitGiveback;

  if (enteredLate) {
    suggestions.push({
      parameterName: "trend.maxEntryDistanceAtr",
      label: "最大入场距离",
      currentValue: input.config.trend.maxEntryDistanceAtr,
      suggestedValue: round(Math.max(0.1, input.config.trend.maxEntryDistanceAtr * 0.9), 2),
      action: "TIGHTEN",
      confidence: 0.62,
      reason: `本次入场距离 ${entryDistanceAtr?.toFixed(2)} ATR 接近上限，持仓后早期表现偏弱，建议减少追价空间。`,
    });
  }
  if (clearlyWeak && entryVolumeRatio3m !== null &&
    entryVolumeRatio3m < input.config.trend.volumeRatio3m * 1.2) {
    suggestions.push({
      parameterName: "trend.volumeRatio3m",
      label: "3分钟成交量倍数",
      currentValue: input.config.trend.volumeRatio3m,
      suggestedValue: round(Math.min(10, input.config.trend.volumeRatio3m + 0.1), 2),
      action: "TIGHTEN",
      confidence: 0.58,
      reason: `入场成交量仅 ${entryVolumeRatio3m.toFixed(2)} 倍，持仓后确认不足，建议提高量能确认门槛。`,
    });
  }
  if (giveback) {
    if (bestRoe! < input.config.risk.trailingActivationPercent) {
      suggestions.push({
        parameterName: "risk.trailingActivationPercent",
        label: "移动止损启动盈利",
        currentValue: input.config.risk.trailingActivationPercent,
        suggestedValue: round(Math.max(0.1, Math.min(
          input.config.risk.trailingActivationPercent * 0.8,
          bestRoe! * 0.8,
        )), 2),
        action: "TIGHTEN",
        confidence: 0.7,
        reason: `最高ROE ${bestRoe?.toFixed(2)}% 尚未达到 ${input.config.risk.trailingActivationPercent}% 启动线，随后回落至 ${latestRoe?.toFixed(2)}%；应更早启用利润保护。`,
      });
    } else {
      suggestions.push({
        parameterName: "risk.trailingDrawdownPercent",
        label: "移动止损回撤",
        currentValue: input.config.risk.trailingDrawdownPercent,
        suggestedValue: round(Math.max(0.1, input.config.risk.trailingDrawdownPercent * 0.85), 2),
        action: "TIGHTEN",
        confidence: 0.66,
        reason: `最高ROE ${bestRoe?.toFixed(2)}% 后回撤至 ${latestRoe?.toFixed(2)}%，建议缩小允许回撤以保护利润。`,
      });
    }
    if (firstTakeProfit > 0 && bestRoe! < firstTakeProfit && bestRoe! >= firstTakeProfit * 0.6) {
      suggestions.push({
        parameterName: "risk.takeProfitSteps[0].profitPercent",
        label: "首档止盈ROE",
        currentValue: firstTakeProfit,
        suggestedValue: round(Math.max(0.1, bestRoe! * 0.8), 2),
        action: "TIGHTEN",
        confidence: 0.64,
        reason: `本次最高ROE ${bestRoe?.toFixed(2)}% 接近但未达到首档 ${firstTakeProfit}%，随后盈利全部回吐；建议用同类样本验证更低的首档兑现点。`,
      });
    }
  }
  if (entryLargeTraderStatus === "SUPPORTS_LONG") {
    const largeTraderFailedConfirmation = clearlyWeak || giveback;
    suggestions.unshift({
      parameterName: "largeTraderConfirmationEvidence",
      label: "大户聚合确认有效性",
      currentValue: {
        openInterestChangePercent: entryOpenInterestChangePercent,
        topPositionRatioChangePercent: entryTopPositionRatioChangePercent,
        topAccountRatioChangePercent: entryTopAccountRatioChangePercent,
        takerBuySellRatio: entryTakerBuySellRatio,
      },
      suggestedValue: largeTraderFailedConfirmation
        ? "WAIT_FOR_GROUP_EVIDENCE_BEFORE_TIGHTENING"
        : "KEEP_AND_COMPARE_MORE_TRADES",
      action: largeTraderFailedConfirmation ? "OBSERVE" : "KEEP",
      confidence: largeTraderFailedConfirmation ? 0.5 : 0.55,
      reason: largeTraderFailedConfirmation
        ? `本次大户增多确认后仍出现${giveback ? "利润回吐" : "早期弱势"}${finalOutcome === "LOSS" ? "且最终亏损" : ""}；先纳入同类对照组，达到策略最低样本数后再判断是否收紧未平仓量或主动买量条件。`
        : `本次大户增多确认与持仓后走势一致；${finalOutcomeSummary}，继续积累相同引擎版本样本验证稳定性。`,
    });
  }
  if (entrySlippagePercent !== null && entrySlippagePercent > 0.15) {
    suggestions.push({
      parameterName: "execution.orderType",
      label: "成交滑点",
      currentValue: input.config.execution.orderType,
      suggestedValue: input.config.execution.orderType,
      action: "OBSERVE",
      confidence: 0.5,
      reason: `实际入场相对判断价出现 ${entrySlippagePercent.toFixed(3)}% 不利滑点；小资金阶段继续记录延迟，暂不自动改为可能错失成交的限价单。`,
    });
  }
  if (clearlyWeak && adverseMarketRatio !== null && adverseMarketRatio >= 0.6) {
    suggestions.unshift({
      parameterName: "marketRegimeObservation",
      label: "大盘逆风归因",
      currentValue: round(adverseMarketRatio * 100, 1),
      suggestedValue: "WAIT_FOR_MORE_SAMPLES",
      action: "OBSERVE",
      confidence: 0.5,
      reason: `持仓后 ${(adverseMarketRatio * 100).toFixed(0)}% 的有效分钟处于大盘逆风，当前弱势不能全部归因于入场参数；先积累同类样本，不自动放宽止损。`,
    });
  } else if (!clearlyWeak && favorableMarketRatio !== null && favorableMarketRatio >= 0.6) {
    suggestions.unshift({
      parameterName: "marketRegimeObservation",
      label: "大盘顺风归因",
      currentValue: round(favorableMarketRatio * 100, 1),
      suggestedValue: "VERIFY_IN_NEUTRAL_MARKET",
      action: "OBSERVE",
      confidence: 0.45,
      reason: `持仓后 ${(favorableMarketRatio * 100).toFixed(0)}% 的有效分钟处于大盘顺风，本次盈利包含市场推动，需在中性行情继续验证入场逻辑。`,
    });
  }
  if (
    clearlyWeak &&
    breakdownPressureRatio !== null &&
    breakdownPressureRatio >= 0.4
  ) {
    suggestions.unshift({
      parameterName: "postEntryBreakdownObservation",
      label: "入场后破位杀盘",
      currentValue: round(breakdownPressureRatio * 100, 1),
      suggestedValue: "COMPARE_BEFORE_EARLY_EXIT_RULE",
      action: "OBSERVE",
      confidence: 0.58,
      reason:
        `持仓后 ${(breakdownPressureRatio * 100).toFixed(0)}% 的有效分钟同时出现支撑连续收盘失守和SELL强平压力；` +
        "先用同引擎版本的最终盈亏验证该状态，再决定是否增加提前减仓，避免单样本过度拟合。",
    });
  }
  if (
    capitalExitShadow.status === "PROTECTIVE" ||
    capitalExitShadow.status === "MISSED_RECOVERY"
  ) {
    suggestions.unshift({
      parameterName: "postEntryCapitalWithdrawalExit",
      label: "资金撤退退出影子",
      currentValue: "OBSERVATION_ONLY",
      suggestedValue:
        capitalExitShadow.status === "PROTECTIVE"
          ? "ADD_TO_PROTECTIVE_CONTROL_GROUP"
          : "KEEP_OBSERVATION_ONLY",
      action: "OBSERVE",
      confidence: capitalExitShadow.status === "PROTECTIVE" ? 0.58 : 0.5,
      reason:
        `${capitalExitShadow.summary} 单笔结果不改变实盘平仓；需由同引擎对照组证明保护率显著高于错失恢复率。`,
    });
  }
  if (!suggestions.length) {
    suggestions.push({
      parameterName: "configuration",
      label: "当前参数",
      currentValue: "KEEP",
      suggestedValue: "KEEP",
      action: "KEEP",
      confidence: 0.6,
      reason: "入场后早期ROE、最大有利波动和回撤未显示明确异常，建议保持参数并继续积累样本。",
    });
  }
  if (
    observationMode === "ACTUAL_POSITION" &&
    earlySamples.length &&
    !causalAttributionReady
  ) {
    suggestions.unshift({
      parameterName: "evidence.causalCompleteness",
      label: "持仓后因果证据完整性",
      currentValue: {
        causalSamples: causalEvidenceSampleCount,
        incompleteCausalSamples: incompleteCausalSampleCount,
        priceOnlySamples: priceOnlySampleCount,
        missingCausalDimensions,
      },
      suggestedValue: "COLLECT_CAUSAL_REALTIME_CHECKPOINTS",
      action: "OBSERVE",
      confidence: 1,
      reason:
        `${evidenceCompletenessSummary}；当前ROE仍可用于收益路径统计，但不得据此归因趋势、破位、资金或大盘条件。`,
    });
  }

  const quality = giveback ? "GIVEBACK" : enteredLate ? "LATE" : clearlyWeak ? "WEAK" : "GOOD";
  const qualitySummary = quality === "GOOD"
    ? "本次入场后走势与判断方向一致，当前参数暂不调整。"
    : quality === "GIVEBACK"
      ? "本次曾出现有效盈利但回撤较大，应重点复核移动止损。"
      : quality === "LATE"
        ? "本次入场位置偏晚且早期表现较弱，应减少追价。"
        : "本次入场后确认偏弱，应收紧量能或价格位置条件。";
  const summary =
    observationMode === "ACTUAL_POSITION" && !causalAttributionReady
      ? `${qualitySummary} 但${evidenceCompletenessSummary}，本次结论只描述价格结果，不作为入场因果调参依据。`
      : qualitySummary;
  return {
    symbol,
    decisionAtMs,
    observationMode,
    rejectionCode,
    sampleCount: earlySamples.length,
    causalEvidenceSampleCount,
    causalEvidenceCoverageRatio,
    priceOnlySampleCount,
    incompleteCausalSampleCount,
    missingCausalDimensions,
    causalAttributionReady,
    evidenceCompletenessSummary,
    latestMinute: latest?.minuteOffset ?? null,
    latestRoePercent: latestRoe,
    bestRoePercent: bestRoe,
    worstRoePercent: worstRoe,
    positiveMinuteRatio,
    entrySlippagePercent,
    ...entryExecutionContext,
    entryPosition24hPercent,
    entryPosition72hPercent,
    entryVolumeRatio3m,
    entryDistanceAtr,
    ...consensusContext,
    ...largeTraderContext,
    ...liquiditySweepContext,
    ...postBreakRecoveryContext,
    entryTriggerKind,
    ...liquidationClusterContext,
    ...concurrentExposureContext,
    ...finalOutcomeContext,
    ...marketContext,
    ...globalLiquidationContext,
    ...breakdownContext,
    ...postEntryLargeTraderContext,
    longHoldAnalysis,
    capitalExitShadow,
    positionManagementDecisionOutcome,
    ...waveThesisContext,
    ...waveEntryAttributionContext,
    deeperLimitCounterfactual,
    deeperLimitCounterfactual30m,
    deeperLimitCounterfactual60m,
    delayedReclaimCounterfactual,
    delayedReclaimCounterfactual30m,
    delayedReclaimCounterfactual60m,
    sentinelShadowEntryValidation,
    quality,
    summary,
    suggestions,
  };
}

function sampleMarketRegime(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  const marketRegime = detail.marketRegime;
  if (!marketRegime || typeof marketRegime !== "object" || Array.isArray(marketRegime))
    return null;
  const status = (marketRegime as Record<string, unknown>).status;
  return status === "FAVORABLE" || status === "NEUTRAL" ||
    status === "ADVERSE" || status === "UNAVAILABLE"
    ? status
    : null;
}

export function buildPostEntryEvidenceWindow(input: {
  samples: PostEntrySample[];
  observationMode: "ACTUAL_POSITION" | "REJECTED_COUNTERFACTUAL";
  holdingDurationMinutes?: number | null;
}) {
  const samples = [...input.samples].sort(
    (a, b) => a.minuteOffset - b.minuteOffset,
  );
  if (input.observationMode === "REJECTED_COUNTERFACTUAL")
    return {
      mode: "REJECTED_1_TO_10" as const,
      samples: samples.filter((sample) => sample.minuteOffset <= 10),
    };

  const terminalShortWave =
    Number.isFinite(input.holdingDurationMinutes) &&
    Number(input.holdingDurationMinutes) < 30;
  if (terminalShortWave)
    return {
      mode: "TERMINAL_SHORT_WAVE_PATH" as const,
      // A pure settlement receipt carries the outcome but no market context.
      // If the terminal receipt was merged into an enriched checkpoint, keep
      // it because its causal facts remain valid.
      samples: samples.filter((sample) => !sampleIsTerminalSettlementOnly(sample)),
    };

  const explicitCheckpointSamples = samples.filter(sampleIsModelCheckpoint);
  if (explicitCheckpointSamples.length)
    return {
      mode: "MODEL_CHECKPOINTS" as const,
      samples: explicitCheckpointSamples,
    };

  // Historical records created before the explicit model-checkpoint marker
  // used 5/30/60. Keep them readable without reconstructing missing facts.
  const legacyCheckpointSamples = samples.filter((sample) =>
    [5, 30, 60].includes(sample.minuteOffset)
  );
  if (legacyCheckpointSamples.some((sample) => sample.minuteOffset >= 30))
    return {
      mode: "LEGACY_MODEL_CHECKPOINTS" as const,
      samples: legacyCheckpointSamples,
    };
  return {
    mode: "LEGACY_1_TO_10" as const,
    samples: samples.filter((sample) => sample.minuteOffset <= 10),
  };
}

function sampleIsModelCheckpoint(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  return detail.modelCheckpoint === true ||
    detail.sampleType === "POST_ENTRY_MODEL_CHECKPOINT" ||
    detail.sampleType === "POST_ENTRY_MODEL_CHECKPOINT_BACKFILL";
}

function sampleIsTerminalSettlementOnly(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  const terminalSettlement =
    detail.sampleType === "POSITION_TERMINAL_SETTLEMENT" ||
    detail.evidenceCompleteness === "TERMINAL_SETTLEMENT";
  return terminalSettlement && !sampleHasCausalAttributionEvidence(sample);
}

export type PostEntryCausalCompleteness = {
  complete: boolean;
  missingDimensions: string[];
  optionalMissingDimensions: string[];
};

export function evaluatePostEntryCausalAttribution(input: {
  samples: PostEntrySample[];
  observationMode: "ACTUAL_POSITION" | "REJECTED_COUNTERFACTUAL";
}) {
  const causalEvidenceSampleCount = input.samples.filter(
    sampleHasCausalAttributionEvidence,
  ).length;
  const priceOnlySampleCount = input.samples.filter(sampleIsPriceOnly).length;
  const incompleteCausalSampleCount = Math.max(
    0,
    input.samples.length -
      causalEvidenceSampleCount -
      priceOnlySampleCount,
  );
  const missingCausalDimensions = [
    ...new Set(
      input.samples.flatMap((sample) => {
        if (sampleIsPriceOnly(sample)) return [];
        const detail = sample.detail ?? parseRecord(sample.evidenceJson);
        return evaluatePostEntryCausalCompleteness(detail).missingDimensions;
      }),
    ),
  ];
  const causalEvidenceCoverageRatio = input.samples.length
    ? causalEvidenceSampleCount / input.samples.length
    : null;
  const latestCausalSample = [...input.samples]
    .reverse()
    .find((sample) => !sampleIsPriceOnly(sample));
  const causalAttributionReady =
    input.observationMode === "ACTUAL_POSITION" &&
    causalEvidenceSampleCount >= 3 &&
    causalEvidenceCoverageRatio !== null &&
    causalEvidenceCoverageRatio >= 0.6 &&
    Boolean(
      latestCausalSample &&
        sampleHasCausalAttributionEvidence(latestCausalSample),
    );
  return {
    causalEvidenceSampleCount,
    causalEvidenceCoverageRatio,
    priceOnlySampleCount,
    incompleteCausalSampleCount,
    missingCausalDimensions,
    causalAttributionReady,
  };
}

export function evaluatePostEntryCausalCompleteness(
  detail: Record<string, unknown>,
): PostEntryCausalCompleteness {
  const missingDimensions: string[] = [];
  const optionalMissingDimensions: string[] = [];
  const marketRegime = directRecord(detail.marketRegime);
  const waveStructure = directRecord(detail.waveStructure);
  const breakdownObservation = directRecord(detail.breakdownObservation);
  const largeTraderObservation = directRecord(
    detail.postEntryLargeTraderObservation,
  );
  const fundingVolumeObservation = directRecord(
    detail.postEntryFundingVolumeObservation,
  );
  const tradeVolumeObservation = directRecord(
    detail.postEntryTradeVolumeObservation,
  );
  const trendPath = directRecord(detail.postEntryTrendPath);
  const contractTrendProfile = directRecord(
    detail.postEntryContractTrendProfile,
  );
  const managementDecision = directRecord(
    detail.positionManagementDecision,
  );
  const marketStatus = String(marketRegime.status ?? "");
  if (!["FAVORABLE", "NEUTRAL", "ADVERSE"].includes(marketStatus))
    optionalMissingDimensions.push("MARKET_REGIME");
  const waveState = String(waveStructure.state ?? "");
  if (
    !["NORMAL_RANGE", "UPSIDE_BREAKOUT", "SUPPORT_BREAK"].includes(
      waveState,
    )
  )
    missingDimensions.push("WAVE_STRUCTURE");
  const breakdownStatus = String(breakdownObservation.status ?? "");
  const shortBreakdownNotApplicable =
    detail.positionSide === "SHORT" && breakdownStatus === "NOT_APPLICABLE";
  if (
    !shortBreakdownNotApplicable &&
    !["STABLE", "WATCH", "BREAKDOWN_PRESSURE"].includes(breakdownStatus)
  )
    missingDimensions.push("BREAKDOWN_OBSERVATION");
  const largeTraderStatus = String(largeTraderObservation.status ?? "");
  if (
    !["SUPPORT_CONTINUES", "CAPITAL_WITHDRAWAL", "MIXED"].includes(
      largeTraderStatus,
    )
  )
    optionalMissingDimensions.push("LARGE_TRADER_POSITIONING");
  const fundingVolumeStatus = String(
    fundingVolumeObservation.status ?? "",
  );
  if (
    ![
      "SQUEEZE_CONTINUATION",
      "POSITION_CONTINUATION",
      "CROWDING_REVERSAL_RISK",
      "POSITIONING_UNWINDING",
      "MIXED",
    ].includes(fundingVolumeStatus)
  )
    optionalMissingDimensions.push("FUNDING_VOLUME_TRANSITION");
  const tradeVolumeProvided = Object.prototype.hasOwnProperty.call(
    detail,
    "postEntryTradeVolumeObservation",
  );
  const tradeVolumeStatus = String(tradeVolumeObservation.status ?? "");
  if (
    tradeVolumeProvided &&
    ![
      "DIRECTIONAL_EXPANSION",
      "OPPOSITE_EXPANSION",
      "CONTRACTING",
      "MIXED",
    ].includes(tradeVolumeStatus)
  )
    missingDimensions.push("POST_ENTRY_TRADE_VOLUME");
  const trendPathProvided = Object.prototype.hasOwnProperty.call(
    detail,
    "postEntryTrendPath",
  );
  const trendPathStatus = String(trendPath.status ?? "");
  if (
    trendPathProvided &&
    ![
      "EARLY_PROBE",
      "RANGE",
      "CONTINUATION_CONFIRMED",
      "MOMENTUM_DECAY",
      "RECOVERY_CONFIRMED",
      "REVERSAL_PRESSURE",
    ].includes(trendPathStatus)
  )
    missingDimensions.push("TREND_PATH");
  if (
    contractTrendProfile.requiredForDecision === true &&
    !["ALIGNED", "PULLBACK", "TRANSITION", "OPPOSED", "RANGE"].includes(
      String(contractTrendProfile.status ?? ""),
    )
  ) missingDimensions.push("MULTI_HOUR_CONTRACT_TREND");
  const managementMissing = Array.isArray(managementDecision.missingEvidence)
    ? managementDecision.missingEvidence.filter(
        (value) => typeof value === "string" && value.trim(),
      )
    : null;
  const requiredManagementMissing = managementMissing?.filter(
    (value) =>
      value !== "LARGE_TRADER_STATUS" &&
      value !== "LARGE_TRADER_POSITIONING" &&
      value !== "MARKET_REGIME" &&
      value !== "FUNDING_VOLUME_TRANSITION",
  );
  if (
    typeof managementDecision.action !== "string" ||
    !requiredManagementMissing ||
    requiredManagementMissing.length > 0
  )
    missingDimensions.push("POSITION_MANAGEMENT_DECISION");
  if (
    detail.orderSource === "STRATEGY" &&
    detail.entryEvidenceAvailable !== true
  )
    missingDimensions.push("ENTRY_EVIDENCE");
  return {
    complete: missingDimensions.length === 0,
    missingDimensions,
    optionalMissingDimensions,
  };
}

function sampleHasCausalAttributionEvidence(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  if (detail.evidenceCompleteness === "PRICE_PATH_ONLY") return false;
  return evaluatePostEntryCausalCompleteness(detail).complete;
}

function sampleIsPriceOnly(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  return detail.evidenceCompleteness === "PRICE_PATH_ONLY";
}

function sampleGlobalLiquidationContext(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  const context = detail.globalLiquidationContext;
  return context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, unknown>
    : null;
}

function sampleBreakdownStatus(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  const observation = detail.breakdownObservation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation))
    return null;
  const status = (observation as Record<string, unknown>).status;
  return status === "STABLE" ||
      status === "WATCH" ||
      status === "BREAKDOWN_PRESSURE" ||
      status === "UNAVAILABLE" ||
      status === "NOT_APPLICABLE"
    ? status
    : null;
}

function samplePostEntryLargeTraderStatus(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  const observation = detail.postEntryLargeTraderObservation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation))
    return null;
  const status = (observation as Record<string, unknown>).status;
  return status === "SUPPORT_CONTINUES" ||
      status === "CAPITAL_WITHDRAWAL" ||
      status === "MIXED" ||
      status === "UNAVAILABLE" ||
      status === "NOT_APPLICABLE" ||
      status === "NOT_SCHEDULED"
    ? status
    : null;
}

function samplePositionManagementDecision(sample: PostEntrySample) {
  const detail = sample.detail ?? parseRecord(sample.evidenceJson);
  const decision = detail.positionManagementDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision))
    return null;
  const record = decision as Record<string, unknown>;
  return {
    action: typeof record.action === "string" ? record.action : null,
    currentRoePercent: finiteOrNull(record.currentRoePercent),
    bestRoePercent: finiteOrNull(record.bestRoePercent),
  };
}

function parseRecord(value?: string) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function directRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function buildAggregateParameterSuggestions(input: {
  config: LiquidationTrendConfig;
  analyses: PostEntryAnalysis[];
  sentinelShadowValidations?: NexusSentinelShadowEntryValidation[];
  minimumOrders: number;
}) {
  const actualComplete = input.analyses.filter(
    (analysis) =>
      analysis.observationMode === "ACTUAL_POSITION" &&
      analysis.sampleCount >= 3 &&
      analysis.latestMinute !== null &&
      analysis.latestMinute >= 60,
  );
  const rejectedComplete = input.analyses.filter(
    (analysis) =>
      analysis.observationMode === "REJECTED_COUNTERFACTUAL" &&
      analysis.latestMinute !== null &&
      analysis.latestMinute >= 10,
  );
  const complete = [...actualComplete, ...rejectedComplete];
  const independentActualComplete = deduplicateWaveOpportunities(
    actualComplete,
  );
  const causalIndependentActualComplete = independentActualComplete.filter(
    (analysis) => analysis.causalAttributionReady === true,
  );
  const knownRepeatedWaveExcludedCount =
    actualComplete.length - independentActualComplete.length;
  const waveSymbolSelection = analyzeWaveSymbolSelection({
    rows: actualComplete.map((analysis) => ({
      clusterId: analysis.entryMarketClusterId,
      symbol: analysis.symbol,
      // The within-wave comparison estimates associations between entry-time
      // symbol features and a real 60-minute outcome. It deliberately does
      // not require post-entry market/large-trader/management context, which
      // cannot be reconstructed for historical checkpoints. Full causal
      // parameter attribution remains protected by causalAttributionReady.
      entryComparisonEvidenceComplete:
        Boolean(analysis.symbol) &&
        Boolean(analysis.entryMarketClusterId) &&
        analysis.consensusRoe60mPercent !== null &&
        [
          analysis.entryPosition72hPercent,
          analysis.entryVolumeRatio3m,
          analysis.entrySymbolLiquidationSharePercent,
          analysis.entrySymbolContributionRank,
          analysis.entryDistanceAtr,
        ].some((value) => value !== null && Number.isFinite(value)),
      roe60mPercent: analysis.consensusRoe60mPercent,
      position72hPercent: analysis.entryPosition72hPercent,
      volumeRatio3m: analysis.entryVolumeRatio3m,
      symbolLiquidationSharePercent:
        analysis.entrySymbolLiquidationSharePercent,
      symbolContributionRank: analysis.entrySymbolContributionRank,
      entryDistanceAtr: analysis.entryDistanceAtr,
      largeTraderStatus: analysis.entryLargeTraderStatus,
      liquiditySweepStatus: analysis.entryLiquiditySweepStatus,
    })),
  });
  const actualReady =
    independentActualComplete.length >= input.minimumOrders;
  const causalActualReady =
    causalIndependentActualComplete.length >= input.minimumOrders;
  const weakRate = causalIndependentActualComplete.length
    ? causalIndependentActualComplete.filter((analysis) =>
        ["WEAK", "LATE"].includes(analysis.quality)
      ).length / causalIndependentActualComplete.length
    : 0;
  const givebackRate = independentActualComplete.length
    ? independentActualComplete.filter(
        (analysis) => analysis.quality === "GIVEBACK",
      ).length / independentActualComplete.length
    : 0;
  const earlyActivationRate = independentActualComplete.length
    ? independentActualComplete.filter((analysis) =>
        analysis.suggestions.some(
          (suggestion) =>
            suggestion.parameterName === "risk.trailingActivationPercent",
        )
      ).length / independentActualComplete.length
    : 0;
  const confidenceFor = (count: number) =>
    round(Math.min(0.95, 0.55 + count / Math.max(input.minimumOrders, 1) * 0.2), 2);
  const actualConfidence = confidenceFor(actualComplete.length);
  const rejectedConfidence = confidenceFor(rejectedComplete.length);
  const result: PostEntrySuggestion[] = [];
  const sentinelShadowMinimumGroupSamples = Math.max(
    3,
    Math.ceil(input.minimumOrders * 0.2),
  );
  const sentinelShadowSummary =
    summarizeNexusSentinelShadowEntryValidations({
      rows: (
        input.sentinelShadowValidations ??
        input.analyses.map(
          (analysis) => analysis.sentinelShadowEntryValidation,
        )
      ).map((validation) => ({ validation })),
      minimumGroupSamples: sentinelShadowMinimumGroupSamples,
    });
  if (sentinelShadowSummary.sampleCount > 0) {
    result.push({
      parameterName: "learning.sentinelShadowEntryTiming",
      label: "哨兵影子入场验证",
      currentValue: sentinelShadowSummary,
      suggestedValue: sentinelShadowSummary.reviewSignal,
      action: "OBSERVE",
      confidence: round(
        Math.min(
          0.95,
          sentinelShadowSummary.finalizedSamples /
            Math.max(sentinelShadowMinimumGroupSamples, 1),
        ),
        2,
      ),
      reason:
        `${sentinelShadowSummary.summary} ` +
        "影子结果仅进入学习记忆与运营复核，不参与当前下单授权，也不会自动修改正式参数。",
    });
  }
  if (waveSymbolSelection.totalMultiSymbolClusters > 0) {
    result.push({
      parameterName: "selection.waveRelativeStrength",
      label: "同波段选币归因",
      currentValue: waveSymbolSelection,
      suggestedValue:
        waveSymbolSelection.verdict === "OBSERVATION_READY"
          ? "REVIEW_STABLE_WINNER_FEATURES"
          : "COLLECT_MORE_INDEPENDENT_WAVES",
      action: "OBSERVE",
      confidence: round(
        Math.min(
          0.9,
          waveSymbolSelection.entryComparableClusters /
            Math.max(waveSymbolSelection.minimumClusters, 1),
        ),
        2,
      ),
      reason:
        `${waveSymbolSelection.summary} 同一波段的多合约不重复计算为独立胜率样本，` +
        "但会配对比较赢家与输家的72小时价格位置、3分钟量能、爆仓贡献、入场距离、大户持仓和扫盘收回状态。",
    });
  }
  const repeatedWaveCohorts = waveClusterCohorts(actualComplete)
    .filter((cohort) => cohort.rows.length > 1)
    .map((cohort) => {
      const roeValues = cohort.rows
        .map(waveRepresentativeRoe)
        .filter((value): value is number => value !== null);
      const firstTakeProfit =
        input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0;
      const reachedFirstTakeProfit = cohort.rows.filter(
        (analysis) =>
          analysis.bestRoePercent !== null &&
          analysis.bestRoePercent >= firstTakeProfit,
      ).length;
      return {
        clusterId: cohort.clusterId,
        positions: cohort.rows.length,
        comparablePositions: roeValues.length,
        medianRoePercent: median(roeValues),
        minimumRoePercent: roeValues.length ? Math.min(...roeValues) : null,
        maximumRoePercent: roeValues.length ? Math.max(...roeValues) : null,
        firstTakeProfitReachedPositions: reachedFirstTakeProfit,
      };
    });
  if (repeatedWaveCohorts.length) {
    const comparable = repeatedWaveCohorts.filter(
      (cohort) =>
        cohort.minimumRoePercent !== null &&
        cohort.maximumRoePercent !== null,
    );
    const widest = comparable
      .map((cohort) => ({
        ...cohort,
        rangeRoePercent:
          cohort.maximumRoePercent! - cohort.minimumRoePercent!,
      }))
      .sort(
        (left, right) => right.rangeRoePercent - left.rangeRoePercent,
      )[0] ?? null;
    const totalPositions = repeatedWaveCohorts.reduce(
      (sum, cohort) => sum + cohort.positions,
      0,
    );
    const firstTakeProfitReachedPositions = repeatedWaveCohorts.reduce(
      (sum, cohort) => sum + cohort.firstTakeProfitReachedPositions,
      0,
    );
    result.push({
      parameterName: "concurrency.waveClusterDispersion",
      label: "同波段多合约离散度",
      currentValue: {
        clusterCount: repeatedWaveCohorts.length,
        positionCount: totalPositions,
        firstTakeProfitRoePercent:
          input.config.risk.takeProfitSteps[0]?.profitPercent ?? null,
        firstTakeProfitReachedPositions,
        cohorts: repeatedWaveCohorts,
        widestCluster: widest,
      },
      suggestedValue: "KEEP_CLUSTER_MEDIAN_AND_SYMBOL_DISPERSION",
      action: "OBSERVE",
      confidence: confidenceFor(repeatedWaveCohorts.length),
      reason:
        `${repeatedWaveCohorts.length}个同波段多合约组合共 ${totalPositions} 个仓位，` +
        `${firstTakeProfitReachedPositions} 个曾达到首档止盈。独立波段统计使用组内中位表现，` +
        `同时保留最好、最差和区间，避免按记录顺序随机忽略盈利或亏损尾部。` +
        (widest
          ? `当前最大组内差异 ${widest.rangeRoePercent.toFixed(2)} 个ROE百分点。`
          : ""),
    });
  }
  if (independentActualComplete.length && !actualReady) {
    const latestExploratory = [...independentActualComplete]
      .sort(
        (left, right) =>
          (left.decisionAtMs ?? 0) - (right.decisionAtMs ?? 0),
      )
      .slice(-2);
    const exactNetCount = latestExploratory.filter(
      (analysis) =>
        analysis.finalPnlBasis === "NET_EXACT" &&
        analysis.finalRealizedPnl !== null,
    ).length;
    const directionInvalidatedCount = latestExploratory.filter(
      (analysis) => analysis.waveDirectionVerdict === "INVALIDATED",
    ).length;
    const tooEarlyCount = latestExploratory.filter(
      (analysis) => analysis.waveEntryTimingVerdict === "TOO_EARLY",
    ).length;
    const givebackCount = latestExploratory.filter(
      (analysis) =>
        analysis.waveThesisOutcome === "PROFIT_GIVEBACK" ||
        analysis.quality === "GIVEBACK",
    ).length;
    const slippageValues = latestExploratory
      .map((analysis) => analysis.entrySlippagePercent)
      .filter((value): value is number => value !== null);
    const averageEntrySlippagePercent = slippageValues.length
      ? slippageValues.reduce((sum, value) => sum + value, 0) /
        slippageValues.length
      : null;
    const diagnosis = exactNetCount < latestExploratory.length
      ? "SETTLEMENT_EVIDENCE_INCOMPLETE"
      : directionInvalidatedCount
        ? "DIRECTION_EVIDENCE_FAILED"
        : tooEarlyCount
          ? "ENTRY_TIMING_TOO_EARLY"
          : givebackCount
            ? "PROFIT_CAPTURE_GIVEBACK"
            : "WAIT_FOR_MORE_INDEPENDENT_WAVES";
    result.push({
      parameterName: "pilot.exploratoryTwoTradeDiagnostic",
      label: "最近两笔独立波段探索诊断",
      currentValue: {
        independentSamples: independentActualComplete.length,
        latestExploratorySamples: latestExploratory.length,
        knownRepeatedWaveExcludedCount,
        exactNetSamples: exactNetCount,
        directionInvalidatedCount,
        tooEarlyCount,
        givebackCount,
        averageEntrySlippagePercent:
          averageEntrySlippagePercent === null
            ? null
            : round(averageEntrySlippagePercent, 4),
        minimumSamplesForParameterChange: input.minimumOrders,
      },
      suggestedValue: diagnosis,
      action: "OBSERVE",
      confidence: round(
        Math.min(
          0.2,
          independentActualComplete.length /
            Math.max(input.minimumOrders, 1),
        ),
        2,
      ),
      reason:
        `最近 ${latestExploratory.length} 笔独立波段只用于排查执行、方向、入场时机和利润保护；` +
        `已排除 ${knownRepeatedWaveExcludedCount} 笔同波段重复暴露。当前诊断 ${diagnosis}，` +
        `至少积累 ${input.minimumOrders} 笔独立完整样本前，不自动改变实盘参数。`,
    });
  }
  const exactNetClosed = independentActualComplete.filter(
    (analysis) =>
      analysis.finalPnlBasis === "NET_EXACT" &&
      analysis.finalRealizedPnl !== null &&
      analysis.finalOutcome !== "OPEN" &&
      analysis.finalOutcome !== "UNKNOWN",
  );
  if (exactNetClosed.length > 0) {
    const movingProtectionReview = evaluateMovingProtectionReview({
      samples: exactNetClosed,
      minimumOrders: input.minimumOrders,
      trailingActivationRoePercent:
        input.config.risk.trailingActivationPercent,
      trailingDrawdownRoePoints:
        input.config.risk.trailingDrawdownPercent,
      firstTakeProfitRoePercent:
        input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0,
    });
    result.push({
      parameterName: "risk.movingProtectionReview",
      label: "移动保护参数评估",
      currentValue: movingProtectionReview,
      suggestedValue: movingProtectionReview.candidate
        ? {
            displayValue:
              `${movingProtectionReview.candidate.candidateValue}% 影子候选`,
            ...movingProtectionReview.candidate,
          }
        : {
            displayValue:
              movingProtectionReview.status === "KEEP_CURRENT"
                ? "保持当前参数"
                : "继续积累完整周期",
            status: movingProtectionReview.status,
          },
      action: "OBSERVE",
      confidence: round(
        Math.min(
          0.9,
          movingProtectionReview.automatedComparableSamples /
            movingProtectionReview.minimumCandidateSamples,
        ),
        2,
      ),
      reason: movingProtectionReview.summary,
    });
  }
  const overallNetProfitability = exactNetClosed.length
    ? empiricalNetProfitability(
        exactNetClosed.map((analysis) => analysis.finalRealizedPnl!),
      )
    : null;
  if (exactNetClosed.length >= input.minimumOrders) {
    const profitability = overallNetProfitability!;
    const theoretical = strategyPayoffProfile({
      stopLossRoePercent: input.config.risk.stopLossPercent,
      takeProfitSteps: input.config.risk.takeProfitSteps,
      leverage: input.config.execution.leverage,
    });
    result.push({
      parameterName: "profitability.netExpectancy",
      label: "交易成本后真实盈利能力",
      currentValue: {
        exactNetSamples: profitability.sampleCount,
        knownRepeatedWaveExcludedCount,
        totalNetPnlUsdt: round(profitability.totalNetPnlUsdt, 4),
        averageNetPnlUsdt: round(profitability.averageNetPnlUsdt, 4),
        profitFactor: profitability.profitFactor === Number.POSITIVE_INFINITY
          ? "NO_LOSSES"
          : profitability.profitFactor === null
            ? null
            : round(profitability.profitFactor, 3),
        decisiveWinRatePercent:
          profitability.decisiveWinRatePercent === null
            ? null
            : round(profitability.decisiveWinRatePercent, 1),
        empiricalBreakEvenWinRatePercent:
          profitability.breakEvenWinRatePercent === null
            ? null
            : round(profitability.breakEvenWinRatePercent, 1),
        wilsonLowerWinRatePercent:
          profitability.wilsonLowerWinRatePercent === null
            ? null
            : round(profitability.wilsonLowerWinRatePercent, 1),
      },
      suggestedValue: profitability.statisticallySupported
        ? "POSITIVE_EDGE_SUPPORTED"
        : profitability.positiveExpectancy
          ? "POSITIVE_BUT_MORE_EVIDENCE_REQUIRED"
          : "NEGATIVE_EXPECTANCY_REVIEW_REQUIRED",
      action: profitability.statisticallySupported ? "KEEP" : "OBSERVE",
      confidence: confidenceFor(profitability.sampleCount),
      reason:
        `仅使用 ${profitability.sampleCount} 笔手续费与资金费已精确回填的完整实盘订单：累计净收益 ${profitability.totalNetPnlUsdt.toFixed(4)} USDT，` +
        `单笔平均 ${profitability.averageNetPnlUsdt.toFixed(4)} USDT，胜/负 ${profitability.wins}/${profitability.losses}，` +
        `实际决胜胜率 ${profitability.decisiveWinRatePercent?.toFixed(1) ?? "—"}%，经验保本胜率 ${profitability.breakEvenWinRatePercent?.toFixed(1) ?? "—"}%，` +
        `95%胜率下界 ${profitability.wilsonLowerWinRatePercent?.toFixed(1) ?? "—"}%。` +
        (profitability.statisticallySupported
          ? "净期望为正且保守胜率下界仍高于经验保本胜率，当前盈利优势获得样本支持。"
          : profitability.positiveExpectancy
            ? `当前净期望为正，但统计证据尚不足；配置模型保本胜率 ${theoretical?.breakEvenWinRatePercent?.toFixed(1) ?? "无法计算"}%，继续积累真实净结算。`
            : "交易成本后的单笔期望未转正，应优先复核入场胜率、平均亏损和退出结构，不以毛盈利掩盖净亏损。"),
    });
  }
  const minimumConcurrencyGroup = Math.max(
    5,
    Math.ceil(input.minimumOrders * 0.2),
  );
  const independentNet = exactNetClosed.filter(
    (analysis) =>
      analysis.entrySameMarketClusterOpenPositions === 0,
  );
  const repeatedClusterNet = exactNetClosed.filter(
    (analysis) =>
      (analysis.entrySameMarketClusterOpenPositions ?? 0) >= 1,
  );
  if (
    independentNet.length >= minimumConcurrencyGroup &&
    repeatedClusterNet.length >= minimumConcurrencyGroup
  ) {
    const averageNet = (rows: PostEntryAnalysis[]) =>
      rows.reduce(
        (sum, analysis) => sum + (analysis.finalRealizedPnl ?? 0),
        0,
      ) / rows.length;
    const lossRate = (rows: PostEntryAnalysis[]) =>
      rows.filter((analysis) => analysis.finalOutcome === "LOSS").length /
      rows.length;
    const independentAverage = averageNet(independentNet);
    const repeatedAverage = averageNet(repeatedClusterNet);
    const independentLossRate = lossRate(independentNet);
    const repeatedLossRate = lossRate(repeatedClusterNet);
    const repeatedUnderperforms =
      repeatedAverage + 0.05 < independentAverage &&
      repeatedLossRate >= independentLossRate + 0.15;
    result.push({
      parameterName: "concurrency.sameMarketClusterExposure",
      label: "同波段并发暴露",
      currentValue: {
        independentSamples: independentNet.length,
        repeatedSamples: repeatedClusterNet.length,
        independentAverageNetPnlUsdt: round(independentAverage, 4),
        repeatedAverageNetPnlUsdt: round(repeatedAverage, 4),
        independentLossRatePercent: round(independentLossRate * 100, 1),
        repeatedLossRatePercent: round(repeatedLossRate * 100, 1),
      },
      suggestedValue: repeatedUnderperforms
        ? "REDUCE_SAME_CLUSTER_CONCURRENCY"
        : "KEEP_CONFIGURED_CONCURRENCY",
      action: repeatedUnderperforms ? "OBSERVE" : "KEEP",
      confidence: confidenceFor(
        Math.min(independentNet.length, repeatedClusterNet.length),
      ),
      reason: repeatedUnderperforms
        ? `同一全市场爆仓波段下重复入场 ${repeatedClusterNet.length} 笔，单笔平均净收益 ${repeatedAverage.toFixed(4)} USDT、亏损率 ${(repeatedLossRate * 100).toFixed(1)}%；独立机会 ${independentNet.length} 笔为 ${independentAverage.toFixed(4)} USDT、${(independentLossRate * 100).toFixed(1)}%。重复暴露同时少赚至少0.05 USDT且亏损率高15个百分点，建议运营复核同波段并发数量。`
        : `同波段重复入场 ${repeatedClusterNet.length} 笔与独立机会 ${independentNet.length} 笔的净收益和亏损率差异不足以降低并发，保持策略参数控制。`,
    });
  }
  const consensusComparable = complete.filter(
    (analysis) =>
      analysis.entryConsensusVerdict !== null &&
      analysis.consensusRoe30mPercent !== null,
  );
  const consensusQualified = consensusComparable.filter((analysis) =>
    analysis.entryConsensusVerdict === "STRICT_CONSENSUS" ||
    analysis.entryConsensusVerdict === "RECOVERY_CONSENSUS"
  );
  const consensusControls = consensusComparable.filter((analysis) =>
    analysis.entryConsensusVerdict === "MIXED" ||
    analysis.entryConsensusVerdict === "CONFLICT"
  );
  const minimumConsensusGroup = Math.max(
    5,
    Math.ceil(input.minimumOrders * 0.2),
  );
  if (
    consensusQualified.length >= minimumConsensusGroup &&
    consensusControls.length >= minimumConsensusGroup
  ) {
    const qualifiedReturns = consensusQualified.map(
      (analysis) => analysis.consensusRoe30mPercent!,
    );
    const controlReturns = consensusControls.map(
      (analysis) => analysis.consensusRoe30mPercent!,
    );
    const qualifiedPositiveRate =
      qualifiedReturns.filter((value) => value > 0).length /
      qualifiedReturns.length;
    const controlPositiveRate =
      controlReturns.filter((value) => value > 0).length /
      controlReturns.length;
    const qualifiedAverage =
      qualifiedReturns.reduce((sum, value) => sum + value, 0) /
      qualifiedReturns.length;
    const qualifiedMedian = median(qualifiedReturns) ?? 0;
    const executionEdgeBuffer = Math.max(
      0.5,
      (input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.1,
    );
    const readyForReview =
      qualifiedPositiveRate >= 0.6 &&
      qualifiedPositiveRate >= controlPositiveRate + 0.15 &&
      qualifiedAverage > executionEdgeBuffer &&
      qualifiedMedian > executionEdgeBuffer;
    result.push({
      parameterName: "consensusShadow.validation",
      label: "异构证据共识影子",
      currentValue: "MONITOR_ONLY",
      suggestedValue: readyForReview
        ? "READY_FOR_OPERATOR_REVIEW"
        : "KEEP_MONITOR_ONLY",
      action: "OBSERVE",
      confidence: confidenceFor(consensusQualified.length),
      reason: readyForReview
        ? `${consensusQualified.length}笔严格或恢复共识样本的30分钟正收益率 ${(qualifiedPositiveRate * 100).toFixed(1)}%，比 ${consensusControls.length} 笔分歧/冲突对照高 ${((qualifiedPositiveRate - controlPositiveRate) * 100).toFixed(1)} 个百分点；平均/中位ROE ${qualifiedAverage.toFixed(2)}%/${qualifiedMedian.toFixed(2)}%，均超过 ${executionEdgeBuffer.toFixed(2)}% 执行成本缓冲。仅进入人工评审，不自动接入下单。`
        : `${consensusQualified.length}笔共识样本与 ${consensusControls.length} 笔分歧/冲突对照尚未同时证明30分钟正收益率至少提高15个百分点，或平均及中位ROE未超过 ${executionEdgeBuffer.toFixed(2)}% 执行成本缓冲；继续保持纯观察。`,
    });
  }
  const attributedWaves = actualComplete.filter(
    (analysis) =>
      analysis.waveDirectionVerdict !== undefined &&
      analysis.waveDirectionVerdict !== "INSUFFICIENT" &&
      analysis.waveDirectionVerdict !== "UNRESOLVED",
  );
  if (attributedWaves.length >= input.minimumOrders) {
    const timely = attributedWaves.filter(
      (analysis) =>
        analysis.waveDirectionVerdict === "VALIDATED_EARLY" &&
        analysis.waveEntryTimingVerdict === "TIMELY",
    );
    const tooEarly = attributedWaves.filter(
      (analysis) =>
        analysis.waveDirectionVerdict === "VALIDATED_LATE" &&
        analysis.waveEntryTimingVerdict === "TOO_EARLY",
    );
    const invalidated = attributedWaves.filter(
      (analysis) => analysis.waveDirectionVerdict === "INVALIDATED",
    );
    const exactNetAverage = (rows: PostEntryAnalysis[]) => {
      const exact = rows.filter(
        (analysis) =>
          analysis.finalPnlBasis === "NET_EXACT" &&
          analysis.finalRealizedPnl !== null,
      );
      return exact.length
        ? exact.reduce(
            (sum, analysis) => sum + analysis.finalRealizedPnl!,
            0,
          ) / exact.length
        : null;
    };
    const timelyNetAverage = exactNetAverage(timely);
    const tooEarlyNetAverage = exactNetAverage(tooEarly);
    const enoughTooEarlyEvidence =
      tooEarly.length >= Math.max(5, Math.ceil(input.minimumOrders * 0.2));
    const tooEarlyUnderperforms =
      enoughTooEarlyEvidence &&
      timelyNetAverage !== null &&
      tooEarlyNetAverage !== null &&
      tooEarlyNetAverage + 0.05 < timelyNetAverage;
    const invalidatedRate = invalidated.length / attributedWaves.length;
    result.push({
      parameterName: "waveEntry.attribution",
      label: "波段方向与入场时机",
      currentValue: {
        samples: attributedWaves.length,
        timelyValidated: timely.length,
        lateValidatedTooEarly: tooEarly.length,
        invalidated: invalidated.length,
        timelyAverageNetPnlUsdt:
          timelyNetAverage === null ? null : round(timelyNetAverage, 4),
        tooEarlyAverageNetPnlUsdt:
          tooEarlyNetAverage === null ? null : round(tooEarlyNetAverage, 4),
      },
      suggestedValue: tooEarlyUnderperforms
        ? "REVIEW_DEEPER_LIMIT_OR_LATER_RECLAIM"
        : invalidatedRate >= 0.35
          ? "TIGHTEN_DIRECTION_CONFIRMATION"
          : "KEEP_AND_ACCUMULATE",
      action:
        tooEarlyUnderperforms || invalidatedRate >= 0.35 ? "OBSERVE" : "KEEP",
      confidence: confidenceFor(attributedWaves.length),
      reason: tooEarlyUnderperforms
        ? `${tooEarly.length}笔方向到30分钟才验证且前10分钟先明显回撤，精确净收益均值 ${tooEarlyNetAverage!.toFixed(4)} USDT，低于 ${timely.length} 笔及时验证样本的 ${timelyNetAverage!.toFixed(4)} USDT；建议人工对照更深限价偏移或更晚收回确认，不自动修改实盘参数。`
        : invalidatedRate >= 0.35
          ? `${attributedWaves.length}笔可归因样本中，方向被结构或30分钟结果否定 ${(invalidatedRate * 100).toFixed(1)}%；应先收紧方向确认，不把问题误归因于下单价格。`
          : `${attributedWaves.length}笔可归因样本尚未证明“入场过早”相对“及时验证”存在至少0.05 USDT净收益劣势，保持当前参数并继续记录。`,
    });
  }
  const validatedWaveSettlements = exactNetClosed.filter(
    (analysis) =>
      analysis.waveDirectionVerdict === "VALIDATED_EARLY" ||
      analysis.waveDirectionVerdict === "VALIDATED_LATE",
  );
  if (validatedWaveSettlements.length >= input.minimumOrders) {
    const realizedCapture = empiricalNetProfitability(
      validatedWaveSettlements.map(
        (analysis) => analysis.finalRealizedPnl!,
      ),
    );
    const timelySettlements = validatedWaveSettlements.filter(
      (analysis) =>
        analysis.waveDirectionVerdict === "VALIDATED_EARLY" &&
        analysis.waveEntryTimingVerdict === "TIMELY",
    );
    const lateSettlements = validatedWaveSettlements.filter(
      (analysis) =>
        analysis.waveDirectionVerdict === "VALIDATED_LATE" &&
        analysis.waveEntryTimingVerdict === "TOO_EARLY",
    );
    const losingValidatedWaves = validatedWaveSettlements.filter(
      (analysis) => analysis.finalOutcome === "LOSS",
    ).length;
    result.push({
      parameterName: "waveCapture.netRealization",
      label: "主力波段判断净收益兑现",
      currentValue: {
        exactNetSettlements: realizedCapture.sampleCount,
        timelySettlements: timelySettlements.length,
        lateTooEarlySettlements: lateSettlements.length,
        profitableSettlements: realizedCapture.wins,
        losingSettlements: realizedCapture.losses,
        validatedButLosingRatePercent: round(
          losingValidatedWaves / validatedWaveSettlements.length * 100,
          1,
        ),
        totalNetPnlUsdt: round(realizedCapture.totalNetPnlUsdt, 4),
        averageNetPnlUsdt: round(realizedCapture.averageNetPnlUsdt, 4),
        profitFactor:
          realizedCapture.profitFactor === Number.POSITIVE_INFINITY
            ? "NO_LOSSES"
            : realizedCapture.profitFactor === null
              ? null
              : round(realizedCapture.profitFactor, 3),
        decisiveWinRatePercent:
          realizedCapture.decisiveWinRatePercent === null
            ? null
            : round(realizedCapture.decisiveWinRatePercent, 1),
        breakEvenWinRatePercent:
          realizedCapture.breakEvenWinRatePercent === null
            ? null
            : round(realizedCapture.breakEvenWinRatePercent, 1),
        wilsonLowerWinRatePercent:
          realizedCapture.wilsonLowerWinRatePercent === null
            ? null
            : round(realizedCapture.wilsonLowerWinRatePercent, 1),
      },
      suggestedValue: realizedCapture.statisticallySupported
        ? "DOMINANT_WAVE_NET_EDGE_SUPPORTED"
        : realizedCapture.positiveExpectancy
          ? "POSITIVE_CAPTURE_MORE_EVIDENCE_REQUIRED"
          : "DIRECTION_SIGNAL_NOT_MONETIZED",
      action: realizedCapture.statisticallySupported ? "KEEP" : "OBSERVE",
      confidence: confidenceFor(realizedCapture.sampleCount),
      reason:
        `${realizedCapture.sampleCount}笔方向曾被后续价格验证且已完整平仓的订单，全部使用交易成本后精确净结算：` +
        `累计 ${realizedCapture.totalNetPnlUsdt.toFixed(4)} USDT、单笔平均 ${realizedCapture.averageNetPnlUsdt.toFixed(4)} USDT，` +
        `其中 ${losingValidatedWaves} 笔虽然方向被验证却最终亏损。` +
        (realizedCapture.statisticallySupported
          ? "净期望为正，且95%胜率下界仍高于这批交易的经验保本胜率；当前证据支持系统不只是猜对方向，也能把波段兑现为净利润。"
          : realizedCapture.positiveExpectancy
            ? "净期望暂为正，但保守统计下界尚未证明优势稳定；继续积累完整周期，不根据短时ROE放大仓位。"
            : "方向验证没有兑现为交易成本后净利润；优先复核入场过早、利润回吐和退出执行，不能把“曾经涨过”当成策略成功。"),
    });
  }
  const minimumExitEfficiencySamples = Math.max(
    5,
    Math.ceil(input.minimumOrders * 0.5),
  );
  const exitEfficiencyCandidates = validatedWaveSettlements.filter(
    (analysis) =>
      analysis.finalNetRoePercent !== null &&
      analysis.lifetimeBestRoePercent !== null &&
      analysis.lifetimeBestRoePercent > 0,
  );
  const exitEfficiencySamples = exitEfficiencyCandidates.filter(
    (analysis) => analysis.exitAttributionMode === "AUTOMATED_ONLY",
  );
  const operatorExcludedCount = exitEfficiencyCandidates.filter(
    (analysis) =>
      analysis.exitAttributionMode === "OPERATOR_INTERVENED",
  ).length;
  const externalExcludedCount = exitEfficiencyCandidates.filter(
    (analysis) =>
      analysis.exitAttributionMode === "EXTERNAL_UNKNOWN" ||
      analysis.exitAttributionMode === "UNKNOWN",
  ).length;
  if (exitEfficiencySamples.length >= minimumExitEfficiencySamples) {
    const meaningfulWaveRoePercent = Math.max(
      0.5,
      (input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.6,
    );
    const captureEfficiencies = exitEfficiencySamples.map(
      (analysis) =>
        analysis.finalNetRoePercent! /
        analysis.lifetimeBestRoePercent! *
        100,
    );
    const givebacks = exitEfficiencySamples.filter(
      (analysis) =>
        analysis.lifetimeBestRoePercent! >= meaningfulWaveRoePercent &&
        analysis.finalNetRoePercent! <= 0,
    );
    const weakCaptures = exitEfficiencySamples.filter(
      (analysis) =>
        analysis.lifetimeBestRoePercent! >= meaningfulWaveRoePercent &&
        analysis.finalNetRoePercent! <
          analysis.lifetimeBestRoePercent! * 0.3,
    );
    const medianCaptureEfficiency = median(captureEfficiencies) ?? 0;
    const averageFinalNetRoe =
      exitEfficiencySamples.reduce(
        (sum, analysis) => sum + analysis.finalNetRoePercent!,
        0,
      ) / exitEfficiencySamples.length;
    const medianLifetimeBestRoe = median(
      exitEfficiencySamples.map(
        (analysis) => analysis.lifetimeBestRoePercent!,
      ),
    ) ?? 0;
    const holdingDurations = exitEfficiencySamples
      .map((analysis) => analysis.holdingDurationMinutes)
      .filter((value): value is number => value !== null);
    const givebackRate = givebacks.length / exitEfficiencySamples.length;
    const weakCaptureRate =
      weakCaptures.length / exitEfficiencySamples.length;
    const suggestedValue =
      givebackRate >= 0.3
        ? "REVIEW_PROFIT_PROTECTION"
        : medianCaptureEfficiency < 30 || weakCaptureRate >= 0.4
          ? "REVIEW_EXIT_CAPTURE_EFFICIENCY"
          : medianCaptureEfficiency >= 50 && averageFinalNetRoe > 0
            ? "WAVE_CAPTURE_EFFICIENCY_SUPPORTED"
            : "KEEP_COLLECTING_COMPLETE_CYCLES";
    result.push({
      parameterName: "waveCapture.exitEfficiency",
      label: "主力波段利润捕获效率",
      currentValue: {
        exactNetSamples: exitEfficiencySamples.length,
        operatorExcludedCount,
        externalOrUnknownExcludedCount: externalExcludedCount,
        meaningfulWaveRoePercent: round(meaningfulWaveRoePercent, 2),
        medianLifetimeBestRoePercent: round(medianLifetimeBestRoe, 2),
        averageFinalNetRoePercent: round(averageFinalNetRoe, 2),
        medianCaptureEfficiencyPercent: round(
          medianCaptureEfficiency,
          1,
        ),
        givebackCount: givebacks.length,
        givebackRatePercent: round(givebackRate * 100, 1),
        weakCaptureRatePercent: round(weakCaptureRate * 100, 1),
        medianHoldingMinutes:
          holdingDurations.length > 0
            ? round(median(holdingDurations) ?? 0, 1)
            : null,
      },
      suggestedValue,
      action:
        suggestedValue === "WAVE_CAPTURE_EFFICIENCY_SUPPORTED" ||
        suggestedValue === "KEEP_COLLECTING_COMPLETE_CYCLES"
          ? "KEEP"
          : "OBSERVE",
      confidence: confidenceFor(exitEfficiencySamples.length),
      reason:
        `${exitEfficiencySamples.length}笔方向已验证、完整净结算且全程由系统自动退出的仓位，持仓期间最高有利ROE中位数 ${medianLifetimeBestRoe.toFixed(2)}%，最终净ROE平均 ${averageFinalNetRoe.toFixed(2)}%，利润捕获效率中位数 ${medianCaptureEfficiency.toFixed(1)}%；另排除人工干预 ${operatorExcludedCount} 笔、外部或归因不明 ${externalExcludedCount} 笔。` +
        (givebackRate >= 0.3
          ? `其中 ${givebacks.length} 笔曾达到至少 ${meaningfulWaveRoePercent.toFixed(2)}% ROE后最终净亏，回吐率 ${(givebackRate * 100).toFixed(1)}%；优先复核首档止盈、移动止损启动与回撤范围。`
          : medianCaptureEfficiency < 30 || weakCaptureRate >= 0.4
            ? `低效捕获比例 ${(weakCaptureRate * 100).toFixed(1)}%，说明方向判断产生过可用波段，但退出只保留了很少利润；先优化退出，不扩大下单量。`
            : medianCaptureEfficiency >= 50 && averageFinalNetRoe > 0
              ? "多数完整周期保留了至少一半可实现波段，且平均净ROE为正；当前退出效率获得样本支持。"
              : "当前捕获效率没有形成稳定结论，继续积累完整周期并保持参数。"),
    });
  }
  const deeperLimitComparable = actualComplete.filter(
    (analysis) =>
      (
        analysis.deeperLimitCounterfactual30m?.status === "FILLED" ||
        analysis.deeperLimitCounterfactual30m?.status === "NOT_FILLED"
      ),
  );
  const minimumDeeperLimitSamples = Math.max(
    5,
    Math.ceil(input.minimumOrders * 0.2),
  );
  if (deeperLimitComparable.length >= minimumDeeperLimitSamples) {
    const filled = deeperLimitComparable.filter(
      (analysis) =>
        analysis.deeperLimitCounterfactual30m.status === "FILLED" &&
        analysis.deeperLimitCounterfactual30m.candidateRoePercent !== null &&
        analysis.deeperLimitCounterfactual30m.actualRoePercent !== null &&
        analysis.deeperLimitCounterfactual30m.advantageRoePercent !== null,
    );
    const fillRate = filled.length / deeperLimitComparable.length;
    const averageAdvantage = filled.length
      ? filled.reduce(
          (sum, analysis) =>
            sum + analysis.deeperLimitCounterfactual30m.advantageRoePercent!,
          0,
        ) / filled.length
      : null;
    const actualPositiveRate = filled.length
      ? filled.filter(
          (analysis) =>
            analysis.deeperLimitCounterfactual30m.actualRoePercent! > 0,
        ).length / filled.length
      : null;
    const candidatePositiveRate = filled.length
      ? filled.filter(
          (analysis) =>
            analysis.deeperLimitCounterfactual30m.candidateRoePercent! > 0,
        ).length / filled.length
      : null;
    const reviewable =
      filled.length >= minimumDeeperLimitSamples &&
      fillRate >= 0.7 &&
      (averageAdvantage ?? 0) >= 0.5 &&
      (candidatePositiveRate ?? 0) >= (actualPositiveRate ?? 0) + 0.15;
    const observedExtraOffset = median(
      deeperLimitComparable.map(
        (analysis) =>
          analysis.deeperLimitCounterfactual30m.extraOffsetPercent,
      ),
    ) ?? 0;
    result.push({
      parameterName: "execution.limitOffsetCounterfactual",
      label: "更深限价反事实",
      currentValue: {
        configuredOffsetPercent:
          input.config.execution.limitOffsetPercent ?? 0,
        samples: deeperLimitComparable.length,
        confirmedFills: filled.length,
        fillRatePercent: round(fillRate * 100, 1),
        averageAdvantageRoePercent:
          averageAdvantage === null ? null : round(averageAdvantage, 2),
        actualPositiveRatePercent:
          actualPositiveRate === null
            ? null
            : round(actualPositiveRate * 100, 1),
        candidatePositiveRatePercent:
          candidatePositiveRate === null
            ? null
            : round(candidatePositiveRate * 100, 1),
      },
      suggestedValue: reviewable
        ? {
            operatorReviewOffsetPercent: round(
              (input.config.execution.limitOffsetPercent ?? 0) +
                observedExtraOffset,
              3,
            ),
          }
        : "KEEP_CURRENT_OFFSET",
      action: reviewable ? "OBSERVE" : "KEEP",
      confidence: confidenceFor(deeperLimitComparable.length),
      reason: reviewable
        ? `${deeperLimitComparable.length}笔未使用未来结果筛选的真实入场机会中，更深限价按有效委托窗口确认可成交 ${(fillRate * 100).toFixed(1)}%，第30分钟影子ROE平均改善 ${averageAdvantage!.toFixed(2)} 个百分点，正ROE率由 ${((actualPositiveRate ?? 0) * 100).toFixed(1)}% 提升至 ${((candidatePositiveRate ?? 0) * 100).toFixed(1)}%。可进入人工参数评审，仍不自动修改实盘。`
        : `${deeperLimitComparable.length}笔完整真实机会中，更深限价的确认成交率、ROE改善或正收益率提升未同时达到门槛；保持当前偏移，避免为了更低价格大量错失主力波段。`,
    });
  }
  const delayedReclaimComparable = actualComplete.filter(
    (analysis) =>
      (
        analysis.delayedReclaimCounterfactual30m?.status === "ENTERED" ||
        analysis.delayedReclaimCounterfactual30m?.status === "NO_CONFIRMATION"
      ),
  );
  const minimumDelayedReclaimSamples = Math.max(
    5,
    Math.ceil(input.minimumOrders * 0.2),
  );
  if (delayedReclaimComparable.length >= minimumDelayedReclaimSamples) {
    const entered = delayedReclaimComparable.filter(
      (analysis) =>
        analysis.delayedReclaimCounterfactual30m.status === "ENTERED" &&
        analysis.delayedReclaimCounterfactual30m.actualRoePercent !== null &&
        analysis.delayedReclaimCounterfactual30m.candidateRoePercent !== null &&
        analysis.delayedReclaimCounterfactual30m.advantageRoePercent !== null,
    );
    const skipped = delayedReclaimComparable.filter(
      (analysis) =>
        analysis.delayedReclaimCounterfactual30m.status === "NO_CONFIRMATION" &&
        analysis.delayedReclaimCounterfactual30m.actualRoePercent !== null,
    );
    const averageAdvantage = entered.length
      ? entered.reduce(
          (sum, analysis) =>
            sum + analysis.delayedReclaimCounterfactual30m.advantageRoePercent!,
          0,
        ) / entered.length
      : null;
    const actualPositiveRate = entered.length
      ? entered.filter(
          (analysis) =>
            analysis.delayedReclaimCounterfactual30m.actualRoePercent! > 0,
        ).length / entered.length
      : null;
    const candidatePositiveRate = entered.length
      ? entered.filter(
          (analysis) =>
            analysis.delayedReclaimCounterfactual30m.candidateRoePercent! > 0,
        ).length / entered.length
      : null;
    const avoidedWeakRate = skipped.length
      ? skipped.filter(
          (analysis) =>
            analysis.delayedReclaimCounterfactual30m.actualRoePercent! < 0,
        ).length / skipped.length
      : null;
    const missedPositiveRate = skipped.length
      ? skipped.filter(
          (analysis) =>
            analysis.delayedReclaimCounterfactual30m.actualRoePercent! > 0,
        ).length / skipped.length
      : null;
    const reviewable =
      entered.length >= minimumDelayedReclaimSamples &&
      skipped.length >= minimumDelayedReclaimSamples &&
      (averageAdvantage ?? 0) >= 0.5 &&
      (candidatePositiveRate ?? 0) >= (actualPositiveRate ?? 0) + 0.15 &&
      (avoidedWeakRate ?? 0) >= (missedPositiveRate ?? 0) + 0.2;
    result.push({
      parameterName: "execution.delayedReclaimCounterfactual",
      label: "延迟收回入场反事实",
      currentValue: {
        samples: delayedReclaimComparable.length,
        confirmedEntries: entered.length,
        skippedNoConfirmation: skipped.length,
        averageAdvantageRoePercent:
          averageAdvantage === null ? null : round(averageAdvantage, 2),
        actualPositiveRatePercent:
          actualPositiveRate === null
            ? null
            : round(actualPositiveRate * 100, 1),
        candidatePositiveRatePercent:
          candidatePositiveRate === null
            ? null
            : round(candidatePositiveRate * 100, 1),
        avoidedWeakRatePercent:
          avoidedWeakRate === null ? null : round(avoidedWeakRate * 100, 1),
        missedPositiveRatePercent:
          missedPositiveRate === null
            ? null
            : round(missedPositiveRate * 100, 1),
      },
      suggestedValue: reviewable
        ? "REVIEW_DELAYED_RECLAIM_ENTRY"
        : "KEEP_OBSERVATION_ONLY",
      action: reviewable ? "OBSERVE" : "KEEP",
      confidence: confidenceFor(
        Math.min(entered.length, skipped.length),
      ),
      reason: reviewable
        ? `${entered.length}笔收回确认后可影子入场样本的第30分钟ROE平均改善 ${averageAdvantage!.toFixed(2)} 个百分点，正ROE率由 ${((actualPositiveRate ?? 0) * 100).toFixed(1)}% 提升至 ${((candidatePositiveRate ?? 0) * 100).toFixed(1)}%；另有 ${skipped.length} 笔未确认跳过样本，其中弱势率 ${((avoidedWeakRate ?? 0) * 100).toFixed(1)}%、错失正ROE率 ${((missedPositiveRate ?? 0) * 100).toFixed(1)}%。可与更深限价一起进入人工评审。`
        : `${delayedReclaimComparable.length}笔未按未来结果筛选的完整机会尚未同时证明“确认后入场改善”和“跳过弱势多于错失盈利”，保持影子观察，不接入实盘。`,
    });
  }
  const minimumEntryPolicySamples = Math.max(
    10,
    Math.ceil(input.minimumOrders * 0.4),
  );
  const payoff = strategyPayoffProfile({
    stopLossRoePercent: input.config.risk.stopLossPercent,
    takeProfitSteps: input.config.risk.takeProfitSteps,
    leverage: input.config.execution.leverage,
  });
  const buildPolicyComparison = (
    horizon: 30 | 60,
    source: PostEntryAnalysis[] = actualComplete,
    requiredSamples: number = minimumEntryPolicySamples,
  ) => {
    const comparable = source.flatMap((analysis) => {
      const legacy60Fallback =
        horizon === 60 &&
        !analysis.deeperLimitCounterfactual60m &&
        !analysis.delayedReclaimCounterfactual60m;
      const deeper = horizon === 30
        ? analysis.deeperLimitCounterfactual30m
        : analysis.deeperLimitCounterfactual60m ??
          analysis.deeperLimitCounterfactual30m;
      const delayed = horizon === 30
        ? analysis.delayedReclaimCounterfactual30m
        : analysis.delayedReclaimCounterfactual60m ??
          analysis.delayedReclaimCounterfactual30m;
      const comparableHorizon = legacy60Fallback ? 30 : horizon;
      if (
        !deeper ||
        !delayed ||
        deeper.evaluationMinute !== comparableHorizon ||
        delayed.evaluationMinute !== comparableHorizon ||
        deeper.actualRoePercent === null ||
        !(
          deeper.status === "FILLED" ||
          deeper.status === "NOT_FILLED"
        ) ||
        (
          deeper.status === "FILLED" &&
          deeper.candidateRoePercent === null
        ) ||
        !(
          delayed.status === "ENTERED" ||
          delayed.status === "NO_CONFIRMATION"
        ) ||
        (
          delayed.status === "ENTERED" &&
          delayed.candidateRoePercent === null
        )
      ) return [];
      return [{
        actualRoePercent: deeper.actualRoePercent,
        deeperLimit:
          deeper.status === "FILLED"
            ? {
                status: "FILLED" as const,
                candidateRoePercent: deeper.candidateRoePercent!,
              }
            : { status: "NOT_FILLED" as const },
        delayedReclaim:
          delayed.status === "ENTERED"
            ? {
                status: "ENTERED" as const,
                candidateRoePercent: delayed.candidateRoePercent!,
              }
            : { status: "NO_CONFIRMATION" as const },
      }];
    });
    return compareEntryPolicies({
      estimatedFeeRoePercent: payoff?.estimatedFeeRoePercent ?? 0,
      minimumSamples: requiredSamples,
      opportunities: comparable,
    });
  };
  const comparison30m = buildPolicyComparison(
    30,
    independentActualComplete,
  );
  if (comparison30m.sampleCount >= minimumEntryPolicySamples) {
    const comparison60m = buildPolicyComparison(
      60,
      independentActualComplete,
    );
    const globalStablePreferredPolicy =
      comparison60m.sampleCount >= minimumEntryPolicySamples &&
        comparison30m.preferredPolicy === comparison60m.preferredPolicy &&
        (
          comparison30m.preferredPolicy === "DEEPER_LIMIT" ||
          comparison30m.preferredPolicy === "DELAYED_RECLAIM"
        )
        ? comparison30m.preferredPolicy
        : null;
    const maxPosition72hPercent =
      input.config.marketPosition.maxPosition72hPercent ?? 35;
    const stratumRows = new Map<string, PostEntryAnalysis[]>();
    for (const analysis of independentActualComplete) {
      const positionBand =
        analysis.entryPosition72hPercent === null
          ? "POSITION_UNKNOWN"
          : analysis.entryPosition72hPercent <= maxPosition72hPercent * 0.5
            ? "DEEP_72H"
            : analysis.entryPosition72hPercent <= maxPosition72hPercent
              ? "UPPER_LOW_72H"
              : "OUTSIDE_LOW_72H";
      const capitalMode =
        analysis.entryLargeTraderConfirmationMode ??
        "CAPITAL_MODE_UNKNOWN";
      const key = `${positionBand}:${capitalMode}`;
      const rows = stratumRows.get(key) ?? [];
      rows.push(analysis);
      stratumRows.set(key, rows);
    }
    const minimumStratumSamples = Math.max(
      5,
      Math.ceil(minimumEntryPolicySamples * 0.4),
    );
    const stratumComparisons = [...stratumRows.entries()]
      .map(([stratum, rows]) => {
        const thirty = buildPolicyComparison(
          30,
          rows,
          minimumStratumSamples,
        );
        const sixty = buildPolicyComparison(
          60,
          rows,
          minimumStratumSamples,
        );
        const stablePolicy =
          thirty.sampleCount >= minimumStratumSamples &&
            sixty.sampleCount >= minimumStratumSamples &&
            thirty.preferredPolicy === sixty.preferredPolicy &&
            (
              thirty.preferredPolicy === "DEEPER_LIMIT" ||
              thirty.preferredPolicy === "DELAYED_RECLAIM"
            )
            ? thirty.preferredPolicy
            : null;
        return {
          stratum,
          eligibleForCrossRegimeConfirmation:
            !stratum.includes("UNKNOWN") &&
            !stratum.startsWith("OUTSIDE_LOW_72H"),
          samples30m: thirty.sampleCount,
          samples60m: sixty.sampleCount,
          preferredPolicy30m: thirty.preferredPolicy,
          preferredPolicy60m: sixty.preferredPolicy,
          stablePolicy,
        };
      })
      .filter(
        (item) =>
          item.samples30m >= minimumStratumSamples ||
          item.samples60m >= minimumStratumSamples,
      );
    const sufficientlyConfirmedStrata = stratumComparisons.filter(
      (item) =>
        item.eligibleForCrossRegimeConfirmation &&
        item.stablePolicy !== null,
    );
    const contradictoryStratum = sufficientlyConfirmedStrata.some(
      (item) => item.stablePolicy !== globalStablePreferredPolicy,
    );
    const regimeStablePreferredPolicy =
      globalStablePreferredPolicy &&
        sufficientlyConfirmedStrata.length >= 2 &&
        !contradictoryStratum
        ? globalStablePreferredPolicy
        : null;
    const minimumHoldoutSamples = Math.max(
      5,
      Math.ceil(minimumEntryPolicySamples * 0.3),
    );
    const chronologicalRows = independentActualComplete
      .filter(
        (analysis) =>
          analysis.decisionAtMs !== null &&
          Number.isFinite(analysis.decisionAtMs),
      )
      .sort((left, right) => left.decisionAtMs! - right.decisionAtMs!);
    const holdoutSize = Math.max(
      minimumHoldoutSamples,
      Math.ceil(chronologicalRows.length * 0.3),
    );
    const chronologicalSplitAvailable =
      chronologicalRows.length >= minimumEntryPolicySamples + minimumHoldoutSamples &&
      chronologicalRows.length - holdoutSize >= minimumEntryPolicySamples;
    const discoveryRows = chronologicalSplitAvailable
      ? chronologicalRows.slice(0, chronologicalRows.length - holdoutSize)
      : [];
    const holdoutRows = chronologicalSplitAvailable
      ? chronologicalRows.slice(chronologicalRows.length - holdoutSize)
      : [];
    const discovery30m = buildPolicyComparison(
      30,
      discoveryRows,
      minimumEntryPolicySamples,
    );
    const discovery60m = buildPolicyComparison(
      60,
      discoveryRows,
      minimumEntryPolicySamples,
    );
    const holdout30m = buildPolicyComparison(
      30,
      holdoutRows,
      minimumHoldoutSamples,
    );
    const holdout60m = buildPolicyComparison(
      60,
      holdoutRows,
      minimumHoldoutSamples,
    );
    const stablePolicyAcrossHorizons = (
      thirty: ReturnType<typeof compareEntryPolicies>,
      sixty: ReturnType<typeof compareEntryPolicies>,
      requiredSamples: number,
    ) =>
      thirty.sampleCount >= requiredSamples &&
      sixty.sampleCount >= requiredSamples &&
      thirty.preferredPolicy === sixty.preferredPolicy &&
      (
        thirty.preferredPolicy === "DEEPER_LIMIT" ||
        thirty.preferredPolicy === "DELAYED_RECLAIM"
      )
        ? thirty.preferredPolicy
        : null;
    const discoveryStablePreferredPolicy = stablePolicyAcrossHorizons(
      discovery30m,
      discovery60m,
      minimumEntryPolicySamples,
    );
    const holdoutStablePreferredPolicy = stablePolicyAcrossHorizons(
      holdout30m,
      holdout60m,
      minimumHoldoutSamples,
    );
    const chronologicalStablePreferredPolicy =
      discoveryStablePreferredPolicy &&
      discoveryStablePreferredPolicy === holdoutStablePreferredPolicy
        ? discoveryStablePreferredPolicy
        : null;
    const chronologicalEvidenceReady =
      chronologicalSplitAvailable &&
      discovery30m.sampleCount >= minimumEntryPolicySamples &&
      discovery60m.sampleCount >= minimumEntryPolicySamples &&
      holdout30m.sampleCount >= minimumHoldoutSamples &&
      holdout60m.sampleCount >= minimumHoldoutSamples;
    const validatedPreferredPolicy =
      regimeStablePreferredPolicy &&
      regimeStablePreferredPolicy === chronologicalStablePreferredPolicy
        ? regimeStablePreferredPolicy
        : null;
    const completeCycleEvidenceReady =
      exactNetClosed.length >= input.minimumOrders &&
      overallNetProfitability !== null;
    const fullyValidatedPreferredPolicy =
      completeCycleEvidenceReady ? validatedPreferredPolicy : null;
    const policyMetrics = (
      comparison: ReturnType<typeof compareEntryPolicies>,
    ) => comparison.policies.map((policy) => ({
      policy: policy.policy,
      opportunities: policy.opportunities,
      entered: policy.entered,
      skipped: policy.skipped,
      averageNetRoePerOpportunity: round(
        policy.averageNetRoePerOpportunity,
        2,
      ),
      medianNetRoePerOpportunity: round(
        policy.medianNetRoePerOpportunity,
        2,
      ),
      positiveOpportunityRatePercent: round(
        policy.positiveOpportunityRate * 100,
        1,
      ),
      lossOpportunityRatePercent: round(
        policy.lossOpportunityRate * 100,
        1,
      ),
    }));
    result.push({
      parameterName: "execution.entryPolicyComparison",
      label: "入场方案30/60分钟机会级对照",
      currentValue: {
        sampleCount30m: comparison30m.sampleCount,
        sampleCount60m: comparison60m.sampleCount,
        knownRepeatedWaveExcludedCount,
        estimatedFeeRoePercent: round(
          comparison30m.estimatedFeeRoePercent,
          3,
        ),
        preferredPolicy30m: comparison30m.preferredPolicy,
        preferredPolicy60m: comparison60m.preferredPolicy,
        pairedEvidence30m: comparison30m.pairedEvidence,
        pairedEvidence60m: comparison60m.pairedEvidence,
        policies30m: policyMetrics(comparison30m),
        policies60m: policyMetrics(comparison60m),
        minimumStratumSamples,
        strata: stratumComparisons,
        chronologicalValidation: {
          timestampedSamples: chronologicalRows.length,
          minimumDiscoverySamples: minimumEntryPolicySamples,
          minimumHoldoutSamples,
          discoverySamples30m: discovery30m.sampleCount,
          discoverySamples60m: discovery60m.sampleCount,
          holdoutSamples30m: holdout30m.sampleCount,
          holdoutSamples60m: holdout60m.sampleCount,
          discoveryPreferredPolicy30m: discovery30m.preferredPolicy,
          discoveryPreferredPolicy60m: discovery60m.preferredPolicy,
          holdoutPreferredPolicy30m: holdout30m.preferredPolicy,
          holdoutPreferredPolicy60m: holdout60m.preferredPolicy,
          discoveryStablePreferredPolicy,
          holdoutStablePreferredPolicy,
        },
        completeCycleNetBaseline: {
          exactNetSettlements: exactNetClosed.length,
          minimumRequired: input.minimumOrders,
          totalNetPnlUsdt:
            overallNetProfitability === null
              ? null
              : round(overallNetProfitability.totalNetPnlUsdt, 4),
          averageNetPnlUsdt:
            overallNetProfitability === null
              ? null
              : round(overallNetProfitability.averageNetPnlUsdt, 4),
          positiveExpectancy:
            overallNetProfitability?.positiveExpectancy ?? null,
          statisticallySupported:
            overallNetProfitability?.statisticallySupported ?? null,
        },
      },
      suggestedValue:
        fullyValidatedPreferredPolicy === "DEEPER_LIMIT"
          ? "REVIEW_DEEPER_LIMIT_POLICY"
          : fullyValidatedPreferredPolicy === "DELAYED_RECLAIM"
            ? "REVIEW_DELAYED_RECLAIM_POLICY"
            : comparison60m.sampleCount < minimumEntryPolicySamples
              ? "WAIT_FOR_60M_STABILITY"
              : contradictoryStratum
                ? "REGIME_POLICY_CONFLICT"
                : !globalStablePreferredPolicy
                  ? "NO_STABLE_POLICY_EDGE"
                  : !regimeStablePreferredPolicy
                  ? "WAIT_FOR_REGIME_STABILITY"
                  : !chronologicalEvidenceReady
                    ? "WAIT_FOR_CHRONOLOGICAL_HOLDOUT"
                    : !chronologicalStablePreferredPolicy ||
                        chronologicalStablePreferredPolicy !==
                          regimeStablePreferredPolicy
                      ? "HOLDOUT_POLICY_CONFLICT"
                      : "WAIT_FOR_COMPLETE_CYCLE_NET_EVIDENCE",
      action: fullyValidatedPreferredPolicy ? "OBSERVE" : "KEEP",
      confidence: confidenceFor(
        Math.min(comparison30m.sampleCount, comparison60m.sampleCount),
      ),
      reason: fullyValidatedPreferredPolicy
        ? `全局30/60分钟、${sufficientlyConfirmedStrata.length} 个独立入场状态分层、旧样本发现集和最新留出集均选择 ${fullyValidatedPreferredPolicy}；同时已有 ${exactNetClosed.length} 笔完整周期交易成本后精确净结算，当前基线单笔平均 ${overallNetProfitability!.averageNetPnlUsdt.toFixed(4)} USDT。${comparison30m.summary} ${comparison60m.summary} 未成交或未确认计0，进入方案均扣除 ${comparison30m.estimatedFeeRoePercent.toFixed(2)}% ROE估算往返手续费。`
        : comparison60m.sampleCount < minimumEntryPolicySamples
          ? `第30分钟已有 ${comparison30m.sampleCount} 个机会，但第60分钟仅 ${comparison60m.sampleCount} 个，未达到 ${minimumEntryPolicySamples} 个同口径样本；短期赢家不能进入参数评审。`
          : contradictoryStratum
            ? `全局周期结论虽然稳定，但至少一个具备 ${minimumStratumSamples} 个样本的72小时位置/大户承接分层选择了不同方案；禁止把单一行情优势推广到全市场。`
            : globalStablePreferredPolicy
              ? !regimeStablePreferredPolicy
                ? `全局30/60分钟均选择 ${globalStablePreferredPolicy}，但只有 ${sufficientlyConfirmedStrata.length} 个市场状态分层完成独立确认，至少需要2个；继续等待行情跨状态验证。`
                : !chronologicalEvidenceReady
                  ? `跨周期和跨市场状态结论已一致，但只有 ${chronologicalRows.length} 笔带真实决策时间的样本；旧样本发现集至少需要 ${minimumEntryPolicySamples} 笔、最新留出集至少需要 ${minimumHoldoutSamples} 笔同口径30/60分钟样本，未通过前不进入参数评审。`
                  : !chronologicalStablePreferredPolicy ||
                      chronologicalStablePreferredPolicy !==
                        regimeStablePreferredPolicy
                    ? `旧样本发现集选择 ${discoveryStablePreferredPolicy ?? "无稳定赢家"}，最新留出集选择 ${holdoutStablePreferredPolicy ?? "无稳定赢家"}，未能在未参与规律发现的新交易上复现 ${regimeStablePreferredPolicy}；保持当前执行方案，禁止用历史拟合结果改实盘。`
                    : `短时、跨行情分层和最新留出集均已选择 ${validatedPreferredPolicy}，但只有 ${exactNetClosed.length} 笔完整周期交易成本后精确净结算，至少需要 ${input.minimumOrders} 笔；在证明分析能够兑现为完整周期净收益前，不把短时优势送入参数评审。`
              : `第30分钟选择 ${comparison30m.preferredPolicy}，第60分钟选择 ${comparison60m.preferredPolicy}，周期结论不一致；继续保持当前入场，不用短期表现替代主力波段验证。`,
    });
  }
  const waveThesisComparable = actualComplete.filter(
    (analysis) =>
      analysis.waveThesisStatus === "CONFIRMED" &&
      analysis.waveThesisOutcome !== null &&
      analysis.waveThesisOutcome !== "INSUFFICIENT",
  );
  if (waveThesisComparable.length >= input.minimumOrders) {
    const followThroughRate = waveThesisComparable.filter(
      (analysis) => analysis.waveThesisOutcome === "FOLLOW_THROUGH",
    ).length / waveThesisComparable.length;
    const failedStructureRate = waveThesisComparable.filter(
      (analysis) => analysis.waveThesisOutcome === "FAILED_STRUCTURE",
    ).length / waveThesisComparable.length;
    const givebackRate = waveThesisComparable.filter(
      (analysis) => analysis.waveThesisOutcome === "PROFIT_GIVEBACK",
    ).length / waveThesisComparable.length;
    const capitalWithdrawalRate = waveThesisComparable.filter(
      (analysis) => analysis.waveThesisOutcome === "CAPITAL_WITHDRAWAL",
    ).length / waveThesisComparable.length;
    result.push({
      parameterName: "waveThesis.validation",
      label: "主导波段假设验证",
      currentValue: {
        samples: waveThesisComparable.length,
        followThroughRate: round(followThroughRate * 100, 1),
        failedStructureRate: round(failedStructureRate * 100, 1),
        capitalWithdrawalRate: round(capitalWithdrawalRate * 100, 1),
        givebackRate: round(givebackRate * 100, 1),
      },
      suggestedValue:
        failedStructureRate >= 0.4
          ? "REVIEW_ENTRY_CONFIRMATION"
          : capitalWithdrawalRate >= 0.35
            ? "REVIEW_POST_ENTRY_CAPITAL_CONTINUITY"
          : givebackRate >= 0.35
            ? "REVIEW_PROFIT_PROTECTION"
            : "KEEP_COLLECTING_MATCHED_EVIDENCE",
      action:
        failedStructureRate >= 0.4 ||
          capitalWithdrawalRate >= 0.35 ||
          givebackRate >= 0.35
          ? "OBSERVE"
          : "KEEP",
      confidence: actualConfidence,
      reason:
        `${waveThesisComparable.length}笔同引擎、同波段假设样本中，持续跟随 ${(followThroughRate * 100).toFixed(1)}%、` +
        `结构失败 ${(failedStructureRate * 100).toFixed(1)}%、资金撤退 ${(capitalWithdrawalRate * 100).toFixed(1)}%、盈利回吐 ${(givebackRate * 100).toFixed(1)}%。` +
        (failedStructureRate >= 0.4
          ? "结构失败偏高，应优先复核5分钟收回、3分钟量价和大户聚合确认，不把问题错误归因于止损。"
          : capitalWithdrawalRate >= 0.35
            ? "入场时资金确认成立，但持仓后承接撤退偏多；应优先比较撤退发生时间与ROE路径，再决定是否增加观察型提前退出规则。"
          : givebackRate >= 0.35
            ? "方向判断多数并非立即失败，但利润保护不足，应优先复核首档止盈和移动止损。"
            : "尚未出现单一主导失效类型，保持当前参数并继续积累配对证据。"),
    });
  }
  const capitalExitComparable = independentActualComplete.filter(
    (analysis) =>
      analysis.capitalExitShadow?.status === "PROTECTIVE" ||
      analysis.capitalExitShadow?.status === "MISSED_RECOVERY" ||
      analysis.capitalExitShadow?.status === "NEUTRAL",
  );
  const minimumCapitalExitGroup = Math.max(
    5,
    Math.ceil(input.minimumOrders * 0.2),
  );
  if (capitalExitComparable.length >= minimumCapitalExitGroup) {
    const protective = capitalExitComparable.filter(
      (analysis) => analysis.capitalExitShadow?.status === "PROTECTIVE",
    );
    const missedRecovery = capitalExitComparable.filter(
      (analysis) => analysis.capitalExitShadow?.status === "MISSED_RECOVERY",
    );
    const protectiveRate = protective.length / capitalExitComparable.length;
    const missedRecoveryRate =
      missedRecovery.length / capitalExitComparable.length;
    const advantages = protective
      .map(
        (analysis) =>
          analysis.capitalExitShadow.advantageVsLatestRoePercent,
      )
      .filter((value): value is number => value !== null);
    const medianAdvantage = median(advantages);
    const requiredEdge = Math.max(
      0.5,
      (input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.1,
    );
    const readyForReview =
      protectiveRate >= 0.6 &&
      protectiveRate >= missedRecoveryRate + 0.2 &&
      medianAdvantage !== null &&
      medianAdvantage > requiredEdge;
    result.push({
      parameterName: "postEntryCapitalWithdrawalExit",
      label: "资金撤退提前退出验证",
      currentValue: "OBSERVATION_ONLY",
      suggestedValue: readyForReview
        ? "WAIT_FOR_COMPLETE_CYCLE_NET_VALIDATION"
        : "KEEP_OBSERVATION_ONLY",
      action: "OBSERVE",
      confidence: confidenceFor(capitalExitComparable.length),
      reason: readyForReview
        ? `${capitalExitComparable.length}笔资金撤退可比样本中，提前退出保护率 ${(protectiveRate * 100).toFixed(1)}%，比错失恢复率 ${(missedRecoveryRate * 100).toFixed(1)}% 高至少20个百分点，保护优势中位数 ${medianAdvantage!.toFixed(2)}% ROE 超过 ${requiredEdge.toFixed(2)}% 执行缓冲；这只证明短窗口路径，必须继续与完整周期精确净ROE配对验证。`
        : `${capitalExitComparable.length}笔资金撤退可比样本中，保护率 ${(protectiveRate * 100).toFixed(1)}%、错失恢复率 ${(missedRecoveryRate * 100).toFixed(1)}%，保护优势中位数 ${medianAdvantage === null ? "—" : `${medianAdvantage.toFixed(2)}%`} ROE；尚未同时满足60%保护率、20个百分点净优势和执行缓冲。`,
    });
  }
  const managementOutcomeMinimum = Math.max(
    5,
    Math.ceil(input.minimumOrders * 0.2),
  );
  const managementOutcomeSummary =
    summarizePositionManagementDecisionOutcomes(
      independentActualComplete
        .map((analysis) => analysis.positionManagementDecisionOutcome)
        .filter((outcome) => outcome?.signalCausalEvidenceReady === true),
      managementOutcomeMinimum,
    );
  if (managementOutcomeSummary.sampleCount >= managementOutcomeMinimum) {
    result.push({
      parameterName: "positionManagement.decisionValidation",
      label: "持仓判断后验验证",
      currentValue: {
        causalCompleteCycles: managementOutcomeSummary.sampleCount,
        supportedCount: managementOutcomeSummary.supportedCount,
        contradictedCount: managementOutcomeSummary.contradictedCount,
        inconclusiveCount: managementOutcomeSummary.inconclusiveCount,
        contradictionRatePercent: round(
          managementOutcomeSummary.contradictionRate * 100,
          1,
        ),
      },
      suggestedValue: managementOutcomeSummary.verdict,
      action: "OBSERVE",
      confidence: confidenceFor(managementOutcomeSummary.sampleCount),
      reason:
        `${managementOutcomeSummary.sampleCount}笔独立且判断时因果证据完整的持仓管理周期中，` +
        `持仓判断得到后续路径支持 ${managementOutcomeSummary.supportedCount} 笔、反证 ${managementOutcomeSummary.contradictedCount} 笔、` +
        `暂不明确 ${managementOutcomeSummary.inconclusiveCount} 笔。` +
        (managementOutcomeSummary.verdict === "REVIEW_DECISION_THRESHOLDS"
          ? "反证率和样本量达到复核线；只建议检查利润回撤、触底修复与趋势失效阈值，不自动改实盘参数。"
          : "当前仍保持观察模式，不根据少量或方向不明确样本改变实盘。"),
    });
  }
  const completeCycleCapitalExit = independentActualComplete.filter(
    (analysis) =>
      analysis.exitAttributionMode === "AUTOMATED_ONLY" &&
      analysis.finalPnlBasis === "NET_EXACT" &&
      analysis.finalNetRoePercent !== null &&
      analysis.capitalExitShadow?.signalRoePercent !== null &&
      (
        analysis.capitalExitShadow?.status === "PROTECTIVE" ||
        analysis.capitalExitShadow?.status === "MISSED_RECOVERY" ||
        analysis.capitalExitShadow?.status === "NEUTRAL"
      ),
  );
  if (completeCycleCapitalExit.length >= input.minimumOrders) {
    const estimatedFeeRoePercent =
      strategyPayoffProfile({
        stopLossRoePercent: input.config.risk.stopLossPercent,
        takeProfitSteps: input.config.risk.takeProfitSteps,
        leverage: input.config.execution.leverage,
      })?.estimatedFeeRoePercent ?? 0;
    const requiredEdgeRoePercent = Math.max(
      0.5,
      (input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.1,
    );
    const compareCapitalExitRows = (rows: PostEntryAnalysis[]) => {
      const comparisons = rows.map((analysis) => {
        const shadowNetRoePercent =
          analysis.capitalExitShadow.signalRoePercent! -
          estimatedFeeRoePercent;
        const actualNetRoePercent = analysis.finalNetRoePercent!;
        return {
          shadowNetRoePercent,
          actualNetRoePercent,
          deltaRoePercent: shadowNetRoePercent - actualNetRoePercent,
        };
      });
      const deltas = comparisons.map((item) => item.deltaRoePercent);
      const averageDelta = comparisons.length
        ? deltas.reduce((sum, value) => sum + value, 0) /
          comparisons.length
        : 0;
      const medianDelta = median(deltas) ?? 0;
      const improvedCount = deltas.filter((value) => value > 0).length;
      const materiallyImprovedCount = deltas.filter(
        (value) => value >= requiredEdgeRoePercent,
      ).length;
      const lossAvoidedCount = comparisons.filter(
        (item) =>
          item.actualNetRoePercent <= 0 &&
          item.shadowNetRoePercent > 0,
      ).length;
      const missedProfitCount = comparisons.filter(
        (item) =>
          item.actualNetRoePercent >=
          item.shadowNetRoePercent + requiredEdgeRoePercent,
      ).length;
      const improvedRate = comparisons.length
        ? improvedCount / comparisons.length
        : 0;
      const improvedRateWilsonLower = wilsonLowerBound(
        improvedCount,
        comparisons.length,
      );
      return {
        sampleCount: comparisons.length,
        averageDelta,
        medianDelta,
        improvedCount,
        materiallyImprovedCount,
        lossAvoidedCount,
        missedProfitCount,
        improvedRate,
        improvedRateWilsonLower,
        supported:
          averageDelta >= requiredEdgeRoePercent &&
          medianDelta >= requiredEdgeRoePercent &&
          improvedRateWilsonLower > 0.5 &&
          lossAvoidedCount > missedProfitCount,
      };
    };
    const overall = compareCapitalExitRows(completeCycleCapitalExit);
    const minimumHoldoutSamples = Math.max(
      5,
      Math.ceil(input.minimumOrders * 0.3),
    );
    const timestamped = completeCycleCapitalExit
      .filter(
        (analysis) =>
          analysis.decisionAtMs !== null &&
          Number.isFinite(analysis.decisionAtMs),
      )
      .sort((left, right) => left.decisionAtMs! - right.decisionAtMs!);
    const holdoutSize = Math.max(
      minimumHoldoutSamples,
      Math.ceil(timestamped.length * 0.3),
    );
    const splitAvailable =
      timestamped.length >= input.minimumOrders + minimumHoldoutSamples &&
      timestamped.length - holdoutSize >= input.minimumOrders;
    const discoveryRows = splitAvailable
      ? timestamped.slice(0, timestamped.length - holdoutSize)
      : [];
    const holdoutRows = splitAvailable
      ? timestamped.slice(timestamped.length - holdoutSize)
      : [];
    const discovery = compareCapitalExitRows(discoveryRows);
    const holdout = compareCapitalExitRows(holdoutRows);
    const readyForCompleteCycleReview =
      overall.supported &&
      discovery.sampleCount >= input.minimumOrders &&
      discovery.supported &&
      holdout.sampleCount >= minimumHoldoutSamples &&
      holdout.supported;
    const suggestedValue = readyForCompleteCycleReview
      ? "READY_FOR_OPERATOR_REVIEW"
      : !splitAvailable
        ? "WAIT_FOR_CHRONOLOGICAL_HOLDOUT"
        : overall.supported && discovery.supported && !holdout.supported
          ? "HOLDOUT_EXIT_EDGE_NOT_REPRODUCED"
          : "KEEP_OBSERVATION_ONLY";
    result.push({
      parameterName: "postEntryCapitalWithdrawalExit.completeCycle",
      label: "资金撤退退出完整周期验证",
      currentValue: {
        exactNetAutomaticSamples: overall.sampleCount,
        knownRepeatedWaveExcludedCount,
        estimatedFeeRoePercent: round(estimatedFeeRoePercent, 3),
        averageDeltaRoePercent: round(overall.averageDelta, 2),
        medianDeltaRoePercent: round(overall.medianDelta, 2),
        improvedRatePercent: round(overall.improvedRate * 100, 1),
        improvedRateWilsonLowerPercent: round(
          overall.improvedRateWilsonLower * 100,
          1,
        ),
        materiallyImprovedCount: overall.materiallyImprovedCount,
        lossAvoidedCount: overall.lossAvoidedCount,
        missedProfitCount: overall.missedProfitCount,
        chronologicalValidation: {
          timestampedSamples: timestamped.length,
          discoverySamples: discovery.sampleCount,
          discoveryAverageDeltaRoePercent: round(
            discovery.averageDelta,
            2,
          ),
          discoveryWilsonLowerPercent: round(
            discovery.improvedRateWilsonLower * 100,
            1,
          ),
          discoverySupported: discovery.supported,
          holdoutSamples: holdout.sampleCount,
          minimumHoldoutSamples,
          holdoutAverageDeltaRoePercent: round(
            holdout.averageDelta,
            2,
          ),
          holdoutWilsonLowerPercent: round(
            holdout.improvedRateWilsonLower * 100,
            1,
          ),
          holdoutSupported: holdout.supported,
        },
      },
      suggestedValue,
      action: readyForCompleteCycleReview ? "OBSERVE" : "KEEP",
      confidence: confidenceFor(overall.sampleCount),
      reason: readyForCompleteCycleReview
        ? `${overall.sampleCount}笔纯自动退出、交易成本精确回填的完整周期中，旧样本发现集与最新留出集均证明资金撤退影子退出改善最终净ROE；全量平均/中位改善 ${overall.averageDelta.toFixed(2)}%/${overall.medianDelta.toFixed(2)}%，改善率 ${(overall.improvedRate * 100).toFixed(1)}%、95%下界 ${(overall.improvedRateWilsonLower * 100).toFixed(1)}%。可进入运营评审，但仍不自动改变平仓。`
        : !splitAvailable
          ? `完整周期已有 ${overall.sampleCount} 笔，但只有 ${timestamped.length} 笔带真实决策时间；发现集至少需要 ${input.minimumOrders} 笔、最新留出集至少需要 ${minimumHoldoutSamples} 笔，未完成时间外验证前继续观察。`
          : suggestedValue === "HOLDOUT_EXIT_EDGE_NOT_REPRODUCED"
            ? `旧样本发现集支持资金撤退提前退出，但最新 ${holdout.sampleCount} 笔留出样本未复现：留出集平均改善 ${holdout.averageDelta.toFixed(2)}%、95%改善率下界 ${(holdout.improvedRateWilsonLower * 100).toFixed(1)}%。禁止把历史优势接入实盘。`
            : `${overall.sampleCount}笔完整周期配对中，资金撤退影子退出相对实际最终净ROE平均/中位差 ${overall.averageDelta.toFixed(2)}%/${overall.medianDelta.toFixed(2)}%，改善率 ${(overall.improvedRate * 100).toFixed(1)}%、95%下界 ${(overall.improvedRateWilsonLower * 100).toFixed(1)}%；尚未同时证明中位优势、保守多数优势和避免亏损多于错失利润，继续观察。`,
    });
  }
  const slippageComparable = actualComplete.filter(
    (analysis) =>
      analysis.observationMode === "ACTUAL_POSITION" &&
      analysis.entrySlippagePercent !== null,
  );
  if (slippageComparable.length >= input.minimumOrders) {
    const adverseSlippage = slippageComparable
      .map((analysis) => Math.max(0, analysis.entrySlippagePercent ?? 0))
      .sort((left, right) => left - right);
    const p75Index = Math.min(
      adverseSlippage.length - 1,
      Math.ceil(adverseSlippage.length * 0.75) - 1,
    );
    const p75 = adverseSlippage[p75Index];
    const adverseRate = adverseSlippage.filter((value) => value > 0.05).length /
      adverseSlippage.length;
    const preferAdaptive = input.config.execution.orderType === "MARKET" &&
      p75 >= 0.15 && adverseRate >= 0.5;
    result.push({
      parameterName: "execution.orderType",
      label: "入场成交方式",
      currentValue: input.config.execution.orderType,
      suggestedValue: preferAdaptive ? "ADAPTIVE" : input.config.execution.orderType,
      action: preferAdaptive ? "TIGHTEN" : "KEEP",
      confidence: actualConfidence,
      reason: preferAdaptive
        ? `${slippageComparable.length}笔实际成交中 ${(adverseRate * 100).toFixed(1)}% 出现超过0.05%的不利滑点，75分位为 ${p75.toFixed(3)}%；建议改为按结构自适应：确认位附近市价跟随，价格拉远时转为限价承接。`
        : `${slippageComparable.length}笔实际成交的不利滑点75分位为 ${p75.toFixed(3)}%，当前成交方式保持不变。`,
    });
  }
  const adaptiveComparable = independentActualComplete.filter(
    (analysis) =>
      analysis.entryConfiguredOrderMode === "ADAPTIVE" &&
      (analysis.entrySelectedOrderType === "MARKET" ||
        analysis.entrySelectedOrderType === "LIMIT"),
  );
  const adaptiveUnfilledLimits = rejectedComplete.filter(
    (analysis) =>
      analysis.entryConfiguredOrderMode === "ADAPTIVE" &&
      analysis.entrySelectedOrderType === "LIMIT" &&
      (
        analysis.rejectionCode === "ANALYZED_LIMIT_NOT_FILLED" ||
        analysis.rejectionCode === "ANALYZED_LIMIT_STRUCTURE_INVALIDATED"
      ),
  );
  if (adaptiveComparable.length || adaptiveUnfilledLimits.length) {
    const marketSelected = adaptiveComparable.filter(
      (analysis) => analysis.entrySelectedOrderType === "MARKET",
    );
    const limitSelected = adaptiveComparable.filter(
      (analysis) => analysis.entrySelectedOrderType === "LIMIT",
    );
    const unfilledMissedWins = adaptiveUnfilledLimits.filter(
      (analysis) => analysis.quality === "MISSED_WIN",
    ).length;
    const unfilledAvoidedLosses = adaptiveUnfilledLimits.filter(
      (analysis) => analysis.quality === "AVOIDED_LOSS",
    ).length;
    const unfilledNoTrigger = adaptiveUnfilledLimits.length -
      unfilledMissedWins - unfilledAvoidedLosses;
    const averageAt = (
      rows: PostEntryAnalysis[],
      field: "consensusRoe5mPercent" | "consensusRoe30mPercent" |
        "consensusRoe60mPercent",
    ) => averageFinite(rows.map((analysis) => analysis[field]));
    const exactNetAverage = (rows: PostEntryAnalysis[]) =>
      averageFinite(
        rows
          .filter(
            (analysis) =>
              analysis.finalPnlBasis === "NET_EXACT" &&
              analysis.finalRealizedPnl !== null,
          )
          .map((analysis) => analysis.finalRealizedPnl),
      );
    result.push({
      parameterName: "execution.adaptiveOrderPerformance",
      label: "自适应市价与限价表现",
      currentValue: {
        totalSamples: adaptiveComparable.length,
        market: {
          samples: marketSelected.length,
          roe5m: averageAt(marketSelected, "consensusRoe5mPercent"),
          roe30m: averageAt(marketSelected, "consensusRoe30mPercent"),
          roe60m: averageAt(marketSelected, "consensusRoe60mPercent"),
          exactNetPnlUsdt: exactNetAverage(marketSelected),
        },
        limit: {
          samples: limitSelected.length,
          roe5m: averageAt(limitSelected, "consensusRoe5mPercent"),
          roe30m: averageAt(limitSelected, "consensusRoe30mPercent"),
          roe60m: averageAt(limitSelected, "consensusRoe60mPercent"),
          exactNetPnlUsdt: exactNetAverage(limitSelected),
        },
        unfilledLimit: {
          samples: adaptiveUnfilledLimits.length,
          missedWins: unfilledMissedWins,
          avoidedLosses: unfilledAvoidedLosses,
          noTriggerOrAmbiguous: unfilledNoTrigger,
        },
      },
      suggestedValue: "KEEP_COLLECTING_PAIRED_EXECUTION_EVIDENCE",
      action: "OBSERVE",
      confidence: confidenceFor(adaptiveComparable.length),
      reason:
        `自适应已产生 ${marketSelected.length} 笔市价和 ${limitSelected.length} 笔限价完整样本；` +
        `另有 ${adaptiveUnfilledLimits.length} 笔限价未成交（错失盈利 ${unfilledMissedWins}、避免亏损 ${unfilledAvoidedLosses}）。` +
        "成交样本比较5/30/60分钟ROE及精确净收益，未成交样本单独计算机会成本。",
    });
    const minimumPerMode = Math.max(
      5,
      Math.ceil(input.minimumOrders * 0.25),
    );
    const marketExactNet = marketSelected.filter(
      (analysis) =>
        analysis.finalPnlBasis === "NET_EXACT" &&
        analysis.finalRealizedPnl !== null,
    );
    const limitExactNet = limitSelected.filter(
      (analysis) =>
        analysis.finalPnlBasis === "NET_EXACT" &&
        analysis.finalRealizedPnl !== null,
    );
    if (
      marketSelected.length >= minimumPerMode &&
      limitSelected.length + adaptiveUnfilledLimits.length >= minimumPerMode &&
      marketExactNet.length >= minimumPerMode &&
      limitExactNet.length >= minimumPerMode
    ) {
      const marketNet = exactNetAverage(marketExactNet)!;
      const limitNet = exactNetAverage(limitExactNet)!;
      const market60m = averageAt(
        marketSelected,
        "consensusRoe60mPercent",
      );
      const limit60m = averageAt(
        limitSelected,
        "consensusRoe60mPercent",
      );
      const currentThreshold =
        input.config.execution.adaptiveMarketMaxDistanceAtr ?? 0.2;
      const tighten =
        marketNet < 0 &&
        limitNet > marketNet &&
        unfilledMissedWins <= unfilledAvoidedLosses &&
        market60m !== null &&
        limit60m !== null &&
        limit60m - market60m >= 1;
      result.push({
        parameterName: "execution.adaptiveMarketMaxDistanceAtr",
        label: "自适应市价跟随距离",
        currentValue: currentThreshold,
        suggestedValue: tighten
          ? round(Math.max(0.05, currentThreshold - 0.05), 2)
          : currentThreshold,
        action: tighten ? "TIGHTEN" : "KEEP",
        confidence: confidenceFor(
          Math.min(marketExactNet.length, limitExactNet.length),
        ),
        reason: tighten
          ? `市价组${marketExactNet.length}笔精确净结算平均 ${marketNet.toFixed(4)} USDT，限价组${limitExactNet.length}笔平均 ${limitNet.toFixed(4)} USDT，限价组60分钟ROE高出 ${(limit60m! - market60m!).toFixed(2)}%，且未成交限价避免亏损不少于错失盈利；建议将市价跟随边界收紧0.05 ATR，仍需人工确认后生效。`
          : `两组均达到最低成交样本要求，但尚未同时证明市价组亏损、限价组在60分钟与最终净收益占优，且未成交限价的错失盈利不超过避免亏损，保持 ${currentThreshold} ATR。`,
      });
    }
  }
  const minimumPositionGroup = Math.max(5, Math.ceil(input.minimumOrders * 0.2));
  const positionWindows = [
    {
      parameterName: "marketPosition.maxPosition72hPercent",
      label: "72小时低位阈值",
      current: input.config.marketPosition.maxPosition72hPercent ?? 35,
      value: (analysis: PostEntryAnalysis) => analysis.entryPosition72hPercent,
    },
  ];
  const positionFailed = (analysis: PostEntryAnalysis) =>
    analysis.finalOutcome === "LOSS" ||
    ["WEAK", "LATE", "GIVEBACK"].includes(analysis.quality);
  for (const window of positionWindows) {
    if (!actualReady) continue;
    const withPosition = actualComplete.filter((analysis) => window.value(analysis) !== null);
    const nearLimit = withPosition.filter(
      (analysis) => window.value(analysis)! >= window.current * 0.8,
    );
    const deeper = withPosition.filter(
      (analysis) => window.value(analysis)! < window.current * 0.8,
    );
    if (nearLimit.length < minimumPositionGroup || deeper.length < minimumPositionGroup)
      continue;
    const nearFailedRate = nearLimit.filter(positionFailed).length / nearLimit.length;
    const deeperFailedRate = deeper.filter(positionFailed).length / deeper.length;
    const tighten = nearFailedRate >= 0.5 && nearFailedRate >= deeperFailedRate + 0.15;
    result.push({
      parameterName: window.parameterName,
      label: window.label,
      currentValue: window.current,
      suggestedValue: tighten
        ? round(Math.max(5, window.current - 2), 1)
        : window.current,
      action: tighten ? "TIGHTEN" : "KEEP",
      confidence: actualConfidence,
      reason: tighten
        ? `靠近${window.label}上限的 ${nearLimit.length} 笔样本失效率 ${(nearFailedRate * 100).toFixed(1)}%，比更低位置 ${deeper.length} 笔的 ${(deeperFailedRate * 100).toFixed(1)}% 至少高15个百分点，建议收紧2个百分点后继续对照。`
        : `靠近${window.label}上限样本失效率 ${(nearFailedRate * 100).toFixed(1)}%、更低位置 ${(deeperFailedRate * 100).toFixed(1)}%，差异不足以收紧阈值。`,
    });
  }
  const largeTraderConfirmed = actualComplete.filter(
    (analysis) => analysis.entryLargeTraderStatus === "SUPPORTS_LONG",
  );
  if (largeTraderConfirmed.length >= input.minimumOrders) {
    const failedRate = largeTraderConfirmed.filter((analysis) =>
      analysis.finalOutcome === "LOSS" ||
      ["WEAK", "LATE", "GIVEBACK"].includes(analysis.quality)
    ).length / largeTraderConfirmed.length;
    result.push({
      parameterName: "largeTraderConfirmationEvidence",
      label: "大户聚合确认有效性",
      currentValue: largeTraderConfirmed.length,
      suggestedValue: failedRate >= 0.5
        ? "REVIEW_OI_AND_TAKER_THRESHOLDS"
        : "KEEP_CURRENT_CONFIRMATION",
      action: failedRate >= 0.5 ? "TIGHTEN" : "KEEP",
      confidence: actualConfidence,
      reason: failedRate >= 0.5
        ? `${largeTraderConfirmed.length}笔大户增多确认样本中 ${(failedRate * 100).toFixed(1)}% 入场后偏弱或利润回吐，应复核未平仓量和主动买量确认条件，不再仅看净多比例抬升。`
        : `${largeTraderConfirmed.length}笔大户增多确认样本中，早期失效比例为 ${(failedRate * 100).toFixed(1)}%，当前确认链保持不变。`,
    });
    if (failedRate >= 0.5) {
      const current = normalizeLargeTraderConfirmation(input.config.largeTrader);
      result.push(
        {
          parameterName: "largeTrader.minTakerBuySellRatio",
          label: "最低主动买卖比",
          currentValue: current.minTakerBuySellRatio,
          suggestedValue: round(Math.min(2, current.minTakerBuySellRatio + 0.02), 2),
          action: "TIGHTEN",
          confidence: actualConfidence,
          reason: `${largeTraderConfirmed.length}笔同引擎样本中 ${(failedRate * 100).toFixed(1)}% 确认后失效，建议小幅提高主动买量门槛后继续对照；系统不会自动改参。`,
        },
        {
          parameterName: "largeTrader.minOpenInterestChangePercent",
          label: "最低未平仓量变化",
          currentValue: current.minOpenInterestChangePercent,
          suggestedValue: round(Math.min(20, current.minOpenInterestChangePercent + 0.25), 2),
          action: "TIGHTEN",
          confidence: actualConfidence,
          reason: `${largeTraderConfirmed.length}笔同引擎样本中 ${(failedRate * 100).toFixed(1)}% 确认后失效，建议提高新增仓位确认门槛后继续对照；系统不会自动改参。`,
        },
      );
    }
  }
  const sweepConfirmed = actualComplete.filter(
    (analysis) => analysis.entryLiquiditySweepStatus === "RECLAIMED",
  );
  if (sweepConfirmed.length >= input.minimumOrders) {
    const failedRate = sweepConfirmed.filter((analysis) =>
      analysis.finalOutcome === "LOSS" ||
      ["WEAK", "LATE", "GIVEBACK"].includes(analysis.quality)
    ).length / sweepConfirmed.length;
    const current = input.config.trend.maxPriorRangeAtr ?? 4;
    result.push({
      parameterName: "trend.maxPriorRangeAtr",
      label: "扫盘前震荡区间上限",
      currentValue: current,
      suggestedValue: failedRate >= 0.5
        ? round(Math.max(1, current - 0.25), 2)
        : current,
      action: failedRate >= 0.5 ? "TIGHTEN" : "KEEP",
      confidence: actualConfidence,
      reason: failedRate >= 0.5
        ? `${sweepConfirmed.length}笔同引擎扫盘收回样本中 ${(failedRate * 100).toFixed(1)}% 入场后偏弱、回吐或最终亏损，建议缩小扫盘前震荡区间后继续对照。`
        : `${sweepConfirmed.length}笔同引擎扫盘收回样本中，失效比例为 ${(failedRate * 100).toFixed(1)}%，当前震荡区间上限保持不变。`,
    });
  }
  const broadRangeControls = rejectedComplete.filter((analysis) =>
    analysis.observationMode === "REJECTED_COUNTERFACTUAL" &&
    analysis.rejectionCode === "PRIOR_RANGE_TOO_WIDE" &&
    analysis.entryLiquiditySweepStatus === "UNCONFIRMED" &&
    analysis.entryPriorRangeState === "BROAD"
  );
  const minimumRejectedControlGroup = Math.max(
    3,
    Math.ceil(input.minimumOrders * 0.2),
  );
  if (
    sweepConfirmed.length < input.minimumOrders &&
    broadRangeControls.length >= minimumRejectedControlGroup
  ) {
    const missedRate = broadRangeControls.filter(
      (analysis) => analysis.quality === "MISSED_WIN",
    ).length / broadRangeControls.length;
    const avoidedRate = broadRangeControls.filter(
      (analysis) => analysis.quality === "AVOIDED_LOSS",
    ).length / broadRangeControls.length;
    const current = input.config.trend.maxPriorRangeAtr ?? 4;
    const loosen = missedRate >= 0.3 && missedRate > avoidedRate;
    result.push({
      parameterName: "trend.maxPriorRangeAtr",
      label: "宽幅扫盘拒绝对照",
      currentValue: current,
      suggestedValue: loosen ? round(Math.min(12, current + 0.25), 2) : current,
      action: loosen ? "LOOSEN" : "KEEP",
      confidence: rejectedConfidence,
      reason: loosen
        ? `${broadRangeControls.length}笔宽幅区间拒绝样本中 ${(missedRate * 100).toFixed(1)}% 成为错失盈利，高于避免亏损的 ${(avoidedRate * 100).toFixed(1)}%，建议仅放宽 0.25 ATR 后重新验证。`
        : `${broadRangeControls.length}笔宽幅区间拒绝样本中，错失盈利 ${(missedRate * 100).toFixed(1)}%、避免亏损 ${(avoidedRate * 100).toFixed(1)}%，当前区间上限保持不变。`,
    });
  }
  const higherTimeframeBreakControls = [
    {
      rejectionCode: "TREND_1H_REJECTED",
      parameterName: "trend.trend1hBreakHandling",
      label: "1小时破位处理",
      currentValue: input.config.trend.trend1hBreakHandling ?? "REJECT",
    },
    {
      rejectionCode: "STRUCTURE_30M_REJECTED",
      parameterName: "trend.structure30mBreakHandling",
      label: "30分钟破位处理",
      currentValue: input.config.trend.structure30mBreakHandling ?? "REJECT",
    },
  ];
  for (const control of higherTimeframeBreakControls) {
    const controls = rejectedComplete.filter((analysis) =>
      analysis.observationMode === "REJECTED_COUNTERFACTUAL" &&
      analysis.rejectionCode === control.rejectionCode &&
      ["QUALIFIED", "REJECTED", "INCOMPLETE"].includes(
        String(analysis.postBreakLocalRecoveryStatus),
      )
    );
    if (controls.length < minimumRejectedControlGroup) continue;
    const minimumExecutionEdgeRoe = Math.max(
      0.5,
      (input.config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.1,
    );
    const estimatedProfits = controls
      .map((analysis) =>
        analysis.postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent
      )
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const averageEstimatedGrossRoe = estimatedProfits.length
      ? estimatedProfits.reduce((sum, value) => sum + value, 0) / estimatedProfits.length
      : null;
    const medianEstimatedGrossRoe = median(estimatedProfits);
    const missedRate = controls.filter(
      (analysis) =>
        analysis.postBreakLocalRecoveryStatus === "QUALIFIED" &&
        analysis.postBreakLocalRecoveryOutcome === "TAKE_PROFIT_FIRST" &&
        (analysis.postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent ?? 0) >
          minimumExecutionEdgeRoe,
    ).length / controls.length;
    const avoidedRate = controls.filter(
      (analysis) =>
        analysis.postBreakLocalRecoveryStatus === "QUALIFIED" &&
        (
          analysis.postBreakLocalRecoveryOutcome === "STOP_LOSS_FIRST" ||
          (analysis.postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent ?? 0) < 0
        ),
    ).length / controls.length;
    const waitForReclaim = missedRate >= 0.3 &&
      missedRate > avoidedRate &&
      averageEstimatedGrossRoe !== null &&
      averageEstimatedGrossRoe > minimumExecutionEdgeRoe &&
      medianEstimatedGrossRoe !== null &&
      medianEstimatedGrossRoe > minimumExecutionEdgeRoe;
    const suggestedValue = waitForReclaim
      ? "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM"
      : "REJECT";
    result.push({
      parameterName: control.parameterName,
      label: control.label,
      currentValue: control.currentValue,
      suggestedValue,
      action: suggestedValue === control.currentValue
        ? "KEEP"
        : waitForReclaim
          ? "LOOSEN"
          : "TIGHTEN",
      confidence: rejectedConfidence,
      reason: waitForReclaim
        ? `${controls.length}笔${control.label}独立影子样本中 ${(missedRate * 100).toFixed(1)}% 在确认后先达到首档止盈，且较差端退出估算超过 ${minimumExecutionEdgeRoe.toFixed(2)}% ROE执行成本缓冲，高于先止损或估算亏损的 ${(avoidedRate * 100).toFixed(1)}%；平均/中位较差端总ROE ${averageEstimatedGrossRoe!.toFixed(2)}%/${medianEstimatedGrossRoe!.toFixed(2)}%。建议只允许等待完整1分钟反转、3分钟量价确认和5分钟局部收回，不允许破位后直接入场。`
        : `${controls.length}笔${control.label}独立影子样本中，超过 ${minimumExecutionEdgeRoe.toFixed(2)}% ROE缓冲且先止盈 ${(missedRate * 100).toFixed(1)}%、先止损或估算亏损 ${(avoidedRate * 100).toFixed(1)}%，平均/中位较差端总ROE ${averageEstimatedGrossRoe === null ? "—" : `${averageEstimatedGrossRoe.toFixed(2)}%`}/${medianEstimatedGrossRoe === null ? "—" : `${medianEstimatedGrossRoe.toFixed(2)}%`}；证据不足时保持直接拒绝。`,
    });
  }
  const clusterComparable = actualComplete.filter(
    (analysis) =>
      analysis.observationMode === "ACTUAL_POSITION" &&
      analysis.entryLiquidationEventCount !== null,
  );
  const repeatedClusters = clusterComparable.filter(
    (analysis) => (analysis.entryLiquidationEventCount ?? 0) >= 2,
  );
  const singleClusters = clusterComparable.filter(
    (analysis) => analysis.entryLiquidationEventCount === 1,
  );
  const minimumClusterGroup = Math.max(3, Math.ceil(input.minimumOrders * 0.2));
  if (
    clusterComparable.length >= input.minimumOrders &&
    repeatedClusters.length >= minimumClusterGroup &&
    singleClusters.length >= minimumClusterGroup
  ) {
    const failed = (analysis: PostEntryAnalysis) =>
      analysis.finalOutcome === "LOSS" ||
      ["WEAK", "LATE", "GIVEBACK"].includes(analysis.quality);
    const repeatedFailedRate = repeatedClusters.filter(failed).length / repeatedClusters.length;
    const singleFailedRate = singleClusters.filter(failed).length / singleClusters.length;
    const current = Math.max(1, input.config.trigger.minClusterEvents ?? 1);
    const tighten = current < 20 &&
      repeatedFailedRate + 0.15 <= singleFailedRate;
    result.push({
      parameterName: "trigger.minClusterEvents",
      label: "单币窗口最少爆仓事件",
      currentValue: current,
      suggestedValue: tighten ? current + 1 : current,
      action: tighten ? "TIGHTEN" : "KEEP",
      confidence: actualConfidence,
      reason: tighten
        ? `同一合约连续累计爆仓组 ${repeatedClusters.length} 笔的失效率 ${(repeatedFailedRate * 100).toFixed(1)}%，比单笔强信号组 ${singleClusters.length} 笔的 ${(singleFailedRate * 100).toFixed(1)}% 至少低15个百分点，建议将单币窗口最少事件数提高到 ${current + 1}。`
        : `同一合约连续爆仓组失效率 ${(repeatedFailedRate * 100).toFixed(1)}%、单笔爆仓组 ${(singleFailedRate * 100).toFixed(1)}%，差异不足以提高触发门槛。`,
    });
  }
  const configuredClusterSpanSeconds = input.config.trigger.maxClusterSpanSeconds ?? 3;
  const clusterSpanComparable = clusterComparable.filter(
    (analysis) => analysis.entryLiquidationClusterSpanMs !== null,
  );
  const compactClusters = clusterSpanComparable.filter(
    (analysis) =>
      (analysis.entryLiquidationClusterSpanMs ?? Number.POSITIVE_INFINITY) <=
        configuredClusterSpanSeconds * 500,
  );
  const dispersedClusters = clusterSpanComparable.filter(
    (analysis) =>
      (analysis.entryLiquidationClusterSpanMs ?? 0) >=
        configuredClusterSpanSeconds * 800,
  );
  if (
    clusterSpanComparable.length >= input.minimumOrders &&
    compactClusters.length >= minimumClusterGroup &&
    dispersedClusters.length >= minimumClusterGroup
  ) {
    const failed = (analysis: PostEntryAnalysis) =>
      analysis.finalOutcome === "LOSS" ||
      ["WEAK", "LATE", "GIVEBACK"].includes(analysis.quality);
    const compactFailedRate = compactClusters.filter(failed).length / compactClusters.length;
    const dispersedFailedRate = dispersedClusters.filter(failed).length / dispersedClusters.length;
    const tighten = dispersedFailedRate >= 0.5 &&
      dispersedFailedRate >= compactFailedRate + 0.15;
    result.push({
      parameterName: "trigger.maxClusterSpanSeconds",
      label: "连续爆仓最大跨度",
      currentValue: configuredClusterSpanSeconds,
      suggestedValue: tighten
        ? Math.max(10, configuredClusterSpanSeconds - 15)
        : configuredClusterSpanSeconds,
      action: tighten ? "TIGHTEN" : "KEEP",
      confidence: actualConfidence,
      reason: tighten
        ? `紧凑爆仓组 ${compactClusters.length} 笔的失效率 ${(compactFailedRate * 100).toFixed(1)}%，接近跨度上限组 ${dispersedClusters.length} 笔为 ${(dispersedFailedRate * 100).toFixed(1)}%，建议收紧15秒以避免把分散事件误判成同一轮杀仓。`
        : `紧凑爆仓组失效率 ${(compactFailedRate * 100).toFixed(1)}%、接近跨度上限组 ${(dispersedFailedRate * 100).toFixed(1)}%，差异不足以收紧事件簇时效。`,
    });
  }
  if (causalActualReady && weakRate >= 0.5) {
    result.push({
      parameterName: "trend.volumeRatio3m",
      label: "3分钟成交量倍数",
      currentValue: input.config.trend.volumeRatio3m,
      suggestedValue: round(Math.min(10, input.config.trend.volumeRatio3m + 0.1), 2),
      action: "TIGHTEN",
      confidence: actualConfidence,
      reason: `${causalIndependentActualComplete.length}笔因果证据完整的独立真实下单样本中 ${(weakRate * 100).toFixed(1)}% 入场后偏弱，建议提高量能确认门槛。`,
    });
    result.push({
      parameterName: "trend.maxEntryDistanceAtr",
      label: "最大入场距离",
      currentValue: input.config.trend.maxEntryDistanceAtr,
      suggestedValue: round(Math.max(0.1, input.config.trend.maxEntryDistanceAtr * 0.9), 2),
      action: "TIGHTEN",
      confidence: actualConfidence,
      reason: `${actualComplete.length}笔真实下单完整样本显示早期弱势比例偏高，建议减少追价距离后继续对照验证。`,
    });
  }
  if (actualReady && givebackRate >= 0.35) {
    result.push(earlyActivationRate >= givebackRate / 2
      ? {
          parameterName: "risk.trailingActivationPercent",
          label: "移动止损启动盈利",
          currentValue: input.config.risk.trailingActivationPercent,
          suggestedValue: round(Math.max(0.1, input.config.risk.trailingActivationPercent * 0.8), 2),
          action: "TIGHTEN" as const,
          confidence: actualConfidence,
          reason: `${actualComplete.length}笔真实下单完整样本中 ${(earlyActivationRate * 100).toFixed(1)}% 在移动止损启动前已出现可保护盈利并最终回吐，建议提前启动。`,
        }
      : {
          parameterName: "risk.trailingDrawdownPercent",
          label: "移动止损回撤",
          currentValue: input.config.risk.trailingDrawdownPercent,
          suggestedValue: round(Math.max(0.1, input.config.risk.trailingDrawdownPercent * 0.85), 2),
          action: "TIGHTEN" as const,
          confidence: actualConfidence,
          reason: `${actualComplete.length}笔真实下单完整样本中 ${(givebackRate * 100).toFixed(1)}% 出现明显利润回撤，建议缩小移动止损回撤。`,
        });
  }
  return result;
}

function nestedNumber(value: Record<string, unknown>, key: string): number | null {
  const direct = finiteOrNull(value[key]);
  if (direct !== null) return direct;
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const found = nestedNumber(nested as Record<string, unknown>, key);
      if (found !== null) return found;
    }
  }
  return null;
}

function boundedPositionPercent(
  value: Record<string, unknown>,
  key: "position24hPercent" | "position72hPercent",
) {
  const percent = nestedNumber(value, key);
  return percent === null ? null : Math.min(100, Math.max(0, percent));
}

function consensusShadowFromEvidence(value: Record<string, unknown>) {
  const shadow = value.consensusShadow;
  if (!shadow || typeof shadow !== "object" || Array.isArray(shadow)) return null;
  const record = shadow as Record<string, unknown>;
  const verdict = String(record.verdict);
  if (![
    "STRICT_CONSENSUS",
    "RECOVERY_CONSENSUS",
    "MIXED",
    "CONFLICT",
    "INCOMPLETE",
  ].includes(verdict)) return null;
  return {
    verdict: verdict as NonNullable<PostEntryAnalysis["entryConsensusVerdict"]>,
    supportCount: finiteOrNull(record.supportCount),
    conflictCount: finiteOrNull(record.conflictCount),
    summary: typeof record.summary === "string"
      ? record.summary
      : "已记录异构证据共识快照",
  };
}

function sampleRoeAt(samples: PostEntrySample[], minuteOffset: number) {
  return finiteOrNull(
    samples.find((sample) => sample.minuteOffset === minuteOffset)?.roePercent,
  );
}

function largeTraderStatus(value: Record<string, unknown>) {
  const status = entryLargeTraderPositioning(value).status;
  return status === "SUPPORTS_LONG" || status === "CONFLICTS_LONG" ||
    status === "NEUTRAL" || status === "UNAVAILABLE"
    ? status
    : null;
}

function largeTraderConfirmationMode(value: Record<string, unknown>) {
  const mode = entryLargeTraderPositioning(value).confirmationMode;
  return mode === "BROAD_LONG" || mode === "CAPITAL_CONCENTRATION_LONG"
    ? mode
    : null;
}

function liquiditySweepStatus(value: Record<string, unknown>) {
  const sweep = value.liquiditySweep;
  if (!sweep || typeof sweep !== "object" || Array.isArray(sweep)) return null;
  const status = (sweep as Record<string, unknown>).status;
  return ["RECLAIMED", "ACTIVE_CASCADE", "UNCONFIRMED", "DATA_STALE"].includes(String(status))
    ? status as PostEntryAnalysis["entryLiquiditySweepStatus"]
    : null;
}

function liquiditySweepRangeState(value: Record<string, unknown>) {
  const sweep = value.liquiditySweep;
  if (!sweep || typeof sweep !== "object" || Array.isArray(sweep)) return null;
  const detail = (sweep as Record<string, unknown>).detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const state = (detail as Record<string, unknown>).rangeState;
  return ["COMPRESSED", "BROAD", "UNKNOWN"].includes(String(state))
    ? state as PostEntryAnalysis["entryPriorRangeState"]
    : null;
}

function postBreakLocalRecovery(samples: PostEntrySample[]) {
  for (const sample of samples) {
    if (!sample.evidenceJson) continue;
    try {
      const evidence = JSON.parse(sample.evidenceJson) as Record<string, unknown>;
      const shadow = evidence.postBreakLocalRecoveryShadow;
      if (!shadow || typeof shadow !== "object" || Array.isArray(shadow)) continue;
      const record = shadow as Record<string, unknown>;
      const status = String(record.status);
      const outcome = String(record.outcome);
      if (!['QUALIFIED', 'REJECTED', 'INCOMPLETE'].includes(status) ||
        !['TAKE_PROFIT_FIRST', 'STOP_LOSS_FIRST', 'AMBIGUOUS', 'NO_TRIGGER', 'NO_ENTRY'].includes(outcome))
        continue;
      return {
        status: status as NonNullable<PostEntryAnalysis["postBreakLocalRecoveryStatus"]>,
        outcome: outcome as NonNullable<PostEntryAnalysis["postBreakLocalRecoveryOutcome"]>,
        reason: typeof record.reason === "string" ? record.reason : null,
        entryPrice: finiteOrNull(record.entryPrice),
        volumeRatio3m: finiteOrNull(record.volumeRatio3m),
        volumeRatio5m: finiteOrNull(record.volumeRatio5m),
        mfeRoePercent: finiteOrNull(record.mfeRoePercent),
        maeRoePercent: finiteOrNull(record.maeRoePercent),
        takeProfitMinute: finiteOrNull(record.takeProfitMinute),
        stopLossMinute: finiteOrNull(record.stopLossMinute),
        estimatedGrossRoePercent: finiteOrNull(record.estimatedGrossRoePercent),
        estimatedObservedCloseGrossRoePercent: finiteOrNull(
          record.estimatedObservedCloseGrossRoePercent,
        ),
        estimatedExitMinute: finiteOrNull(record.estimatedExitMinute),
        estimatedExitReason: ["TAKE_PROFIT", "TRAILING_STOP", "STOP_LOSS", "OPEN"].includes(
          String(record.estimatedExitReason),
        )
          ? record.estimatedExitReason as NonNullable<PostEntryAnalysis["postBreakLocalRecoveryEstimatedExitReason"]>
          : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function formatSigned(value: number | null) {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatNumber(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteOr(value: unknown, fallback: number) {
  return finiteOrNull(value) ?? fallback;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function averageFinite(values: Array<number | null | undefined>) {
  const valid = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  return valid.length
    ? valid.reduce((sum, value) => sum + value, 0) / valid.length
    : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wilsonLowerBound(successes: number, total: number) {
  if (total <= 0) return 0;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const z2 = z * z;
  return (
    proportion +
    z2 / (2 * total) -
    z *
      Math.sqrt(
        (proportion * (1 - proportion) + z2 / (4 * total)) / total,
      )
  ) / (1 + z2 / total);
}

function waveRepresentativeRoe(analysis: PostEntryAnalysis) {
  const value = analysis.consensusRoe60mPercent ??
    analysis.latestRoePercent ??
    analysis.finalNetRoePercent;
  return value !== null && Number.isFinite(value) ? value : null;
}

function waveClusterCohorts(rows: PostEntryAnalysis[]) {
  const groups = new Map<string, PostEntryAnalysis[]>();
  for (const row of rows) {
    if (row.entryIndependentOpportunity === false) continue;
    const clusterId = row.entryMarketClusterId?.trim();
    if (!clusterId) continue;
    const group = groups.get(clusterId) ?? [];
    group.push(row);
    groups.set(clusterId, group);
  }
  return [...groups].map(([clusterId, cohortRows]) => ({
    clusterId,
    rows: cohortRows,
  }));
}

function deduplicateWaveOpportunities(rows: PostEntryAnalysis[]) {
  const eligible = rows.filter(
    (analysis) => analysis.entryIndependentOpportunity !== false,
  );
  const byCluster = new Map<
    string,
    Array<{ row: PostEntryAnalysis; index: number }>
  >();
  const ungrouped: Array<{ row: PostEntryAnalysis; index: number }> = [];
  eligible.forEach((row, index) => {
    const clusterId = row.entryMarketClusterId?.trim();
    if (!clusterId) {
      ungrouped.push({ row, index });
      return;
    }
    const group = byCluster.get(clusterId) ?? [];
    group.push({ row, index });
    byCluster.set(clusterId, group);
  });
  const representatives = [...byCluster.values()].map((group) => {
    const comparable = group
      .map((item) => ({
        ...item,
        roe: waveRepresentativeRoe(item.row),
      }))
      .filter(
        (item): item is typeof item & { roe: number } =>
          item.roe !== null,
      );
    if (!comparable.length)
      return [...group].sort(
        (left, right) =>
          (left.row.decisionAtMs ?? Number.POSITIVE_INFINITY) -
            (right.row.decisionAtMs ?? Number.POSITIVE_INFINITY) ||
          left.index - right.index,
      )[0];
    const middle = median(comparable.map((item) => item.roe))!;
    return [...comparable].sort(
      (left, right) =>
        Math.abs(left.roe - middle) - Math.abs(right.roe - middle) ||
        (left.row.decisionAtMs ?? Number.POSITIVE_INFINITY) -
          (right.row.decisionAtMs ?? Number.POSITIVE_INFINITY) ||
        left.index - right.index,
    )[0];
  });
  return [...ungrouped, ...representatives]
    .sort((left, right) => {
      if (
        left.row.decisionAtMs !== null &&
        right.row.decisionAtMs !== null &&
        left.row.decisionAtMs !== right.row.decisionAtMs
      )
        return left.row.decisionAtMs - right.row.decisionAtMs;
      return left.index - right.index;
    })
    .map((item) => item.row);
}
