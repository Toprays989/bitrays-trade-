import type { LiquidationTrendConfig } from "./liquidation-trend-config";

export const ENTRY_EXECUTION_SHADOW_VERSION =
  "nexus-entry-distance-shadow-v1" as const;

export type EntryDistanceExecutionMode = "SHADOW" | "LIVE";
export type EntryExecutionOrder = {
  orderType: "MARKET" | "LIMIT";
  price: number | null;
  analysis: Record<string, unknown>;
};

export type EntryExecutionShadow = {
  version: typeof ENTRY_EXECUTION_SHADOW_VERSION;
  observationOnly: boolean;
  activationMode: EntryDistanceExecutionMode;
  configuredOrderMode: LiquidationTrendConfig["execution"]["orderType"];
  effectiveRequestedMode: LiquidationTrendConfig["execution"]["orderType"];
  actualOrderType: "MARKET" | "LIMIT";
  actualRequestedPrice: number;
  adaptiveOrderType: "MARKET" | "LIMIT";
  adaptiveRequestedPrice: number;
  recommendationDiffers: boolean;
  distanceAtr: number | null;
  marketDistanceThresholdAtr: number;
  leverage: number;
  selectionReason: string;
};

/**
 * Existing ADAPTIVE strategies are treated as LIVE for backward compatibility.
 * All fixed MARKET/LIMIT strategies default to SHADOW until an operator
 * explicitly enables the entry-distance executor.
 */
export function entryDistanceExecutionMode(
  execution: Pick<
    LiquidationTrendConfig["execution"],
    "orderType" | "entryDistanceExecutionMode"
  >,
): EntryDistanceExecutionMode {
  if (execution.entryDistanceExecutionMode === "LIVE") return "LIVE";
  if (execution.entryDistanceExecutionMode === "SHADOW") return "SHADOW";
  return execution.orderType === "ADAPTIVE" ? "LIVE" : "SHADOW";
}

export function effectiveEntryOrderMode(
  execution: Pick<
    LiquidationTrendConfig["execution"],
    "orderType" | "entryDistanceExecutionMode"
  >,
): LiquidationTrendConfig["execution"]["orderType"] {
  return entryDistanceExecutionMode(execution) === "LIVE"
    ? "ADAPTIVE"
    : execution.orderType === "ADAPTIVE"
      ? "MARKET"
      : execution.orderType;
}

export function buildEntryExecutionShadow(input: {
  execution: Pick<
    LiquidationTrendConfig["execution"],
    | "orderType"
    | "entryDistanceExecutionMode"
    | "adaptiveMarketMaxDistanceAtr"
    | "leverage"
  >;
  decisionMarkPrice: number;
  actualOrder: EntryExecutionOrder;
  adaptiveOrder: EntryExecutionOrder;
}): EntryExecutionShadow | null {
  const mark = positive(input.decisionMarkPrice);
  const actualPrice = positive(input.actualOrder.price) ?? mark;
  const adaptivePrice = positive(input.adaptiveOrder.price) ?? mark;
  if (mark === null || actualPrice === null || adaptivePrice === null) return null;
  const mode = entryDistanceExecutionMode(input.execution);
  const adaptiveAnalysis = input.adaptiveOrder.analysis;
  const distanceAtr = finite(
    adaptiveAnalysis.distanceAboveConfirmationAtr ??
      adaptiveAnalysis.distanceBelowBrokenSupportAtr,
  );
  const threshold = positive(
    input.execution.adaptiveMarketMaxDistanceAtr,
  ) ?? 0.2;
  const leverage = positive(input.execution.leverage) ?? 1;
  return {
    version: ENTRY_EXECUTION_SHADOW_VERSION,
    observationOnly: mode === "SHADOW",
    activationMode: mode,
    configuredOrderMode: input.execution.orderType,
    effectiveRequestedMode: effectiveEntryOrderMode(input.execution),
    actualOrderType: input.actualOrder.orderType,
    actualRequestedPrice: actualPrice,
    adaptiveOrderType: input.adaptiveOrder.orderType,
    adaptiveRequestedPrice: adaptivePrice,
    recommendationDiffers:
      input.actualOrder.orderType !== input.adaptiveOrder.orderType ||
      Math.abs(actualPrice - adaptivePrice) > Math.max(1e-12, mark * 1e-10),
    distanceAtr,
    marketDistanceThresholdAtr: threshold,
    leverage,
    selectionReason:
      typeof adaptiveAnalysis.selectionReason === "string"
        ? adaptiveAnalysis.selectionReason
        : "结构距离影子已计算；不参与方向、数量或风险判断。",
  };
}

export type EntryExecutionShadowCheckpoint = {
  minute: 5 | 30 | 60;
  status: "FILLED" | "NOT_FILLED" | "INSUFFICIENT";
  fillMinute: number | null;
  actualRoePercent: number | null;
  shadowRoePercent: number | null;
  shadowOpportunityRoePercent: number | null;
  advantageRoePercent: number | null;
};

/**
 * Minute-close evidence is deliberately conservative: it proves a resting
 * limit was reachable only when a recorded minute close crosses the quote.
 * An unfilled shadow counts as zero ROE so missed opportunities are not hidden.
 */
export function evaluateEntryExecutionShadow(input: {
  positionSide: "LONG" | "SHORT";
  leverage: number;
  actualEntryPrice: number;
  shadow: Pick<
    EntryExecutionShadow,
    "adaptiveOrderType" | "adaptiveRequestedPrice"
  >;
  fillDeadlineMinute?: number;
  samples: Array<{ minuteOffset: number; markPrice: number | null }>;
}): EntryExecutionShadowCheckpoint[] {
  const leverage = positive(input.leverage);
  const actualEntry = positive(input.actualEntryPrice);
  const shadowEntry = positive(input.shadow.adaptiveRequestedPrice);
  const fillDeadline = Math.max(
    1,
    Math.min(1, Math.trunc(input.fillDeadlineMinute ?? 1)),
  );
  const samples = input.samples
    .map((sample) => ({
      minuteOffset: Number(sample.minuteOffset),
      markPrice: positive(sample.markPrice),
    }))
    .filter(
      (sample): sample is { minuteOffset: number; markPrice: number } =>
        Number.isFinite(sample.minuteOffset) &&
        sample.minuteOffset >= 1 &&
        sample.markPrice !== null,
    )
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
  if (leverage === null || actualEntry === null || shadowEntry === null)
    return [5, 30, 60].map((minute) => insufficient(minute as 5 | 30 | 60));

  const fill = input.shadow.adaptiveOrderType === "MARKET"
    ? { minuteOffset: 0 }
    : samples.find((sample) =>
        sample.minuteOffset <= fillDeadline &&
        (input.positionSide === "LONG"
          ? sample.markPrice <= shadowEntry
          : sample.markPrice >= shadowEntry)
      ) ?? null;

  return ([5, 30, 60] as const).map((minute) => {
    const evaluation = samples.find((sample) => sample.minuteOffset === minute);
    if (!evaluation) return insufficient(minute);
    const actualRoe = roe(input.positionSide, actualEntry, evaluation.markPrice, leverage);
    if (!fill)
      return {
        minute,
        status: "NOT_FILLED" as const,
        fillMinute: null,
        actualRoePercent: actualRoe,
        shadowRoePercent: null,
        shadowOpportunityRoePercent: 0,
        advantageRoePercent: -actualRoe,
      };
    const shadowRoe = roe(
      input.positionSide,
      shadowEntry,
      evaluation.markPrice,
      leverage,
    );
    return {
      minute,
      status: "FILLED" as const,
      fillMinute: fill.minuteOffset,
      actualRoePercent: actualRoe,
      shadowRoePercent: shadowRoe,
      shadowOpportunityRoePercent: shadowRoe,
      advantageRoePercent: shadowRoe - actualRoe,
    };
  });
}

function insufficient(minute: 5 | 30 | 60): EntryExecutionShadowCheckpoint {
  return {
    minute,
    status: "INSUFFICIENT",
    fillMinute: null,
    actualRoePercent: null,
    shadowRoePercent: null,
    shadowOpportunityRoePercent: null,
    advantageRoePercent: null,
  };
}

function roe(
  side: "LONG" | "SHORT",
  entry: number,
  mark: number,
  leverage: number,
) {
  const direction = side === "LONG" ? 1 : -1;
  return direction * ((mark - entry) / entry) * leverage * 100;
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finite(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
