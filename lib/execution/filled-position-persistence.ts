import type { livePositions } from "../../db/schema.ts";
import { buildInstrumentId } from "../position-protection-version.ts";
import type {
  buildFilledPositionProtection,
} from "./filled-position-protection.ts";
import {
  buildFilledPositionHandoff,
  FILLED_POSITION_HANDOFF_CONTRACT_VERSION,
  type FilledPositionHandoffOrigin,
} from "../position-lifecycle/filled-position-handoff.ts";

export const FILLED_POSITION_PERSISTENCE_CONTRACT_VERSION =
  "filled-position-persistence-v1" as const;

type LivePositionInsert = typeof livePositions.$inferInsert;
type FilledPositionProtection = ReturnType<
  typeof buildFilledPositionProtection
>;

function normalizedLifecycleId(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizedEntryDecisionHandoffJson(
  value: string | null | undefined,
) {
  return typeof value === "string" && value.trim().length > 0 ? value : "{}";
}

export function buildFilledPositionInsertValues(input: {
  ownerEmail: string;
  accountId: string;
  credentialId: number;
  sourceEventId: number;
  handoffOrigin: FilledPositionHandoffOrigin;
  lifecycleId?: string | null;
  entryDecisionHandoffJson?: string | null;
  symbol: string;
  instrumentId?: string | null;
  instrumentRuleVersion: number;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  leverage: number;
  protection: FilledPositionProtection;
  openedAt: Date;
  updatedAt: Date;
}): LivePositionInsert {
  const instrumentId =
    typeof input.instrumentId === "string" && input.instrumentId.trim().length > 0
      ? input.instrumentId
      : buildInstrumentId({ symbol: input.symbol });
  const positionHandoff = buildFilledPositionHandoff({
    origin: input.handoffOrigin,
    sourceEventId: input.sourceEventId,
    lifecycleId: input.lifecycleId,
    entryDecisionHandoffJson: input.entryDecisionHandoffJson,
    symbol: input.symbol,
    positionSide: input.positionSide,
    quantity: input.quantity,
    entryPrice: input.entryPrice,
    leverage: input.leverage,
    filledAt: input.openedAt,
  });

  return {
    ownerEmail: input.ownerEmail,
    accountId: input.accountId,
    credentialId: input.credentialId,
    sourceEventId: input.sourceEventId,
    lifecycleId: normalizedLifecycleId(input.lifecycleId),
    entryDecisionHandoffJson: normalizedEntryDecisionHandoffJson(
      input.entryDecisionHandoffJson,
    ),
    positionHandoffKey: positionHandoff.handoffKey,
    positionHandoffVersion: FILLED_POSITION_HANDOFF_CONTRACT_VERSION,
    positionHandoffJson: JSON.stringify(positionHandoff),
    symbol: input.symbol,
    instrumentId,
    instrumentRuleVersion: input.instrumentRuleVersion,
    positionSide: input.positionSide,
    quantity: input.quantity,
    entryPrice: input.entryPrice,
    markPrice: input.entryPrice,
    leverage: input.leverage,
    riskPlanJson: input.protection.riskPlanJson,
    protectionState: input.protection.protectionState,
    protectionUpdatedAt: input.protection.protectionUpdatedAt,
    trailingActivationPercent:
      input.protection.trailingActivationPercent,
    trailingStopPercent: input.protection.trailingStopPercent,
    favorablePrice: input.entryPrice,
    status: "OPEN",
    openedAt: input.openedAt,
    updatedAt: input.updatedAt,
  };
}

export function buildFilledPositionRecoveryValues(input: {
  lifecycleId?: string | null;
  entryDecisionHandoffJson?: string | null;
  positionHandoffKey?: string | null;
  positionHandoffVersion?: string | null;
  positionHandoffJson?: string | null;
  leverage: number;
  protection: FilledPositionProtection;
  updatedAt: Date;
}): Partial<LivePositionInsert> {
  return {
    lifecycleId: normalizedLifecycleId(input.lifecycleId),
    entryDecisionHandoffJson: normalizedEntryDecisionHandoffJson(
      input.entryDecisionHandoffJson,
    ),
    positionHandoffKey: input.positionHandoffKey ?? null,
    positionHandoffVersion: input.positionHandoffVersion ?? null,
    positionHandoffJson: normalizedEntryDecisionHandoffJson(
      input.positionHandoffJson,
    ),
    leverage: input.leverage,
    riskPlanJson: input.protection.riskPlanJson,
    protectionState: input.protection.protectionState,
    protectionUpdatedAt: input.protection.protectionUpdatedAt,
    trailingActivationPercent:
      input.protection.trailingActivationPercent,
    trailingStopPercent: input.protection.trailingStopPercent,
    lastError: null,
    updatedAt: input.updatedAt,
  };
}
