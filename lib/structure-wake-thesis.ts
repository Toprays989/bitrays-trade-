import { hasCompleteNetProfitPath } from "./strategy-payoff.ts";
import type { StrategyTriggerKind } from "./strategy-trigger-catalog.ts";

export function buildStructureWakeThesis(input: {
  traceId: string;
  symbol: string;
  eventTimeMs: number;
  triggerKind: StrategyTriggerKind;
  direction: "LONG" | "SHORT";
  evidence: Record<string, unknown>;
  entryOrderAnalysis: Record<string, unknown>;
  firstTakeProfitRoePercent?: number | null;
  trailingActivationRoePercent?: number | null;
  profitabilityBaseline?: unknown;
}) {
  const triggerIdentity = record(input.evidence.triggerIdentity);
  const triggerEvidence = record(input.evidence.strategyTriggerEvidence);
  const marketEye = record(input.evidence.nexusMarketEyeDecision);
  const anchors = record(input.evidence.entryAnchorResolution);
  const confirmationLevel = finite(
    input.entryOrderAnalysis.confirmationLevel,
  ) ?? finite(anchors.confirmationLevel);
  const invalidBoundary = finite(
    input.entryOrderAnalysis.invalidBoundary,
  ) ?? finite(anchors.invalidBoundary);
  const profitabilityBaseline = record(input.profitabilityBaseline);
  const validDirectionalBoundary = confirmationLevel !== null &&
    invalidBoundary !== null &&
    (input.direction === "LONG"
      ? confirmationLevel > invalidBoundary
      : confirmationLevel < invalidBoundary);
  const checklist = [
    {
      code: "IMMUTABLE_TRIGGER_FACT",
      required: true,
      passed: Boolean(
        String(triggerIdentity.factSnapshotId ?? "").trim() &&
        Object.keys(triggerEvidence).length,
      ),
      observed: String(triggerIdentity.factSnapshotId ?? "未生成"),
    },
    {
      code: "DIRECTIONAL_ENTRY_BOUNDARY",
      required: true,
      passed: validDirectionalBoundary,
      observed: `确认 ${format(confirmationLevel)} / 失效 ${format(invalidBoundary)}`,
    },
    {
      code: "MARKET_EYE_CONFIRMED",
      required: true,
      passed: marketEye.verdict === "CONFIRMED",
      observed: String(marketEye.summary ?? marketEye.verdict ?? "未确认"),
    },
    {
      code: "NET_PROFIT_CAPTURE_PATH",
      required: true,
      passed: hasCompleteNetProfitPath(profitabilityBaseline),
      observed:
        `完整退出 ${profitabilityBaseline.completeExitConfigured === true ? "是" : "否"}` +
        ` / 净盈亏比 ${format(finite(profitabilityBaseline.netRiskRewardRatio))}`,
    },
  ];
  const status = checklist.every((item) => !item.required || item.passed)
    ? "CONFIRMED" as const
    : "INCOMPLETE" as const;
  return {
    schemaVersion: "structure-wake-thesis-v1" as const,
    thesisId: `${input.symbol}:${Math.trunc(input.eventTimeMs)}:${input.traceId}`,
    objective: "VALIDATE_TRIGGERED_STRUCTURE_FOLLOW_THROUGH" as const,
    triggerKind: input.triggerKind,
    direction: input.direction,
    setup: "STRUCTURE_WAKE" as const,
    authorizationMode: "CONFIRMED_EYE" as const,
    status,
    statement:
      "独立触发器只负责唤醒；统一眼睛和大脑确认当前量价结构后，冻结方向、成交边界和失效边界。",
    confirmationChecklist: checklist,
    entryPlan: {
      mode: input.entryOrderAnalysis.mode === "CONFIRMED_MARKET"
        ? "CONFIRMED_MARKET" as const
        : "STRUCTURAL_RETEST_LIMIT" as const,
      analyzedEntryPrice: finite(input.entryOrderAnalysis.analyzedEntryPrice),
      confirmationLevel,
      invalidBoundary,
    },
    invalidationRules: [
      "委托成交前价格越过方向失效边界，本轮假设立即终止",
      "超过触发有效期必须重新生成事实，不复用旧判断追价",
      "成交后统一仓位生命周期接管止盈、止损、移动保护和复盘学习",
    ],
    profitValidation: {
      firstTakeProfitRoePercent: finite(input.firstTakeProfitRoePercent),
      trailingActivationRoePercent: finite(input.trailingActivationRoePercent),
      estimatedRoundTripFeePercent:
        finite(profitabilityBaseline.estimatedRoundTripFeePercent) ?? 0.08,
      netRiskRewardRatio: finite(profitabilityBaseline.netRiskRewardRatio),
      breakEvenWinRatePercent:
        finite(profitabilityBaseline.breakEvenWinRatePercent),
      completeExitConfigured:
        profitabilityBaseline.completeExitConfigured === true,
      observationMinutes: [1, 3, 5, 10] as const,
    },
  };
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function format(value: number | null) {
  return value === null ? "—" : Number(value.toFixed(4)).toString();
}
