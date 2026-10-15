import type {
  BrainTradeDirection,
  StrategyExecutionDirection,
} from "./strategy-execution-direction.ts";

export const INVERSE_STRATEGY_OBSERVABILITY_VERSION = 1 as const;
export const INVERSE_DIRECTION_MINIMUM_SETTLED_SAMPLES = 20;

export type InverseDirectionLane =
  | "LONG_TO_SHORT"
  | "SHORT_TO_LONG";

export type InverseExecutionObservation = {
  version: typeof INVERSE_STRATEGY_OBSERVABILITY_VERSION;
  lane: InverseDirectionLane;
  brainDirection: BrainTradeDirection;
  tradeDirection: BrainTradeDirection;
  approvedAtMs: number | null;
  executionStartedAtMs: number;
  orderCreatedAtMs: number | null;
  confirmationToExecutionMs: number | null;
  confirmationToOrderMs: number | null;
  approvalPrice: number | null;
  executionPrice: number | null;
  priceDeviationBps: number | null;
  targetConfirmationToOrderMs: 3_000;
  targetMet: boolean | null;
  orderAffecting: false;
  parameterAffecting: false;
};

export function inverseDirectionLane(
  direction: Pick<
    StrategyExecutionDirection,
    "brainDirection" | "tradeDirection" | "inverted"
  >,
): InverseDirectionLane | null {
  if (!direction.inverted) return null;
  if (
    direction.brainDirection === "LONG" &&
    direction.tradeDirection === "SHORT"
  ) return "LONG_TO_SHORT";
  if (
    direction.brainDirection === "SHORT" &&
    direction.tradeDirection === "LONG"
  ) return "SHORT_TO_LONG";
  return null;
}

export function inverseDirectionLaneFromEvidence(
  value: unknown,
  fallbackBrainDirection?: BrainTradeDirection | null,
) {
  const evidence = asRecord(value);
  const executionDirection = asRecord(evidence.executionDirection);
  const observation = asRecord(evidence.inverseExecutionObservation);
  const brainDirection = brainDirectionValue(
    observation.brainDirection ??
      evidence.brainDecisionDirection ??
      executionDirection.brainDirection ??
      fallbackBrainDirection,
  );
  const tradeDirection = brainDirectionValue(
    observation.tradeDirection ??
      evidence.tradeDirection ??
      executionDirection.tradeDirection,
  );
  if (brainDirection === "LONG" && tradeDirection === "SHORT")
    return "LONG_TO_SHORT" as const;
  if (brainDirection === "SHORT" && tradeDirection === "LONG")
    return "SHORT_TO_LONG" as const;
  return null;
}

export function buildInverseExecutionObservation(input: {
  direction: StrategyExecutionDirection;
  frozenDecision?: unknown;
  executionStartedAt: Date | number | string;
  orderCreatedAt?: Date | number | string | null;
  approvalPrice?: unknown;
  executionPrice?: unknown;
}): InverseExecutionObservation | null {
  const lane = inverseDirectionLane(input.direction);
  if (!lane) return null;
  const frozenDecision = asRecord(input.frozenDecision);
  const approvedAtMs = timestamp(frozenDecision.approvedAt);
  const executionStartedAtMs = timestamp(input.executionStartedAt) ?? Date.now();
  const orderCreatedAtMs = timestamp(input.orderCreatedAt);
  const approvalPrice = positiveNumber(input.approvalPrice);
  const executionPrice = positiveNumber(input.executionPrice);
  const confirmationToExecutionMs = approvedAtMs === null
    ? null
    : Math.max(0, executionStartedAtMs - approvedAtMs);
  const confirmationToOrderMs =
    approvedAtMs === null || orderCreatedAtMs === null
      ? null
      : Math.max(0, orderCreatedAtMs - approvedAtMs);
  const priceDeviationBps =
    approvalPrice === null || executionPrice === null
      ? null
      : Math.abs((executionPrice - approvalPrice) / approvalPrice) * 10_000;
  return {
    version: INVERSE_STRATEGY_OBSERVABILITY_VERSION,
    lane,
    brainDirection: input.direction.brainDirection,
    tradeDirection: input.direction.tradeDirection,
    approvedAtMs,
    executionStartedAtMs,
    orderCreatedAtMs,
    confirmationToExecutionMs,
    confirmationToOrderMs,
    approvalPrice,
    executionPrice,
    priceDeviationBps,
    targetConfirmationToOrderMs: 3_000,
    targetMet:
      confirmationToOrderMs === null ? null : confirmationToOrderMs <= 3_000,
    orderAffecting: false,
    parameterAffecting: false,
  };
}

export function inverseExecutionObservationFromEvidence(value: unknown) {
  const evidence = asRecord(value);
  const observation = asRecord(evidence.inverseExecutionObservation);
  if (
    observation.version !== INVERSE_STRATEGY_OBSERVABILITY_VERSION ||
    (observation.lane !== "LONG_TO_SHORT" &&
      observation.lane !== "SHORT_TO_LONG")
  ) return null;
  return observation as unknown as InverseExecutionObservation;
}

export type InverseDirectionPerformanceSample = {
  lane: InverseDirectionLane | null;
  terminalStatus: "OPEN" | "CLOSED";
  exactNetPnlUsdt?: number | null;
  openGrossPnlUsdt?: number | null;
};

export function summarizeInverseDirectionPerformance(input: {
  samples: InverseDirectionPerformanceSample[];
  minimumSettledSamples?: number;
}) {
  const minimumSettledSamples = Math.max(
    INVERSE_DIRECTION_MINIMUM_SETTLED_SAMPLES,
    Math.trunc(Number(input.minimumSettledSamples) || 0),
  );
  const lanes = {
    LONG_TO_SHORT: summarizeLane("LONG_TO_SHORT"),
    SHORT_TO_LONG: summarizeLane("SHORT_TO_LONG"),
  };
  return {
    version: INVERSE_STRATEGY_OBSERVABILITY_VERSION,
    minimumSettledSamples,
    lanes,
    bothLanesReady:
      lanes.LONG_TO_SHORT.reviewReady && lanes.SHORT_TO_LONG.reviewReady,
    liveConfigMutationAllowed: false as const,
    automaticPublishAllowed: false as const,
    summary:
      `原多→实空精确结算 ${lanes.LONG_TO_SHORT.settledSamples}/${minimumSettledSamples}，` +
      `原空→实多 ${lanes.SHORT_TO_LONG.settledSamples}/${minimumSettledSamples}；` +
      "两条反转路径独立观察，结果不会自动修改大脑或策略参数。",
  };

  function summarizeLane(lane: InverseDirectionLane) {
    const rows = input.samples.filter((sample) => sample.lane === lane);
    const settled = rows.filter(
      (sample) =>
        sample.terminalStatus === "CLOSED" &&
        Number.isFinite(Number(sample.exactNetPnlUsdt)),
    );
    const open = rows.filter((sample) => sample.terminalStatus === "OPEN");
    const exactNetPnlUsdt = settled.reduce(
      (sum, sample) => sum + Number(sample.exactNetPnlUsdt),
      0,
    );
    const grossProfit = settled.reduce(
      (sum, sample) =>
        Number(sample.exactNetPnlUsdt) > 0
          ? sum + Number(sample.exactNetPnlUsdt)
          : sum,
      0,
    );
    const grossLoss = Math.abs(settled.reduce(
      (sum, sample) =>
        Number(sample.exactNetPnlUsdt) < 0
          ? sum + Number(sample.exactNetPnlUsdt)
          : sum,
      0,
    ));
    const openGrossPnlUsdt = open.reduce(
      (sum, sample) =>
        sum + (Number.isFinite(Number(sample.openGrossPnlUsdt))
          ? Number(sample.openGrossPnlUsdt)
          : 0),
      0,
    );
    const wins = settled.filter(
      (sample) => Number(sample.exactNetPnlUsdt) > 0,
    ).length;
    return {
      lane,
      totalPositions: rows.length,
      settledSamples: settled.length,
      wins,
      losses: settled.filter(
        (sample) => Number(sample.exactNetPnlUsdt) < 0,
      ).length,
      winRatePercent: settled.length ? wins / settled.length * 100 : null,
      exactNetPnlUsdt,
      profitFactor:
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null,
      openPositions: open.length,
      openGrossPnlUsdt,
      reviewReady: settled.length >= minimumSettledSamples,
      remainingSettledSamples: Math.max(
        0,
        minimumSettledSamples - settled.length,
      ),
    };
  }
}

export function medianFinite(values: unknown[]) {
  const rows = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2
    ? rows[middle]
    : (rows[middle - 1] + rows[middle]) / 2;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function brainDirectionValue(value: unknown): BrainTradeDirection | null {
  return value === "LONG" || value === "SHORT" ? value : null;
}

function timestamp(value: unknown) {
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : null;
  }
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function positiveNumber(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}
