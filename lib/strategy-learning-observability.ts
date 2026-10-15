type TerminalTrace = {
  traceId: string;
  configVersion: number;
  triggerKind: string;
  triggerVersion: string;
  completedAtMs: number;
};

type LearningCycle = {
  traceId: string;
  configVersion: number;
  terminalStatus: string;
  eligibility: string;
  exactNetAvailable: boolean;
  updatedAtMs: number;
};

type ParameterSuggestion = {
  configVersion: number;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
};

export function summarizeStrategyLearningObservability(input: {
  currentConfigVersion: number;
  traces: TerminalTrace[];
  cycles: LearningCycle[];
  suggestions: ParameterSuggestion[];
}) {
  const cycleByTrace = new Map<string, LearningCycle>();
  for (const cycle of input.cycles) {
    const previous = cycleByTrace.get(cycle.traceId);
    if (!previous || cycle.updatedAtMs > previous.updatedAtMs)
      cycleByTrace.set(cycle.traceId, cycle);
  }

  const groups = new Map<string, {
    triggerKind: string;
    triggerVersion: string;
    currentConfig: boolean;
    terminalTraces: number;
    absorbedCycles: number;
    exactNetCycles: number;
    eligibleCycles: number;
    latencies: number[];
  }>();
  for (const trace of uniqueTraces(input.traces)) {
    const currentConfig = trace.configVersion === input.currentConfigVersion;
    const key = [
      trace.triggerKind,
      trace.triggerVersion,
      currentConfig ? "CURRENT" : "HISTORICAL",
    ].join("\u0000");
    const group = groups.get(key) ?? {
      triggerKind: trace.triggerKind || "UNKNOWN",
      triggerVersion: trace.triggerVersion || "unknown",
      currentConfig,
      terminalTraces: 0,
      absorbedCycles: 0,
      exactNetCycles: 0,
      eligibleCycles: 0,
      latencies: [],
    };
    group.terminalTraces += 1;
    const cycle = cycleByTrace.get(trace.traceId);
    if (cycle) {
      group.absorbedCycles += 1;
      if (cycle.exactNetAvailable) group.exactNetCycles += 1;
      if (cycle.eligibility !== "INCOMPLETE") group.eligibleCycles += 1;
      const latencyMs = cycle.updatedAtMs - trace.completedAtMs;
      if (Number.isFinite(latencyMs) && latencyMs >= 0)
        group.latencies.push(latencyMs);
    }
    groups.set(key, group);
  }

  const triggerCoverage = [...groups.values()]
    .map((group) => ({
      triggerKind: group.triggerKind,
      triggerVersion: group.triggerVersion,
      currentConfig: group.currentConfig,
      terminalTraces: group.terminalTraces,
      absorbedCycles: group.absorbedCycles,
      exactNetCycles: group.exactNetCycles,
      eligibleCycles: group.eligibleCycles,
      absorptionRatePercent: percentage(
        group.absorbedCycles,
        group.terminalTraces,
      ),
      medianAbsorptionLatencyMs: percentile(group.latencies, 0.5),
      p90AbsorptionLatencyMs: percentile(group.latencies, 0.9),
    }))
    .sort((left, right) =>
      Number(right.currentConfig) - Number(left.currentConfig) ||
      right.terminalTraces - left.terminalTraces
    );
  const currentGroups = triggerCoverage.filter((group) => group.currentConfig);
  const currentConfig = currentGroups.reduce(
    (summary, group) => ({
      version: input.currentConfigVersion,
      terminalTraces: summary.terminalTraces + group.terminalTraces,
      absorbedCycles: summary.absorbedCycles + group.absorbedCycles,
      exactNetCycles: summary.exactNetCycles + group.exactNetCycles,
      eligibleCycles: summary.eligibleCycles + group.eligibleCycles,
    }),
    {
      version: input.currentConfigVersion,
      terminalTraces: 0,
      absorbedCycles: 0,
      exactNetCycles: 0,
      eligibleCycles: 0,
    },
  );
  const currentLatencies = uniqueTraces(input.traces).flatMap((trace) => {
    if (trace.configVersion !== input.currentConfigVersion) return [];
    const cycle = cycleByTrace.get(trace.traceId);
    const latencyMs = cycle ? cycle.updatedAtMs - trace.completedAtMs : -1;
    return Number.isFinite(latencyMs) && latencyMs >= 0 ? [latencyMs] : [];
  });

  return {
    currentConfig: {
      ...currentConfig,
      absorptionRatePercent: percentage(
        currentConfig.absorbedCycles,
        currentConfig.terminalTraces,
      ),
      medianAbsorptionLatencyMs: percentile(currentLatencies, 0.5),
      pendingTerminalReceipts: Math.max(
        0,
        currentConfig.terminalTraces - currentConfig.absorbedCycles,
      ),
    },
    candidates: {
      currentPending: input.suggestions.filter((item) =>
        item.configVersion === input.currentConfigVersion &&
        item.status === "PENDING"
      ).length,
      stalePending: input.suggestions.filter((item) =>
        item.configVersion !== input.currentConfigVersion &&
        item.status === "PENDING"
      ).length,
      expired: input.suggestions.filter((item) => item.status === "EXPIRED").length,
      accepted: input.suggestions.filter((item) => item.status === "ACCEPTED").length,
      rejected: input.suggestions.filter((item) => item.status === "REJECTED").length,
      automaticConfigMutationAllowed: false as const,
    },
    triggerCoverage,
  };
}

function uniqueTraces(traces: TerminalTrace[]) {
  const byTrace = new Map<string, TerminalTrace>();
  for (const trace of traces)
    if (!byTrace.has(trace.traceId)) byTrace.set(trace.traceId, trace);
  return [...byTrace.values()];
}

function percentage(numerator: number, denominator: number) {
  return denominator > 0
    ? Math.round((numerator / denominator) * 10_000) / 100
    : null;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  )];
}
