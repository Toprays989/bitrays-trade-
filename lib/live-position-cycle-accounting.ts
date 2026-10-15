import { reductionAccountingPnl } from "./live-reduction-accounting.ts";

export type PositionReductionAccountingRow = {
  quantity: number;
  reason: string;
  realizedPnl: number;
  responseJson?: string | null;
};

export type PositionReductionAttribution =
  | "EVIDENCE_RISK_PARTIAL_REDUCTION"
  | "EVIDENCE_RISK_FULL_EXIT"
  | "DYNAMIC_PROFIT_PARTIAL_REDUCTION"
  | "DYNAMIC_PROFIT_REMAINDER_EXIT"
  | "ENTRY_THESIS_INVALIDATION"
  | "ACCOUNT_EQUITY_HARD_STOP"
  | "ACCOUNT_EQUITY_DEFENSIVE_EXIT"
  | "CAPITAL_PRESERVATION_HARD_STOP"
  | "CONFIGURED_STOP_LOSS"
  | "TAKE_PROFIT"
  | "TRAILING_STOP"
  | "TIME_EXIT"
  | "MANUAL"
  | "EXTERNAL"
  | "MIN_NOTIONAL_PROMOTED_FULL_CLOSE"
  | "UNKNOWN";

export function positionReductionAttribution(
  reduction: PositionReductionAccountingRow,
): PositionReductionAttribution {
  const response = parseResponse(reduction.responseJson);
  const explicit = normalizedText(response.protectionTrigger);
  if (explicit === "EVIDENCE_RISK_PARTIAL_REDUCTION" ||
    explicit === "EVIDENCE_RISK_FULL_EXIT") return explicit;

  const evidenceRisk = record(response.evidenceRisk);
  if (evidenceRisk.action === "REDUCE_PARTIAL")
    return "EVIDENCE_RISK_PARTIAL_REDUCTION";
  if (evidenceRisk.action === "EXIT_FULL")
    return "EVIDENCE_RISK_FULL_EXIT";

  const dynamicProfitReduction = record(response.dynamicProfitReduction);
  if (dynamicProfitReduction.action === "PARTIAL")
    return "DYNAMIC_PROFIT_PARTIAL_REDUCTION";
  if (dynamicProfitReduction.action === "CLOSE_REMAINDER")
    return "DYNAMIC_PROFIT_REMAINDER_EXIT";

  if (explicit === "ENTRY_THESIS_INVALIDATION" || response.structureExit === true)
    return "ENTRY_THESIS_INVALIDATION";
  if (explicit === "ACCOUNT_EQUITY_HARD_STOP")
    return "ACCOUNT_EQUITY_HARD_STOP";
  if (explicit === "ACCOUNT_EQUITY_DEFENSIVE_EXIT")
    return "ACCOUNT_EQUITY_DEFENSIVE_EXIT";
  if (explicit === "CAPITAL_PRESERVATION_HARD_STOP")
    return "CAPITAL_PRESERVATION_HARD_STOP";

  const reason = normalizedText(reduction.reason);
  if (reason === "STOP_LOSS") return "CONFIGURED_STOP_LOSS";
  if (reason === "TAKE_PROFIT" || reason === "TRAILING_STOP" ||
    reason === "TIME_EXIT" || reason === "MANUAL" || reason === "EXTERNAL")
    return reason;
  return "UNKNOWN";
}

export function positionReductionExecutionAdjustment(
  reduction: PositionReductionAccountingRow,
): "MIN_NOTIONAL_PROMOTED_FULL_CLOSE" | null {
  const response = parseResponse(reduction.responseJson);
  const direct = record(response.executionAdjustment);
  const audit = record(response._nexusExecutionAudit);
  const nested = record(audit.executionAdjustment);
  const code = normalizedText(direct.code ?? nested.code);
  return code === "MIN_NOTIONAL_PROMOTED_FULL_CLOSE"
    ? "MIN_NOTIONAL_PROMOTED_FULL_CLOSE"
    : null;
}

export function aggregatePositionReductionCycle(
  reductions: PositionReductionAccountingRow[],
) {
  const result = reductions.reduce(
    (current, reduction) => {
      const accounting = reductionAccountingPnl(reduction);
      current.quantity += Number.isFinite(reduction.quantity)
        ? reduction.quantity
        : 0;
      current.pnl += accounting.pnl;
      current.grossPnl += accounting.grossRealizedPnl;
      current.reasons.push(reduction.reason);
      const attribution = positionReductionAttribution(reduction);
      current.attributions.push(attribution);
      current.attributionCounts[attribution] =
        (current.attributionCounts[attribution] ?? 0) + 1;
      const executionAdjustment =
        positionReductionExecutionAdjustment(reduction);
      if (executionAdjustment) {
        current.attributions.push(executionAdjustment);
        current.attributionCounts[executionAdjustment] =
          (current.attributionCounts[executionAdjustment] ?? 0) + 1;
      }
      current.settlementStatuses.push(accounting.settlementStatus);
      if (accounting.exactNetAvailable) current.exactCount += 1;
      return current;
    },
    {
      count: reductions.length,
      quantity: 0,
      pnl: 0,
      grossPnl: 0,
      exactCount: 0,
      reasons: [] as string[],
      attributions: [] as PositionReductionAttribution[],
      attributionCounts: {} as Partial<
        Record<PositionReductionAttribution, number>
      >,
      settlementStatuses: [] as Array<
        ReturnType<typeof reductionAccountingPnl>["settlementStatus"]
      >,
    },
  );
  const exactNetAvailable =
    result.count > 0 && result.exactCount === result.count;
  const netSettlementStatus = exactNetAvailable
    ? "READY" as const
    : result.count > 0 && result.settlementStatuses.every((status) =>
        status === "TRADE_DETAILS_UNAVAILABLE" || status === "FUNDING_SHARED"
      )
      ? "UNAVAILABLE" as const
      : "PENDING" as const;
  return {
    ...result,
    exactNetAvailable,
    netSettlementStatus,
  };
}

function parseResponse(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedText(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}
