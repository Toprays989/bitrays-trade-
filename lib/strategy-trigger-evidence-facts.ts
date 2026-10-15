import {
  createNexusMarketFact,
  marketStructureWakeFact,
  type NexusMarketFact,
} from "./nexus-market-facts.ts";
import type { StrategyTriggerKind } from "./strategy-trigger-catalog.ts";

type TriggerDirection = "LONG" | "SHORT";

type StrategyWakeFactInput = {
  wakeId: string;
  triggerKind: StrategyTriggerKind;
  symbol: string;
  direction: TriggerDirection;
  referencePrice: number;
  eventAt: number;
  receivedAt: number;
  expiresAt: number;
  evidence: unknown;
};

/**
 * Converts the immutable trigger handoff into the fact vocabulary consumed by
 * the shared state machines.  A trigger still cannot authorize an order: it
 * only prevents already-verified trigger evidence from being discarded and
 * requested a second time by the brain.
 */
export function strategyWakeEvidenceFacts(
  input: StrategyWakeFactInput,
): NexusMarketFact[] {
  const evidence = asRecord(input.evidence);
  const breakoutAt = positiveNumber(evidence.breakoutAt);
  const triggerEventAt =
    input.triggerKind === "BREAKOUT_RETEST" && breakoutAt !== null
      ? breakoutAt
      : input.eventAt;
  const marketSide = input.direction === "LONG" ? "SELL" : "BUY";
  const triggerFact = marketStructureWakeFact({
    id: input.wakeId,
    symbol: input.symbol,
    side: marketSide,
    eventAt: triggerEventAt,
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    referencePrice: input.referencePrice,
    position72hPercent:
      finiteNumber(evidence.position72hPercent) ?? 50,
    relativeVolume5m:
      finiteNumber(evidence.breakoutVolumeRatio) ??
      finiteNumber(evidence.relativeVolume5m),
    structureCode: `${input.triggerKind}_${input.direction}`,
  });

  if (input.triggerKind !== "BREAKOUT_RETEST") return [triggerFact];
  const breakoutLevel = positiveNumber(evidence.breakoutLevel);
  const breakoutClose = positiveNumber(evidence.breakoutClose);
  const breakoutVolumeRatio = positiveNumber(
    evidence.breakoutVolumeRatio,
  );
  const retestAt = positiveNumber(evidence.retestAt) ?? input.eventAt;
  if (
    breakoutAt === null ||
    breakoutLevel === null ||
    breakoutClose === null ||
    breakoutVolumeRatio === null
  ) return [triggerFact];

  const structureKind =
    input.direction === "LONG" ? "PRICE_NEW_HIGH" : "PRICE_NEW_LOW";
  const structurePayload = {
    triggerWakeId: input.wakeId,
    triggerFactId: triggerFact.id,
    triggerKind: input.triggerKind,
    price: breakoutClose,
    priorHigh: input.direction === "LONG" ? breakoutLevel : null,
    priorLow: input.direction === "SHORT" ? breakoutLevel : null,
    breakoutLevel,
    breakoutDistanceBps:
      finiteNumber(evidence.breakoutDistanceBps) ?? null,
    retestAt,
    retestDistanceBps:
      finiteNumber(evidence.retestDistanceBps) ?? null,
    retestConfirmed: true,
    orderAffecting: false,
  };
  const structureFact = createNexusMarketFact({
    kind: structureKind,
    symbol: input.symbol,
    interval: "5m",
    source: "SYSTEM_DERIVED",
    eventAt: breakoutAt,
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    payload: structurePayload,
  });
  const volumeFact = createNexusMarketFact({
    kind: "VOLUME_EXPANDED",
    symbol: input.symbol,
    interval: "5m",
    source: "SYSTEM_DERIVED",
    eventAt: breakoutAt,
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    payload: {
      triggerWakeId: input.wakeId,
      triggerFactId: triggerFact.id,
      triggerKind: input.triggerKind,
      ratio: breakoutVolumeRatio,
      retestAt,
      retestConfirmed: true,
      orderAffecting: false,
    },
  });
  return [triggerFact, structureFact, volumeFact];
}

/**
 * Restores only the immutable facts owned by the trigger handoff.  Rolling
 * candles and mark prices are deliberately excluded and must be refreshed by
 * the market-data layer on every evaluation.
 */
export function restoreStrategyTriggerFacts(input: {
  value: unknown;
  symbol: string;
  triggerKind: StrategyTriggerKind;
  traceExpiresAt: number;
}): NexusMarketFact[] {
  if (!Array.isArray(input.value) || !Number.isFinite(input.traceExpiresAt))
    return [];
  const symbol = input.symbol.trim().toUpperCase();
  const parsed = input.value
    .map(validFact)
    .filter((fact): fact is NexusMarketFact => fact !== null)
    .filter((fact) => fact.symbol === symbol);
  if (input.triggerKind === "LIQUIDATION_WINDOW") {
    const liquidation = parsed.find(
      (fact) =>
        fact.kind === "LIQUIDATION_AGGREGATED" &&
        ["BUY", "SELL"].includes(String(fact.payload.side)),
    );
    return liquidation ? [extendFact(liquidation, input.traceExpiresAt)] : [];
  }

  const triggers = parsed.filter(
    (fact) =>
      fact.kind === "MARKET_STRUCTURE_WAKE" &&
      ["BUY", "SELL"].includes(String(fact.payload.side)) &&
      String(fact.payload.structureCode ?? "").startsWith(
        `${input.triggerKind}_`,
      ),
  );
  if (!triggers.length) return [];
  const facts = triggers.map((trigger) =>
    extendFact(trigger, input.traceExpiresAt)
  );
  if (input.triggerKind !== "BREAKOUT_RETEST") return facts;
  const trigger = triggers[0]!;
  const wakeId = String(trigger.payload.upstreamId ?? "");
  for (const fact of parsed) {
    if (
      !["PRICE_NEW_HIGH", "PRICE_NEW_LOW", "VOLUME_EXPANDED"].includes(
        fact.kind,
      ) ||
      String(fact.payload.triggerWakeId ?? "") !== wakeId ||
      String(fact.payload.triggerFactId ?? "") !== trigger.id ||
      fact.payload.triggerKind !== input.triggerKind
    ) continue;
    facts.push(extendFact(fact, input.traceExpiresAt));
  }
  return facts;
}

function validFact(value: unknown): NexusMarketFact | null {
  const fact = asRecord(value);
  if (
    fact.version !== 1 ||
    typeof fact.id !== "string" ||
    typeof fact.kind !== "string" ||
    typeof fact.symbol !== "string" ||
    !Number.isFinite(Number(fact.eventAt)) ||
    !Number.isFinite(Number(fact.receivedAt)) ||
    !Number.isFinite(Number(fact.expiresAt)) ||
    !fact.payload ||
    typeof fact.payload !== "object" ||
    Array.isArray(fact.payload)
  ) return null;
  return fact as NexusMarketFact;
}

function extendFact(fact: NexusMarketFact, expiresAt: number) {
  return {
    ...fact,
    expiresAt: Math.max(fact.expiresAt, expiresAt),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
