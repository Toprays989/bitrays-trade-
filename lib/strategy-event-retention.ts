export const STRATEGY_EVENT_ARCHIVE_VERSION = 3;
export const STRATEGY_EVENT_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const STRATEGY_EVENT_DELETE_CONFIRMATION =
  "SAFE_NO_ORDER_TERMINALS_ONLY" as const;

const KEY_EYE_FIELDS = [
  "symbol",
  "brainDecisionDirection",
  "tradeDirection",
  "positionSide",
  "decisionEngineVersion",
  "triggerScope",
  "triggerSource",
  "marketTriggerMode",
  "marketClusterId",
  "marketClusterNotional",
  "marketClusterEventCount",
  "marketClusterSpanMs",
  "symbolLiquidationNotional",
  "symbolEventCount",
  "symbolLiquidationSharePercent",
  "signalMarkPrice",
  "signalMarkTime",
  "signalLiquidationPrice",
  "nexusTriggerFact",
  "nexusMarketEyeDecision",
  "nexusDecisionSnapshot",
  "nexusOpportunity",
  "nexusPureStateMachine",
  "nexusTrendBreakoutStateMachine",
  "nexusVolumeTiming",
  "nexusFundingContext",
  "liquidationFactorSnapshot",
  "liquidationFactorDecision",
  "nexusOwnEntryRegime5m",
  "nexusOwnMultiHourContext",
  "nexusBtcMacroRegime6h",
  "nexusBtcRelationship",
  "preTrigger3mReference",
  "frozenExecutionDecision",
  "executionAuthorization",
  "executionApprovedMarkPrice",
] as const;

const IMPORTANT_EVENT_TYPE = /(?:SIGNAL_RECEIVED|NEXUS_MARKET_EYE:CONFIRMED|REJECT|EXPIRED|CANCELED|ERROR|UNKNOWN|ORDER|EXECUTION_CAPACITY|DAILY_LOSS_LIMIT|POSITION_OPEN|POSITION_CLOSED|STOP_LOSS|TAKE_PROFIT|TRAILING_STOP|TIME_EXIT)/;
const UNSAFE_RESULT_CODE = /(?:ERROR|UNKNOWN|RECONCIL|MISMATCH)/;

type JsonRecord = Record<string, unknown>;

export type EyeFactSnapshot = {
  factId: string;
  symbol: string;
  kind: string;
  interval: string | null;
  source: string;
  eventAtMs: number;
  receivedAtMs: number;
  expiresAtMs: number;
  factJson: string;
};

export type RetentionEvent = {
  eventType: string;
  stage: string;
  outcome: string;
  message: string;
  detailJson: string;
  eventAtMs: number;
};

export type StrategyEventRetentionMode = "PREVIEW" | "DELETE";

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function finiteTimestamp(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function extractNexusEyeFactSnapshots(
  entryEvidence: unknown,
): { facts: EyeFactSnapshot[]; factIds: string[] } {
  const evidence = record(entryEvidence);
  const values = Array.isArray(evidence.nexusMarketFactsShadow)
    ? evidence.nexusMarketFactsShadow
    : [];
  const facts: EyeFactSnapshot[] = [];
  const factIds: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") {
      const factId = value.trim();
      if (factId && !seen.has(factId)) {
        seen.add(factId);
        factIds.push(factId);
      }
      continue;
    }
    const fact = record(value);
    const factId = typeof fact.id === "string" ? fact.id.trim() : "";
    const symbol = typeof fact.symbol === "string" ? fact.symbol.trim() : "";
    const kind = typeof fact.kind === "string" ? fact.kind.trim() : "";
    const source = typeof fact.source === "string" ? fact.source.trim() : "";
    const eventAtMs = finiteTimestamp(fact.eventAt);
    const receivedAtMs = finiteTimestamp(fact.receivedAt);
    const expiresAtMs = finiteTimestamp(fact.expiresAt);
    if (
      !factId || !symbol || !kind || !source || eventAtMs === null ||
      receivedAtMs === null || expiresAtMs === null
    ) continue;
    if (!seen.has(factId)) {
      seen.add(factId);
      factIds.push(factId);
      facts.push({
        factId,
        symbol,
        kind,
        interval: typeof fact.interval === "string" ? fact.interval : null,
        source,
        eventAtMs,
        receivedAtMs,
        expiresAtMs,
        factJson: JSON.stringify(fact),
      });
    }
  }
  return { facts, factIds };
}

export function compactNexusEyeDecision(entryEvidence: unknown) {
  const evidence = record(entryEvidence);
  const compact: JsonRecord = {};
  for (const field of KEY_EYE_FIELDS) {
    if (evidence[field] !== undefined) compact[field] = evidence[field];
  }
  return compact;
}

export function keyStrategyRetentionEvents(
  events: RetentionEvent[],
  limit = 32,
) {
  const selected = events.filter((event) =>
    event.outcome === "ERROR" || IMPORTANT_EVENT_TYPE.test(event.eventType)
  );
  const terminal = events.at(-1);
  if (terminal && !selected.includes(terminal)) selected.push(terminal);
  return selected.slice(-Math.max(1, Math.trunc(limit))).map((event) => ({
    eventType: event.eventType,
    stage: event.stage,
    outcome: event.outcome,
    message: event.message,
    eventAtMs: event.eventAtMs,
  }));
}

export function strategyTerminalArchiveSourceMaterial(input: {
  traceId: string;
  traceDatabaseId: number;
  strategyId: number;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  symbol: string;
  triggerKind: string;
  triggerVersion: string;
  triggerFactSnapshotId: string | null;
  terminalState: string;
  resultCode: string | null;
  completedAtMs: number;
  hadOrder: boolean;
  hadPosition: boolean;
  learningStatus: string;
  entryEvidenceJson: string;
  events: Array<{
    sequence: number;
    eventType: string;
    outcome: string;
    eventAtMs: number;
    detailJson: string;
  }>;
}) {
  return JSON.stringify({
    archiveVersion: STRATEGY_EVENT_ARCHIVE_VERSION,
    identity: {
      traceId: input.traceId,
      traceDatabaseId: input.traceDatabaseId,
      strategyId: input.strategyId,
      configVersion: input.configVersion,
      ownerEmail: input.ownerEmail,
      accountId: input.accountId,
      symbol: input.symbol,
      triggerKind: input.triggerKind,
      triggerVersion: input.triggerVersion,
      triggerFactSnapshotId: input.triggerFactSnapshotId,
    },
    terminal: {
      state: input.terminalState,
      resultCode: input.resultCode,
      completedAtMs: input.completedAtMs,
      hadOrder: input.hadOrder,
      hadPosition: input.hadPosition,
      learningStatus: input.learningStatus,
    },
    entryEvidenceJson: input.entryEvidenceJson,
    events: input.events,
  });
}

export function buildStrategyTerminalArchive(input: {
  identity: {
    traceId: string;
    traceDatabaseId: number;
    strategyId: number;
    configVersion: number;
    ownerEmail: string;
    accountId: string;
    symbol: string;
    triggerKind: string;
    triggerVersion: string;
    triggerFactSnapshotId: string | null;
  };
  configSnapshotJson: string;
  entryEvidence: unknown;
  terminal: {
    state: string;
    resultCode: string | null;
    resultMessage: string | null;
    eventTimeMs: number;
    completedAtMs: number;
    hadOrder: boolean;
    hadPosition: boolean;
  };
  position?: {
    id: number;
    positionSide: string;
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    leverage: number;
    openedAtMs: number;
    closedAtMs: number | null;
    exitReason: string | null;
    realizedPnl: number;
  } | null;
  reductions: Array<{
    quantity: number;
    exitPrice: number;
    reason: string;
    realizedPnl: number;
    createdAtMs: number;
    settlement: unknown;
  }>;
  mfeRoePercent: number | null;
  maeRoePercent: number | null;
  learning: {
    learningKey: string | null;
    terminalStatus: string | null;
    eligibility: string | null;
    exactNetAvailable: boolean;
    exactNetPnlUsdt: number | null;
    blockedReasons: unknown;
    detail: unknown;
  } | null;
  keyEvents: Array<{
    eventType: string;
    stage: string;
    outcome: string;
    message: string;
    eventAtMs: number;
  }>;
  sourceChecksum: string;
}) {
  const position = input.position ?? null;
  return {
    archiveVersion: STRATEGY_EVENT_ARCHIVE_VERSION,
    immutable: true,
    identity: input.identity,
    configuration: record(parseJson(input.configSnapshotJson)),
    entry: compactNexusEyeDecision(input.entryEvidence),
    position: position
      ? {
          ...position,
          holdingDurationMs: position.closedAtMs === null
            ? null
            : Math.max(0, position.closedAtMs - position.openedAtMs),
          mfeRoePercent: input.mfeRoePercent,
          maeRoePercent: input.maeRoePercent,
        }
      : null,
    reductions: input.reductions,
    terminal: input.terminal,
    learning: input.learning,
    keyEvents: input.keyEvents,
    sourceIntegrity: {
      algorithm: "SHA-256",
      checksum: input.sourceChecksum,
    },
  };
}

export function resolveStrategyEventRetentionMode(input: {
  mode?: string | null;
  cleanupEnabled?: string | null;
  deleteConfirmation?: string | null;
}) {
  const requestedMode: StrategyEventRetentionMode =
    input.mode === "DELETE" ? "DELETE" : "PREVIEW";
  const deleteEnabled =
    requestedMode === "DELETE" &&
    input.cleanupEnabled === "true" &&
    input.deleteConfirmation === STRATEGY_EVENT_DELETE_CONFIRMATION;
  return {
    requestedMode,
    effectiveMode: deleteEnabled ? "DELETE" : "PREVIEW" as StrategyEventRetentionMode,
    deleteEnabled,
    reason: deleteEnabled
      ? "EXPLICIT_THREE_FACTOR_DELETE_AUTHORIZATION"
      : requestedMode === "DELETE"
        ? "DELETE_AUTHORIZATION_INCOMPLETE"
        : "PREVIEW_ONLY",
  };
}

export function strategyEventLearningStatus(input: {
  terminalState: string;
  learningCycle?: { terminalStatus: string; eligibility: string } | null;
}) {
  if (input.terminalState !== "REJECTED") return "NOT_REQUIRED" as const;
  if (!input.learningCycle) return "MISSING" as const;
  if (
    input.learningCycle.terminalStatus !== "REJECTED" ||
    input.learningCycle.eligibility === "INCOMPLETE"
  ) return "INCOMPLETE" as const;
  return "FINALIZED" as const;
}

export function strategyEventDeletionDecision(input: {
  terminalState: string;
  resultCode: string | null;
  completedAtMs: number;
  nowMs: number;
  hadOrder: boolean;
  hadPosition: boolean;
  learningStatus: "NOT_REQUIRED" | "MISSING" | "INCOMPLETE" | "FINALIZED";
  cleanupEnabled: boolean;
}) {
  if (!input.cleanupEnabled) return { eligible: false, reason: "CLEANUP_DISABLED" };
  return strategyEventRetentionEligibility(input);
}

export function strategyEventRetentionEligibility(input: {
  terminalState: string;
  resultCode: string | null;
  completedAtMs: number;
  nowMs: number;
  hadOrder: boolean;
  hadPosition: boolean;
  learningStatus: "NOT_REQUIRED" | "MISSING" | "INCOMPLETE" | "FINALIZED";
}) {
  if (input.hadOrder || input.hadPosition)
    return { eligible: false, reason: "REAL_LIFECYCLE" };
  if (!Number.isFinite(input.completedAtMs) || input.completedAtMs <= 0)
    return { eligible: false, reason: "TERMINAL_TIME_MISSING" };
  if (input.nowMs - input.completedAtMs < STRATEGY_EVENT_DETAIL_RETENTION_MS)
    return { eligible: false, reason: "DETAIL_RETENTION_WINDOW" };
  if (UNSAFE_RESULT_CODE.test(input.resultCode ?? ""))
    return { eligible: false, reason: "UNRESOLVED_OR_ERROR" };
  if (input.terminalState === "REJECTED" && input.learningStatus !== "FINALIZED")
    return { eligible: false, reason: "LEARNING_NOT_FINALIZED" };
  if (!["REJECTED", "EXPIRED", "CANCELED", "DATA_STALE"].includes(input.terminalState))
    return { eligible: false, reason: "STATE_NOT_DELETABLE" };
  return { eligible: true, reason: "SAFE_NO_ORDER_TERMINAL" };
}
