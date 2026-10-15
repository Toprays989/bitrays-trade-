import type { NexusEntryDecisionIdentityChain } from "./nexus-mainline-contract.ts";
import { buildEntryPositionHoldingMandate } from "./position-holding-mandate.ts";

export const TRADE_LIFECYCLE_CONTRACT_VERSION = 6 as const;
export const ENTRY_THESIS_CONTRACT_VERSION = "entry-thesis-v1" as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function optionalRecord(value: unknown) {
  const parsed = record(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function optionalStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0,
  ))];
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectEvidenceFactIds(evidence: JsonRecord) {
  const ids = [...optionalStringArray(evidence.evidenceFactIds)];
  for (const collection of [
    evidence.nexusMarketFactsShadow,
    evidence.marketFacts,
    evidence.preTradeFacts,
  ]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (typeof item === "string") ids.push(item);
      else {
        const id = optionalString(record(item).id);
        if (id) ids.push(id);
      }
    }
  }
  for (const source of [
    evidence.nexusPureStateMachine,
    evidence.nexusTrendBreakoutStateMachine,
    evidence.nexusDecisionSnapshot,
  ]) ids.push(...optionalStringArray(record(source).evidenceFactIds));
  const brainShadow = record(evidence.nexusBrainShadow);
  const triggerFactId = optionalString(brainShadow.triggerFactId);
  if (triggerFactId) ids.push(triggerFactId);
  ids.push(...optionalStringArray(brainShadow.confirmationFactIds));
  return [...new Set(ids)];
}

function resolveWaveThesis(input: {
  positionSide: "LONG" | "SHORT";
  evidence: JsonRecord;
  waveThesis: JsonRecord | null;
}) {
  if (input.waveThesis) return input.waveThesis;
  const marketEye = record(input.evidence.nexusMarketEyeDecision);
  const analyzedOrder = record(input.evidence.analyzedEntryOrder);
  const structure = record(input.evidence.structure);
  const adaptiveContext = record(analyzedOrder.adaptiveExecutionContext);
  const confirmationLevel =
    optionalNumber(analyzedOrder.confirmationLevel) ??
    optionalNumber(analyzedOrder.brokenSupport) ??
    optionalNumber(structure.brokenSupport);
  const atr5m =
    optionalNumber(analyzedOrder.atr5m) ?? optionalNumber(structure.atr);
  const invalidBoundary =
    optionalNumber(analyzedOrder.invalidBoundary) ??
    (confirmationLevel !== null && atr5m !== null && atr5m > 0
      ? input.positionSide === "LONG"
        ? confirmationLevel - atr5m * 0.1
        : confirmationLevel + atr5m * 0.1
      : null);
  const entryPlan = {
    source: "DERIVED_FROM_FROZEN_ENTRY_EVIDENCE",
    selectedPath:
      optionalString(adaptiveContext.confirmedPath) ??
      optionalString(marketEye.selectedPath),
    analyzedEntryPrice: optionalNumber(analyzedOrder.analyzedEntryPrice),
    currentMarkPrice: optionalNumber(analyzedOrder.currentMarkPrice),
    confirmationLevel,
    invalidBoundary,
    atr5m,
  };
  return {
    source: "DERIVED_FROM_FROZEN_ENTRY_EVIDENCE",
    statement: optionalString(marketEye.summary),
    entryPlan,
    invalidationRules: invalidBoundary !== null && invalidBoundary > 0
      ? [
          `连续2根完整1分钟收盘${input.positionSide === "LONG" ? "低于" : "高于"}${invalidBoundary}时，原入场结构失效`,
        ]
      : [],
  };
}

function buildEntryThesisContract(input: {
  positionSide: "LONG" | "SHORT";
  resultMessage?: string | null;
  waveThesis: JsonRecord | null;
  netExpectancy: JsonRecord | null;
  evidenceFactIds: string[];
}) {
  const entryPlan = optionalRecord(input.waveThesis?.entryPlan);
  const profitValidation = optionalRecord(
    input.waveThesis?.profitValidation,
  );
  return {
    schemaVersion: ENTRY_THESIS_CONTRACT_VERSION,
    direction: input.positionSide,
    statement:
      optionalString(input.waveThesis?.statement) ??
      optionalString(input.resultMessage),
    entryPlan,
    invalidationRules: optionalStringArray(
      input.waveThesis?.invalidationRules,
    ),
    profitability: {
      expectedProfitRoePercent:
        optionalNumber(input.netExpectancy?.expectedProfitRoePercent) ??
        optionalNumber(profitValidation?.firstTakeProfitRoePercent),
      expectedLossRoePercent:
        optionalNumber(input.netExpectancy?.expectedLossRoePercent),
      posteriorWinProbabilityPercent:
        optionalNumber(input.netExpectancy?.posteriorWinProbabilityPercent),
      feeCostRoePercent:
        optionalNumber(input.netExpectancy?.feeCostRoePercent),
      slippageCostRoePercent:
        optionalNumber(input.netExpectancy?.slippageCostRoePercent),
      netExpectancyRoePercent:
        optionalNumber(input.netExpectancy?.netExpectancyRoePercent),
      breakEvenWinRatePercent:
        optionalNumber(profitValidation?.breakEvenWinRatePercent),
    },
    evidenceFactIds: input.evidenceFactIds,
  };
}

function buildEntryExecutionDecision(evidence: JsonRecord) {
  const analyzedOrder = optionalRecord(evidence.analyzedEntryOrder);
  if (!analyzedOrder) return null;
  const marketEye = record(evidence.nexusMarketEyeDecision);
  const volumeTiming = record(evidence.nexusVolumeTiming);
  const book = record(evidence.nexusBookEyeAtEntry);
  const adaptiveContext = record(analyzedOrder.adaptiveExecutionContext);
  return {
    attempt: optionalNumber(evidence.entryOrderAttempt) ?? 1,
    configuredMode: optionalString(analyzedOrder.configuredMode),
    requestedMode: optionalString(analyzedOrder.requestedMode),
    selectedOrderType: optionalString(analyzedOrder.selectedOrderType),
    selectionReason: optionalString(analyzedOrder.selectionReason),
    analysisMode: optionalString(analyzedOrder.mode),
    selectedPath:
      optionalString(adaptiveContext.confirmedPath) ??
      optionalString(marketEye.selectedPath),
    analyzedEntryPrice: optionalNumber(analyzedOrder.analyzedEntryPrice),
    currentMarkPrice: optionalNumber(analyzedOrder.currentMarkPrice),
    confirmationLevel:
      optionalNumber(analyzedOrder.confirmationLevel) ??
      optionalNumber(analyzedOrder.brokenSupport),
    invalidBoundary: optionalNumber(analyzedOrder.invalidBoundary),
    atr5m: optionalNumber(analyzedOrder.atr5m),
    distanceAtr:
      optionalNumber(analyzedOrder.distanceAboveConfirmationAtr) ??
      optionalNumber(analyzedOrder.distanceBelowBrokenSupportAtr),
    adaptiveDistance: {
      configuredMaxAtr: optionalNumber(
        analyzedOrder.adaptiveMarketMaxDistanceAtr,
      ),
      effectiveMaxAtr: optionalNumber(
        analyzedOrder.effectiveAdaptiveMarketMaxDistanceAtr,
      ),
      strategyMaxAtr: optionalNumber(
        adaptiveContext.strategyMaxEntryDistanceAtr,
      ),
      gate: optionalString(adaptiveContext.gate),
      fastBreakoutMarketEligible:
        adaptiveContext.fastBreakoutMarketEligible === true,
    },
    book: {
      source: optionalString(book.source),
      ageMs: optionalNumber(book.ageMs),
      staleAfterMs: optionalNumber(book.staleAfterMs),
      spreadBps: optionalNumber(book.spreadBps),
      directionalImbalance: optionalNumber(book.directionalImbalance),
    },
    volume: {
      state: optionalString(volumeTiming.state),
      currentExecutionVolumeRatio: optionalNumber(
        volumeTiming.currentExecutionVolumeRatio,
      ),
      requiredVolumeRatio: optionalNumber(volumeTiming.requiredVolumeRatio),
    },
  };
}

export function canonicalTradeLifecycleId(traceId: unknown) {
  return typeof traceId === "string" && traceId.trim().length > 0
    ? traceId.trim()
    : null;
}

export function buildEntryDecisionHandoff(input: {
  traceId: string;
  strategyId: number;
  configVersion: number;
  positionSide: "LONG" | "SHORT";
  decisionAt: Date | number | string;
  executionIntentId: string;
  resultCode?: string | null;
  resultMessage?: string | null;
  entryEvidence?: unknown;
}) {
  const lifecycleId = canonicalTradeLifecycleId(input.traceId);
  if (!lifecycleId) throw new Error("入场决策交接缺少有效 traceId");
  const frozenExecutionIntentId = optionalString(input.executionIntentId);
  if (!frozenExecutionIntentId)
    throw new Error("入场决策交接缺少本轮最终执行意图");
  const evidence = record(input.entryEvidence);
  const frozenExecutionDecision = record(evidence.frozenExecutionDecision);
  const frozenApprovalIsAuthoritative =
    frozenExecutionDecision.approved === true &&
    frozenExecutionDecision.decisionFrozen === true &&
    frozenExecutionDecision.retryWithoutReanalysis === true &&
    optionalString(frozenExecutionDecision.approvedAt) !== null &&
    optionalString(frozenExecutionDecision.approvalCode) !== null;
  const finalResultCode = frozenApprovalIsAuthoritative
    ? optionalString(frozenExecutionDecision.approvalCode)
    : null;
  const finalResultMessage = frozenApprovalIsAuthoritative
    ? optionalString(frozenExecutionDecision.approvalSummary)
    : null;
  const decisionSnapshot = record(evidence.nexusDecisionSnapshot);
  const directionDecision = optionalRecord(evidence.nexusDirectionDecision);
  const directionDecisionId = optionalString(
    directionDecision?.decisionGroupId,
  );
  if (directionDecision) {
    if (
      directionDecision.outcome !== "SELECTED" ||
      directionDecision.selectedDirection !== input.positionSide ||
      !directionDecisionId
    ) throw new Error("入场决策交接与多空方向裁决不一致");
    const directionFactSnapshotId = optionalString(
      directionDecision.factSnapshotId,
    );
    const decisionFactSnapshotId = optionalString(
      decisionSnapshot.factSnapshotId,
    );
    if (
      directionFactSnapshotId &&
      decisionFactSnapshotId &&
      directionFactSnapshotId !== decisionFactSnapshotId
    ) throw new Error("入场决策交接的方向裁决与事实快照不一致");
  }
  const netExpectancy =
    optionalRecord(evidence.nexusNetExpectancyDecision) ??
    optionalRecord(evidence.nexusNetExpectancy) ??
    optionalRecord(evidence.netExpectancy);
  const waveThesis = resolveWaveThesis({
    positionSide: input.positionSide,
    evidence,
    waveThesis: optionalRecord(evidence.waveThesis),
  });
  const evidenceFactIds = collectEvidenceFactIds(evidence);
  const decisionAtMs = input.decisionAt instanceof Date
    ? input.decisionAt.getTime()
    : typeof input.decisionAt === "number"
      ? input.decisionAt
      : Date.parse(input.decisionAt);
  const holdingMandate = buildEntryPositionHoldingMandate({
    entryEvidence: evidence,
    positionSide: input.positionSide,
    frozenAtMs: Number.isFinite(decisionAtMs) ? decisionAtMs : null,
    origin: "STRATEGY",
  });
  const executionDecision = buildEntryExecutionDecision(evidence);

  const identities: NexusEntryDecisionIdentityChain = {
    cycleId: lifecycleId,
    factSnapshotId: optionalString(decisionSnapshot.factSnapshotId),
    decisionId:
      directionDecisionId ?? `nqd:${lifecycleId}:v${input.configVersion}`,
    executionIntentId: frozenExecutionIntentId,
    configVersion: input.configVersion,
  };

  return {
    schemaVersion: TRADE_LIFECYCLE_CONTRACT_VERSION,
    lifecycleId,
    strategyId: input.strategyId,
    configVersion: input.configVersion,
    positionSide: input.positionSide,
    decisionAtMs: Number.isFinite(decisionAtMs) ? decisionAtMs : null,
    resultCode: finalResultCode ?? input.resultCode ?? null,
    resultMessage: finalResultMessage ?? input.resultMessage ?? null,
    identities,
    entryThesis: buildEntryThesisContract({
      positionSide: input.positionSide,
      resultMessage: input.resultMessage,
      waveThesis,
      netExpectancy,
      evidenceFactIds,
    }),
    evidence: {
      opportunityContext: optionalRecord(evidence.opportunityContext),
      directionDecision,
      entryStructureBaseline: optionalRecord(evidence.entryStructureBaseline),
      netExpectancy,
      waveThesis,
      frozenExecutionDecision: optionalRecord(frozenExecutionDecision),
      executionDecision,
      holdingMandate,
      entryMultiHourContext: optionalRecord(
        evidence.nexusOwnMultiHourContext,
      ),
      evidenceFactIds,
    },
    evidenceReference: {
      traceId: lifecycleId,
      source: "strategy_execution_traces" as const,
    },
  };
}

export type TradeLifecycleLink = {
  lifecycleId?: string | null;
  entryDecisionHandoffJson?: string | null;
};

export function validateTradeLifecycleLinks(input: {
  traceId?: string | null;
  order?: TradeLifecycleLink | null;
  position?: TradeLifecycleLink | null;
  reductions?: TradeLifecycleLink[];
  additions?: TradeLifecycleLink[];
}) {
  const expected = canonicalTradeLifecycleId(input.traceId) ??
    canonicalTradeLifecycleId(input.order?.lifecycleId) ??
    canonicalTradeLifecycleId(input.position?.lifecycleId);
  const issues: string[] = [];
  const check = (label: string, value: unknown) => {
    const lifecycleId = canonicalTradeLifecycleId(value);
    if (expected && lifecycleId && lifecycleId !== expected)
      issues.push(`${label} 生命周期号 ${lifecycleId} 与 ${expected} 不一致`);
  };
  check("委托", input.order?.lifecycleId);
  check("仓位", input.position?.lifecycleId);
  input.reductions?.forEach((item, index) =>
    check(`减仓${index + 1}`, item.lifecycleId));
  input.additions?.forEach((item, index) =>
    check(`补仓${index + 1}`, item.lifecycleId));
  if (expected && input.order && !canonicalTradeLifecycleId(input.order.lifecycleId))
    issues.push("委托缺少生命周期号");
  if (expected && input.position && !canonicalTradeLifecycleId(input.position.lifecycleId))
    issues.push("仓位缺少生命周期号");
  return {
    lifecycleId: expected,
    managed: expected !== null,
    consistent: issues.length === 0,
    issues,
  };
}
