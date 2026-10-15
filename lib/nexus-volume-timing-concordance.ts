export const NEXUS_VOLUME_TIMING_CONCORDANCE_VERSION =
  "nexus-volume-timing-concordance-v2" as const;

export const NEXUS_PRE_TRIGGER_VOLUME_REFERENCE_VERSION =
  "nexus-pre-trigger-volume-reference-v1" as const;

export type NexusVolumeTimingState =
  | "TIME_MISALIGNED"
  // Historical persisted value. The current analyzer never waits for a
  // post-trigger 3m close; execution is decided from the latest closed 1m
  // candle plus the fresh WebSocket mark price.
  | "POST_TRIGGER_EXECUTION_PENDING"
  | "CURRENT_FACT_STALE"
  | "DATA_INCOMPLETE"
  | "CURRENT_EXECUTION_CONFIRMED"
  | "BACKGROUND_WITHOUT_EXECUTION"
  | "IMPULSE_DECAYED"
  | "CURRENT_QUIET";

export type NexusVolumeTimingConcordance = {
  version: typeof NEXUS_VOLUME_TIMING_CONCORDANCE_VERSION;
  state: NexusVolumeTimingState;
  historicalImpulseVolumeRatio: number | null;
  currentExecutionVolumeRatio: number | null;
  currentContextVolumeRatio: number | null;
  requiredVolumeRatio: number;
  historicalImpulseConcentrated: boolean;
  historicalImpulseStrong: boolean;
  executionVolumeConfirmed: boolean;
  contextVolumeConfirmed: boolean;
  triggerAgeMs: number | null;
  executionFactAgeMs: number | null;
  contextFactAgeMs: number | null;
  executionIntervalMs: number;
  contextIntervalMs: number;
  continuationRequiresFreshExecution: boolean;
  summary: string;
  orderAffecting: true;
};

/**
 * 将爆仓当时的历史量能、当前1分钟执行量能和当前15分钟背景量能
 * 固定在同一个决策时点比较。触发前3分钟K线由独立历史参照保存，
 * 不参与等待，也不能冒充当前仍有资金接力。
 */
export function analyzeNexusVolumeTimingConcordance(input: {
  decisionAt: number;
  triggerEventAt?: number | null;
  currentExecutionCloseAt?: number | null;
  currentContextCloseAt?: number | null;
  historicalImpulseVolumeRatio?: number | null;
  historicalImpulseConcentrated?: boolean;
  currentExecutionVolumeRatio?: number | null;
  currentContextVolumeRatio?: number | null;
  requiredVolumeRatio?: number | null;
  executionIntervalMs?: number;
  contextIntervalMs?: number;
}): NexusVolumeTimingConcordance {
  const decisionAt = finiteOrNull(input.decisionAt);
  const triggerEventAt = finiteOrNull(input.triggerEventAt ?? null);
  const executionCloseAt = finiteOrNull(
    input.currentExecutionCloseAt ?? null,
  );
  const contextCloseAt = finiteOrNull(input.currentContextCloseAt ?? null);
  const historicalImpulseVolumeRatio = nonNegativeOrNull(
    input.historicalImpulseVolumeRatio ?? null,
  );
  const currentExecutionVolumeRatio = nonNegativeOrNull(
    input.currentExecutionVolumeRatio ?? null,
  );
  const currentContextVolumeRatio = nonNegativeOrNull(
    input.currentContextVolumeRatio ?? null,
  );
  const requiredVolumeRatio = Math.max(
    0.1,
    nonNegativeOrNull(input.requiredVolumeRatio ?? null) ?? 1.2,
  );
  const executionIntervalMs = Math.max(
    60_000,
    Math.trunc(input.executionIntervalMs ?? 60_000),
  );
  const contextIntervalMs = Math.max(
    executionIntervalMs,
    Math.trunc(input.contextIntervalMs ?? 15 * 60_000),
  );
  const triggerAgeMs = age(decisionAt, triggerEventAt);
  const executionFactAgeMs = age(decisionAt, executionCloseAt);
  const contextFactAgeMs = age(decisionAt, contextCloseAt);
  const historicalImpulseConcentrated =
    input.historicalImpulseConcentrated === true;
  const historicalImpulseStrong =
    historicalImpulseConcentrated &&
    historicalImpulseVolumeRatio !== null &&
    historicalImpulseVolumeRatio >= Math.max(1.5, requiredVolumeRatio);
  const executionVolumeConfirmed =
    currentExecutionVolumeRatio !== null &&
    currentExecutionVolumeRatio >= requiredVolumeRatio;
  const contextVolumeConfirmed =
    currentContextVolumeRatio !== null &&
    currentContextVolumeRatio >= requiredVolumeRatio;

  const result = (
    state: NexusVolumeTimingState,
    summary: string,
    continuationRequiresFreshExecution: boolean,
  ): NexusVolumeTimingConcordance => ({
    version: NEXUS_VOLUME_TIMING_CONCORDANCE_VERSION,
    state,
    historicalImpulseVolumeRatio,
    currentExecutionVolumeRatio,
    currentContextVolumeRatio,
    requiredVolumeRatio,
    historicalImpulseConcentrated,
    historicalImpulseStrong,
    executionVolumeConfirmed,
    contextVolumeConfirmed,
    triggerAgeMs,
    executionFactAgeMs,
    contextFactAgeMs,
    executionIntervalMs,
    contextIntervalMs,
    continuationRequiresFreshExecution,
    summary,
    orderAffecting: true,
  });

  if (
    decisionAt === null ||
    [triggerEventAt, executionCloseAt, contextCloseAt].some(
      (timestamp) => timestamp !== null && timestamp > decisionAt + 1_000,
    )
  )
    return result(
      "TIME_MISALIGNED",
      "量价事实时间晚于决策时点，禁止用未来数据或错位快照确认入场",
      true,
    );

  if (
    (executionFactAgeMs !== null &&
      executionFactAgeMs > executionIntervalMs * 2) ||
    (contextFactAgeMs !== null && contextFactAgeMs > contextIntervalMs * 2)
  )
    return result(
      "CURRENT_FACT_STALE",
      `当前闭合量价事实已过期：${intervalLabel(executionIntervalMs)} ${formatAge(executionFactAgeMs)}，${intervalLabel(contextIntervalMs)} ${formatAge(contextFactAgeMs)}`,
      true,
    );

  if (
    executionCloseAt === null ||
    contextCloseAt === null ||
    currentExecutionVolumeRatio === null ||
    currentContextVolumeRatio === null
  )
    return result(
      "DATA_INCOMPLETE",
      `当前${intervalLabel(executionIntervalMs)}或${intervalLabel(contextIntervalMs)}闭合量能不完整，历史爆发量不能代替当前执行事实`,
      true,
    );

  if (executionVolumeConfirmed)
    return result(
      "CURRENT_EXECUTION_CONFIRMED",
      `爆仓时量能 ${formatRatio(historicalImpulseVolumeRatio)}；当前${intervalLabel(executionIntervalMs)} ${formatRatio(currentExecutionVolumeRatio)}、${intervalLabel(contextIntervalMs)} ${formatRatio(currentContextVolumeRatio)}，执行窗口仍有资金接力`,
      false,
    );

  if (contextVolumeConfirmed)
    return result(
      "BACKGROUND_WITHOUT_EXECUTION",
      `${intervalLabel(contextIntervalMs)}背景量能 ${formatRatio(currentContextVolumeRatio)}，但当前${intervalLabel(executionIntervalMs)}仅 ${formatRatio(currentExecutionVolumeRatio)}；背景活跃不等于此刻可追单`,
      true,
    );

  if (historicalImpulseStrong)
    return result(
      "IMPULSE_DECAYED",
      `爆仓时量能曾达 ${formatRatio(historicalImpulseVolumeRatio)}，当前${intervalLabel(executionIntervalMs)}/${intervalLabel(contextIntervalMs)}已降至 ${formatRatio(currentExecutionVolumeRatio)}/${formatRatio(currentContextVolumeRatio)}；历史冲击已衰减，延续路径需重新确认，反转路径可作为衰竭背景`,
      true,
    );

  return result(
    "CURRENT_QUIET",
    `当前${intervalLabel(executionIntervalMs)}/${intervalLabel(contextIntervalMs)}量能为 ${formatRatio(currentExecutionVolumeRatio)}/${formatRatio(currentContextVolumeRatio)}，未形成新的执行放量`,
    false,
  );
}

export function buildNexusPreTriggerVolumeReference(input: {
  candles: Array<{ openTime?: number | null; volume?: number | null }>;
  triggerEventAt: number;
  intervalMs?: number;
  baselineCount?: number;
}) {
  const intervalMs = Math.max(
    60_000,
    Math.trunc(input.intervalMs ?? 3 * 60_000),
  );
  const triggerEventAt = finiteOrNull(input.triggerEventAt);
  const baselineCount = Math.max(2, Math.trunc(input.baselineCount ?? 10));
  const eligible = input.candles
    .map((candle) => {
      const openTime = finiteOrNull(candle.openTime ?? null);
      const volume = nonNegativeOrNull(candle.volume ?? null);
      return openTime === null || volume === null
        ? null
        : { closeAt: openTime + intervalMs - 1, volume };
    })
    .filter(
      (candle): candle is { closeAt: number; volume: number } =>
        candle !== null &&
        triggerEventAt !== null &&
        candle.closeAt < triggerEventAt,
    )
    .sort((left, right) => left.closeAt - right.closeAt);
  const window = eligible.slice(-(baselineCount + 1));
  const latest = window.at(-1) ?? null;
  const baseline = window.slice(0, -1);
  const average = baseline.length
    ? baseline.reduce((sum, candle) => sum + candle.volume, 0) /
      baseline.length
    : null;
  return {
    version: NEXUS_PRE_TRIGGER_VOLUME_REFERENCE_VERSION,
    intervalMs,
    closeAt: latest?.closeAt ?? null,
    relativeVolume:
      latest && average !== null && average > 0
        ? latest.volume / average
        : null,
    candleCount: eligible.length,
    contextOnly: true as const,
    orderAffecting: false as const,
  };
}

function intervalLabel(intervalMs: number) {
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}小时`;
  return `${Math.max(1, Math.trunc(intervalMs / 60_000))}分钟`;
}

function age(now: number | null, timestamp: number | null) {
  return now === null || timestamp === null ? null : Math.max(0, now - timestamp);
}

function finiteOrNull(value: number | null) {
  return Number.isFinite(value) ? Number(value) : null;
}

function nonNegativeOrNull(value: number | null) {
  const finite = finiteOrNull(value);
  return finite !== null && finite >= 0 ? finite : null;
}

function formatRatio(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}×`;
}

function formatAge(value: number | null) {
  return value === null ? "--" : `${Math.round(value / 1_000)}秒`;
}
