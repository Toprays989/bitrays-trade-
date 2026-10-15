export const STRATEGY_LEARNING_RUNTIME_TRACE_CONTEXT_BUDGET_BYTES =
  2 * 1024 * 1024;
export const STRATEGY_LEARNING_RUNTIME_OBSERVATION_ROW_LIMIT = 128;
export const STRATEGY_LEARNING_RUNTIME_TRACE_ID_LIMIT = 64;
export const STRATEGY_LEARNING_UI_TRACE_CONTEXT_BUDGET_BYTES =
  32 * 1024 * 1024;
export const STRATEGY_LEARNING_UI_OBSERVATION_ROW_LIMIT = 3_000;

export type StrategyLearningTraceContext = {
  traceId: string;
  entryEvidenceJson: string;
  configSnapshotJson?: string | null;
};

export function estimatedStrategyLearningTraceContextBytes(
  context: StrategyLearningTraceContext,
) {
  // V8 stores ordinary JavaScript strings as up to two bytes per code unit.
  // Count the retained string payload conservatively without allocating a
  // second encoded copy of the JSON merely to measure it.
  return 256 +
    2 * (
      context.traceId.length +
      context.entryEvidenceJson.length +
      (context.configSnapshotJson?.length ?? 0)
    );
}

export function selectStrategyLearningTraceContextsWithinBudget<
  T extends StrategyLearningTraceContext,
>(input: {
  contexts: T[];
  orderedTraceIds: string[];
  byteBudget: number;
  mustIncludeTraceId?: string | null;
}) {
  const byTraceId = new Map(
    input.contexts.map((context) => [context.traceId, context]),
  );
  const selected: T[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for (const traceId of input.orderedTraceIds) {
    const context = byTraceId.get(traceId);
    if (!context) continue;
    const contextBytes = estimatedStrategyLearningTraceContextBytes(context);
    const mustInclude = traceId === input.mustIncludeTraceId;
    if (
      !mustInclude &&
      retainedBytes + contextBytes > Math.max(0, input.byteBudget)
    ) {
      truncated = true;
      break;
    }
    selected.push(context);
    retainedBytes += contextBytes;
  }
  return { selected, retainedBytes, truncated };
}
