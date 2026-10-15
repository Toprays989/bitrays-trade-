import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { backgroundRepairTasks, contractSymbols, exchangeCredentials, liveOrderEvents, livePositionAdditionEvidence, livePositionAdditions, livePositionReductions, livePositions, strategyExecutionTraces, strategyPositionEvidence, tradingAccounts } from "../../../../db/schema";
import { BinanceLiveError, LOCAL_POSITION_MISSING_CODE, getBinanceLiveOrderTrades, getLivePositionSnapshot } from "../../../../lib/binance-usdm-live";
import { queryLiveOrder, submitLiveEntryOrder, submitLiveReduceLimitFokOrder, submitLiveReduceMarketOrder } from "../../../../lib/execution/exchange-order-gateway";
import { credentialContext, decryptCredential, isSecureCredentialRequest, liveTradingAllowedByServer } from "../../../../lib/credential-vault";
import { attachReductionSettlement, buildReductionSettlement, reductionAccountingPnl } from "../../../../lib/live-reduction-settlement";
import { combinePositionAddition } from "../../../../lib/live-position-addition";
import { rebalanceRiskPlan } from "../../../../lib/risk-plan-rebalance";
import {
  applyExternalPositionReduction,
  normalizeExecutedRiskProgress,
  reanchorProgressAfterAddition,
  resetGridProgressPreservingDynamic,
} from "../../../../lib/risk-execution-progress";
import {
  canonicalizeOrderQuantity,
  effectiveMarketMinimumOrderQuantity,
  effectiveMinimumOrderQuantity,
  normalizeReduceQuantity,
  subtractOrderQuantity,
} from "../../../../lib/order-quantity";
import { mergeRiskPlanWithPositionMemory, readNexusPositionMemory } from "../../../../lib/nexus-position-memory";
import { positionAllocationEntryPrice } from "../../../../lib/position-allocation-basis";
import { monotonicFavorablePrice } from "../../../../lib/monotonic-favorable-price";
import {
  positionObservationCausalLearningEligible,
  positionObservationHasCausalSchedule,
} from "../../../../lib/position-observation-timing";
import {
  activateProtectionPlan,
  buildInstrumentId,
  rebuildProtectionAfterAddition,
} from "../../../../lib/position-protection-version";
import {
  ACTUAL_POSITION_EVIDENCE_TASK,
  positionSampleCollectionLabel,
} from "../../../../lib/background-repair-task";
import {
  liveOrderFillIsConfirmed,
  liveOrderHasExecutionEvidence,
  resolveLiveOrderFill,
  resolveLiveOrderTradeFill,
  type LiveOrderFillPayload,
} from "../../../../lib/live-order-fill";
import { type AuthorizedUser, isResponse, requirePermission, writeAudit } from "../shared";
import { observeExecutionQuote } from "../../../../lib/execution-quote-shadow-store";
import { normalizeRiskLevelsForExecution } from "../../../../lib/risk-grid";

export const dynamic = "force-dynamic";

type PositionLearningSample = Pick<
  typeof strategyPositionEvidence.$inferSelect,
  | "traceId"
  | "minuteOffset"
  | "scheduledAt"
  | "sampledAt"
  | "sampleDelayMs"
  | "status"
  | "markPrice"
  | "roePercent"
  | "mfeRoePercent"
  | "maeRoePercent"
  | "evidenceJson"
>;

function sqlValueBatches<T>(values: T[], batchSize = 50) {
  const unique = [...new Set(values)];
  const batches: T[][] = [];
  for (let index = 0; index < unique.length; index += batchSize)
    batches.push(unique.slice(index, index + batchSize));
  return batches;
}

function parseRecord(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resolveFilledExecution(
  data: LiveOrderFillPayload,
  fallbackLimitPrice?: number,
) {
  const fill = resolveLiveOrderFill(data, fallbackLimitPrice);
  return {
    status: fill.status,
    executedQuantity: fill.executedQuantity,
    exitPrice: fill.executionPrice,
  };
}

function effectiveRiskPlanJsonForDisplay(
  riskPlanJson: string,
  trailingStopPercent: number,
) {
  const plan = parseRecord(riskPlanJson);
  const dynamicProfitProtectionEnabled =
    plan.dynamicProfitProtectionEnabled !== false &&
    Number(trailingStopPercent) > 0;
  if (
    !dynamicProfitProtectionEnabled ||
    !Array.isArray(plan.stopLosses) ||
    plan.stopLosses.length === 0
  )
    return riskPlanJson;
  return JSON.stringify({
    ...plan,
    dynamicProfitProtectionEnabled: true,
    stopLosses: [],
  });
}

function openAccountingPolicy(configSnapshotJson?: string | null) {
  const config = parseRecord(configSnapshotJson);
  const trigger = parseRecord(
    config.trigger && typeof config.trigger === "object"
      ? JSON.stringify(config.trigger)
      : null,
  );
  const threeMinute = parseRecord(
    trigger.threeMinuteProbability &&
      typeof trigger.threeMinuteProbability === "object"
      ? JSON.stringify(trigger.threeMinuteProbability)
      : null,
  );
  const probabilityPolicy = parseRecord(
    config.probabilityPolicy && typeof config.probabilityPolicy === "object"
      ? JSON.stringify(config.probabilityPolicy)
      : null,
  );
  const threeMinuteFeeBps = Number(threeMinute.estimatedRoundTripFeeBps);
  const generalFeePercent = Number(
    probabilityPolicy.estimatedRoundTripFeePercent,
  );
  const estimatedRoundTripFeePercent =
    Number.isFinite(threeMinuteFeeBps) &&
      threeMinuteFeeBps >= 0 &&
      threeMinuteFeeBps <= 200
      ? threeMinuteFeeBps / 100
      : Number.isFinite(generalFeePercent) &&
          generalFeePercent >= 0 &&
          generalFeePercent <= 2
        ? generalFeePercent
        : 0.08;
  return {
    estimatedRoundTripFeePercent,
    source:
      Number.isFinite(threeMinuteFeeBps) &&
        threeMinuteFeeBps >= 0 &&
        threeMinuteFeeBps <= 200 ||
      Number.isFinite(generalFeePercent) &&
        generalFeePercent >= 0 &&
        generalFeePercent <= 2
        ? "FROZEN_STRATEGY_CONFIG" as const
        : "DEFAULT_ESTIMATE" as const,
  };
}

function positionAdditionExecutionLabel(reason: unknown) {
  const labels: Record<string, string> = {
    ADD_ON_FILLED: "补仓已成交",
    ADD_ON_OPPORTUNITY_EXPIRED: "补仓机会已过期，未下单",
    ADD_ON_MARK_STALE: "最新行情不可用或超过 5 秒，未下单",
    ADD_ON_REBOUND_LOST: "委托前反弹条件已经消失，未下单",
    ADD_ON_NO_LONGER_NEEDED: "仓位已恢复盈利，无需补仓",
    LOSS_EXCEEDS_ADD_ON_RANGE: "亏损超过策略允许范围，未补仓",
    SCALE_IN_NOT_PROFITABLE: "盈利奖励加仓取消：当前已不盈利",
    SCALE_IN_GIVEBACK_TOO_DEEP: "盈利奖励加仓取消：利润回撤过深",
    SCALE_IN_STAGE_NOT_ALLOWED: "盈利奖励加仓取消：仅允许5/30分钟证据窗口",
    ADD_ON_DISABLED: "策略未启用自动补仓",
    POSITION_ALREADY_REDUCED: "仓位已经减仓，不再自动补仓",
    ADD_ON_COUNT_LIMIT: "已达到单仓补仓次数",
    ADD_ON_COOLDOWN: "仍在补仓间隔期",
    STRATEGY_NOT_RUNNING: "策略已停止，未补仓",
    AMBIGUOUS_AGGREGATED_POSITION: "同方向仓位归属不唯一，未补仓",
    ACCOUNT_NOT_READY: "实盘账户或密钥状态未就绪",
    REST_CAPACITY_WAIT: "交易接口预留容量不足，等待下一轮",
    DAILY_LOSS_LIMIT: "达到当日亏损限制，未补仓",
    PENDING_ORDER_EXISTS: "账户存在待确认委托，禁止重复下单",
    ADD_ON_SIZE_INVALID: "交易所最小数量或金额无法满足",
    DAILY_NOTIONAL_LIMIT: "达到策略当日保证金限制",
    DAILY_MARGIN_LIMIT: "达到策略当日保证金限制",
    MARGIN_CAPACITY_LIMIT: "可用保证金不足或占用比例超限",
    IDEMPOTENT_DUPLICATE: "同一补仓机会已经处理",
    ORDER_LEDGER_NOT_CREATED: "委托记录创建失败，未发送订单",
    MANUAL_POSITION: "人工仓位只记录判断，不自动补仓",
    ACCOUNT_OR_SYMBOL_MISSING: "账户或合约配置不完整",
    PENDING: "补仓委托等待确认",
    EXECUTION_UNKNOWN: "补仓成交状态正在对账",
    REJECTED: "补仓委托被交易所拒绝",
  };
  return labels[String(reason ?? "")] ?? `补仓未执行：${String(reason ?? "原因未知")}`;
}

function buildPositionLearningSummary(
  position: typeof livePositions.$inferSelect,
  trace: { traceId: string; strategyId: number; entryEvidenceJson: string } | undefined,
  samples: PositionLearningSample[],
  reductions: Array<typeof livePositionReductions.$inferSelect>,
  repairTask: typeof backgroundRepairTasks.$inferSelect | null,
) {
  const positionMemory = readNexusPositionMemory(position.riskPlanJson, position);
  const opportunityContext = positionMemory.opportunityContext;
  const causalSamples = samples.filter((sample) =>
    positionObservationHasCausalSchedule(sample)
  );
  const latest = causalSamples.at(-1);
  const latestRoe = latest?.roePercent ?? null;
  const mfe = causalSamples.reduce<number | null>((best, sample) =>
    sample.mfeRoePercent === null ? best : best === null ? sample.mfeRoePercent : Math.max(best, sample.mfeRoePercent), null);
  const mae = causalSamples.reduce<number | null>((worst, sample) =>
    sample.maeRoePercent === null ? worst : worst === null ? sample.maeRoePercent : Math.min(worst, sample.maeRoePercent), null);
  const source = trace ? "STRATEGY" as const : positionMemory.origin;
  const latestDetailCandidate = parseRecord(latest?.evidenceJson);
  const latestDetail = latest && positionObservationCausalLearningEligible({
    ...latest,
    timing: latestDetailCandidate.observationTiming,
  })
    ? latestDetailCandidate
    : {};
  const rawPositionManagementDecision =
    latestDetail.positionManagementDecision &&
    typeof latestDetail.positionManagementDecision === "object" &&
    !Array.isArray(latestDetail.positionManagementDecision)
      ? latestDetail.positionManagementDecision as Record<string, unknown>
      : null;
  const rawOpportunityValidUntil = Number(
    rawPositionManagementDecision?.validUntilMs,
  );
  const positionManagementDecision = rawPositionManagementDecision
    ? {
        ...rawPositionManagementDecision,
        opportunityExpired:
          ["ADD_ELIGIBLE", "SCALE_IN_ELIGIBLE"].includes(
            String(rawPositionManagementDecision.action ?? ""),
          ) &&
          (
            !Number.isFinite(rawOpportunityValidUntil) ||
            Date.now() > rawOpportunityValidUntil
          ),
      }
    : null;
  const rawPositionManagementExecutionBinding =
    latestDetail.positionManagementExecutionBinding &&
    typeof latestDetail.positionManagementExecutionBinding === "object" &&
    !Array.isArray(latestDetail.positionManagementExecutionBinding)
      ? latestDetail.positionManagementExecutionBinding as Record<
          string,
          unknown
        >
      : null;
  const rawPositionAdditionExecution =
    latestDetail.positionAdditionExecution &&
    typeof latestDetail.positionAdditionExecution === "object" &&
    !Array.isArray(latestDetail.positionAdditionExecution)
      ? latestDetail.positionAdditionExecution as Record<string, unknown>
      : null;
  const positionAdditionExecution = rawPositionAdditionExecution
    ? {
        ...rawPositionAdditionExecution,
        label: positionAdditionExecutionLabel(
          rawPositionAdditionExecution.reason,
        ),
      }
    : null;
  const entryThesisInvalidation =
    latestDetail.entryThesisInvalidation &&
    typeof latestDetail.entryThesisInvalidation === "object" &&
    !Array.isArray(latestDetail.entryThesisInvalidation)
      ? latestDetail.entryThesisInvalidation as Record<string, unknown>
      : null;
  const pendingClosePlan = parseRecord(position.pendingClosePlanJson);
  const reconciledStructureExit = reductions.some((reduction) => {
    const response = parseRecord(reduction.responseJson);
    return (
      response.structureExit === true ||
      response.protectionTrigger === "ENTRY_THESIS_INVALIDATION"
    );
  });
  const structureProtectionStage = reconciledStructureExit
    ? "RECONCILED" as const
    : pendingClosePlan.structureExit === true &&
        Boolean(position.pendingCloseClientOrderId)
      ? "SUBMITTED" as const
      : entryThesisInvalidation?.status === "INVALIDATED"
        ? "CONFIRMED" as const
        : entryThesisInvalidation?.status === "WATCH"
          ? "WARNING" as const
          : entryThesisInvalidation?.status === "STABLE"
            ? "STABLE" as const
            : "UNAVAILABLE" as const;
  const structureProtectionLabel = {
    UNAVAILABLE: "结构证据待补",
    STABLE: "入场结构有效",
    WARNING: "结构越界预警",
    CONFIRMED: "结构失效已确认",
    SUBMITTED: "纪律退出已提交",
    RECONCILED: "纪律退出已对账",
  }[structureProtectionStage];
  const structureProtection = {
    stage: structureProtectionStage,
    label: structureProtectionLabel,
    reason:
      typeof entryThesisInvalidation?.reason === "string"
        ? entryThesisInvalidation.reason
        : structureProtectionStage === "RECONCILED"
          ? "结构失效退出已与 Binance 成交结果完成对账。"
          : "尚无可用的入场结构失效证据。",
    consecutiveClosedMinutes: Number(
      entryThesisInvalidation?.consecutiveClosedMinutesBeyondBoundary ?? 0,
    ),
    requiredClosedMinutes: Number(
      entryThesisInvalidation?.requiredClosedMinutes ?? 2,
    ),
  };
  const manualEntryExecution =
    latestDetail.entryExecution &&
    typeof latestDetail.entryExecution === "object" &&
    !Array.isArray(latestDetail.entryExecution)
      ? latestDetail.entryExecution as Record<string, unknown>
      : {};
  const entryEvidence = trace
    ? parseRecord(trace.entryEvidenceJson)
    : source === "STRATEGY"
      ? {
          decisionMode: "STRATEGY_EXECUTION_MEMORY",
          strategyId: positionMemory.strategyId,
          strategyConfigVersion: positionMemory.strategyConfigVersion,
          traceId: positionMemory.traceId,
          entryPrice: position.entryPrice,
          leverage: position.leverage,
          openedAt: position.openedAt.toISOString(),
        }
      : source === "SEMI_AUTO"
      ? {
          decisionMode: "OPERATOR_HYPOTHESIS_BRAIN_VERIFIED",
          entryPrice: position.entryPrice,
          leverage: position.leverage,
          openedAt: position.openedAt.toISOString(),
          execution: manualEntryExecution,
          opportunityContext,
        }
      : {
          decisionMode: "OPERATOR_DECISION",
          entryPrice: position.entryPrice,
          leverage: position.leverage,
          openedAt: position.openedAt.toISOString(),
          execution: manualEntryExecution,
        };
  const position72hPercent = Number(entryEvidence.position72hPercent);
  const entryMode = entryEvidence.entryMode === "LOW_POSITION_PROBE"
    ? "低位探针"
    : "完整周期";
  const recordedStages = [
    ["1h", entryEvidence.oneHour],
    ["30m", entryEvidence.thirtyMinute],
    ["5m", entryEvidence.fiveMinute],
    ["3m", entryEvidence.threeMinute],
  ].filter(([, value]) => value && typeof value === "object")
    .map(([label]) => label)
    .join("/");
  const entryEvidenceSummary = source === "MANUAL"
    ? `${manualEntryExecution.orderType === "LIMIT" ? "限价" : manualEntryExecution.orderType === "MARKET" ? "市价" : "人工"}决策入场；系统仅作为同币种、同方向实盘对照样本`
    : source === "SEMI_AUTO"
      ? `运营提出 ${String(opportunityContext?.horizon ?? "INTRADAY")} 机会，经 ${String(opportunityContext?.analysisVersion ?? "NEXUS 大脑")} 验证后人工确认`
      : `${entryMode} · ${Number.isFinite(position72hPercent) ? `72h位置 ${position72hPercent.toFixed(1)}%` : "72h位置—"} · 已记录 ${recordedStages || "入场判断"} 证据`;
  const verdict = latestRoe === null
    ? "COLLECTING" as const
    : latestRoe > 0.5
      ? "FAVORABLE" as const
      : latestRoe < -0.5
        ? "ADVERSE" as const
        : "NEUTRAL" as const;
  const latestMinute = latest?.minuteOffset ?? 0;
  const sampledMinutes = new Set(
    causalSamples.map((sample) => sample.minuteOffset),
  );
  const complete = [1, 3, 5, 15, 30, 60].every((minute) =>
    sampledMinutes.has(minute)
  );
  const collection = positionSampleCollectionLabel({
    sampleCount: causalSamples.length,
    complete,
    task: repairTask
      ? {
          status: repairTask.status,
          attemptCount: repairTask.attemptCount,
          nextAttemptAt: repairTask.nextAttemptAt,
          lastErrorCode: repairTask.lastErrorCode,
          lastError: repairTask.lastError,
          completedAt: repairTask.completedAt,
        }
      : null,
  });
  const comparison = verdict === "COLLECTING"
    ? `${collection.label}；${collection.nextAction}`
    : verdict === "FAVORABLE"
      ? latestMinute > 60
        ? `持仓第 ${latestMinute} 分钟保持正收益，长周期趋势仍有利`
        : `入场后第 ${latestMinute} 分钟保持正收益，当前时机验证有利`
      : verdict === "ADVERSE"
        ? latestMinute > 60
          ? `持仓第 ${latestMinute} 分钟处于负收益，需区分趋势失效与正常回撤`
          : `入场后第 ${latestMinute} 分钟处于负收益，需复核入场是否偏早`
        : `入场后第 ${latestMinute} 分钟方向尚未拉开，继续观察 1/3/5/15/30/60 分钟完整周期`;
  const suggestion = source === "MANUAL"
    ? "人工订单作为对照样本维护，不自动改变策略参数"
    : source === "SEMI_AUTO"
      ? verdict === "ADVERSE"
        ? "运营假设与后续事实出现偏差；保留独立半自动样本，复核反证与失效条件"
        : complete && verdict === "FAVORABLE"
          ? "运营假设通过完整周期验证；保留为独立半自动正向样本"
          : "继续收集 1/3/5/15/30/60 分钟事实，不与自动策略样本混合"
    : verdict === "ADVERSE"
      ? "纳入策略同版本样本；优先检查 3 分钟确认、成交量确认和限价偏移"
      : complete && verdict === "FAVORABLE"
        ? "本次入场时机验证有效，纳入同版本正向样本"
        : "1/3/5/15/30/60 分钟样本未完整，暂不调整策略参数";
  return {
    source,
    traceId:
      trace?.traceId ??
      positionMemory.traceId ??
      `${source.toLowerCase()}-position-${position.id}`,
    strategyId:
      trace?.strategyId ??
      positionMemory.strategyId ??
      (source === "SEMI_AUTO" && Number.isInteger(Number(opportunityContext?.strategyId))
        ? Number(opportunityContext?.strategyId)
        : null),
    latestMinute,
    sampleCount: causalSamples.length,
    historicalSampleCount: samples.length - causalSamples.length,
    causalTimingVerified: causalSamples.length > 0,
    checkpoints: causalSamples.map((sample) => ({
      minute: sample.minuteOffset,
      markPrice: sample.markPrice,
      roePercent: sample.roePercent,
      status: sample.status,
    })),
    collection,
    complete,
    latestRoePercent: latestRoe,
    mfeRoePercent: mfe,
    maeRoePercent: mae,
    verdict,
    comparison,
    suggestion,
    entryEvidenceSummary,
    entryEvidence,
    positionManagementDecision,
    positionManagementExecutionBinding:
      rawPositionManagementExecutionBinding,
    positionAdditionExecution,
    structureProtection,
  };
}

function fallbackPositionLearningSummary(
  position: typeof livePositions.$inferSelect,
  trace: { traceId: string; strategyId: number; entryEvidenceJson: string } | undefined,
) {
  const memory = readNexusPositionMemory(position.riskPlanJson, position);
  const source = trace ? "STRATEGY" as const : memory.origin;
  return {
    source,
    traceId:
      trace?.traceId ??
      memory.traceId ??
      `${source.toLowerCase()}-position-${position.id}`,
    strategyId:
      trace?.strategyId ??
      memory.strategyId ??
      (source === "SEMI_AUTO" &&
          Number.isInteger(Number(memory.opportunityContext?.strategyId))
        ? Number(memory.opportunityContext?.strategyId)
        : null),
    latestMinute: 0,
    sampleCount: 0,
    checkpoints: [],
    collection: {
      state: "RETRY_WAIT" as const,
      label: "学习摘要重试中",
      nextAction: "后台样本继续采集；列表下次刷新自动恢复，不需要重新下单",
    },
    complete: false,
    latestRoePercent: null,
    mfeRoePercent: null,
    maeRoePercent: null,
    verdict: "COLLECTING" as const,
    comparison: "仓位核心账本与保护继续运行，学习摘要正在独立恢复",
    suggestion: "无需人工补样；后台会按检查点继续采集并自动恢复显示",
    entryEvidenceSummary:
      source === "STRATEGY"
        ? "策略入场证据正在恢复"
        : source === "SEMI_AUTO"
          ? "半自动入场证据正在恢复"
          : "人工入场证据正在恢复",
    entryEvidence: {},
    positionManagementDecision: null,
    positionManagementExecutionBinding: null,
    positionAdditionExecution: null,
    structureProtection: {
      stage: "UNAVAILABLE" as const,
      label: "结构证据恢复中",
      reason: "学习摘要读取失败，不影响既有仓位保护和平仓。",
      consecutiveClosedMinutes: 0,
      requiredClosedMinutes: 2,
    },
  };
}

function safeBuildPositionLearningSummary(
  position: typeof livePositions.$inferSelect,
  trace: { traceId: string; strategyId: number; entryEvidenceJson: string } | undefined,
  samples: PositionLearningSample[],
  reductions: Array<typeof livePositionReductions.$inferSelect>,
  repairTask: typeof backgroundRepairTasks.$inferSelect | null,
) {
  try {
    return buildPositionLearningSummary(
      position,
      trace,
      samples,
      reductions,
      repairTask,
    );
  } catch (error) {
    console.error(
      `position learning enrichment failed for ${position.id}`,
      error instanceof Error ? error.message : "unknown error",
    );
    return fallbackPositionLearningSummary(position, trace);
  }
}

function buildAdditionLearningSummary(
  samples: Array<typeof livePositionAdditionEvidence.$inferSelect>,
) {
  const ordered = [...samples].sort(
    (left, right) => left.minuteOffset - right.minuteOffset,
  );
  const latest = ordered.at(-1);
  const sampledMinutes = new Set(ordered.map((sample) => sample.minuteOffset));
  const complete = [5, 30, 60].every((minute) => sampledMinutes.has(minute));
  const additionRoePercent = latest?.additionRoePercent ?? null;
  const compositeRoePercent = latest?.compositeRoePercent ?? null;
  const latestDetail = parseRecord(latest?.evidenceJson);
  const rawImprovement =
    typeof latestDetail.compositeRoeImprovement === "number"
      ? latestDetail.compositeRoeImprovement
      : Number.NaN;
  const compositeRoeImprovement = Number.isFinite(rawImprovement)
    ? rawImprovement
    : null;
  const rawNetAdditionRoe =
    typeof latestDetail.netAdditionRoePercent === "number"
      ? latestDetail.netAdditionRoePercent
      : Number.NaN;
  const netAdditionRoePercent = Number.isFinite(rawNetAdditionRoe)
    ? rawNetAdditionRoe
    : null;
  const rawNetImprovement =
    typeof latestDetail.netCompositeRoeImprovement === "number"
      ? latestDetail.netCompositeRoeImprovement
      : Number.NaN;
  const netCompositeRoeImprovement = Number.isFinite(rawNetImprovement)
    ? rawNetImprovement
    : null;
  const improved =
    netAdditionRoePercent !== null &&
    netAdditionRoePercent > 0 &&
    netCompositeRoeImprovement !== null &&
    netCompositeRoeImprovement >= 0;
  return {
    sampleCount: ordered.length,
    latestMinute: latest?.minuteOffset ?? null,
    additionRoePercent,
    compositeRoePercent,
    compositeRoeImprovement,
    netAdditionRoePercent,
    netCompositeRoeImprovement,
    complete,
    verdict:
      netAdditionRoePercent === null
        ? "COLLECTING"
        : improved
          ? "IMPROVED"
          : "WORSENED",
    comparison:
      latest
        ? netAdditionRoePercent === null
          ? `补仓腿第 ${latest.minuteOffset} 分钟毛ROE ${additionRoePercent! >= 0 ? "+" : ""}${additionRoePercent!.toFixed(2)}%，费用后指标待补`
          : `补仓腿第 ${latest.minuteOffset} 分钟扣费后 ${netAdditionRoePercent >= 0 ? "+" : ""}${netAdditionRoePercent.toFixed(2)}% ROE，组合仓位 ${compositeRoePercent! >= 0 ? "+" : ""}${compositeRoePercent!.toFixed(2)}%${netCompositeRoeImprovement === null ? "" : `，扣费后较不补仓 ${netCompositeRoeImprovement >= 0 ? "+" : ""}${netCompositeRoeImprovement.toFixed(2)} 个ROE点`}`
        : "等待补仓后第 5 分钟样本",
  };
}

function isFokRejected(error: unknown) {
  return error instanceof BinanceLiveError && (
    error.code === -5021 ||
    /FOK order has been rejected|could not be filled immediately/i.test(error.message)
  );
}

function rebalanceRiskPlanJson(
  riskPlanJson: string,
  quantity: number,
  minOrderQty: number,
  quantityStep: number,
  executedRiskPlanJson?: string,
  trailingStopPercent?: number,
) {
  return rebalanceRiskPlan(
    parseRecord(riskPlanJson),
    quantity,
    minOrderQty,
    quantityStep,
    parseRecord(executedRiskPlanJson),
    trailingStopPercent,
  );
}

async function handleManualAddOn(
  user: AuthorizedUser,
  body: {
    id?: number;
    orderType?: "MARKET" | "LIMIT";
    quantity?: number;
    price?: number;
    confirmation?: string;
    idempotencyKey?: string;
  },
) {
  if (!Number.isInteger(body.id) || !["MARKET", "LIMIT"].includes(body.orderType ?? "") || !Number.isFinite(body.quantity) || body.quantity! <= 0 || body.confirmation !== "CONFIRM_LIVE_ADD" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.idempotencyKey ?? "")) return Response.json({ error: "实盘补仓确认参数不完整" }, { status: 400 });
  if (body.orderType === "LIMIT" && (!Number.isFinite(body.price) || body.price! <= 0)) return Response.json({ error: "限价补仓必须填写有效价格" }, { status: 400 });
  const db = getDb();
  const [position] = await db.select().from(livePositions).where(and(eq(livePositions.id, body.id!), eq(livePositions.ownerEmail, user.email))).limit(1);
  if (!position) return Response.json({ error: "实盘仓位不存在或无权访问" }, { status: 404 });
  if (position.status !== "OPEN") return Response.json({ error: "只有后台保护中的实盘仓位可以补仓" }, { status: 409 });
  const [symbol, credential, account] = await Promise.all([
    db.select().from(contractSymbols).where(eq(contractSymbols.symbol, position.symbol)).limit(1).then((rows) => rows[0]),
    db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, position.credentialId), eq(exchangeCredentials.ownerEmail, user.email))).limit(1).then((rows) => rows[0]),
    db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, position.accountId))).limit(1).then((rows) => rows[0]),
  ]);
  if (!symbol) return Response.json({ error: "合约数量规则不存在，请先同步合约池" }, { status: 409 });
  const referencePriceCandidate = body.orderType === "LIMIT"
    ? body.price!
    : position.markPrice || position.entryPrice || symbol.lastPrice;
  const referencePrice = Number(referencePriceCandidate);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0)
    return Response.json(
      { error: "当前合约价格不可用，请刷新行情后重试" },
      { status: 409 },
    );
  const effectiveMinimumQuantity = body.orderType === "MARKET"
    ? effectiveMarketMinimumOrderQuantity(
        symbol.minOrderQty,
        symbol.quantityStep,
        symbol.minNotionalUsdt,
        referencePrice,
      )
    : effectiveMinimumOrderQuantity(
        symbol.minOrderQty,
        symbol.quantityStep,
        symbol.minNotionalUsdt,
        referencePrice,
      );
  if (
    body.quantity! < effectiveMinimumQuantity - 1e-12 ||
    Math.abs(
      body.quantity! / symbol.quantityStep -
        Math.round(body.quantity! / symbol.quantityStep),
    ) > 1e-8
  )
    return Response.json(
      {
        error:
          `补仓数量必须不低于 ${Number(effectiveMinimumQuantity.toPrecision(15))}` +
          `，并按 ${symbol.quantityStep} 步长对齐` +
          (body.orderType === "MARKET" ? "（已包含市价安全垫）" : ""),
      },
      { status: 400 },
    );
  if (!credential || credential.connectionStatus !== "VERIFIED" || credential.lastError || !credential.lastVerifiedAt) return Response.json({ error: "该账户的 Binance 密钥未通过校验" }, { status: 423 });
  if (!account?.isActive || account.executionMode !== "LIVE" || account.accountType === "MAIN") return Response.json({ error: "该交易子账户未启用实盘" }, { status: 423 });

  const clientOrderId = `nqa_${position.id}_${body.idempotencyKey}`.slice(0, 36);
  const leaseUntil = new Date(Date.now() + 30_000);
  const [claimed] = await db.update(livePositions).set({ riskLeaseUntil: leaseUntil, lastError: null, updatedAt: new Date() }).where(and(eq(livePositions.id, position.id), eq(livePositions.status, "OPEN"), isNull(livePositions.pendingCloseClientOrderId), or(isNull(livePositions.riskLeaseUntil), lte(livePositions.riskLeaseUntil, new Date())))).returning();
  if (!claimed) return Response.json({ error: "该仓位正在执行其他风控、平仓或补仓操作，请稍后刷新" }, { status: 409 });

  const [addition] = await db.insert(livePositionAdditions).values({
    positionId: position.id,
    lifecycleId: position.lifecycleId,
    basePositionVersion: position.positionVersion,
    ownerEmail: user.email,
    accountId: position.accountId,
    clientOrderId,
    symbol: position.symbol,
    positionSide: position.positionSide,
    quantity: body.quantity!,
    notionalUsdt: body.quantity! * referencePrice,
    status: "PENDING",
    decisionJson: JSON.stringify({
      source: "MANUAL_ADD_ON",
      orderType: body.orderType,
      price: body.orderType === "LIMIT" ? body.price : null,
      previousQuantity: position.quantity,
      previousEntryPrice: position.entryPrice,
      previousLiquidationPrice: position.liquidationPrice,
    }),
    responseJson: "{}",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  const [orderEvent] = await db.insert(liveOrderEvents).values({
    ownerEmail: user.email,
    accountId: position.accountId,
    credentialId: position.credentialId,
    clientOrderId,
    symbol: position.symbol,
    side: position.positionSide === "LONG" ? "BUY" : "SELL",
    positionSide: position.positionSide,
    orderType: body.orderType!,
    quantity: body.quantity!,
    referencePrice,
    estimatedNotional: body.quantity! * referencePrice,
    testOnly: false,
    status: "PENDING",
    responseJson: "{}",
    lifecycleId: position.lifecycleId,
    entryDecisionHandoffJson: position.entryDecisionHandoffJson,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  await observeExecutionQuote({
    recordKey: `ADD:${addition.id}`,
    quoteRole: "ADD",
    liveOrderEventId: orderEvent.id,
    positionId: position.id,
    positionAdditionId: addition.id,
    clientOrderId,
    ownerEmail: user.email,
    accountId: position.accountId,
    origin: "MANUAL",
    symbol: position.symbol,
    side: position.positionSide === "LONG" ? "BUY" : "SELL",
    positionSide: position.positionSide,
    actualOrderType: body.orderType!,
    actualRequestedPrice: referencePrice,
    decisionMarkPrice: position.markPrice || position.entryPrice,
    executableReferencePrice: position.markPrice || position.entryPrice,
    priceTickSize: symbol.priceTickSize,
    atr5m: Number(parseRecord(position.riskPlanJson).atr5m) || null,
    prospectiveNotionalUsdt: body.quantity! * referencePrice,
  });

  let acknowledgedExecutionData: LiveOrderFillPayload | null = null;
  try {
    const keys = { apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(user.email, position.accountId, "api-key")), secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(user.email, position.accountId, "secret-key")) };
    const result = await submitLiveEntryOrder(keys, {
      symbol: position.symbol,
      side: position.positionSide === "LONG" ? "BUY" : "SELL",
      positionSide: position.positionSide,
      quantity: body.quantity!,
      clientOrderId,
      leverage: position.leverage,
      orderType: body.orderType!,
      price: body.orderType === "LIMIT" ? body.price : undefined,
      positionMode: credential.positionMode,
    });
    acknowledgedExecutionData = result.data;
    let executionData: Awaited<ReturnType<typeof queryLiveOrder>>["data"] =
      result.data;
    let execution = resolveLiveOrderFill(
      executionData,
      body.orderType === "LIMIT" ? body.price : undefined,
    );
    if (execution.status === "FILLED" &&
      (execution.executedQuantity <= 0 || execution.executionPrice <= 0)) {
      try {
        const reconciled = await queryLiveOrder(
          keys,
          position.symbol,
          clientOrderId,
        );
        executionData = reconciled.data;
        acknowledgedExecutionData = reconciled.data;
        execution = resolveLiveOrderFill(
          executionData,
          body.orderType === "LIMIT" ? body.price : undefined,
        );
      } catch (error) {
        throw new BinanceLiveError(
          "补仓委托已被 Binance 接收，但成交结果尚未完成传播；已进入订单号对账，禁止重复提交",
          503,
          error instanceof BinanceLiveError ? error.code : undefined,
          true,
        );
      }
    }
    if (execution.executedQuantity > 0 && execution.executionPrice <= 0 &&
      execution.exchangeOrderId) {
      const trades = await getBinanceLiveOrderTrades(
        keys,
        position.symbol,
        execution.exchangeOrderId,
      );
      const tradeFill = resolveLiveOrderTradeFill(trades);
      if (tradeFill.executedQuantity > 0 && tradeFill.executionPrice > 0) {
        execution = {
          ...execution,
          executedQuantity: tradeFill.executedQuantity,
          executionPrice: tradeFill.executionPrice,
        };
      }
    }
    const executedQuantity = execution.executedQuantity;
    const additionEntryPrice = execution.executionPrice;
    if (!liveOrderFillIsConfirmed(execution)) {
      if (liveOrderHasExecutionEvidence(acknowledgedExecutionData))
        throw new BinanceLiveError(
          "补仓委托已被 Binance 接收，但完整成交数量或均价尚不可证明；已进入订单号对账，禁止重复提交",
          503,
          undefined,
          true,
        );
      await db.update(livePositions).set({ riskLeaseUntil: null, lastError: body.orderType === "LIMIT" ? "限价补仓 FOK 未全部成交，订单已自动撤销" : "Binance 未返回有效补仓成交", updatedAt: new Date() }).where(eq(livePositions.id, position.id));
      await db.update(liveOrderEvents).set({ status: "REJECTED", responseJson: JSON.stringify(executionData), updatedAt: new Date() }).where(eq(liveOrderEvents.id, orderEvent.id));
      await db.update(livePositionAdditions).set({ status: "REJECTED", responseJson: JSON.stringify(executionData), lastError: "补仓未成交", updatedAt: new Date() }).where(eq(livePositionAdditions.id, addition.id));
      return Response.json({ error: body.orderType === "LIMIT" ? "限价补仓未能立即全部成交，订单已自动撤销，仓位保持不变" : "Binance 未返回有效补仓成交" }, { status: 409 });
    }

    const fallback = combinePositionAddition({
      currentQuantity: position.quantity,
      currentEntryPrice: position.entryPrice,
      addedQuantity: executedQuantity,
      addedEntryPrice: additionEntryPrice,
    });
    const localCombinedQuantity = fallback.combinedQuantity;
    let exchangeAggregateQuantity: number | null = null;
    let exchangeEntryPrice = fallback.combinedEntryPrice;
    let exchangeMarkPrice = additionEntryPrice;
    let exchangeLiquidationPrice = position.liquidationPrice;
    let exchangeLiquidationPriceRaw = position.liquidationPriceRaw;
    let exchangeLiquidationPriceStatus = position.liquidationPriceStatus;
    let exchangeLiquidationPriceObservedAt =
      position.liquidationPriceObservedAt;
    try {
      const snapshot = await getLivePositionSnapshot(keys, position.symbol, position.positionSide);
      if (snapshot.quantity > 0) {
        exchangeAggregateQuantity = snapshot.quantity;
        exchangeEntryPrice = snapshot.entryPrice || fallback.combinedEntryPrice;
        exchangeMarkPrice = snapshot.markPrice || additionEntryPrice;
        exchangeLiquidationPrice =
          snapshot.liquidationPriceStatus === "AVAILABLE"
            ? snapshot.liquidationPrice
            : null;
        exchangeLiquidationPriceRaw = snapshot.liquidationPriceRaw;
        exchangeLiquidationPriceStatus = snapshot.liquidationPriceStatus;
        exchangeLiquidationPriceObservedAt = new Date(
          snapshot.liquidationPriceObservedAt,
        );
        await db.update(livePositions).set({
          entryPrice: exchangeEntryPrice,
          markPrice: exchangeMarkPrice,
          leverage:
            Number.isFinite(snapshot.leverage) && snapshot.leverage > 0
              ? snapshot.leverage
              : position.leverage,
          liquidationPrice: exchangeLiquidationPrice,
          liquidationPriceRaw: exchangeLiquidationPriceRaw,
          liquidationPriceStatus: exchangeLiquidationPriceStatus,
          liquidationPriceObservedAt: exchangeLiquidationPriceObservedAt,
          favorablePrice: exchangeMarkPrice,
          updatedAt: new Date(),
        }).where(and(
          eq(livePositions.ownerEmail, position.ownerEmail),
          eq(livePositions.accountId, position.accountId),
          eq(livePositions.credentialId, position.credentialId),
          eq(livePositions.symbol, position.symbol),
          eq(livePositions.positionSide, position.positionSide),
          inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
        ));
        if (Number.isFinite(snapshot.leverage) && snapshot.leverage > 0) {
          await db.update(livePositions).set({
            leverage: snapshot.leverage,
            updatedAt: new Date(),
          }).where(and(
            eq(livePositions.ownerEmail, position.ownerEmail),
            eq(livePositions.accountId, position.accountId),
            eq(livePositions.credentialId, position.credentialId),
            eq(livePositions.symbol, position.symbol),
            inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
          ));
        }
      }
    } catch {
      // Binance 持仓快照偶发延迟时，先使用成交回报计算均价；下一轮风险巡检会继续对账强平价。
    }
    const authoritativeCombinedQuantity =
      exchangeAggregateQuantity !== null &&
      Number.isFinite(exchangeAggregateQuantity) &&
      exchangeAggregateQuantity > 0
        ? exchangeAggregateQuantity
        : localCombinedQuantity;
    const rebalancedRiskPlan = rebalanceRiskPlanJson(
      position.riskPlanJson,
      authoritativeCombinedQuantity,
      symbol.minOrderQty,
      symbol.quantityStep,
      undefined,
      position.trailingStopPercent,
    );
    const nextPositionVersion = position.positionVersion + 1;
    const nextProtectionVersion = position.protectionVersion + 1;
    const protectionUpdatedAt = new Date();
    const postAdditionRiskPlan = rebuildProtectionAfterAddition({
      plan: rebalancedRiskPlan.plan,
      rebalancedTakeProfits: rebalancedRiskPlan.plan.takeProfits as unknown[],
      rebalancedStopLosses: rebalancedRiskPlan.plan.stopLosses as unknown[],
      nextPositionVersion,
      nextProtectionVersion,
      nowMs: protectionUpdatedAt.getTime(),
      source: "MANUAL_ADD_ON",
    });
    const postAdditionProgress = reanchorProgressAfterAddition({
      progress: normalizeExecutedRiskProgress(
        parseRecord(position.executedRiskPlanJson),
      ),
      newPositionQuantity: authoritativeCombinedQuantity,
    });
    const responseJson = JSON.stringify({
      ...executionData,
      timing: result.timing,
      previousQuantity: position.quantity,
      previousEntryPrice: position.entryPrice,
      previousLiquidationPrice: position.liquidationPrice,
      combinedQuantity: localCombinedQuantity,
      combinedEntryPrice: fallback.combinedEntryPrice,
      exchangeAggregateQuantity,
      authoritativeCombinedQuantity,
      exchangeEntryPrice,
      exchangeLiquidationPrice,
      riskPlanRebalanced: true,
      previousPositionVersion: position.positionVersion,
      positionVersion: nextPositionVersion,
      protectionVersion: nextProtectionVersion,
      protectionState: "ACTIVE",
      takeProfitGrids: rebalancedRiskPlan.takeProfitGrids,
      stopLossGrids: {
        ...rebalancedRiskPlan.stopLossGrids,
        actual: 0,
        suspendedAfterAddition: true,
      },
    });
    const [positionApplied] = await db.update(livePositions).set({
      quantity: authoritativeCombinedQuantity,
      entryPrice: exchangeEntryPrice,
      markPrice: exchangeMarkPrice,
      liquidationPrice: exchangeLiquidationPrice,
      liquidationPriceRaw: exchangeLiquidationPriceRaw,
      liquidationPriceStatus: exchangeLiquidationPriceStatus,
      liquidationPriceObservedAt: exchangeLiquidationPriceObservedAt,
      instrumentId: position.instrumentId ?? symbol.instrumentId ??
        buildInstrumentId({ symbol: position.symbol }),
      instrumentRuleVersion: symbol.ruleVersion,
      positionVersion: nextPositionVersion,
      protectionVersion: nextProtectionVersion,
      protectionState: "ACTIVE",
      protectionUpdatedAt,
      riskPlanJson: JSON.stringify(postAdditionRiskPlan),
      executedRiskPlanJson: JSON.stringify(postAdditionProgress),
      // Adding quantity creates a new cost basis and restarts the favorable
      // peak, but it must not silently switch the operator-selected stop mode.
      trailingActivationPercent: position.trailingActivationPercent,
      trailingStopPercent: position.trailingStopPercent,
      favorablePrice: exchangeMarkPrice,
      additionCount: position.additionCount + 1,
      lastAdditionClientOrderId: clientOrderId,
      riskLeaseUntil: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(livePositions.id, position.id),
      eq(livePositions.status, "OPEN"),
      eq(livePositions.positionVersion, position.positionVersion),
      eq(livePositions.protectionVersion, position.protectionVersion),
    )).returning({ id: livePositions.id });
    if (!positionApplied)
      throw new BinanceLiveError(
        "补仓已成交，但仓位保护版本发生变化；系统已停止旧止损并进入订单号对账",
        503,
        undefined,
        true,
      );
    await db.update(liveOrderEvents).set({ exchangeOrderId: String(executionData.orderId), status: "FILLED", responseJson, updatedAt: new Date() }).where(eq(liveOrderEvents.id, orderEvent.id));
    await db.update(livePositionAdditions).set({ exchangeOrderId: String(executionData.orderId), quantity: executedQuantity, entryPrice: additionEntryPrice, notionalUsdt: executedQuantity * additionEntryPrice, status: "SUBMITTED", appliedPositionVersion: nextPositionVersion, protectionVersion: nextProtectionVersion, responseJson, lastError: null, updatedAt: new Date() }).where(eq(livePositionAdditions.id, addition.id));
    await writeAudit(user, "MANUAL_LIVE_POSITION_ADD_ON", "live_position", String(position.id), { symbol: position.symbol, positionSide: position.positionSide, orderType: body.orderType, requestedQuantity: body.quantity, executedQuantity, additionEntryPrice, previousEntryPrice: position.entryPrice, newEntryPrice: exchangeEntryPrice, previousLiquidationPrice: position.liquidationPrice, newLiquidationPrice: exchangeLiquidationPrice, previousPositionVersion: position.positionVersion, positionVersion: nextPositionVersion, protectionVersion: nextProtectionVersion, protectionState: "ACTIVE", riskGridsRebalanced: true, exchangeOrderId: executionData.orderId });
    return Response.json({ positionId: position.id, orderType: body.orderType, executedQuantity, additionEntryPrice, previousQuantity: position.quantity, quantity: authoritativeCombinedQuantity, exchangeAggregateQuantity, previousEntryPrice: position.entryPrice, entryPrice: exchangeEntryPrice, previousLiquidationPrice: position.liquidationPrice, liquidationPrice: exchangeLiquidationPrice, positionVersion: nextPositionVersion, protectionVersion: nextProtectionVersion, protectionState: "ACTIVE", riskGridsRebalanced: true, clientOrderId, exchangeOrderId: executionData.orderId });
  } catch (error) {
    const fokRejected = body.orderType === "LIMIT" && isFokRejected(error);
    const unknown = !fokRejected && (
      (error instanceof BinanceLiveError && error.executionUnknown) ||
      liveOrderHasExecutionEvidence(acknowledgedExecutionData)
    );
    const acknowledgedOrderId = String(
      acknowledgedExecutionData?.orderId ?? "",
    ).trim() || null;
    const lastError = fokRejected
      ? "限价补仓 FOK 未能立即全部成交，交易所已拒绝，仓位保持不变"
      : error instanceof Error ? error.message : "实盘补仓失败";
    await db.update(livePositions).set({ riskLeaseUntil: null, lastError, updatedAt: new Date() }).where(eq(livePositions.id, position.id));
    await db.update(liveOrderEvents).set({ exchangeOrderId: acknowledgedOrderId, status: unknown ? "EXECUTION_UNKNOWN" : "REJECTED", responseJson: JSON.stringify({ ...acknowledgedExecutionData, error: lastError }), updatedAt: new Date() }).where(eq(liveOrderEvents.id, orderEvent.id));
    await db.update(livePositionAdditions).set({ exchangeOrderId: acknowledgedOrderId, status: unknown ? "EXECUTION_UNKNOWN" : "REJECTED", responseJson: JSON.stringify(acknowledgedExecutionData ?? {}), lastError, updatedAt: new Date() }).where(eq(livePositionAdditions.id, addition.id));
    await writeAudit(user, unknown ? "LIVE_POSITION_ADD_ON_EXECUTION_UNKNOWN" : "LIVE_POSITION_ADD_ON_FAILED", "live_position", String(position.id), { symbol: position.symbol, orderType: body.orderType, clientOrderId, code: error instanceof BinanceLiveError ? error.code : undefined, error: lastError });
    if (fokRejected) return Response.json({ error: "限价补仓 FOK 未能立即全部成交，交易所已拒绝；仓位保持不变。请调整限价或改用市价补仓", code: error instanceof BinanceLiveError ? error.code : -5021 }, { status: 409 });
    if (error instanceof BinanceLiveError) return Response.json({ error: error.message, code: error.code, executionUnknown: error.executionUnknown }, { status: error.status });
    return Response.json({ error: lastError }, { status: 500 });
  }
}

async function handleGet(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const db = getDb();
  const searchParams = new URL(request.url).searchParams;
  const scope = searchParams.get("scope");
  const openOnly = scope === "open";
  const historyOnly = scope === "history";
  const coreOnly = openOnly && searchParams.get("detail") === "core";
  const positions = await db
    .select()
    .from(livePositions)
    .where(
      openOnly
        ? and(
            eq(livePositions.ownerEmail, user.email),
            inArray(livePositions.status, [
              "OPEN",
              "EXECUTION_UNKNOWN",
              "ERROR",
            ]),
          )
        : eq(livePositions.ownerEmail, user.email),
    )
    .orderBy(desc(livePositions.updatedAt))
    .limit(200);
  const scopedPositionIds = positions.map((position) => position.id);
  if (coreOnly) {
    const coreTraces = scopedPositionIds.length
      ? await db
          .select({
            traceId: strategyExecutionTraces.traceId,
            strategyId: strategyExecutionTraces.strategyId,
            positionId: strategyExecutionTraces.positionId,
            entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
            configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
          })
          .from(strategyExecutionTraces)
          .where(and(
            eq(strategyExecutionTraces.ownerEmail, user.email),
            inArray(
              strategyExecutionTraces.positionId,
              scopedPositionIds.map(String),
            ),
          ))
      : [];
    const coreTraceByPosition = new Map(
      coreTraces.map((trace) => [trace.positionId, trace]),
    );
    return Response.json({
      mode: "LIVE",
      detail: "CORE",
      positions: positions.map((position) => ({
        ...position,
        riskPlanJson: effectiveRiskPlanJsonForDisplay(
          position.riskPlanJson,
          position.trailingStopPercent,
        ),
        allocationEntryPrice: position.entryPrice,
        exchangeEntryPrice: position.entryPrice,
        executionRule: null,
        additionSummary: { count: position.additionCount, latest: null },
        openAccountingPolicy: openAccountingPolicy(
          coreTraceByPosition.get(String(position.id))?.configSnapshotJson,
        ),
        learning: fallbackPositionLearningSummary(
          position,
          coreTraceByPosition.get(String(position.id)),
        ),
      })),
      additions: [],
      reductions: [],
    });
  }
  if (historyOnly) {
    const [historyReductions, historyTraces] = await Promise.all([
      scopedPositionIds.length
        ? (await Promise.all(
            sqlValueBatches(scopedPositionIds).map((ids) =>
              db
                .select()
                .from(livePositionReductions)
                .where(inArray(livePositionReductions.positionId, ids))
                .orderBy(desc(livePositionReductions.createdAt))
                .limit(500),
            ),
          )).flat()
        : Promise.resolve([]),
      scopedPositionIds.length
        ? (await Promise.all(
            sqlValueBatches(scopedPositionIds.map(String)).map((ids) =>
              db
                .select({
                  traceId: strategyExecutionTraces.traceId,
                  strategyId: strategyExecutionTraces.strategyId,
                  positionId: strategyExecutionTraces.positionId,
                  entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
                  configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
                })
                .from(strategyExecutionTraces)
                .where(and(
                  eq(strategyExecutionTraces.ownerEmail, user.email),
                  inArray(strategyExecutionTraces.positionId, ids),
                )),
            ),
          )).flat()
        : Promise.resolve([]),
    ]);
    const historyTraceByPosition = new Map(
      historyTraces.map((trace) => [trace.positionId, trace]),
    );
    return Response.json({
      mode: "LIVE",
      detail: "LEDGER",
      positions: positions.map((position) => ({
        ...position,
        riskPlanJson: effectiveRiskPlanJsonForDisplay(
          position.riskPlanJson,
          position.trailingStopPercent,
        ),
        allocationEntryPrice: position.entryPrice,
        exchangeEntryPrice: position.entryPrice,
        executionRule: null,
        additionSummary: { count: position.additionCount, latest: null },
        learning: fallbackPositionLearningSummary(
          position,
          historyTraceByPosition.get(String(position.id)),
        ),
      })),
      additions: [],
      reductions: historyReductions.map((reduction) => ({
        ...reduction,
        accounting: reductionAccountingPnl(reduction),
      })),
    });
  }
  const [reductions, additions] = await Promise.all([
    openOnly
      ? scopedPositionIds.length
        ? db
            .select()
            .from(livePositionReductions)
            .where(
              and(
                eq(livePositionReductions.ownerEmail, user.email),
                inArray(
                  livePositionReductions.positionId,
                  scopedPositionIds,
                ),
              ),
            )
            .orderBy(desc(livePositionReductions.createdAt))
            .limit(500)
        : Promise.resolve([])
      : db
          .select()
          .from(livePositionReductions)
          .where(eq(livePositionReductions.ownerEmail, user.email))
          .orderBy(desc(livePositionReductions.createdAt))
          .limit(500),
    openOnly
      ? scopedPositionIds.length
        ? db
            .select()
            .from(livePositionAdditions)
            .where(
              and(
                eq(livePositionAdditions.ownerEmail, user.email),
                inArray(livePositionAdditions.positionId, scopedPositionIds),
              ),
            )
            .orderBy(desc(livePositionAdditions.createdAt))
            .limit(500)
        : Promise.resolve([])
      : db
          .select()
          .from(livePositionAdditions)
          .where(eq(livePositionAdditions.ownerEmail, user.email))
          .orderBy(desc(livePositionAdditions.createdAt))
          .limit(500),
  ]);
  const additionsByPosition = new Map<number, typeof additions>();
  for (const addition of additions) {
    const current = additionsByPosition.get(addition.positionId) ?? [];
    current.push(addition);
    additionsByPosition.set(addition.positionId, current);
  }
  const sourceEventIds = positions
    .map((position) => position.sourceEventId)
    .filter((id): id is number => Number.isInteger(id) && id > 0);
  const sourceOrders = sourceEventIds.length
    ? (await Promise.all(
        sqlValueBatches(sourceEventIds).map((ids) =>
          db
            .select()
            .from(liveOrderEvents)
            .where(inArray(liveOrderEvents.id, ids))
        ),
      )).flat()
    : [];
  const sourceOrderById = new Map(
    sourceOrders.map((order) => [order.id, order]),
  );
  const reductionsByPosition = new Map<number, typeof reductions>();
  for (const reduction of reductions) {
    const current = reductionsByPosition.get(reduction.positionId) ?? [];
    current.push(reduction);
    reductionsByPosition.set(reduction.positionId, current);
  }
  const additionEvidence = positions.length
    ? (await Promise.all(
        sqlValueBatches(positions.map((position) => position.id)).map(
          (ids) =>
            db
              .select()
              .from(livePositionAdditionEvidence)
              .where(inArray(
                livePositionAdditionEvidence.positionId,
                ids,
              ))
              .orderBy(asc(livePositionAdditionEvidence.minuteOffset))
              .limit(2_000),
        ),
      )).flat()
    : [];
  const additionEvidenceById = new Map<
    number,
    Array<typeof livePositionAdditionEvidence.$inferSelect>
  >();
  for (const sample of additionEvidence) {
    const current = additionEvidenceById.get(sample.additionId) ?? [];
    current.push(sample);
    additionEvidenceById.set(sample.additionId, current);
  }
  const positionIds = positions.map((position) => String(position.id));
  const repairTasks = positionIds.length
    ? (await Promise.all(
        sqlValueBatches(positionIds).map((ids) =>
          db
            .select()
            .from(backgroundRepairTasks)
            .where(and(
              eq(
                backgroundRepairTasks.taskType,
                ACTUAL_POSITION_EVIDENCE_TASK,
              ),
              eq(backgroundRepairTasks.resourceType, "live_position"),
              inArray(backgroundRepairTasks.resourceId, ids),
            ))
        ),
      )).flat()
    : [];
  const repairTaskByPosition = new Map(
    repairTasks.map((task) => [task.resourceId, task]),
  );
  const traces = positionIds.length
    ? (await Promise.all(
        sqlValueBatches(positionIds).map((ids) =>
          db.select({
            traceId: strategyExecutionTraces.traceId,
            strategyId: strategyExecutionTraces.strategyId,
            positionId: strategyExecutionTraces.positionId,
            entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
            configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
          }).from(strategyExecutionTraces).where(and(
            eq(strategyExecutionTraces.ownerEmail, user.email),
            inArray(strategyExecutionTraces.positionId, ids),
          ))
        ),
      )).flat()
    : [];
  const traceByPosition = new Map(traces.map((trace) => [trace.positionId, trace]));
  const learningTraceIds = positions.map((position) =>
    traceByPosition.get(String(position.id))?.traceId ?? `manual-position-${position.id}`);
  const samples = learningTraceIds.length
    ? (await Promise.all(
        sqlValueBatches(learningTraceIds).map((traceIds) =>
          db.select({
            traceId: strategyPositionEvidence.traceId,
            minuteOffset: strategyPositionEvidence.minuteOffset,
            scheduledAt: strategyPositionEvidence.scheduledAt,
            sampledAt: strategyPositionEvidence.sampledAt,
            sampleDelayMs: strategyPositionEvidence.sampleDelayMs,
            status: strategyPositionEvidence.status,
            markPrice: strategyPositionEvidence.markPrice,
            roePercent: strategyPositionEvidence.roePercent,
            mfeRoePercent: strategyPositionEvidence.mfeRoePercent,
            maeRoePercent: strategyPositionEvidence.maeRoePercent,
            // Older checkpoints only need their numeric path in the list.
            // Keep the full JSON solely on the latest checkpoint so the
            // position decision card stays complete without rereading
            // megabytes of historical evidence every five seconds.
            evidenceJson: sql<string>`CASE
              WHEN ${strategyPositionEvidence.minuteOffset} = (
                SELECT MAX(latest.minute_offset)
                FROM strategy_position_evidence AS latest
                WHERE latest.trace_id = ${strategyPositionEvidence.traceId}
              ) THEN ${strategyPositionEvidence.evidenceJson}
              ELSE '{}'
            END`,
          }).from(strategyPositionEvidence)
            .where(inArray(strategyPositionEvidence.traceId, traceIds))
            .orderBy(asc(strategyPositionEvidence.minuteOffset))
        ),
      )).flat()
    : [];
  const samplesByTrace = new Map<string, PositionLearningSample[]>();
  for (const sample of samples) {
    const current = samplesByTrace.get(sample.traceId) ?? [];
    current.push(sample);
    samplesByTrace.set(sample.traceId, current);
  }
  const positionSymbols = [...new Set(positions.map((position) => position.symbol))];
  const positionRules = positionSymbols.length
    ? (await Promise.all(
        sqlValueBatches(positionSymbols).map((symbols) =>
          db
            .select({
              symbol: contractSymbols.symbol,
              minOrderQty: contractSymbols.minOrderQty,
              quantityStep: contractSymbols.quantityStep,
              minNotionalUsdt: contractSymbols.minNotionalUsdt,
            })
            .from(contractSymbols)
            .where(inArray(contractSymbols.symbol, symbols))
        ),
      )).flat()
    : [];
  const positionRuleBySymbol = new Map(
    positionRules.map((rule) => [rule.symbol, rule]),
  );
  return Response.json({
    mode: "LIVE",
    positions: positions.map((position) => {
      const trace = traceByPosition.get(String(position.id));
      const traceId = trace?.traceId ?? `manual-position-${position.id}`;
      const sourceOrder = sourceOrderById.get(position.sourceEventId);
      const sourceResponse = parseRecord(sourceOrder?.responseJson);
      const sourceQuantity =
        Number(sourceResponse.executedQty) > 0
          ? Number(sourceResponse.executedQty)
          : Number(sourceOrder?.quantity) || 0;
      const sourcePrice =
        Number(sourceResponse.avgPrice) > 0
          ? Number(sourceResponse.avgPrice)
          : Number(sourceOrder?.referencePrice) || 0;
      const submittedAdditions = (additionsByPosition.get(position.id) ?? [])
        .filter(
          (addition) =>
            addition.status === "SUBMITTED" &&
            addition.quantity > 0 &&
            Number(addition.entryPrice) > 0,
        );
      const allocationEntryPrice = positionAllocationEntryPrice(
        { quantity: sourceQuantity, entryPrice: sourcePrice },
        submittedAdditions.map((addition) => ({
          quantity: addition.quantity,
          entryPrice: Number(addition.entryPrice),
        })),
        position.entryPrice,
      );
      const executionRule = positionRuleBySymbol.get(position.symbol) ?? null;
      return {
        ...position,
        riskPlanJson: effectiveRiskPlanJsonForDisplay(
          position.riskPlanJson,
          position.trailingStopPercent,
        ),
        quantity: executionRule
          ? canonicalizeOrderQuantity(
              position.quantity,
              executionRule.quantityStep,
            )
          : position.quantity,
        // Binance aggregates account/symbol/direction into entryPrice.
        // Preserve the local order/addition basis separately for attribution.
        allocationEntryPrice,
        exchangeEntryPrice: position.entryPrice,
        executionRule,
        openAccountingPolicy: openAccountingPolicy(trace?.configSnapshotJson),
        additionSummary: {
          count: additionsByPosition.get(position.id)?.filter(
            (addition) => addition.status === "SUBMITTED",
          ).length ?? 0,
          latest: additionsByPosition.get(position.id)?.[0]
            ? {
                ...additionsByPosition.get(position.id)![0],
                learning: buildAdditionLearningSummary(
                  additionEvidenceById.get(
                    additionsByPosition.get(position.id)![0].id,
                  ) ?? [],
                ),
              }
            : null,
        },
        learning: safeBuildPositionLearningSummary(
          position,
          trace,
          samplesByTrace.get(traceId) ?? [],
          reductionsByPosition.get(position.id) ?? [],
          repairTaskByPosition.get(String(position.id)) ?? null,
        ),
      };
    }),
    additions: additions.map((addition) => ({
      ...addition,
      learning: buildAdditionLearningSummary(
        additionEvidenceById.get(addition.id) ?? [],
      ),
    })),
    reductions: reductions.map((reduction) => ({ ...reduction, accounting: reductionAccountingPnl(reduction) })),
  });
}

export async function GET(request: Request) {
  try {
    return await handleGet(request);
  } catch (error) {
    console.error(
      "live position enrichment failed; returning core position ledger",
      error instanceof Error ? error.message : "unknown error",
    );
    try {
      const user = await requirePermission(request, "trade:dashboard:view");
      if (isResponse(user)) return user;
      const db = getDb();
      const openOnly =
        new URL(request.url).searchParams.get("scope") === "open";
      const [positions, reductions] = await Promise.all([
        db
          .select()
          .from(livePositions)
          .where(
            openOnly
              ? and(
                  eq(livePositions.ownerEmail, user.email),
                  inArray(livePositions.status, [
                    "OPEN",
                    "EXECUTION_UNKNOWN",
                    "ERROR",
                  ]),
                )
              : eq(livePositions.ownerEmail, user.email),
          )
          .orderBy(desc(livePositions.updatedAt))
          .limit(200),
        db
          .select()
          .from(livePositionReductions)
          .where(eq(livePositionReductions.ownerEmail, user.email))
          .orderBy(desc(livePositionReductions.createdAt))
          .limit(500),
      ]);
      const positionIds = positions.map((position) => String(position.id));
      const reductionsByPosition = new Map<
        number,
        Array<typeof livePositionReductions.$inferSelect>
      >();
      for (const reduction of reductions) {
        const current = reductionsByPosition.get(reduction.positionId) ?? [];
        current.push(reduction);
        reductionsByPosition.set(reduction.positionId, current);
      }
      let traceByPosition = new Map<
        string,
        {
          traceId: string;
          strategyId: number;
          positionId: string | null;
          entryEvidenceJson: string;
        }
      >();
      const samplesByTrace = new Map<
        string,
        PositionLearningSample[]
      >();
      let repairTaskByPosition = new Map<
        string,
        typeof backgroundRepairTasks.$inferSelect
      >();
      try {
        const traces = positionIds.length
          ? (await Promise.all(
              sqlValueBatches(positionIds).map((ids) =>
                db
                  .select({
                    traceId: strategyExecutionTraces.traceId,
                    strategyId: strategyExecutionTraces.strategyId,
                    positionId: strategyExecutionTraces.positionId,
                    entryEvidenceJson:
                      strategyExecutionTraces.entryEvidenceJson,
                  })
                  .from(strategyExecutionTraces)
                  .where(and(
                    eq(strategyExecutionTraces.ownerEmail, user.email),
                    inArray(strategyExecutionTraces.positionId, ids),
                  ))
              ),
            )).flat()
          : [];
        traceByPosition = new Map(
          traces
            .filter((trace) => trace.positionId)
            .map((trace) => [String(trace.positionId), trace]),
        );
        const learningTraceIds = positions.map((position) =>
          traceByPosition.get(String(position.id))?.traceId ??
          `manual-position-${position.id}`
        );
        const [sampleBatches, repairTaskBatches] = await Promise.all([
          learningTraceIds.length
            ? Promise.all(
                sqlValueBatches(learningTraceIds).map((traceIds) =>
                  db
                    .select()
                    .from(strategyPositionEvidence)
                    .where(inArray(
                      strategyPositionEvidence.traceId,
                      traceIds,
                    ))
                    .orderBy(asc(strategyPositionEvidence.minuteOffset))
                ),
              )
            : Promise.resolve([]),
          positionIds.length
            ? Promise.all(
                sqlValueBatches(positionIds).map((ids) =>
                  db
                    .select()
                    .from(backgroundRepairTasks)
                    .where(and(
                      eq(
                        backgroundRepairTasks.taskType,
                        ACTUAL_POSITION_EVIDENCE_TASK,
                      ),
                      eq(
                        backgroundRepairTasks.resourceType,
                        "live_position",
                      ),
                      inArray(backgroundRepairTasks.resourceId, ids),
                    ))
                ),
              )
            : Promise.resolve([]),
        ]);
        const samples = sampleBatches.flat();
        const repairTasks = repairTaskBatches.flat();
        for (const sample of samples) {
          const current = samplesByTrace.get(sample.traceId) ?? [];
          current.push(sample);
          samplesByTrace.set(sample.traceId, current);
        }
        repairTaskByPosition = new Map(
          repairTasks.map((task) => [task.resourceId, task]),
        );
      } catch (learningError) {
        console.error(
          "position learning recovery query failed",
          learningError instanceof Error ? learningError.message : "unknown error",
        );
      }
      return Response.json({
        mode: "LIVE",
        degraded: true,
        warning:
          "仓位核心账本已正常读取；部分附加摘要正在独立恢复，不影响后台保护与平仓。",
        positions: positions.map((position) => ({
          ...position,
          riskPlanJson: effectiveRiskPlanJsonForDisplay(
            position.riskPlanJson,
            position.trailingStopPercent,
          ),
          executionRule: null,
          additionSummary: { count: 0, latest: null },
          learning: safeBuildPositionLearningSummary(
            position,
            traceByPosition.get(String(position.id)),
            samplesByTrace.get(
              traceByPosition.get(String(position.id))?.traceId ??
                `manual-position-${position.id}`,
            ) ?? [],
            reductionsByPosition.get(position.id) ?? [],
            repairTaskByPosition.get(String(position.id)) ?? null,
          ),
        })),
        additions: [],
        reductions: reductions.map((reduction) => ({
          ...reduction,
          accounting: reductionAccountingPnl(reduction),
        })),
      });
    } catch {
      return Response.json(
        {
          error:
            "仓位核心账本暂时无法读取，已成交订单不受影响，请勿重复下单，稍后点击刷新",
          code: "LIVE_POSITION_LIST_TEMPORARILY_UNAVAILABLE",
        },
        { status: 503 },
      );
    }
  }
}

export async function POST(request: Request) {
  const body = await request.json() as { action?: "ADD" | "CLOSE"; id?: number; orderType?: "MARKET" | "LIMIT"; quantity?: number; price?: number; closeAll?: boolean; confirmation?: string; idempotencyKey?: string };
  const user = await requirePermission(
    request,
    body.action === "ADD" ? "trade:manual:create" : "trade:position:close",
  );
  if (isResponse(user)) return user;
  if (!isSecureCredentialRequest(request))
    return Response.json(
      {
        error: body.action === "ADD" ? "实盘补仓只能通过可信 HTTPS 提交" : "实盘平仓只能通过可信 HTTPS 提交",
        code: body.action === "ADD" ? "HTTPS_REQUIRED_FOR_LIVE_ADD" : "HTTPS_REQUIRED_FOR_LIVE_CLOSE",
      },
      { status: 426 },
    );
  if (!(await liveTradingAllowedByServer())) return Response.json({ error: "服务器尚未开放实盘交易，请先在账户管理页开启" }, { status: 423 });
  if (body.action === "ADD") return await handleManualAddOn(user, body);
  if (!Number.isInteger(body.id) || !["MARKET", "LIMIT"].includes(body.orderType ?? "") || !Number.isFinite(body.quantity) || body.quantity! <= 0 || (body.closeAll !== undefined && typeof body.closeAll !== "boolean") || body.confirmation !== "CONFIRM_LIVE_CLOSE" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.idempotencyKey ?? "")) return Response.json({ error: "实盘平仓确认参数不完整" }, { status: 400 });
  if (body.orderType === "LIMIT" && (!Number.isFinite(body.price) || body.price! <= 0)) return Response.json({ error: "限价平仓必须填写有效价格" }, { status: 400 });
  const db = getDb();
  const [position] = await db.select().from(livePositions).where(and(eq(livePositions.id, body.id!), eq(livePositions.ownerEmail, user.email))).limit(1);
  if (!position) return Response.json({ error: "实盘仓位不存在或无权访问" }, { status: 404 });
  if (position.status !== "OPEN") return Response.json({ error: "只有后台保护中的实盘仓位可以平仓" }, { status: 409 });
  const [symbol, credential, account] = await Promise.all([
    db.select().from(contractSymbols).where(eq(contractSymbols.symbol, position.symbol)).limit(1).then((rows) => rows[0]),
    db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, position.credentialId), eq(exchangeCredentials.ownerEmail, user.email))).limit(1).then((rows) => rows[0]),
    db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, user.email), eq(tradingAccounts.accountId, position.accountId))).limit(1).then((rows) => rows[0]),
  ]);
  if (!symbol) return Response.json({ error: "合约数量规则不存在，请先同步合约池" }, { status: 409 });
  const closeQuantity = normalizeReduceQuantity({
    requestedQuantity: body.quantity!,
    positionQuantity: position.quantity,
    minimum: symbol.minOrderQty,
    step: symbol.quantityStep,
  });
  if (!Number.isFinite(closeQuantity) || closeQuantity <= 0)
    return Response.json(
      {
        error: `平仓数量不足交易所最小量 ${symbol.minOrderQty}，或当前仓位无法按 ${symbol.quantityStep} 步长对齐`,
      },
      { status: 400 },
    );
  const requestedRemainingQuantity = Number(
    (position.quantity - closeQuantity).toPrecision(15),
  );
  if (
    requestedRemainingQuantity > 1e-12 &&
    requestedRemainingQuantity < symbol.minOrderQty - 1e-12
  )
    return Response.json(
      {
        error: `本次分批平仓会留下低于最小下单量 ${symbol.minOrderQty} 的尾仓，请减少平仓数量或直接全部平仓`,
      },
      { status: 400 },
    );
  if (!credential || credential.connectionStatus !== "VERIFIED" || credential.lastError || !credential.lastVerifiedAt) return Response.json({ error: "该账户的 Binance 密钥未通过校验" }, { status: 423 });
  // A daily-loss/risk lock blocks new exposure, but it must never block a
  // reduce-only close. Existing positions still need a manual exit path while
  // the account remains locked.
  if (!account || account.executionMode !== "LIVE" || account.accountType === "MAIN") return Response.json({ error: "该交易子账户未启用实盘平仓" }, { status: 423 });
  const keys = {
    apiKey: await decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(user.email, position.accountId, "api-key"),
    ),
    secretKey: await decryptCredential(
      credential.secretKeyCiphertext,
      credential.secretKeyIv,
      credentialContext(user.email, position.accountId, "secret-key"),
    ),
  };
  if (position.pendingCloseClientOrderId) {
    const staleForMs = Date.now() - position.updatedAt.getTime();
    try {
      const pendingOrder = await queryLiveOrder(
        keys,
        position.symbol,
        position.pendingCloseClientOrderId,
      );
      const pendingFill = resolveLiveOrderFill(pendingOrder.data);
      if (
        ["CANCELED", "EXPIRED", "REJECTED"].includes(pendingFill.status) &&
        pendingFill.executedQuantity <= 0
      ) {
        await db
          .update(livePositions)
          .set({
            status: "OPEN",
            riskLeaseUntil: null,
            pendingCloseClientOrderId: null,
            pendingCloseReason: null,
            pendingCloseQuantity: null,
            pendingClosePlanJson: null,
            lastError: `旧平仓委托已${pendingFill.status}且未成交，已允许重新平仓`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(livePositions.id, position.id),
            eq(
              livePositions.pendingCloseClientOrderId,
              position.pendingCloseClientOrderId,
            ),
          ));
      } else {
        return Response.json(
          {
            error: pendingFill.executedQuantity > 0 || pendingFill.status === "FILLED"
              ? "上一笔平仓已产生真实成交，系统正在按订单号更新仓位，请刷新后查看，禁止重复平仓"
              : "上一笔平仓委托仍在 Binance 处理中，请勿重复提交",
            code: "LIVE_CLOSE_RECONCILIATION_PENDING",
          },
          { status: 409 },
        );
      }
    } catch (error) {
      if (
        error instanceof BinanceLiveError &&
        error.code === -2013 &&
        staleForMs >= 30_000
      ) {
        await db
          .update(livePositions)
          .set({
            status: "OPEN",
            riskLeaseUntil: null,
            pendingCloseClientOrderId: null,
            pendingCloseReason: null,
            pendingCloseQuantity: null,
            pendingClosePlanJson: null,
            lastError: "Binance 未找到旧平仓委托，已解除占用并允许重新平仓",
            updatedAt: new Date(),
          })
          .where(and(
            eq(livePositions.id, position.id),
            eq(
              livePositions.pendingCloseClientOrderId,
              position.pendingCloseClientOrderId,
            ),
          ));
      } else {
        return Response.json(
          {
            error: "上一笔平仓状态暂时无法向 Binance 核对；为避免重复减仓，请稍后重试",
            code: "LIVE_CLOSE_RECONCILIATION_UNAVAILABLE",
          },
          { status: 503 },
        );
      }
    }
  }
  const clientOrderId = `nqc_${position.id}_${body.idempotencyKey}`.slice(0, 36);
  const leaseUntil = new Date(Date.now() + 30_000);
  // Manual reduce-only close is the highest-priority operation. It may take
  // over an ordinary inspection lease, while the pending-close CAS still
  // prevents two close orders from being submitted for the same position.
  const [claimed] = await db.update(livePositions).set({ riskLeaseUntil: leaseUntil, pendingCloseClientOrderId: clientOrderId, pendingCloseReason: "MANUAL", pendingCloseQuantity: closeQuantity, pendingClosePlanJson: JSON.stringify({ orderType: body.orderType, price: body.orderType === "LIMIT" ? body.price : null, requestedQuantity: body.quantity, normalizedQuantity: closeQuantity, closeAll: body.closeAll === true }), lastError: null, updatedAt: new Date() }).where(and(eq(livePositions.id, position.id), eq(livePositions.status, "OPEN"), isNull(livePositions.pendingCloseClientOrderId))).returning();
  if (!claimed) return Response.json({ error: "该仓位正在执行其他风控或平仓操作，请稍后刷新" }, { status: 409 });
  await observeExecutionQuote({
    recordKey: `EXIT:${clientOrderId}`,
    quoteRole: "EXIT",
    positionId: position.id,
    clientOrderId,
    ownerEmail: user.email,
    accountId: position.accountId,
    origin: "MANUAL",
    symbol: position.symbol,
    side: position.positionSide === "LONG" ? "SELL" : "BUY",
    positionSide: position.positionSide,
    actualOrderType: body.orderType!,
    actualRequestedPrice: body.orderType === "LIMIT" ? body.price! : position.markPrice,
    decisionMarkPrice: position.markPrice,
    executableReferencePrice: position.markPrice,
    priceTickSize: symbol.priceTickSize,
    atr5m: Number(parseRecord(position.riskPlanJson).atr5m) || null,
    orderHorizonSeconds: body.orderType === "LIMIT" ? 30 : 5,
    urgency: body.orderType === "MARKET" ? 0.9 : 0.55,
    prospectiveNotionalUsdt: closeQuantity * position.markPrice,
  });
  try {
    // "全部平仓" is an intent, not a stale browser quantity. Both Binance
    // submitters verify the current exchange position immediately before the
    // reduce-only order and cap this sentinel to that authoritative quantity.
    const submitQuantity = body.closeAll === true
      ? Number.MAX_SAFE_INTEGER
      : closeQuantity;
    const result = body.orderType === "LIMIT"
      ? await submitLiveReduceLimitFokOrder(keys, { symbol: position.symbol, positionSide: position.positionSide, quantity: submitQuantity, price: body.price!, clientOrderId })
      : await submitLiveReduceMarketOrder(keys, { symbol: position.symbol, positionSide: position.positionSide, quantity: submitQuantity, clientOrderId, quantityStep: symbol.quantityStep });
    let executionData: Awaited<ReturnType<typeof queryLiveOrder>>["data"] =
      result.data;
    let execution = resolveFilledExecution(
      executionData,
      body.orderType === "LIMIT" ? body.price : undefined,
    );
    if (execution.status === "FILLED" && (!Number.isFinite(execution.executedQuantity) || execution.executedQuantity <= 0 || !Number.isFinite(execution.exitPrice) || execution.exitPrice <= 0)) {
      try {
        const reconciled = await queryLiveOrder(keys, position.symbol, clientOrderId);
        executionData = reconciled.data;
        execution = resolveFilledExecution(executionData, body.orderType === "LIMIT" ? body.price : undefined);
      } catch {
        throw new BinanceLiveError("Binance 已确认平仓成交，系统正在按订单号补齐成交明细，请勿重复下单", 503, undefined, true);
      }
      if (!Number.isFinite(execution.executedQuantity) || execution.executedQuantity <= 0 || !Number.isFinite(execution.exitPrice) || execution.exitPrice <= 0)
        throw new BinanceLiveError("Binance 已确认平仓成交，成交明细尚未完整同步，系统已进入安全对账", 503, undefined, true);
    }
    const { executedQuantity, exitPrice } = execution;
    if (execution.status !== "FILLED" || !Number.isFinite(executedQuantity) || executedQuantity <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) {
      await db.update(livePositions).set({ riskLeaseUntil: null, pendingCloseClientOrderId: null, pendingCloseReason: null, pendingCloseQuantity: null, pendingClosePlanJson: null, lastError: body.orderType === "LIMIT" ? "限价 FOK 未全部成交，订单已自动撤销" : "Binance 未返回有效平仓成交", updatedAt: new Date() }).where(eq(livePositions.id, position.id));
      await writeAudit(user, "LIVE_POSITION_CLOSE_NOT_FILLED", "live_position", String(position.id), { symbol: position.symbol, orderType: body.orderType, clientOrderId, status: execution.status });
      return Response.json({ error: body.orderType === "LIMIT" ? "限价未能立即全部成交，订单已自动撤销，仓位保持不变" : "Binance 未返回有效平仓成交" }, { status: 409 });
    }
    const exchangePositionQuantityBefore = Number(result.positionBefore.quantity);
    if (!Number.isFinite(exchangePositionQuantityBefore) || exchangePositionQuantityBefore <= 0)
      throw new BinanceLiveError(
        "平仓已成交，但下单前 Binance 真实仓位数量无效；系统已进入安全对账",
        503,
        undefined,
        true,
      );
    const remainingQuantity = subtractOrderQuantity(
      exchangePositionQuantityBefore,
      executedQuantity,
      symbol.quantityStep,
    );
    if (!Number.isFinite(remainingQuantity))
      throw new BinanceLiveError(
        "平仓已成交，但剩余仓位无法按 Binance 数量步长核算；系统已进入安全对账",
        503,
        undefined,
        true,
      );
    const closed = remainingQuantity <= 1e-12;
    const closedAt = new Date();
    const localGrossRealizedPnl = (position.positionSide === "LONG" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice) * executedQuantity;
    // A confirmed reduce-only fill is the critical path. Fee/funding reads are
    // deliberately deferred to the independent settlement backfill so a slow
    // Binance trade-history endpoint can never leave a real close stuck behind
    // the browser/API deadline.
    const settlement = buildReductionSettlement({
      localGrossRealizedPnl,
      executedQuantity,
      entryOrderQuantity: null,
      entryTrades: [],
      exitTrades: [],
      fundingAttribution: closed ? "UNAVAILABLE" : "NOT_REQUESTED_PARTIAL",
    });
    const realizedPnl = settlement.grossRealizedPnl;
    const cumulativeRealizedPnl = position.realizedPnl + realizedPnl;
    const rebalancedRiskPlan = closed
      ? null
      : rebalanceRiskPlanJson(
          position.riskPlanJson,
          remainingQuantity,
          symbol.minOrderQty,
          symbol.quantityStep,
          position.executedRiskPlanJson,
          position.trailingStopPercent,
        );
    await db.insert(livePositionReductions).values({ positionId: position.id, lifecycleId: position.lifecycleId, ownerEmail: user.email, accountId: position.accountId, clientOrderId, exchangeOrderId: String(executionData.orderId), symbol: position.symbol, positionSide: position.positionSide, quantity: executedQuantity, exitPrice, realizedPnl, reason: "MANUAL", responseJson: JSON.stringify(attachReductionSettlement(executionData, settlement)), createdAt: new Date() });
    const nextPositionVersion = position.positionVersion + 1;
    const nextProtectionVersion = position.protectionVersion + 1;
    const protectionUpdatedAt = new Date();
    const activeRebalancedRiskPlan = rebalancedRiskPlan
      ? activateProtectionPlan({
          plan: rebalancedRiskPlan.plan,
          positionVersion: nextPositionVersion,
          protectionVersion: nextProtectionVersion,
          nowMs: protectionUpdatedAt.getTime(),
          source: "MANUAL_REDUCTION",
        })
      : null;
    const dynamicModeActive =
      parseRecord(position.riskPlanJson).dynamicProfitProtectionEnabled !==
        false && position.trailingStopPercent > 0;
    const postReductionProgress = !closed && rebalancedRiskPlan
      ? dynamicModeActive
        ? applyExternalPositionReduction({
            progress: normalizeExecutedRiskProgress(
              parseRecord(position.executedRiskPlanJson),
            ),
            quantityBeforeReduction: exchangePositionQuantityBefore,
            executedQuantity,
          })
        : normalizeExecutedRiskProgress(null)
      : null;
    const [positionApplied] = await db.update(livePositions).set({
      quantity: closed ? executedQuantity : remainingQuantity,
      markPrice: exitPrice,
      riskPlanJson: activeRebalancedRiskPlan
        ? JSON.stringify(activeRebalancedRiskPlan)
        : position.riskPlanJson,
      executedRiskPlanJson: rebalancedRiskPlan
        ? JSON.stringify(postReductionProgress)
        : position.executedRiskPlanJson,
      positionVersion: closed ? position.positionVersion : nextPositionVersion,
      protectionVersion: closed
        ? position.protectionVersion
        : nextProtectionVersion,
      protectionState: closed ? position.protectionState : "ACTIVE",
      protectionUpdatedAt: closed
        ? position.protectionUpdatedAt
        : protectionUpdatedAt,
      status: closed ? "CLOSED" : "OPEN",
      exitReason: closed ? "MANUAL" : null,
      realizedPnl: cumulativeRealizedPnl,
      closedAt: closed ? closedAt : null,
      riskLeaseUntil: null,
      pendingCloseClientOrderId: null,
      pendingCloseReason: null,
      pendingCloseQuantity: null,
      pendingClosePlanJson: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(livePositions.id, position.id),
      eq(livePositions.positionVersion, position.positionVersion),
      eq(livePositions.protectionVersion, position.protectionVersion),
      eq(livePositions.pendingCloseClientOrderId, clientOrderId),
    )).returning({ id: livePositions.id });
    if (!positionApplied)
      throw new BinanceLiveError(
        "平仓已成交，但仓位保护版本发生变化；系统已进入订单号对账，禁止恢复旧网格",
        503,
        undefined,
        true,
      );
    await writeAudit(user, "CLOSE_LIVE_POSITION", "live_position", String(position.id), {
      symbol: position.symbol,
      positionSide: position.positionSide,
      orderType: body.orderType,
      requestedQuantity: body.quantity,
      normalizedQuantity: closeQuantity,
      closeAll: body.closeAll === true,
      exchangePositionQuantityBefore,
      executedQuantity,
      exitPrice,
      remainingQuantity,
      realizedPnl,
      exchangeOrderId: executionData.orderId,
      riskPlanRebalanced: Boolean(rebalancedRiskPlan),
      previousPositionVersion: position.positionVersion,
      positionVersion: closed ? position.positionVersion : nextPositionVersion,
      previousProtectionVersion: position.protectionVersion,
      protectionVersion: closed
        ? position.protectionVersion
        : nextProtectionVersion,
      takeProfitGrids: rebalancedRiskPlan?.takeProfitGrids ?? null,
      stopLossGrids: rebalancedRiskPlan?.stopLossGrids ?? null,
    });
    return Response.json({
      positionId: position.id,
      orderType: body.orderType,
      executedQuantity,
      exitPrice,
      positionQuantityBefore: exchangePositionQuantityBefore,
      remainingQuantity,
      realizedPnl,
      netRealizedPnl: settlement.netRealizedPnl,
      exactNetAvailable: settlement.exactNetAvailable,
      closed,
      protectionRebalanced: Boolean(rebalancedRiskPlan),
      takeProfitGrids: rebalancedRiskPlan?.takeProfitGrids ?? null,
      stopLossGrids: rebalancedRiskPlan?.stopLossGrids ?? null,
      clientOrderId,
      exchangeOrderId: executionData.orderId,
    });
  } catch (error) {
    const fokRejected = body.orderType === "LIMIT" && isFokRejected(error);
    const unknown = error instanceof BinanceLiveError && error.executionUnknown;
    const missing = error instanceof BinanceLiveError && error.code === LOCAL_POSITION_MISSING_CODE;
    const lastError = fokRejected
      ? "限价 FOK 未能立即全部成交，交易所已拒绝，仓位保持不变"
      : missing
        ? "Binance 当前方向仓位为 0，系统记录已同步关闭"
        : error instanceof Error ? error.message : "实盘平仓失败";
    await db.update(livePositions).set({
      status: missing ? "CLOSED" : unknown ? "EXECUTION_UNKNOWN" : "OPEN",
      exitReason: missing ? "EXTERNAL" : position.exitReason,
      closedAt: missing ? new Date() : position.closedAt,
      riskLeaseUntil: null,
      pendingCloseClientOrderId: unknown ? clientOrderId : null,
      pendingCloseReason: unknown ? "MANUAL" : null,
      pendingCloseQuantity: unknown ? closeQuantity : null,
      pendingClosePlanJson: unknown ? JSON.stringify({ orderType: body.orderType, price: body.price ?? null }) : null,
      lastError,
      updatedAt: new Date(),
    }).where(eq(livePositions.id, position.id));
    await writeAudit(user,
      fokRejected ? "LIVE_POSITION_CLOSE_NOT_FILLED" : missing ? "LIVE_POSITION_RECONCILED_EXTERNAL_CLOSE" : unknown ? "LIVE_POSITION_CLOSE_EXECUTION_UNKNOWN" : "LIVE_POSITION_CLOSE_FAILED",
      "live_position",
      String(position.id),
      { symbol: position.symbol, orderType: body.orderType, clientOrderId, code: error instanceof BinanceLiveError ? error.code : undefined, error: error instanceof Error ? error.message : "未知错误" },
    );
    if (fokRejected) return Response.json({ error: "限价 FOK 未能立即全部成交，交易所已拒绝；仓位保持不变。请调整限价或改用市价平仓", code: error instanceof BinanceLiveError ? error.code : -5021 }, { status: 409 });
    if (missing) return Response.json({ error: "Binance 当前方向仓位为 0，系统记录已同步关闭；本次未发送新的平仓指令", code: LOCAL_POSITION_MISSING_CODE }, { status: 409 });
    if (error instanceof BinanceLiveError) return Response.json({ error: error.message, code: error.code, executionUnknown: error.executionUnknown }, { status: error.status });
    return Response.json({ error: error instanceof Error ? error.message : "实盘平仓失败" }, { status: 500 });
  }
}

type RiskLevel = { triggerPercent: number; closePercent: number; closeQuantity?: number };
function validPlan(levels: RiskLevel[] | undefined, allowEmpty = false) {
  if (!Array.isArray(levels) || levels.length > 10) return false;
  if (!levels.length) return allowEmpty;
  if (levels.at(-1)?.closePercent !== 100) return false;
  return levels.every((level, index) => Number.isFinite(level.triggerPercent) && level.triggerPercent > 0 && (index === 0 || level.triggerPercent > levels[index - 1].triggerPercent) && Number.isFinite(level.closePercent) && level.closePercent >= 1 && level.closePercent <= 100 && Number.isFinite(level.closeQuantity) && level.closeQuantity! > 0);
}

export async function PUT(request: Request) {
  const user = await requirePermission(request, "trade:position:risk_edit");
  if (isResponse(user)) return user;
  const body = await request.json() as { id?: number; requestId?: string; takeProfitPlan?: RiskLevel[]; stopLossPlan?: RiskLevel[]; trailingActivationPercent?: number; trailingStopPercent?: number; minimumObservationMinutes?: number; liquidationGuardBufferPercent?: number };
  if (!Number.isInteger(body.id) || !/^[A-Za-z0-9_-]{8,64}$/.test(body.requestId ?? "") || !validPlan(body.takeProfitPlan) || !validPlan(body.stopLossPlan, true)) return Response.json({ error: "实盘止盈止损ROE计划无效" }, { status: 400 });
  const activation = Number(body.trailingActivationPercent ?? 0);
  const callback = Number(body.trailingStopPercent ?? 0);
  const minimumObservationMinutes = Number(body.minimumObservationMinutes ?? 0);
  const liquidationGuardBufferPercent = Number(body.liquidationGuardBufferPercent ?? 5);
  if (!Number.isFinite(activation) || !Number.isFinite(callback) || activation < 0 || activation > 100 || callback < 0 || callback > 50 || (callback > 0 && activation < 0.1)) return Response.json({ error: "移动止损参数无效" }, { status: 400 });
  if (!Number.isInteger(minimumObservationMinutes) || minimumObservationMinutes < 0 || minimumObservationMinutes > 1_440) return Response.json({ error: "完整周期观察时长需为 0 至 1440 分钟" }, { status: 400 });
  if (!Number.isFinite(liquidationGuardBufferPercent) || liquidationGuardBufferPercent < 0.1 || liquidationGuardBufferPercent > 50) return Response.json({ error: "强平保护缓冲需为 0.1% 至 50%" }, { status: 400 });
  const db = getDb();
  const [position] = await db.select().from(livePositions).where(and(eq(livePositions.id, body.id!), eq(livePositions.ownerEmail, user.email))).limit(1);
  if (!position) return Response.json({ error: "实盘仓位不存在或无权访问" }, { status: 404 });
  const currentRiskPlan = parseRecord(position.riskPlanJson);
  const currentProtection =
    currentRiskPlan.protection &&
    typeof currentRiskPlan.protection === "object" &&
    !Array.isArray(currentRiskPlan.protection)
      ? currentRiskPlan.protection as Record<string, unknown>
      : {};
  if (currentProtection.updateRequestId === body.requestId)
    return Response.json({ position, idempotentReplay: true });
  if (position.status !== "OPEN") return Response.json({ error: "只有后台保护中的实盘仓位可以修改参数" }, { status: 409 });
  const [symbol] = await db.select().from(contractSymbols).where(eq(contractSymbols.symbol, position.symbol)).limit(1);
  if (!symbol) return Response.json({ error: "合约数量规则不存在，请先同步合约池" }, { status: 409 });
  for (const level of [...body.takeProfitPlan!, ...body.stopLossPlan!]) {
    if (level.closeQuantity! < symbol.minOrderQty || Math.abs(level.closeQuantity! / symbol.quantityStep - Math.round(level.closeQuantity! / symbol.quantityStep)) > 1e-8) return Response.json({ error: `每档数量必须不低于 ${symbol.minOrderQty} 并按 ${symbol.quantityStep} 步长对齐` }, { status: 400 });
  }
  const executableTakeProfitPlan = normalizeRiskLevelsForExecution({
    levels: body.takeProfitPlan!.map((item) => ({
      triggerPercent: item.triggerPercent,
      closePercent: item.closePercent,
      closeQuantity: Number(item.closeQuantity),
    })),
    totalQuantity: position.quantity,
    minQuantity: symbol.minOrderQty,
    quantityStep: symbol.quantityStep,
    referencePrice: position.markPrice,
    minNotionalUsdt: symbol.minNotionalUsdt,
  });
  const executableStopLossPlan = callback > 0
    ? { levels: [] as typeof executableTakeProfitPlan.levels }
    : normalizeRiskLevelsForExecution({
        levels: body.stopLossPlan!.map((item) => ({
          triggerPercent: item.triggerPercent,
          closePercent: item.closePercent,
          closeQuantity: Number(item.closeQuantity),
        })),
        totalQuantity: position.quantity,
        minQuantity: symbol.minOrderQty,
        quantityStep: symbol.quantityStep,
        referencePrice: position.markPrice,
        minNotionalUsdt: symbol.minNotionalUsdt,
      });
  const nextProtectionVersion = position.protectionVersion + 1;
  const protectionUpdatedAt = new Date();
  const effectiveStopLossPlan = executableStopLossPlan.levels;
  const currentDynamicProtectionEnabled =
    currentRiskPlan.dynamicProfitProtectionEnabled !== false &&
    position.trailingStopPercent > 0;
  const nextExecutedProgress = currentDynamicProtectionEnabled && callback > 0
    ? resetGridProgressPreservingDynamic(
        normalizeExecutedRiskProgress(
          parseRecord(position.executedRiskPlanJson),
        ),
      )
    : normalizeExecutedRiskProgress(null);
  const activeRiskPlan = mergeRiskPlanWithPositionMemory(position.riskPlanJson, {
    calculationMode: "ROE",
    dynamicProfitProtectionEnabled: callback > 0,
    minimumObservationMinutes,
    liquidationGuardBufferPercent,
    takeProfits: executableTakeProfitPlan.levels,
    stopLosses: effectiveStopLossPlan,
    notionalExitPolicy: executableTakeProfitPlan.exitPolicy,
    protection: {
      version: nextProtectionVersion,
      basisPositionVersion: position.positionVersion,
      state: "ACTIVE",
      source: "MANUAL_UPDATE",
      updateRequestId: body.requestId,
      createdAtMs: protectionUpdatedAt.getTime(),
    },
  });
  const [updated] = await db.update(livePositions).set({
    riskPlanJson: JSON.stringify(activeRiskPlan),
    protectionVersion: nextProtectionVersion,
    protectionState: "ACTIVE",
    protectionUpdatedAt,
    executedRiskPlanJson: JSON.stringify(nextExecutedProgress),
    trailingActivationPercent: activation,
    trailingStopPercent: callback,
    // Editing protection parameters must not erase an already-earned peak.
    favorablePrice: monotonicFavorablePrice({
      positionSide: position.positionSide,
      entryPrice: position.entryPrice,
      previousFavorablePrice: position.favorablePrice,
      currentMarkPrice: position.markPrice,
      reset: !currentDynamicProtectionEnabled && callback > 0,
    }),
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(livePositions.id, position.id),
    eq(livePositions.status, "OPEN"),
    eq(livePositions.positionVersion, position.positionVersion),
    eq(livePositions.protectionVersion, position.protectionVersion),
  )).returning();
  if (!updated) return Response.json({ error: "实盘仓位状态已变化，请刷新后重试" }, { status: 409 });
  await writeAudit(user, "UPDATE_LIVE_POSITION_RISK", "live_position", String(position.id), { symbol: position.symbol, positionSide: position.positionSide, positionVersion: position.positionVersion, previousProtectionVersion: position.protectionVersion, protectionVersion: nextProtectionVersion, protectionState: "ACTIVE", takeProfitPlan: executableTakeProfitPlan.levels, stopLossPlan: effectiveStopLossPlan, notionalExitPolicy: executableTakeProfitPlan.exitPolicy, dynamicProfitProtectionEnabled: callback > 0, minimumObservationMinutes, liquidationGuardBufferPercent, trailingActivationPercent: activation, trailingStopPercent: callback });
  return Response.json({ position: updated, idempotentReplay: false });
}
