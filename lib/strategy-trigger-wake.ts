import type { StrategyTriggerKind } from "./strategy-trigger-catalog.ts";
import type { LowPositionWindowTriggerCandidate } from "./strategy-triggers/low-position-window.ts";

export const NEXUS_STRATEGY_TRIGGER_WAKE_VERSION =
  "nexus-strategy-trigger-wake-v1" as const;

export type StrategyTriggerWakeDirection = "LONG" | "SHORT";

/**
 * Immutable handoff from a trigger adapter to the shared analysis brain.
 * A wake only starts analysis; it can never authorize or size an order.
 */
export type StrategyTriggerWake = Readonly<{
  version: typeof NEXUS_STRATEGY_TRIGGER_WAKE_VERSION;
  wakeId: string;
  triggerKind: StrategyTriggerKind;
  triggerVersion: string;
  strategyId: number;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  symbol: string;
  direction: StrategyTriggerWakeDirection;
  eventAt: number;
  receivedAt: number;
  expiresAt: number;
  referencePrice: number;
  factSnapshotId: string;
  sourceId: string;
  evidence: Readonly<Record<string, unknown>>;
  canAuthorizeOrder: false;
}>;

export type CreateStrategyTriggerWakeInput = Readonly<{
  triggerKind: StrategyTriggerKind;
  triggerVersion: string;
  strategyId: number;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  symbol: string;
  direction: StrategyTriggerWakeDirection;
  eventAt: number;
  receivedAt: number;
  analysisValiditySeconds: number;
  referencePrice: number;
  factSnapshotId: string;
  sourceId: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

export function createStrategyTriggerWake(
  input: CreateStrategyTriggerWakeInput,
): StrategyTriggerWake {
  const identity = {
    triggerKind: input.triggerKind,
    triggerVersion: requiredText(input.triggerVersion, "triggerVersion"),
    strategyId: finitePositiveInteger(input.strategyId, "strategyId"),
    configVersion: finitePositiveInteger(input.configVersion, "configVersion"),
    ownerEmail: requiredText(input.ownerEmail, "ownerEmail").toLowerCase(),
    accountId: requiredText(input.accountId, "accountId").toLowerCase(),
    symbol: normalizedSymbol(input.symbol),
    direction: input.direction,
    eventAt: finitePositiveInteger(input.eventAt, "eventAt"),
    factSnapshotId: requiredText(input.factSnapshotId, "factSnapshotId"),
  } as const;
  const wakeId = `wake-${fnv1a64(stableSerialize(identity))}`;
  return Object.freeze({
    version: NEXUS_STRATEGY_TRIGGER_WAKE_VERSION,
    wakeId,
    ...identity,
    receivedAt: finitePositiveInteger(input.receivedAt, "receivedAt"),
    expiresAt:
      identity.eventAt +
      finitePositiveInteger(
        input.analysisValiditySeconds,
        "analysisValiditySeconds",
      ) * 1_000,
    referencePrice: finitePositive(input.referencePrice, "referencePrice"),
    sourceId: requiredText(input.sourceId, "sourceId"),
    evidence: Object.freeze({ ...input.evidence }),
    canAuthorizeOrder: false,
  });
}

export function lowPositionStrategyTriggerWake(input: {
  candidate: LowPositionWindowTriggerCandidate;
  triggerVersion: string;
  strategyId: number;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  analysisValiditySeconds: number;
}): StrategyTriggerWake {
  const candidate = input.candidate;
  return createStrategyTriggerWake({
    triggerKind: candidate.kind,
    triggerVersion: input.triggerVersion,
    strategyId: input.strategyId,
    configVersion: input.configVersion,
    ownerEmail: input.ownerEmail,
    accountId: input.accountId,
    symbol: candidate.symbol,
    direction: candidate.direction,
    eventAt: candidate.eventAt,
    receivedAt: candidate.receivedAt,
    analysisValiditySeconds: input.analysisValiditySeconds,
    referencePrice: candidate.markPrice,
    factSnapshotId: candidate.factSnapshotId,
    sourceId: candidate.factSnapshotId,
    evidence: {
      high72h: candidate.high72h,
      low72h: candidate.low72h,
      position72hPercent: candidate.position72hPercent,
      factSnapshotId: candidate.factSnapshotId,
    },
  });
}

function normalizedSymbol(value: string) {
  const symbol = requiredText(value, "symbol").toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol))
    throw new Error("策略唤醒合约代码无效");
  return symbol;
}

function requiredText(value: string, label: string) {
  const text = String(value).trim();
  if (!text) throw new Error(`策略唤醒 ${label} 无效`);
  return text;
}

function finitePositive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`策略唤醒 ${label} 无效`);
  return value;
}

function finitePositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`策略唤醒 ${label} 无效`);
  return value;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(",")}}`;
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
