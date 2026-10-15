export const NEXUS_SENTINEL_SHADOW_ENTRY_VALIDATION_VERSION =
  "nexus-sentinel-shadow-entry-validation-v1" as const;

export const NEXUS_SENTINEL_SHADOW_ENTRY_HORIZONS = [
  3,
  5,
  15,
  30,
  60,
] as const;

export type NexusSentinelShadowEntryValidationStatus =
  | "NOT_APPLICABLE"
  | "COLLECTING"
  | "MISSED_ENTRY"
  | "FILTER_VALIDATED"
  | "MIXED_PATH"
  | "NO_EDGE";

type ShadowCheckpointInput = {
  minuteOffset: number;
  roePercent?: number | null;
  mfeRoePercent?: number | null;
  maeRoePercent?: number | null;
  firstTakeProfitMinute?: number | null;
  firstStopLossMinute?: number | null;
};

export type NexusSentinelShadowEntryValidation = {
  version: typeof NEXUS_SENTINEL_SHADOW_ENTRY_VALIDATION_VERSION;
  status: NexusSentinelShadowEntryValidationStatus;
  triggerKind: string;
  positionSide: "LONG" | "SHORT";
  rejectionCode: string | null;
  observedHorizons: number[];
  missingHorizons: number[];
  latestObservedMinute: number | null;
  firstTakeProfitMinute: number | null;
  firstStopLossMinute: number | null;
  checkpointResults: Array<{
    minuteOffset: number;
    roePercent: number | null;
    mfeRoePercent: number | null;
    maeRoePercent: number | null;
  }>;
  summary: string;
  authority: "SHADOW_VALIDATION_ONLY";
  historicalLabelOnly: true;
  operatorReviewRequired: true;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
};

export type NexusSentinelShadowEntryValidationSummary = {
  version: typeof NEXUS_SENTINEL_SHADOW_ENTRY_VALIDATION_VERSION;
  sampleCount: number;
  finalizedSamples: number;
  collectingSamples: number;
  missedEntries: number;
  validatedFilters: number;
  mixedPaths: number;
  noEdgeSamples: number;
  groups: Array<{
    triggerKind: string;
    positionSide: "LONG" | "SHORT";
    rejectionCode: string;
    sampleCount: number;
    finalizedSamples: number;
    missedEntries: number;
    validatedFilters: number;
    mixedPaths: number;
    noEdgeSamples: number;
    missedEntryRate: number | null;
    validatedFilterRate: number | null;
    reviewReady: boolean;
    verdict:
      | "REVIEW_MISSED_ENTRY_GROUP"
      | "FILTER_VALIDATED"
      | "MIXED_OR_NO_EDGE"
      | "COLLECT_MORE";
  }>;
  horizonAverages: Array<{
    minuteOffset: number;
    sampleCount: number;
    averageRoePercent: number | null;
  }>;
  reviewSignal:
    | "REVIEW_MISSED_ENTRY_GROUP"
    | "FILTER_VALIDATED"
    | "MIXED_OR_NO_EDGE"
    | "COLLECT_MORE";
  reviewReady: boolean;
  summary: string;
  authority: "SHADOW_VALIDATION_ONLY";
  operatorConfirmationRequired: true;
  orderAffecting: false;
  liveConfigMutationAllowed: false;
};

/**
 * 对被拒绝候选做决策后的影子观察。它只回答“过滤是否保护了账户，
 * 或是否错过了波段”，不能授权订单，也不能自动改动生产参数。
 */
export function buildNexusSentinelShadowEntryValidation(input: {
  observationMode: "ACTUAL_POSITION" | "REJECTED_COUNTERFACTUAL";
  triggerKind?: string | null;
  positionSide?: "LONG" | "SHORT" | null;
  rejectionCode?: string | null;
  firstTakeProfitRoePercent: number;
  stopLossRoePercent: number;
  checkpoints: ShadowCheckpointInput[];
}): NexusSentinelShadowEntryValidation {
  const triggerKind = clean(input.triggerKind) || "UNKNOWN_TRIGGER";
  const positionSide = input.positionSide === "SHORT" ? "SHORT" : "LONG";
  const rejectionCode = clean(input.rejectionCode) || null;
  const checkpoints = normalizeCheckpoints(input.checkpoints);
  const checkpointResults = NEXUS_SENTINEL_SHADOW_ENTRY_HORIZONS.flatMap(
    (minuteOffset) => {
      const checkpoint = checkpoints.find(
        (item) => item.minuteOffset === minuteOffset,
      );
      return checkpoint ? [checkpoint] : [];
    },
  );
  const observedHorizons = checkpointResults.map((item) => item.minuteOffset);
  const missingHorizons = NEXUS_SENTINEL_SHADOW_ENTRY_HORIZONS.filter(
    (minuteOffset) => !observedHorizons.includes(minuteOffset),
  );
  const latestObservedMinute = checkpoints.at(-1)?.minuteOffset ?? null;
  const takeProfitRoe = Math.max(0, finiteOrZero(input.firstTakeProfitRoePercent));
  const stopLossRoe = Math.max(0, finiteOrZero(input.stopLossRoePercent));
  const firstTakeProfitMinute = takeProfitRoe > 0
    ? earliestMinute(checkpoints, "firstTakeProfitMinute") ??
      checkpoints.find(
        (item) =>
          finiteOr(item.mfeRoePercent, finiteOr(item.roePercent, 0)) >=
          takeProfitRoe,
      )?.minuteOffset ?? null
    : null;
  const firstStopLossMinute = stopLossRoe > 0
    ? earliestMinute(checkpoints, "firstStopLossMinute") ??
      checkpoints.find(
        (item) =>
          finiteOr(
            item.maeRoePercent,
            Math.min(0, finiteOr(item.roePercent, 0)),
          ) <= -stopLossRoe,
      )?.minuteOffset ?? null
    : null;

  let status: NexusSentinelShadowEntryValidationStatus;
  if (input.observationMode !== "REJECTED_COUNTERFACTUAL") {
    status = "NOT_APPLICABLE";
  } else if (
    firstTakeProfitMinute !== null &&
    firstStopLossMinute !== null &&
    firstTakeProfitMinute === firstStopLossMinute
  ) {
    status = "MIXED_PATH";
  } else if (
    firstTakeProfitMinute !== null &&
    (firstStopLossMinute === null ||
      firstTakeProfitMinute < firstStopLossMinute)
  ) {
    status = "MISSED_ENTRY";
  } else if (
    firstStopLossMinute !== null &&
    (firstTakeProfitMinute === null ||
      firstStopLossMinute < firstTakeProfitMinute)
  ) {
    status = "FILTER_VALIDATED";
  } else if (observedHorizons.includes(60)) {
    status = "NO_EDGE";
  } else {
    status = "COLLECTING";
  }

  return {
    version: NEXUS_SENTINEL_SHADOW_ENTRY_VALIDATION_VERSION,
    status,
    triggerKind,
    positionSide,
    rejectionCode,
    observedHorizons,
    missingHorizons,
    latestObservedMinute,
    firstTakeProfitMinute,
    firstStopLossMinute,
    checkpointResults,
    summary: shadowValidationSummary({
      status,
      rejectionCode,
      firstTakeProfitMinute,
      firstStopLossMinute,
      missingHorizons,
    }),
    authority: "SHADOW_VALIDATION_ONLY",
    historicalLabelOnly: true,
    operatorReviewRequired: true,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
  };
}

export function summarizeNexusSentinelShadowEntryValidations(input: {
  rows: Array<{
    validation?: NexusSentinelShadowEntryValidation | null;
  }>;
  minimumGroupSamples: number;
}): NexusSentinelShadowEntryValidationSummary {
  const validations = input.rows
    .map((row) => row.validation)
    .filter(
      (validation): validation is NexusSentinelShadowEntryValidation =>
        validation?.version ===
          NEXUS_SENTINEL_SHADOW_ENTRY_VALIDATION_VERSION &&
        validation.status !== "NOT_APPLICABLE",
    );
  const minimumGroupSamples = Math.max(
    1,
    Math.trunc(input.minimumGroupSamples),
  );
  const finalized = validations.filter((validation) =>
    !["COLLECTING", "NOT_APPLICABLE"].includes(validation.status)
  );
  const groupMap = new Map<string, typeof validations>();
  for (const validation of validations) {
    const rejectionCode = validation.rejectionCode ?? "UNKNOWN_REJECTION";
    const key = `${validation.triggerKind}:${validation.positionSide}:${rejectionCode}`;
    const group = groupMap.get(key) ?? [];
    group.push(validation);
    groupMap.set(key, group);
  }
  const groups = [...groupMap.values()].map((group) => {
    const first = group[0];
    const completed = group.filter((validation) =>
      validation.status !== "COLLECTING"
    );
    const missedEntries = countStatus(completed, "MISSED_ENTRY");
    const validatedFilters = countStatus(completed, "FILTER_VALIDATED");
    const mixedPaths = countStatus(completed, "MIXED_PATH");
    const noEdgeSamples = countStatus(completed, "NO_EDGE");
    const directional = missedEntries + validatedFilters;
    const reviewReady = completed.length >= minimumGroupSamples;
    const missedEntryRate = directional
      ? round(missedEntries / directional)
      : null;
    const validatedFilterRate = directional
      ? round(validatedFilters / directional)
      : null;
    const verdict = !reviewReady
      ? "COLLECT_MORE" as const
      : missedEntryRate !== null &&
          missedEntryRate >= 0.6 &&
          missedEntries >= validatedFilters * 1.5
        ? "REVIEW_MISSED_ENTRY_GROUP" as const
        : validatedFilterRate !== null &&
            validatedFilterRate >= 0.6 &&
            validatedFilters >= missedEntries * 1.5
          ? "FILTER_VALIDATED" as const
          : "MIXED_OR_NO_EDGE" as const;
    return {
      triggerKind: first.triggerKind,
      positionSide: first.positionSide,
      rejectionCode: first.rejectionCode ?? "UNKNOWN_REJECTION",
      sampleCount: group.length,
      finalizedSamples: completed.length,
      missedEntries,
      validatedFilters,
      mixedPaths,
      noEdgeSamples,
      missedEntryRate,
      validatedFilterRate,
      reviewReady,
      verdict,
    };
  }).sort((left, right) =>
    Number(right.reviewReady) - Number(left.reviewReady) ||
    right.finalizedSamples - left.finalizedSamples
  );
  const reviewGroup = groups.find(
    (group) => group.verdict === "REVIEW_MISSED_ENTRY_GROUP",
  );
  const validatedGroup = groups.find(
    (group) => group.verdict === "FILTER_VALIDATED",
  );
  const reviewSignal = reviewGroup
    ? "REVIEW_MISSED_ENTRY_GROUP" as const
    : validatedGroup
      ? "FILTER_VALIDATED" as const
      : groups.some((group) => group.reviewReady)
        ? "MIXED_OR_NO_EDGE" as const
        : "COLLECT_MORE" as const;
  const horizonAverages = NEXUS_SENTINEL_SHADOW_ENTRY_HORIZONS.map(
    (minuteOffset) => {
      const values = validations.flatMap((validation) => {
        const checkpoint = validation.checkpointResults.find(
          (item) => item.minuteOffset === minuteOffset,
        );
        return checkpoint?.roePercent === null ||
            checkpoint?.roePercent === undefined
          ? []
          : [checkpoint.roePercent];
      });
      return {
        minuteOffset,
        sampleCount: values.length,
        averageRoePercent: values.length ? round(average(values)) : null,
      };
    },
  );
  return {
    version: NEXUS_SENTINEL_SHADOW_ENTRY_VALIDATION_VERSION,
    sampleCount: validations.length,
    finalizedSamples: finalized.length,
    collectingSamples: countStatus(validations, "COLLECTING"),
    missedEntries: countStatus(finalized, "MISSED_ENTRY"),
    validatedFilters: countStatus(finalized, "FILTER_VALIDATED"),
    mixedPaths: countStatus(finalized, "MIXED_PATH"),
    noEdgeSamples: countStatus(finalized, "NO_EDGE"),
    groups,
    horizonAverages,
    reviewSignal,
    reviewReady: reviewSignal !== "COLLECT_MORE",
    summary: aggregateSummary({
      sampleCount: validations.length,
      finalizedSamples: finalized.length,
      reviewSignal,
      reviewGroup,
      validatedGroup,
      minimumGroupSamples,
    }),
    authority: "SHADOW_VALIDATION_ONLY",
    operatorConfirmationRequired: true,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
  };
}

function normalizeCheckpoints(checkpoints: ShadowCheckpointInput[]) {
  return checkpoints
    .map((checkpoint) => ({
      minuteOffset: Math.max(0, Math.trunc(Number(checkpoint.minuteOffset))),
      roePercent: finiteOrNull(checkpoint.roePercent),
      mfeRoePercent: finiteOrNull(checkpoint.mfeRoePercent),
      maeRoePercent: finiteOrNull(checkpoint.maeRoePercent),
      firstTakeProfitMinute: positiveMinuteOrNull(
        checkpoint.firstTakeProfitMinute,
      ),
      firstStopLossMinute: positiveMinuteOrNull(
        checkpoint.firstStopLossMinute,
      ),
    }))
    .filter(
      (checkpoint) => checkpoint.minuteOffset > 0 && checkpoint.minuteOffset <= 60,
    )
    .sort((left, right) => left.minuteOffset - right.minuteOffset);
}

function earliestMinute(
  checkpoints: ReturnType<typeof normalizeCheckpoints>,
  key: "firstTakeProfitMinute" | "firstStopLossMinute",
) {
  const values = checkpoints.flatMap((checkpoint) =>
    checkpoint[key] === null ? [] : [checkpoint[key]],
  );
  return values.length ? Math.min(...values) : null;
}

function positiveMinuteOrNull(value: unknown) {
  const minute = Number(value);
  return Number.isInteger(minute) && minute > 0 && minute <= 60
    ? minute
    : null;
}

function shadowValidationSummary(input: {
  status: NexusSentinelShadowEntryValidationStatus;
  rejectionCode: string | null;
  firstTakeProfitMinute: number | null;
  firstStopLossMinute: number | null;
  missingHorizons: readonly number[];
}) {
  const rejection = input.rejectionCode ?? "当前过滤条件";
  if (input.status === "NOT_APPLICABLE")
    return "实际成交由完整持仓生命周期复盘，哨兵影子层不重复归因。";
  if (input.status === "MISSED_ENTRY")
    return `${rejection} 后第 ${input.firstTakeProfitMinute} 分钟先达到首档止盈，记为潜在错失；仅进入同组统计，不能据此自动放宽条件。`;
  if (input.status === "FILTER_VALIDATED")
    return `${rejection} 后第 ${input.firstStopLossMinute} 分钟先触及止损，当前过滤避免了一次弱势入场。`;
  if (input.status === "MIXED_PATH")
    return `${rejection} 后止盈与止损在同一分钟首次触及，分钟级路径无法确定先后，只记录为混合样本。`;
  if (input.status === "NO_EDGE")
    return `${rejection} 后已观察至 60 分钟，既未先触发止盈也未先触发止损，本次没有可验证入场优势。`;
  return `${rejection} 后影子路径仍在采样，待补 ${input.missingHorizons.join("/") || "后续"} 分钟检查点。`;
}

function aggregateSummary(input: {
  sampleCount: number;
  finalizedSamples: number;
  reviewSignal: NexusSentinelShadowEntryValidationSummary["reviewSignal"];
  reviewGroup?: NexusSentinelShadowEntryValidationSummary["groups"][number];
  validatedGroup?: NexusSentinelShadowEntryValidationSummary["groups"][number];
  minimumGroupSamples: number;
}) {
  if (input.reviewSignal === "REVIEW_MISSED_ENTRY_GROUP" && input.reviewGroup)
    return `${input.reviewGroup.triggerKind}/${input.reviewGroup.rejectionCode} 已有 ${input.reviewGroup.finalizedSamples} 个同组终态影子样本，潜在错失率 ${percent(input.reviewGroup.missedEntryRate)}；只建议运营复核该过滤条件，不自动调参。`;
  if (input.reviewSignal === "FILTER_VALIDATED" && input.validatedGroup)
    return `${input.validatedGroup.triggerKind}/${input.validatedGroup.rejectionCode} 已有 ${input.validatedGroup.finalizedSamples} 个同组终态影子样本，过滤有效率 ${percent(input.validatedGroup.validatedFilterRate)}，当前条件得到影子路径支持。`;
  if (input.reviewSignal === "MIXED_OR_NO_EDGE")
    return `已有 ${input.finalizedSamples}/${input.sampleCount} 个终态影子样本，但同组结果仍混合或无明显优势，继续保持现有入场纪律。`;
  return `已有 ${input.finalizedSamples}/${input.sampleCount} 个终态影子样本；同一触发器和拒绝原因至少需要 ${input.minimumGroupSamples} 个样本才进入人工复核。`;
}

function countStatus(
  rows: NexusSentinelShadowEntryValidation[],
  status: NexusSentinelShadowEntryValidationStatus,
) {
  return rows.filter((row) => row.status === status).length;
}

function finiteOrNull(value: unknown) {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
}

function finiteOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteOrZero(value: unknown) {
  return finiteOr(value, 0);
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}
