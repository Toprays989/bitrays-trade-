export type RuntimeMemoryPressurePhase =
  | "NORMAL"
  | "PRESSURE_DRAINING"
  | "RECYCLE_READY"
  | "RECOVERING";

export type RuntimeMemoryPressureState = Readonly<{
  phase: RuntimeMemoryPressurePhase;
  marketAnalysisPaused: boolean;
  reason: string | null;
  changedAt: number;
}>;

let state: RuntimeMemoryPressureState = {
  phase: "NORMAL",
  marketAnalysisPaused: false,
  reason: null,
  changedAt: Date.now(),
};

export function runtimeMemoryPressureState() {
  return state;
}

export function setRuntimeMemoryPressure(input: {
  marketAnalysisPaused: boolean;
  reason?: string | null;
  phase?: unknown;
}) {
  const phase = normalizedPhase(input.phase, input.marketAnalysisPaused);
  const marketAnalysisPaused =
    phase === "PRESSURE_DRAINING" || phase === "RECYCLE_READY";
  if (
    state.phase === phase &&
    state.marketAnalysisPaused === marketAnalysisPaused &&
    state.reason === (input.reason ?? null)
  ) return state;
  state = {
    phase,
    marketAnalysisPaused,
    reason: input.reason ?? null,
    changedAt: Date.now(),
  };
  return state;
}

export function marketAnalysisPressureResponse() {
  if (!state.marketAnalysisPaused) return null;
  return Response.json(
    {
      ok: true,
      paused: true,
      code: "MARKET_ANALYSIS_MEMORY_PRESSURE_PAUSED",
      message: "主应用内存达到高水位，全市场分析暂缓；订单对账与仓位保护继续运行。",
      pressure: state,
      checkedAt: new Date().toISOString(),
    },
    { status: 429, headers: { "retry-after": "15" } },
  );
}

function normalizedPhase(
  value: unknown,
  marketAnalysisPaused: boolean,
): RuntimeMemoryPressurePhase {
  if (
    value === "NORMAL" ||
    value === "PRESSURE_DRAINING" ||
    value === "RECYCLE_READY" ||
    value === "RECOVERING"
  ) return value;
  return marketAnalysisPaused ? "PRESSURE_DRAINING" : "NORMAL";
}
