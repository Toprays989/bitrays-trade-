export type PositionProtectionState =
  | "ACTIVE"
  | "POST_ADD_REVALIDATION"
  | "ERROR";

export type ProtectionMetadata = {
  version: number;
  basisPositionVersion: number;
  state: PositionProtectionState;
  source:
    | "ENTRY"
    | "MANUAL_UPDATE"
    | "MANUAL_ADD_ON"
    | "AUTO_ADD_ON"
    | "MANUAL_REDUCTION"
    | "AUTO_REDUCTION"
    | "RECONCILIATION";
  createdAtMs: number;
  revalidateAfterMs?: number;
  deferredStopLosses?: unknown[];
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asPositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedStopModePlan(plan: JsonRecord) {
  return plan.dynamicProfitProtectionEnabled === true
    ? { ...plan, stopLosses: [] }
    : plan;
}

export function readProtectionMetadata(
  plan: unknown,
  fallback: {
    positionVersion: number;
    protectionVersion: number;
  },
): ProtectionMetadata {
  const metadata = asRecord(asRecord(plan).protection);
  const state = ["ACTIVE", "POST_ADD_REVALIDATION", "ERROR"].includes(
    String(metadata.state),
  )
    ? String(metadata.state) as PositionProtectionState
    : "ACTIVE";
  const source = [
    "ENTRY",
    "MANUAL_UPDATE",
    "MANUAL_ADD_ON",
    "AUTO_ADD_ON",
    "MANUAL_REDUCTION",
    "AUTO_REDUCTION",
    "RECONCILIATION",
  ].includes(String(metadata.source))
    ? String(metadata.source) as ProtectionMetadata["source"]
    : "ENTRY";
  return {
    version: asPositiveInteger(
      metadata.version,
      fallback.protectionVersion,
    ),
    basisPositionVersion: asPositiveInteger(
      metadata.basisPositionVersion,
      fallback.positionVersion,
    ),
    state,
    source,
    createdAtMs: Number.isFinite(Number(metadata.createdAtMs))
      ? Number(metadata.createdAtMs)
      : 0,
    revalidateAfterMs: Number.isFinite(Number(metadata.revalidateAfterMs))
      ? Number(metadata.revalidateAfterMs)
      : undefined,
    deferredStopLosses: Array.isArray(metadata.deferredStopLosses)
      ? metadata.deferredStopLosses
      : undefined,
  };
}

export function protectionMatchesPosition(input: {
  plan: unknown;
  positionVersion: number;
  protectionVersion: number;
}) {
  const metadata = readProtectionMetadata(input.plan, input);
  return metadata.version === input.protectionVersion &&
    metadata.basisPositionVersion === input.positionVersion;
}

export function rebuildProtectionAfterAddition(input: {
  plan: JsonRecord;
  rebalancedTakeProfits: unknown[];
  rebalancedStopLosses?: unknown[];
  nextPositionVersion: number;
  nextProtectionVersion: number;
  nowMs: number;
  source: "MANUAL_ADD_ON" | "AUTO_ADD_ON" | "RECONCILIATION";
}) {
  const plan = normalizedStopModePlan(input.plan);
  return {
    ...plan,
    takeProfits: input.rebalancedTakeProfits,
    // After an add-on the exchange entry price, quantity and liquidation price
    // form a new position basis. Both exit grids are rebuilt against that basis
    // before this ACTIVE version is published; inherited quantities never stay
    // attached to the previous position size.
    stopLosses: plan.dynamicProfitProtectionEnabled === true
      ? []
      : input.rebalancedStopLosses ??
        (Array.isArray(plan.stopLosses) ? plan.stopLosses : []),
    protection: {
      version: input.nextProtectionVersion,
      basisPositionVersion: input.nextPositionVersion,
      state: "ACTIVE",
      source: input.source,
      createdAtMs: input.nowMs,
    } satisfies ProtectionMetadata,
  };
}

export function effectiveSoftProtection(input: {
  plan: JsonRecord;
  positionVersion: number;
  protectionVersion: number;
}) {
  const metadata = readProtectionMetadata(input.plan, input);
  if (
    metadata.version !== input.protectionVersion ||
    metadata.basisPositionVersion !== input.positionVersion
  ) {
    return {
      executable: false,
      reason: "STALE_PROTECTION_VERSION" as const,
      metadata,
    };
  }
  if (metadata.state !== "ACTIVE") {
    return {
      executable: false,
      reason: "PROTECTION_REVALIDATION_REQUIRED" as const,
      metadata,
    };
  }
  return {
    executable: true,
    reason: "ACTIVE" as const,
    metadata,
  };
}

export function activateProtectionPlan(input: {
  plan: JsonRecord;
  positionVersion?: number;
  protectionVersion?: number;
  nowMs?: number;
  source?: ProtectionMetadata["source"];
  state?: PositionProtectionState;
}) {
  const positionVersion = asPositiveInteger(input.positionVersion, 1);
  const protectionVersion = asPositiveInteger(input.protectionVersion, 1);
  const plan = normalizedStopModePlan(input.plan);
  return {
    ...plan,
    protection: {
      version: protectionVersion,
      basisPositionVersion: positionVersion,
      state: input.state ?? "ACTIVE",
      source: input.source ?? "ENTRY",
      createdAtMs: Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now(),
    } satisfies ProtectionMetadata,
  };
}

export function buildInstrumentId(input: {
  exchange?: string;
  environment?: string;
  market?: string;
  contractType?: string;
  symbol: string;
  listingGeneration?: string | number | null;
}) {
  const normalizeNamespace = (value: unknown, fallback: string) =>
    String(value ?? fallback).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  // Binance contract symbols are the venue identity. Some production USDT-M
  // contracts contain Unicode letters, so stripping everything outside ASCII
  // collapses different contracts (for example Chinese symbols) onto the same
  // `USDT` suffix. Preserve Unicode letters and numbers while removing only
  // separators that cannot be part of the stable identifier.
  const normalizeSymbol = (value: unknown) =>
    String(value ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^\p{L}\p{N}_-]/gu, "");
  const exchange = normalizeNamespace(input.exchange, "BINANCE");
  const environment = normalizeNamespace(input.environment, "LIVE");
  const market = normalizeNamespace(input.market, "USDT_M");
  const contractType = normalizeNamespace(input.contractType, "PERPETUAL");
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) throw new Error("instrument symbol is required");
  const generation = normalizeNamespace(input.listingGeneration, "CURRENT");
  return [exchange, environment, market, contractType, symbol, generation].join(":");
}
