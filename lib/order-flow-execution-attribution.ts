export const ORDER_FLOW_EXECUTION_CHECKPOINTS = [1, 3, 5, 15, 30, 60] as const;

export type OrderFlowExecutionOutcome =
  | "WAITING_FOR_PATH"
  | "ORDER_FLOW_UNAVAILABLE"
  | "ORDER_FLOW_MIXED"
  | "ALIGNED_CONTINUATION"
  | "ALIGNED_EXHAUSTION_REVERSAL"
  | "ENTERED_AGAINST_ORDER_FLOW"
  | "CONTRARIAN_RECOVERY"
  | "NO_CLEAR_OUTCOME";

export type OrderFlowExecutionAttribution = {
  observationOnly: true;
  status: "WAITING" | "UNAVAILABLE" | "COMPARABLE";
  outcome: OrderFlowExecutionOutcome;
  pressureBias: "ALIGNED" | "OPPOSED" | "MIXED" | "UNAVAILABLE";
  decisionConfidence: number;
  directionalPressure: number;
  evaluationMinute: number | null;
  evaluationRoePercent: number | null;
  costBufferRoePercent: number;
  marketChaseObserved: boolean;
  fullCycleComplete: boolean;
  checkpoints: Array<{
    minute: number;
    status: "OBSERVED" | "WAITING";
    roePercent: number | null;
    mfeRoePercent: number | null;
    maeRoePercent: number | null;
  }>;
  explanation: string;
};

type EvidenceCheckpoint = {
  minuteOffset: number;
  roePercent?: number | null;
  mfeRoePercent?: number | null;
  maeRoePercent?: number | null;
};

/**
 * Explains the first-hour result of a real entry against the public order-flow
 * evidence frozen at decision time. It does not change orders, strategy
 * parameters, direction or position management.
 */
export function attributeOrderFlowExecution(input: {
  quoteRole: "ENTRY" | "ADD" | "EXIT";
  evidenceKind?: unknown;
  evidenceReady?: unknown;
  proxyState?: unknown;
  confidence?: unknown;
  directionalPressure?: unknown;
  leverage?: unknown;
  actualOrderType: "MARKET" | "LIMIT";
  actualAdverseSlippageBps?: number | null;
  theoreticalImprovementBps?: number | null;
  checkpoints: EvidenceCheckpoint[];
}): OrderFlowExecutionAttribution {
  const confidence = clamp(finiteOr(input.confidence, 0), 0, 1);
  const pressure = clamp(finiteOr(input.directionalPressure, 0), -1, 1);
  const costBuffer = Math.max(0.2, (positive(input.leverage) ?? 1) * 0.08);
  const checkpoints = ORDER_FLOW_EXECUTION_CHECKPOINTS.map((minute) => {
    const source = input.checkpoints.find(
      (item) => Math.trunc(finiteOr(item.minuteOffset, -1)) === minute,
    );
    const roe = finiteOrNull(source?.roePercent);
    return {
      minute,
      status: roe === null ? "WAITING" as const : "OBSERVED" as const,
      roePercent: roe,
      mfeRoePercent: finiteOrNull(source?.mfeRoePercent),
      maeRoePercent: finiteOrNull(source?.maeRoePercent),
    };
  });
  const fullCycleComplete = checkpoints.every((item) => item.status === "OBSERVED");
  const base = {
    observationOnly: true as const,
    decisionConfidence: round(confidence),
    directionalPressure: round(pressure),
    costBufferRoePercent: round(costBuffer),
    marketChaseObserved: false,
    fullCycleComplete,
    checkpoints,
  };

  if (input.quoteRole !== "ENTRY") {
    return {
      ...base,
      status: "UNAVAILABLE",
      outcome: "ORDER_FLOW_UNAVAILABLE",
      pressureBias: "UNAVAILABLE",
      evaluationMinute: null,
      evaluationRoePercent: null,
      explanation: "补仓和退出保留订单流快照，但本阶段只归因真实开仓后的价格路径。",
    };
  }
  if (
    input.evidenceKind !== "PUBLIC_ORDER_FLOW_PROXY" ||
    input.evidenceReady !== true ||
    confidence < 0.45
  ) {
    return {
      ...base,
      status: "UNAVAILABLE",
      outcome: "ORDER_FLOW_UNAVAILABLE",
      pressureBias: "UNAVAILABLE",
      evaluationMinute: null,
      evaluationRoePercent: null,
      explanation: "决策时订单流尚未形成足够可信的公开市场证据，不做事后方向归因。",
    };
  }

  const pressureBias = pressure >= 0.18
    ? "ALIGNED" as const
    : pressure <= -0.18
      ? "OPPOSED" as const
      : "MIXED" as const;
  const evaluation = checkpoints.find((item) =>
    item.minute === 5 && item.roePercent !== null
  ) ?? [...checkpoints]
    .filter((item) => item.minute <= 5 && item.roePercent !== null)
    .at(-1) ?? null;
  if (!evaluation) {
    return {
      ...base,
      status: "WAITING",
      outcome: "WAITING_FOR_PATH",
      pressureBias,
      evaluationMinute: null,
      evaluationRoePercent: null,
      explanation: "订单流决策快照已经保存，等待成交后1/3/5分钟价格路径完成早期验证。",
    };
  }

  const roe = evaluation.roePercent!;
  const positiveOutcome = roe > costBuffer;
  const negativeOutcome = roe < -costBuffer;
  const marketChaseObserved = negativeOutcome && input.actualOrderType === "MARKET" &&
    (finiteOr(input.theoreticalImprovementBps, 0) >= 5 ||
      finiteOr(input.actualAdverseSlippageBps, 0) >= 5);
  let outcome: OrderFlowExecutionOutcome = "NO_CLEAR_OUTCOME";
  if (pressureBias === "MIXED") outcome = "ORDER_FLOW_MIXED";
  else if (pressureBias === "ALIGNED" && positiveOutcome)
    outcome = "ALIGNED_CONTINUATION";
  else if (pressureBias === "ALIGNED" && negativeOutcome)
    outcome = "ALIGNED_EXHAUSTION_REVERSAL";
  else if (pressureBias === "OPPOSED" && negativeOutcome)
    outcome = "ENTERED_AGAINST_ORDER_FLOW";
  else if (pressureBias === "OPPOSED" && positiveOutcome)
    outcome = "CONTRARIAN_RECOVERY";

  return {
    ...base,
    status: "COMPARABLE",
    outcome,
    pressureBias,
    evaluationMinute: evaluation.minute,
    evaluationRoePercent: round(roe),
    marketChaseObserved,
    explanation: explanation(outcome, evaluation.minute, marketChaseObserved),
  };
}

export function summarizeOrderFlowAttributions(
  rows: OrderFlowExecutionAttribution[],
) {
  const comparable = rows.filter((item) => item.status === "COMPARABLE");
  return {
    total: rows.length,
    comparable: comparable.length,
    waiting: rows.filter((item) => item.status === "WAITING").length,
    unavailable: rows.filter((item) => item.status === "UNAVAILABLE").length,
    alignedContinuation: comparable.filter(
      (item) => item.outcome === "ALIGNED_CONTINUATION",
    ).length,
    alignedExhaustion: comparable.filter(
      (item) => item.outcome === "ALIGNED_EXHAUSTION_REVERSAL",
    ).length,
    enteredAgainstFlow: comparable.filter(
      (item) => item.outcome === "ENTERED_AGAINST_ORDER_FLOW",
    ).length,
    contrarianRecovery: comparable.filter(
      (item) => item.outcome === "CONTRARIAN_RECOVERY",
    ).length,
    marketChaseObserved: comparable.filter((item) => item.marketChaseObserved).length,
    fullCycles: comparable.filter((item) => item.fullCycleComplete).length,
  };
}

function explanation(
  outcome: OrderFlowExecutionOutcome,
  minute: number,
  marketChase: boolean,
) {
  const suffix = marketChase
    ? " 同时存在市价追价证据，应优先核对成交时机，不改变方向大脑。"
    : "";
  const message = {
    ALIGNED_CONTINUATION: `决策时公开订单流与仓位方向一致，第${minute}分钟仍覆盖交易成本，属于顺流延续。`,
    ALIGNED_EXHAUSTION_REVERSAL: `决策时订单流看似同向，但第${minute}分钟已反向超过交易成本，可能是末端衰竭、吸收或短时假突破。`,
    ENTERED_AGAINST_ORDER_FLOW: `决策时主动成交与仓位方向相反，第${minute}分钟继续受损，属于逆流入场。`,
    CONTRARIAN_RECOVERY: `决策时订单流与仓位方向相反，但第${minute}分钟价格已向仓位方向运行；只能记录为反转样本，不能证明能稳定抄底或摸顶。`,
    ORDER_FLOW_MIXED: `决策时多空订单流混合，第${minute}分钟结果不能归因于单一资金方向。`,
    NO_CLEAR_OUTCOME: `第${minute}分钟波动尚未覆盖估算交易成本，暂不能判断订单流延续或失效。`,
    WAITING_FOR_PATH: "等待价格路径。",
    ORDER_FLOW_UNAVAILABLE: "订单流不可用。",
  }[outcome];
  return `${message}${suffix}`;
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function finiteOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
