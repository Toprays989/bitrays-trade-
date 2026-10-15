export const POSITION_HOLDING_MANDATE_VERSION =
  "position-holding-mandate-v1" as const;

export type PositionHoldingHorizon =
  | "SCALP"
  | "INTRADAY"
  | "SWING"
  | "UNSPECIFIED";

export type PositionHoldingMandate = {
  schemaVersion: typeof POSITION_HOLDING_MANDATE_VERSION;
  source:
    | "OPERATOR_EXPLICIT"
    | "STRATEGY_TRIGGER"
    | "LEGACY_INFERRED"
    | "MANUAL_UNSPECIFIED";
  frozenAtMs: number | null;
  positionSide: "LONG" | "SHORT";
  triggerKind: string | null;
  baseHorizon: PositionHoldingHorizon;
  dominantTimeframe: "3m" | "30m" | "1h" | null;
  invalidationTimeframe: "3m" | "30m" | "1h" | null;
  maximumObservationMinutes: number | null;
  swingUpgradePolicy: "PROFIT_AND_MULTI_HOUR_CONFIRMATION" | "DISABLED";
  lossExtensionAllowed: false;
  entryMultiHourRegime: string | null;
  reason: string;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function explicitHorizon(value: unknown): PositionHoldingHorizon | null {
  return ["SCALP", "INTRADAY", "SWING"].includes(String(value))
    ? value as PositionHoldingHorizon
    : null;
}

function triggerKindFromEvidence(entryEvidence: JsonRecord) {
  return nonEmptyString(record(entryEvidence.triggerIdentity).triggerKind) ??
    nonEmptyString(record(entryEvidence.trigger).kind);
}

function mandateShape(input: {
  source: PositionHoldingMandate["source"];
  frozenAtMs: number | null;
  positionSide: "LONG" | "SHORT";
  triggerKind: string | null;
  baseHorizon: PositionHoldingHorizon;
  entryMultiHourRegime: string | null;
  reason: string;
}): PositionHoldingMandate {
  const cadence = {
    SCALP: {
      dominantTimeframe: "3m" as const,
      invalidationTimeframe: "3m" as const,
      maximumObservationMinutes: 3,
      swingUpgradePolicy: "DISABLED" as const,
    },
    INTRADAY: {
      dominantTimeframe: "30m" as const,
      invalidationTimeframe: "30m" as const,
      maximumObservationMinutes: 240,
      swingUpgradePolicy: "PROFIT_AND_MULTI_HOUR_CONFIRMATION" as const,
    },
    SWING: {
      dominantTimeframe: "1h" as const,
      invalidationTimeframe: "1h" as const,
      maximumObservationMinutes: null,
      swingUpgradePolicy: "DISABLED" as const,
    },
    UNSPECIFIED: {
      dominantTimeframe: null,
      invalidationTimeframe: null,
      maximumObservationMinutes: null,
      swingUpgradePolicy: "DISABLED" as const,
    },
  }[input.baseHorizon];
  return {
    schemaVersion: POSITION_HOLDING_MANDATE_VERSION,
    ...input,
    ...cadence,
    lossExtensionAllowed: false,
  };
}

/**
 * Freeze the intended holding horizon at entry. Current PnL is deliberately
 * absent from this function: a losing short-term trade can never rewrite
 * itself into a long-term investment after the fill.
 */
export function buildEntryPositionHoldingMandate(input: {
  entryEvidence?: unknown;
  positionSide: "LONG" | "SHORT";
  frozenAtMs?: number | null;
  origin?: "MANUAL" | "SEMI_AUTO" | "STRATEGY";
}) {
  const entryEvidence = record(input.entryEvidence);
  const opportunityContext = record(entryEvidence.opportunityContext);
  const entryMultiHourContext = record(
    entryEvidence.nexusOwnMultiHourContext,
  );
  const triggerKind = triggerKindFromEvidence(entryEvidence);
  const selectedHorizon = explicitHorizon(opportunityContext.horizon);
  const origin = input.origin ?? "STRATEGY";
  const frozenAtMs = Number.isFinite(input.frozenAtMs)
    ? Number(input.frozenAtMs)
    : null;
  const entryMultiHourRegime = nonEmptyString(
    entryMultiHourContext.decisionRegime,
  );

  if (selectedHorizon)
    return mandateShape({
      source: "OPERATOR_EXPLICIT",
      frozenAtMs,
      positionSide: input.positionSide,
      triggerKind,
      baseHorizon: selectedHorizon,
      entryMultiHourRegime,
      reason: `入场时已明确选择 ${selectedHorizon} 持仓周期；该周期在仓位生命周期内不可被当前盈亏改写。`,
    });

  if (triggerKind === "THREE_MINUTE_PROBABILITY")
    return mandateShape({
      source: "STRATEGY_TRIGGER",
      frozenAtMs,
      positionSide: input.positionSide,
      triggerKind,
      baseHorizon: "SCALP",
      entryMultiHourRegime,
      reason: "3分钟概率轮次固定为短线周期，到期规则优先且禁止升级为波段持仓。",
    });

  if (origin === "MANUAL")
    return mandateShape({
      source: "MANUAL_UNSPECIFIED",
      frozenAtMs,
      positionSide: input.positionSide,
      triggerKind,
      baseHorizon: "UNSPECIFIED",
      entryMultiHourRegime,
      reason: "人工仓位没有冻结持仓周期，保持兼容并只记录多周期观察。",
    });

  return mandateShape({
    source: "STRATEGY_TRIGGER",
    frozenAtMs,
    positionSide: input.positionSide,
    triggerKind,
    baseHorizon: "INTRADAY",
    entryMultiHourRegime,
    reason: "策略仓默认冻结为日内周期；只有已盈利且多小时趋势持续同向时才可获得波段延展。",
  });
}

export function resolvePositionHoldingMandate(input: {
  storedMandate?: unknown;
  entryEvidence?: unknown;
  positionSide: "LONG" | "SHORT";
  origin?: "MANUAL" | "SEMI_AUTO" | "STRATEGY";
  openedAtMs?: number | null;
}): PositionHoldingMandate {
  const stored = record(input.storedMandate);
  if (
    stored.schemaVersion === POSITION_HOLDING_MANDATE_VERSION &&
    ["SCALP", "INTRADAY", "SWING", "UNSPECIFIED"].includes(
      String(stored.baseHorizon),
    ) &&
    stored.positionSide === input.positionSide
  ) return stored as PositionHoldingMandate;

  const inferred = buildEntryPositionHoldingMandate({
    entryEvidence: input.entryEvidence,
    positionSide: input.positionSide,
    frozenAtMs: input.openedAtMs,
    origin: input.origin,
  });
  if (inferred.source === "MANUAL_UNSPECIFIED") return inferred;
  return {
    ...inferred,
    source: "LEGACY_INFERRED",
    reason:
      `旧仓缺少冻结周期，已仅依据原始入场证据推断为 ${inferred.baseHorizon}；` +
      "当前盈亏未参与推断，后续不得自动改写基础周期。",
  };
}
