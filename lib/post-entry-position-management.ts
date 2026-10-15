import type { PostEntryContractTrendProfile } from "./post-entry-contract-trend.ts";
import type { PositionThesisOutlook } from "./position-thesis-update.ts";
import {
  assessPositionEvidenceRisk,
  type PositionEvidenceRiskAssessment,
  type PositionEvidenceRiskConfig,
} from "./position-evidence-risk.ts";

export type PositionManagementState =
  | "PROFIT_CONTINUATION"
  | "PROFIT_HOLD_OBSERVE"
  | "PROFIT_PROTECT"
  | "LOSS_WAIT_BOTTOM"
  | "BOTTOM_REBOUND_CONFIRMED"
  | "EVIDENCE_DEGRADING"
  | "TREND_INVALIDATED"
  | "NEUTRAL";

export type PositionManagementAction =
  | "HOLD_FOR_EXTENSION"
  | "HOLD_AND_OBSERVE"
  | "TIGHTEN_PROFIT_PROTECTION"
  | "WAIT_NO_ADD"
  | "ADD_ELIGIBLE"
  | "SCALE_IN_ELIGIBLE"
  | "REDUCE_RISK_BY_EVIDENCE"
  | "EXIT_OR_REDUCE_BY_RISK_PLAN";

export type PositionMarketPhase =
  | "CONTINUATION"
  | "NORMAL_OSCILLATION"
  | "MOMENTUM_DECAY"
  | "STRUCTURE_DAMAGED"
  | "REVERSAL_CONFIRMED"
  | "DATA_UNRELIABLE";

export type ReversalEvidenceSequence = {
  structureBroken: boolean;
  reclaimFailed: boolean;
  oppositeFlowConfirmed: boolean;
  shortCycleConfirmed: boolean;
  horizonConfirmed: boolean;
  confirmed: boolean;
  nextRequiredEvidence: string | null;
};

export type PositionStructureEvidenceStage =
  | "STABLE"
  | "STRUCTURE_BREAK_OBSERVED"
  | "INVALIDATION_CONFIRMED_WAITING_VOLUME"
  | "SHORT_CYCLE_INVALIDATED_WAITING_HORIZON"
  | "DISCIPLINARY_EXIT_CANDIDATE";

export const POSITION_MANAGEMENT_MODEL_VERSION = "position-management-v10" as const;
export const POSITION_ROTATION_MODEL_VERSION = "position-rotation-v1" as const;

export type PositionRotationPrimaryAction =
  | "KEEP_WINNER"
  | "HOLD_PRIMARY_LEG"
  | "PROTECT_AND_ROTATE_PARTIAL"
  | "WAIT_FOR_BOTTOM_CONFIRMATION"
  | "ADD_PRIMARY_PROBE"
  | "RELEASE_CAPITAL_BY_RISK_PLAN";

export type PositionRotationHedgeAction =
  | "NO_HEDGE"
  | "WATCH_OPPOSITE_LEG_AFTER_PRICE_IMPROVES"
  | "ALLOW_HEDGE_AFTER_PROFIT_LOCK"
  | "DO_NOT_HEDGE_INVALIDATED_LOSS";

export type PositionRotationCapitalAction =
  | "KEEP_CAPITAL_ASSIGNED"
  | "FREE_PROFIT_CAPITAL"
  | "RESERVE_FOR_CONFIRMED_ADD"
  | "DO_NOT_ADD_CAPITAL"
  | "RELEASE_FOR_NEW_SIGNAL";

export type PositionRotationPlan = {
  modelVersion: typeof POSITION_ROTATION_MODEL_VERSION;
  primaryAction: PositionRotationPrimaryAction;
  hedgeAction: PositionRotationHedgeAction;
  capitalAction: PositionRotationCapitalAction;
  label: string;
  reason: string;
  evidenceCodes: string[];
  blockedReasons: string[];
};

export type PositionManagementDecision = {
  modelVersion: typeof POSITION_MANAGEMENT_MODEL_VERSION;
  state: PositionManagementState;
  action: PositionManagementAction;
  label: string;
  currentRoePercent: number;
  currentNetRoePercent: number;
  bestRoePercent: number;
  worstRoePercent: number;
  recoveryFromTroughRoePoints: number;
  givebackFromPeakRoePoints: number;
  continuationEvidence: boolean;
  bottomReboundEvidence: boolean;
  trendPathStatus: string | null;
  tradeVolumeStatus: string | null;
  fundingVolumeStatus: string | null;
  contractTrendProfile: PostEntryContractTrendProfile | null;
  positionThesisOutlook: PositionThesisOutlook | null;
  addOnExecutionAuthorized: false;
  evidenceCodes: string[];
  missingEvidence: string[];
  marketPhase: PositionMarketPhase;
  reversalEvidenceSequence: ReversalEvidenceSequence;
  structureEvidenceStage: PositionStructureEvidenceStage;
  evidenceRiskAssessment: PositionEvidenceRiskAssessment;
  rotationPlan: PositionRotationPlan;
  reason: string;
};

/**
 * 持仓管理只解释已经发生的价格与资金证据，不预测必然创新高，也不直接下单。
 * 补仓资格必须同时满足“先形成低点、再反弹、支撑未失效、资金未撤退”，
 * 避免把持续下跌误当成低位。
 */
export function analyzePositionManagementDecision(input: {
  positionSide?: "LONG" | "SHORT";
  currentRoePercent: number;
  bestRoePercent: number;
  worstRoePercent: number;
  waveState?: string | null;
  breakdownStatus?: string | null;
  largeTraderStatus?: string | null;
  marketRegimeStatus?: string | null;
  liquidationRegimeStatus?: string | null;
  liquidationRegimeReason?: string | null;
  trendPathStatus?: string | null;
  tradeVolumeStatus?: string | null;
  entryThesisStatus?: string | null;
  fundingVolumeStatus?: string | null;
  profitGivebackRoePoints?: number;
  bottomRecoveryRoePoints?: number;
  contractTrendProfile?: PostEntryContractTrendProfile | null;
  positionThesisOutlook?: PositionThesisOutlook | null;
  observedMinute?: number;
  minute3RoePercent?: number | null;
  minute5RoePercent?: number | null;
  estimatedRoundTripCostRoePercent?: number | null;
  evidenceRiskConfig?: Partial<PositionEvidenceRiskConfig> | null;
  priorEvidenceRiskReductionExecuted?: boolean;
  postReductionElapsedSeconds?: number | null;
}): PositionManagementDecision {
  const current = finite(input.currentRoePercent);
  const estimatedRoundTripCostRoePercent = Math.max(
    0,
    finite(input.estimatedRoundTripCostRoePercent),
  );
  const currentNet = current - estimatedRoundTripCostRoePercent;
  const best = Math.max(current, finite(input.bestRoePercent));
  const worst = Math.min(current, finite(input.worstRoePercent));
  const recovery = Math.max(0, current - worst);
  const giveback = Math.max(0, best - current);
  const givebackThreshold = positiveOr(input.profitGivebackRoePoints, 3);
  const reboundThreshold = positiveOr(input.bottomRecoveryRoePoints, 2);
  const supportBroken = input.waveState === "SUPPORT_BREAK";
  const upsideBreakout = input.waveState === "UPSIDE_BREAKOUT";
  const breakdownPressure = input.breakdownStatus === "BREAKDOWN_PRESSURE";
  const breakdownStable = input.breakdownStatus === "STABLE";
  const capitalWithdrawal = input.largeTraderStatus === "CAPITAL_WITHDRAWAL";
  const capitalSupports = input.largeTraderStatus === "SUPPORT_CONTINUES";
  const fundingSupports = [
    "SQUEEZE_CONTINUATION",
    "POSITION_CONTINUATION",
  ].includes(input.fundingVolumeStatus ?? "");
  const fundingAdverse =
    input.fundingVolumeStatus === "CROWDING_REVERSAL_RISK";
  const fundingUnwinding =
    input.fundingVolumeStatus === "POSITIONING_UNWINDING";
  const trendPathProvided = input.trendPathStatus !== undefined;
  const trendContinuation =
    !trendPathProvided || input.trendPathStatus === "CONTINUATION_CONFIRMED";
  const trendDecay = input.trendPathStatus === "MOMENTUM_DECAY";
  const trendRecovery =
    !trendPathProvided || input.trendPathStatus === "RECOVERY_CONFIRMED";
  const trendReversal = input.trendPathStatus === "REVERSAL_PRESSURE";
  const tradeVolumeProvided = input.tradeVolumeStatus !== undefined;
  const directionalFlowSupports =
    input.tradeVolumeStatus === "DIRECTIONAL_EXPANSION";
  const directionalFlowAdverse =
    input.tradeVolumeStatus === "OPPOSITE_EXPANSION";
  const closedThesisInvalidated = input.entryThesisStatus === "INVALIDATED";
  const adverseMarket = input.marketRegimeStatus === "ADVERSE";
  const adverseLiquidation =
    input.liquidationRegimeStatus === "ADVERSE";
  const remainingExpectancyDeteriorating =
    input.positionThesisOutlook === "DETERIORATING" ||
    input.positionThesisOutlook === "INVALIDATED";
  const localProfitWeaknessConfirmed =
    trendDecay ||
    trendReversal ||
    breakdownPressure ||
    directionalFlowAdverse;
  const costAwareProfitProtection =
    currentNet > 0 &&
    giveback >= givebackThreshold &&
    remainingExpectancyDeteriorating &&
    localProfitWeaknessConfirmed;
  const expiredHorizonProfitGiveback =
    input.contractTrendProfile?.observationHorizonExpired === true &&
    currentNet > 0 &&
    giveback >= givebackThreshold;
  // 真正反转必须按顺序形成闭环：目标币结构破坏、连续闭合1分钟无法收回，
  // 再由持仓后的短周期真实成交量确认反向扩张。背景数据不参与动作授权。
  const reversalEvidenceSequence = buildReversalEvidenceSequence({
    structureBroken: supportBroken,
    reclaimFailed: breakdownPressure && closedThesisInvalidated,
    oppositeFlowConfirmed: directionalFlowAdverse,
    horizonConfirmed:
      input.contractTrendProfile?.shortCycleExitAuthorized ?? true,
  });
  const structureEvidenceStage: PositionStructureEvidenceStage =
    reversalEvidenceSequence.confirmed
      ? "DISCIPLINARY_EXIT_CANDIDATE"
      : reversalEvidenceSequence.shortCycleConfirmed
        ? "SHORT_CYCLE_INVALIDATED_WAITING_HORIZON"
      : reversalEvidenceSequence.reclaimFailed
        ? "INVALIDATION_CONFIRMED_WAITING_VOLUME"
        : reversalEvidenceSequence.structureBroken
          ? "STRUCTURE_BREAK_OBSERVED"
          : "STABLE";
  const evidenceRiskAssessment = assessPositionEvidenceRisk({
    config: input.evidenceRiskConfig,
    observedMinute: input.observedMinute ?? 0,
    currentRoePercent: current,
    bestRoePercent: best,
    minute3RoePercent: input.minute3RoePercent,
    minute5RoePercent: input.minute5RoePercent,
    estimatedRoundTripCostRoePercent:
      input.estimatedRoundTripCostRoePercent,
    profitGivebackRoePoints: input.profitGivebackRoePoints,
    priorReductionExecuted: input.priorEvidenceRiskReductionExecuted,
    postReductionElapsedSeconds: input.postReductionElapsedSeconds,
    clearInvalidation: reversalEvidenceSequence.confirmed,
    waveState: input.waveState,
    entryThesisStatus: input.entryThesisStatus,
    trendPathStatus: input.trendPathStatus,
    tradeVolumeStatus: input.tradeVolumeStatus,
    contractTrendStatus: input.contractTrendProfile?.status,
    positionThesisOutlook: input.positionThesisOutlook,
  });
  const continuationEvidence =
    currentNet > 0 &&
    upsideBreakout &&
    trendContinuation &&
    !breakdownPressure &&
    directionalFlowSupports &&
    !directionalFlowAdverse;
  const bottomReboundEvidence =
    currentNet < 0 &&
    worst < current &&
    recovery >= reboundThreshold &&
    trendRecovery &&
    breakdownStable &&
    !supportBroken &&
    !directionalFlowAdverse &&
    directionalFlowSupports;
  const evidenceCodes = [
    upsideBreakout ? "PRIOR_HIGH_BROKEN" : null,
    input.waveState === "NORMAL_RANGE" ? "SUPPORT_RANGE_INTACT" : null,
    breakdownStable ? "BREAKDOWN_NOT_CONFIRMED" : null,
    capitalSupports ? "CAPITAL_SUPPORT_PRESENT" : null,
    capitalWithdrawal ? "CAPITAL_WITHDRAWAL" : null,
    fundingSupports ? "FUNDING_VOLUME_CONTINUATION" : null,
    fundingAdverse ? "FUNDING_CROWDING_REVERSAL_RISK" : null,
    fundingUnwinding ? "FUNDING_POSITIONING_UNWINDING" : null,
    input.trendPathStatus === "CONTINUATION_CONFIRMED"
      ? "CLOSED_5M_PATH_CONTINUATION"
      : null,
    trendDecay ? "CLOSED_5M_PATH_DECAY" : null,
    input.trendPathStatus === "RECOVERY_CONFIRMED"
      ? "CLOSED_5M_PATH_RECOVERY"
      : null,
    trendReversal ? "CLOSED_5M_PATH_REVERSAL_PRESSURE" : null,
    directionalFlowSupports ? "POST_ENTRY_TRADE_VOLUME_SUPPORTS" : null,
    directionalFlowAdverse ? "POST_ENTRY_TRADE_VOLUME_OPPOSES" : null,
    closedThesisInvalidated ? "CLOSED_1M_THESIS_INVALIDATED" : null,
    adverseMarket ? "MARKET_ADVERSE" : null,
    adverseLiquidation ? "GLOBAL_LIQUIDATION_ADVERSE" : null,
    recovery >= reboundThreshold ? "TROUGH_RECOVERY_CONFIRMED" : null,
    giveback >= givebackThreshold ? "PROFIT_GIVEBACK_REACHED" : null,
    remainingExpectancyDeteriorating
      ? "REMAINING_EXPECTANCY_DETERIORATING"
      : null,
    costAwareProfitProtection
      ? "NET_EXPECTANCY_GIVEBACK_PROTECTION"
      : null,
    expiredHorizonProfitGiveback
      ? "EXPIRED_HORIZON_PROFIT_GIVEBACK"
      : null,
    ...(input.contractTrendProfile?.evidenceCodes ?? []),
  ].filter((code): code is string => Boolean(code));
  const missingEvidence = [
    !input.waveState || input.waveState === "UNAVAILABLE"
      ? "WAVE_STRUCTURE"
      : null,
    !input.breakdownStatus || input.breakdownStatus === "UNAVAILABLE"
      ? "BREAKDOWN_STATUS"
      : null,
    tradeVolumeProvided &&
    (!input.tradeVolumeStatus || input.tradeVolumeStatus === "UNAVAILABLE")
      ? "POST_ENTRY_TRADE_VOLUME"
      : null,
    trendPathProvided &&
    (!input.trendPathStatus || input.trendPathStatus === "UNAVAILABLE")
      ? "TREND_PATH"
      : null,
    input.contractTrendProfile?.requiredForDecision === true &&
      input.contractTrendProfile.status === "UNAVAILABLE"
      ? "MULTI_HOUR_CONTRACT_TREND"
      : null,
  ].filter((code): code is string => Boolean(code));
  const dataUnreliable = missingEvidence.length >= 3;

  const common = {
    modelVersion: POSITION_MANAGEMENT_MODEL_VERSION,
    currentRoePercent: rounded(current),
    currentNetRoePercent: rounded(currentNet),
    bestRoePercent: rounded(best),
    worstRoePercent: rounded(worst),
    recoveryFromTroughRoePoints: rounded(recovery),
    givebackFromPeakRoePoints: rounded(giveback),
    continuationEvidence,
    bottomReboundEvidence,
    trendPathStatus: input.trendPathStatus ?? null,
    tradeVolumeStatus: input.tradeVolumeStatus ?? null,
    fundingVolumeStatus: input.fundingVolumeStatus ?? null,
    contractTrendProfile: input.contractTrendProfile ?? null,
    positionThesisOutlook: input.positionThesisOutlook ?? null,
    addOnExecutionAuthorized: false as const,
    evidenceCodes,
    missingEvidence,
    marketPhase: "NORMAL_OSCILLATION" as PositionMarketPhase,
    reversalEvidenceSequence,
    structureEvidenceStage,
    evidenceRiskAssessment,
  };

  if (reversalEvidenceSequence.confirmed)
    return {
      ...common,
      marketPhase: "REVERSAL_CONFIRMED",
      state: "TREND_INVALIDATED",
      action: "EXIT_OR_REDUCE_BY_RISK_PLAN",
      label: "波段假设失效",
      rotationPlan: rotationPlanFor({
        state: "TREND_INVALIDATED",
        action: "EXIT_OR_REDUCE_BY_RISK_PLAN",
        currentRoePercent: current,
        givebackFromPeakRoePoints: giveback,
        recoveryFromTroughRoePoints: recovery,
        evidenceCodes,
        missingEvidence,
      }),
      reason:
        "目标币支撑破位、连续闭合1分钟无法收回，并由持仓后的真实短周期成交量确认反向扩张；禁止补仓，按明确配置执行纪律退出。",
    };

  if (evidenceRiskAssessment.action === "EXIT_FULL")
    return {
      ...common,
      marketPhase: "REVERSAL_CONFIRMED",
      state: "TREND_INVALIDATED",
      action: "EXIT_OR_REDUCE_BY_RISK_PLAN",
      label: "持续恶化·退出剩余仓位",
      rotationPlan: rotationPlanFor({
        state: "TREND_INVALIDATED",
        action: "EXIT_OR_REDUCE_BY_RISK_PLAN",
        currentRoePercent: current,
        givebackFromPeakRoePoints: giveback,
        recoveryFromTroughRoePoints: recovery,
        evidenceCodes: [
          ...evidenceCodes,
          ...evidenceRiskAssessment.adverseEvidenceCodes,
        ],
        missingEvidence,
      }),
      reason: evidenceRiskAssessment.reason,
    };

  if (evidenceRiskAssessment.action === "REDUCE_PARTIAL")
    return {
      ...common,
      marketPhase: "STRUCTURE_DAMAGED",
      state: "EVIDENCE_DEGRADING",
      action: "REDUCE_RISK_BY_EVIDENCE",
      label: "证据恶化·先降低风险",
      rotationPlan: rotationPlanFor({
        state: "EVIDENCE_DEGRADING",
        action: "REDUCE_RISK_BY_EVIDENCE",
        currentRoePercent: current,
        givebackFromPeakRoePoints: giveback,
        recoveryFromTroughRoePoints: recovery,
        evidenceCodes: [
          ...evidenceCodes,
          ...evidenceRiskAssessment.adverseEvidenceCodes,
        ],
        missingEvidence,
      }),
      reason: evidenceRiskAssessment.reason,
    };

  if (evidenceRiskAssessment.action === "FREEZE_RISK")
    return {
      ...common,
      marketPhase: evidenceRiskAssessment.priorReductionExecuted
        ? "STRUCTURE_DAMAGED"
        : "MOMENTUM_DECAY",
      state: "EVIDENCE_DEGRADING",
      action: "WAIT_NO_ADD",
      label: evidenceRiskAssessment.priorReductionExecuted
        ? "已减险·等待结构重新证明"
        : "证据开始恶化·冻结加仓",
      rotationPlan: rotationPlanFor({
        state: "EVIDENCE_DEGRADING",
        action: "WAIT_NO_ADD",
        currentRoePercent: current,
        givebackFromPeakRoePoints: giveback,
        recoveryFromTroughRoePoints: recovery,
        evidenceCodes: [
          ...evidenceCodes,
          ...evidenceRiskAssessment.adverseEvidenceCodes,
        ],
        missingEvidence,
      }),
      reason: evidenceRiskAssessment.reason,
    };

  if (currentNet > 0) {
    const normalPullbackExemptionActive =
      input.contractTrendProfile?.profitProtectionBias ===
        "ALLOW_NORMAL_PULLBACK" &&
      !costAwareProfitProtection;
    const confirmedProfitGiveback =
      giveback >= givebackThreshold &&
      !normalPullbackExemptionActive &&
      (!trendPathProvided ||
        localProfitWeaknessConfirmed ||
        expiredHorizonProfitGiveback);
    if (
      confirmedProfitGiveback
    )
      return {
        ...common,
        marketPhase:
          supportBroken || breakdownPressure
            ? "STRUCTURE_DAMAGED"
            : "MOMENTUM_DECAY",
        state: "PROFIT_PROTECT",
        action: "TIGHTEN_PROFIT_PROTECTION",
        label: "费用后盈利波段减弱",
        rotationPlan: rotationPlanFor({
          state: "PROFIT_PROTECT",
          action: "TIGHTEN_PROFIT_PROTECTION",
          currentRoePercent: current,
          givebackFromPeakRoePoints: giveback,
          recoveryFromTroughRoePoints: recovery,
          evidenceCodes,
          missingEvidence,
        }),
        reason: expiredHorizonProfitGiveback
          ? `日内观察周期已经结束且未获得波段延展；当前费用后仍为正收益，但已从峰值回撤 ${giveback.toFixed(2)} 个 ROE 百分点，达到策略配置的利润回撤阈值。时间本身不触发平仓，本轮由“周期到期 + 费用已覆盖 + 峰值回撤”共同授权收紧移动保护。`
          : costAwareProfitProtection
          ? `当前仍盈利，但已从峰值回撤 ${giveback.toFixed(2)} 个 ROE 百分点，局部结构转弱且费用后剩余期望已经恶化；正常回撤豁免不再覆盖该组合证据，应交给分批止盈与移动止损保护利润。`
          : `当前仍盈利，但已从峰值回撤 ${giveback.toFixed(2)} 个 ROE 百分点，且目标币闭合结构或真实短周期成交量已经转弱；` +
            "不再假设必然创新高，应交给分批止盈与移动止损保护利润。",
      };
    if (continuationEvidence) {
      const rewardScaleInEligible =
        directionalFlowSupports &&
        input.contractTrendProfile?.riskIncreaseAllowed !== false &&
        !remainingExpectancyDeteriorating;
      return {
        ...common,
        marketPhase: "CONTINUATION",
        state: "PROFIT_CONTINUATION",
        action: rewardScaleInEligible
          ? "SCALE_IN_ELIGIBLE"
          : "HOLD_FOR_EXTENSION",
        label: rewardScaleInEligible
          ? "费用后盈利延续·允许奖励加仓"
          : "费用后盈利延续·继续持有",
        rotationPlan: rotationPlanFor({
          state: "PROFIT_CONTINUATION",
          action: rewardScaleInEligible
            ? "SCALE_IN_ELIGIBLE"
            : "HOLD_FOR_EXTENSION",
          currentRoePercent: current,
          givebackFromPeakRoePoints: giveback,
          recoveryFromTroughRoePoints: recovery,
          evidenceCodes,
          missingEvidence,
        }),
        reason: rewardScaleInEligible
          ? "连续闭合5分钟路径、结构突破与持仓后真实短周期成交量共同确认延续；形成盈利奖励加仓候选，仍必须经过账户、额度、冷却、最小量和幂等校验。"
          : "连续闭合5分钟路径确认延续，但持仓后的真实短周期成交量尚未确认；继续持有观察，不扩大风险。",
      };
    }
    return {
      ...common,
      marketPhase: dataUnreliable
        ? "DATA_UNRELIABLE"
        : supportBroken || breakdownPressure
          ? "STRUCTURE_DAMAGED"
          : "NORMAL_OSCILLATION",
      state: "PROFIT_HOLD_OBSERVE",
      action: "HOLD_AND_OBSERVE",
      label: "费用后盈利但尚未确认延续",
      rotationPlan: rotationPlanFor({
        state: "PROFIT_HOLD_OBSERVE",
        action: "HOLD_AND_OBSERVE",
        currentRoePercent: current,
        givebackFromPeakRoePoints: giveback,
        recoveryFromTroughRoePoints: recovery,
        evidenceCodes,
        missingEvidence,
      }),
      reason: reversalEvidenceSequence.shortCycleConfirmed &&
          !reversalEvidenceSequence.horizonConfirmed
        ? "短周期结构、收回失败和逆向成交量已经转弱，但所属持仓周期的多小时趋势尚未确认反转；本轮只预警，保持原止盈止损且不追加风险。"
        : "仓位已经覆盖预计往返成本并形成费用后盈利，但目标币闭合结构与持仓后的真实短周期成交量尚未同时确认延续；保持原止盈止损，不追加强仓。",
    };
  }

  if (currentNet < 0) {
    if (bottomReboundEvidence) {
      const addEligible =
        directionalFlowSupports &&
        input.contractTrendProfile?.riskIncreaseAllowed !== false &&
        !remainingExpectancyDeteriorating;
      return {
        ...common,
        marketPhase: "CONTINUATION",
        state: "BOTTOM_REBOUND_CONFIRMED",
        action: addEligible ? "ADD_ELIGIBLE" : "WAIT_NO_ADD",
        label: addEligible
          ? "触底反弹证据成立"
          : "触底修复·继续观察",
        rotationPlan: rotationPlanFor({
          state: "BOTTOM_REBOUND_CONFIRMED",
          action: addEligible ? "ADD_ELIGIBLE" : "WAIT_NO_ADD",
          currentRoePercent: current,
          givebackFromPeakRoePoints: giveback,
          recoveryFromTroughRoePoints: recovery,
          evidenceCodes,
          missingEvidence,
        }),
        reason: addEligible
          ? `ROE 已从阶段低点修复 ${recovery.toFixed(2)} 个百分点，连续闭合5分钟路径、支撑和持仓后真实短周期成交量共同确认；仅形成补仓候选，仍须经过额度、保证金和幂等校验。`
          : `ROE 已从阶段低点修复 ${recovery.toFixed(2)} 个百分点，但持仓后的真实短周期成交量尚未确认；继续观察，不补仓。`,
      };
    }
    return {
      ...common,
      marketPhase: dataUnreliable
        ? "DATA_UNRELIABLE"
        : supportBroken || breakdownPressure
          ? "STRUCTURE_DAMAGED"
          : "NORMAL_OSCILLATION",
      state: "LOSS_WAIT_BOTTOM",
      action: "WAIT_NO_ADD",
      label: reversalEvidenceSequence.shortCycleConfirmed &&
          !reversalEvidenceSequence.horizonConfirmed
        ? "短周期失效·等待多小时确认"
        : "费用后亏损中·尚未确认触底",
      rotationPlan: rotationPlanFor({
        state: "LOSS_WAIT_BOTTOM",
        action: "WAIT_NO_ADD",
        currentRoePercent: current,
        givebackFromPeakRoePoints: giveback,
        recoveryFromTroughRoePoints: recovery,
        evidenceCodes,
        missingEvidence,
      }),
      reason: reversalEvidenceSequence.shortCycleConfirmed &&
          !reversalEvidenceSequence.horizonConfirmed
        ? "短周期反转证据已经闭合，但多小时合约趋势尚未达到当前持仓周期的失效标准；禁止补仓或延长亏损周期，既有硬止损和强平保护继续独立执行。"
        : `当前费用后 ROE ${currentNet.toFixed(2)}%，从低点仅修复 ${recovery.toFixed(2)} 个百分点；` +
          "没有形成支撑稳定后的反弹共振，禁止因价格继续下跌而摊薄成本。",
    };
  }

  return {
    ...common,
    marketPhase: dataUnreliable
      ? "DATA_UNRELIABLE"
      : supportBroken || breakdownPressure
        ? "STRUCTURE_DAMAGED"
        : "NORMAL_OSCILLATION",
    state: "NEUTRAL",
    action: "HOLD_AND_OBSERVE",
    label: "盈亏平衡附近",
    rotationPlan: rotationPlanFor({
      state: "NEUTRAL",
      action: "HOLD_AND_OBSERVE",
      currentRoePercent: current,
      givebackFromPeakRoePoints: giveback,
      recoveryFromTroughRoePoints: recovery,
      evidenceCodes,
      missingEvidence,
    }),
    reason: "当前方向尚未拉开，继续积累完整5分钟结构和资金证据。",
  };
}

export function buildReversalEvidenceSequence(input: {
  structureBroken: boolean;
  reclaimFailed: boolean;
  oppositeFlowConfirmed: boolean;
  horizonConfirmed?: boolean;
}): ReversalEvidenceSequence {
  const shortCycleConfirmed =
    input.structureBroken &&
    input.reclaimFailed &&
    input.oppositeFlowConfirmed;
  const horizonConfirmed = input.horizonConfirmed ?? true;
  const confirmed = shortCycleConfirmed && horizonConfirmed;
  return {
    structureBroken: input.structureBroken,
    reclaimFailed: input.reclaimFailed,
    oppositeFlowConfirmed: input.oppositeFlowConfirmed,
    shortCycleConfirmed,
    horizonConfirmed,
    confirmed,
    nextRequiredEvidence: confirmed
      ? null
      : shortCycleConfirmed && !horizonConfirmed
        ? "MULTI_HOUR_REVERSAL_CONFIRMATION"
        : !input.structureBroken
          ? "STRUCTURE_BREAK"
          : !input.reclaimFailed
            ? "FAILED_RECLAIM"
            : "OPPOSITE_FLOW_CONFIRMATION",
  };
}

function rotationPlanFor(input: {
  state: PositionManagementState;
  action: PositionManagementAction;
  currentRoePercent: number;
  givebackFromPeakRoePoints: number;
  recoveryFromTroughRoePoints: number;
  evidenceCodes: string[];
  missingEvidence: string[];
}): PositionRotationPlan {
  const common = {
    modelVersion: POSITION_ROTATION_MODEL_VERSION,
    evidenceCodes: input.evidenceCodes,
    blockedReasons: input.missingEvidence,
  };
  if (input.state === "PROFIT_CONTINUATION")
    return {
      ...common,
      primaryAction: "KEEP_WINNER",
      hedgeAction: "WATCH_OPPOSITE_LEG_AFTER_PRICE_IMPROVES",
      capitalAction: "KEEP_CAPITAL_ASSIGNED",
      label: "保留盈利主腿，等待更好对冲价",
      reason:
        "主仓已经有延续证据，先让盈利仓奔跑；只有出现动能衰减、利润锁定后，才观察反向腿作为保护，不默认双开消耗手续费。",
    };
  if (input.state === "PROFIT_PROTECT")
    return {
      ...common,
      primaryAction: "PROTECT_AND_ROTATE_PARTIAL",
      hedgeAction: "ALLOW_HEDGE_AFTER_PROFIT_LOCK",
      capitalAction: "FREE_PROFIT_CAPITAL",
      label: "利润保护并释放部分资金",
      reason:
        `盈利已回撤 ${input.givebackFromPeakRoePoints.toFixed(2)} 个 ROE 点或环境转弱；优先收紧保护线/分批止盈，再观察反向腿是否给出更好对冲价格。`,
    };
  if (input.state === "PROFIT_HOLD_OBSERVE")
    return {
      ...common,
      primaryAction: "HOLD_PRIMARY_LEG",
      hedgeAction: "NO_HEDGE",
      capitalAction: "KEEP_CAPITAL_ASSIGNED",
      label: "盈利观察，不急着轮动",
      reason:
        "仓位盈利但证据未共振，暂不追仓也不新开对冲腿，避免把正常波动做成手续费磨损。",
    };
  if (input.state === "BOTTOM_REBOUND_CONFIRMED")
    return input.action === "ADD_ELIGIBLE"
      ? {
          ...common,
          primaryAction: "ADD_PRIMARY_PROBE",
          hedgeAction: "NO_HEDGE",
          capitalAction: "RESERVE_FOR_CONFIRMED_ADD",
          label: "触底反弹后允许小额补主腿",
          reason:
            `亏损仓从低点修复 ${input.recoveryFromTroughRoePoints.toFixed(2)} 个 ROE 点，且已有独立资金确认；仅保留补仓候选资格。`,
        }
      : {
          ...common,
          primaryAction: "WAIT_FOR_BOTTOM_CONFIRMATION",
          hedgeAction: "NO_HEDGE",
          capitalAction: "DO_NOT_ADD_CAPITAL",
          label: "触底修复观察，不补仓",
          reason:
            `亏损仓从低点修复 ${input.recoveryFromTroughRoePoints.toFixed(2)} 个 ROE 点，但独立资金确认不足；保留原仓观察，不新增风险。`,
        };
  if (input.state === "TREND_INVALIDATED")
    return {
      ...common,
      primaryAction: "RELEASE_CAPITAL_BY_RISK_PLAN",
      hedgeAction: "DO_NOT_HEDGE_INVALIDATED_LOSS",
      capitalAction: "RELEASE_FOR_NEW_SIGNAL",
      label: "释放失效仓资金",
      reason:
        "波段假设已经失效，不能用反向单掩盖错误仓位；按既定风险计划释放资金，等待新的独立信号。",
    };
  if (input.state === "EVIDENCE_DEGRADING")
    return {
      ...common,
      primaryAction: input.action === "REDUCE_RISK_BY_EVIDENCE"
        ? "PROTECT_AND_ROTATE_PARTIAL"
        : "HOLD_PRIMARY_LEG",
      hedgeAction: "DO_NOT_HEDGE_INVALIDATED_LOSS",
      capitalAction: input.action === "REDUCE_RISK_BY_EVIDENCE"
        ? "FREE_PROFIT_CAPITAL"
        : "DO_NOT_ADD_CAPITAL",
      label: input.action === "REDUCE_RISK_BY_EVIDENCE"
        ? "先降低错误机会的风险敞口"
        : "冻结新增风险并等待复核",
      reason: input.action === "REDUCE_RISK_BY_EVIDENCE"
        ? "早期费用后亏损持续扩大，并有局部结构与独立资金证据共同确认；只减一次，不用补仓掩盖错误。"
        : "证据已经开始恶化但尚未达到执行节点；保留仓位复核，不增加风险。",
    };
  if (input.state === "LOSS_WAIT_BOTTOM")
    return {
      ...common,
      primaryAction: "WAIT_FOR_BOTTOM_CONFIRMATION",
      hedgeAction: "NO_HEDGE",
      capitalAction: "DO_NOT_ADD_CAPITAL",
      label: "亏损等待触底，不摊薄",
      reason:
        `当前 ROE ${input.currentRoePercent.toFixed(2)}%，尚未出现足够反弹证据；先等市场证明，不因便宜而继续加仓。`,
    };
  return {
    ...common,
    primaryAction: "HOLD_PRIMARY_LEG",
    hedgeAction: "NO_HEDGE",
    capitalAction: "KEEP_CAPITAL_ASSIGNED",
    label: "中性观察",
    reason: "盈亏还没拉开，轮动与对冲都缺少优势价格。",
  };
}

function finite(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function positiveOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
