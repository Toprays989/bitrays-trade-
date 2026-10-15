export const FILLED_POSITION_HANDOFF_CONTRACT_VERSION =
  "filled-position-handoff-v1" as const;

export type FilledPositionHandoffOrigin =
  | "STRATEGY"
  | "MANUAL"
  | "LEGACY_ADOPTED";

type JsonRecord = Record<string, unknown>;

export type FilledPositionHandoff = Readonly<{
  contractVersion: typeof FILLED_POSITION_HANDOFF_CONTRACT_VERSION;
  handoffKey: string;
  origin: FilledPositionHandoffOrigin;
  sourceEventId: number;
  lifecycleId: string | null;
  identities: {
    strategyId: number | null;
    configVersion: number | null;
    executionIntentId: string | null;
  };
  fill: {
    symbol: string;
    positionSide: "LONG" | "SHORT";
    quantity: number;
    entryPrice: number;
    leverage: number;
    filledAtMs: number;
  };
  entryDecision: JsonRecord | null;
  ownership: {
    entryAuthorityReleased: true;
    positionAuthority: "UNIFIED_POSITION_LIFECYCLE";
    allowedIntentPurposes: readonly ["REDUCE_POSITION", "CLOSE_POSITION"];
  };
}>;

export function buildFilledPositionHandoff(input: {
  origin: FilledPositionHandoffOrigin;
  sourceEventId: number;
  lifecycleId?: string | null;
  entryDecisionHandoffJson?: string | null;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  leverage: number;
  filledAt: Date | number;
}): FilledPositionHandoff {
  const sourceEventId = positiveInteger(input.sourceEventId, "来源订单编号");
  const lifecycleId = optionalString(input.lifecycleId);
  const entryDecision = parseRecord(input.entryDecisionHandoffJson);
  const entryLifecycleId = optionalString(entryDecision?.lifecycleId);
  const entrySide = optionalString(entryDecision?.positionSide);

  if (input.origin === "STRATEGY") {
    if (!lifecycleId || !entryDecision)
      throw new Error("策略成交交接缺少冻结入场决策");
    if (entryLifecycleId !== lifecycleId)
      throw new Error("策略成交交接与入场决策生命周期不一致");
    if (entrySide !== input.positionSide)
      throw new Error("策略成交交接与入场决策方向不一致");
    const executionIntentId = optionalString(
      record(entryDecision.identities).executionIntentId,
    );
    if (!executionIntentId)
      throw new Error("策略成交交接缺少最终执行意图");
  }

  const filledAtMs = input.filledAt instanceof Date
    ? input.filledAt.getTime()
    : Number(input.filledAt);
  if (!Number.isFinite(filledAtMs) || filledAtMs <= 0)
    throw new Error("成交交接时间无效");

  const identities = record(entryDecision?.identities);
  return {
    contractVersion: FILLED_POSITION_HANDOFF_CONTRACT_VERSION,
    handoffKey: `nqph:${sourceEventId}`,
    origin: input.origin,
    sourceEventId,
    lifecycleId,
    identities: {
      strategyId: positiveIntegerOrNull(entryDecision?.strategyId),
      configVersion: positiveIntegerOrNull(entryDecision?.configVersion),
      executionIntentId: optionalString(identities.executionIntentId),
    },
    fill: {
      symbol: normalizedSymbol(input.symbol),
      positionSide: input.positionSide,
      quantity: positive(input.quantity, "成交数量"),
      entryPrice: positive(input.entryPrice, "成交均价"),
      leverage: positiveInteger(input.leverage, "成交杠杆"),
      filledAtMs,
    },
    entryDecision,
    ownership: {
      entryAuthorityReleased: true,
      positionAuthority: "UNIFIED_POSITION_LIFECYCLE",
      allowedIntentPurposes: ["REDUCE_POSITION", "CLOSE_POSITION"],
    },
  };
}

export function parseFilledPositionHandoff(
  value: string | null | undefined,
): FilledPositionHandoff | null {
  const parsed = parseRecord(value);
  if (
    !parsed ||
    parsed.contractVersion !== FILLED_POSITION_HANDOFF_CONTRACT_VERSION
  ) return null;
  const fill = record(parsed.fill);
  const ownership = record(parsed.ownership);
  if (
    !optionalString(parsed.handoffKey) ||
    !positiveIntegerOrNull(parsed.sourceEventId) ||
    !optionalString(fill.symbol) ||
    !["LONG", "SHORT"].includes(String(fill.positionSide)) ||
    !positiveNumberOrNull(fill.quantity) ||
    !positiveNumberOrNull(fill.entryPrice) ||
    !positiveIntegerOrNull(fill.leverage) ||
    !positiveNumberOrNull(fill.filledAtMs) ||
    ownership.entryAuthorityReleased !== true ||
    ownership.positionAuthority !== "UNIFIED_POSITION_LIFECYCLE"
  ) return null;
  return parsed as FilledPositionHandoff;
}

function parseRecord(value: string | null | undefined) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return Object.keys(parsed).length > 0 ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function positive(value: unknown, label: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0)
    throw new Error(`${label}必须大于0`);
  return numeric;
}

function positiveInteger(value: unknown, label: string) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0)
    throw new Error(`${label}必须是正整数`);
  return numeric;
}

function positiveIntegerOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function positiveNumberOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizedSymbol(value: unknown) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,26}USDT$/.test(symbol))
    throw new Error("成交交接合约代码无效");
  return symbol;
}
