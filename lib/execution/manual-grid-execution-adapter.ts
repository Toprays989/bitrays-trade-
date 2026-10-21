import type { liveOrderEvents, livePositionAdditions } from "../../db/schema.ts";
import type { ManualGridMarketOrderRequest } from "../manual-entry-grid.ts";

type LiveOrderInsert = typeof liveOrderEvents.$inferInsert;
type AdditionInsert = typeof livePositionAdditions.$inferInsert;

export function buildManualGridLiveOrderLedger(input: {
  ownerEmail: string;
  accountId: string;
  credentialId: number;
  order: ManualGridMarketOrderRequest;
  referencePrice: number;
  lifecycleId?: string | null;
  now: Date;
}): LiveOrderInsert {
  if (!input.ownerEmail || !input.accountId || !Number.isInteger(input.credentialId)) throw new Error("manual grid order ownership is invalid");
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) throw new Error("manual grid reference price is invalid");
  const estimatedNotional = input.referencePrice * input.order.quantity;
  return {
    ownerEmail: input.ownerEmail,
    accountId: input.accountId,
    credentialId: input.credentialId,
    clientOrderId: input.order.clientOrderId,
    symbol: input.order.symbol,
    side: input.order.side,
    positionSide: input.order.positionSide,
    orderType: "MARKET",
    quantity: input.order.quantity,
    referencePrice: input.referencePrice,
    estimatedNotional,
    testOnly: false,
    status: "PENDING",
    responseJson: JSON.stringify({ source: "MANUAL_GRID", triggerLevelPrice: input.order.triggerLevelPrice, triggerPrice: input.order.triggerPrice, triggerCount: input.order.triggerCount }),
    lifecycleId: input.lifecycleId ?? null,
    entryDecisionHandoffJson: JSON.stringify({ source: "MANUAL_GRID", triggerLevelPrice: input.order.triggerLevelPrice, triggerPrice: input.order.triggerPrice, triggerCount: input.order.triggerCount }),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function buildManualGridAdditionLedger(input: {
  positionId: number;
  ownerEmail: string;
  accountId: string;
  order: ManualGridMarketOrderRequest;
  basePositionVersion: number;
  lifecycleId?: string | null;
  referencePrice: number;
  now: Date;
}): AdditionInsert {
  if (!Number.isInteger(input.positionId) || input.positionId <= 0) throw new Error("positionId is invalid");
  if (!Number.isInteger(input.basePositionVersion) || input.basePositionVersion < 1) throw new Error("basePositionVersion is invalid");
  return {
    positionId: input.positionId,
    basePositionVersion: input.basePositionVersion,
    ownerEmail: input.ownerEmail,
    accountId: input.accountId,
    clientOrderId: input.order.clientOrderId,
    symbol: input.order.symbol,
    positionSide: input.order.positionSide,
    quantity: input.order.quantity,
    notionalUsdt: input.referencePrice * input.order.quantity,
    status: "PENDING",
    decisionJson: JSON.stringify({ source: "MANUAL_GRID", triggerLevelPrice: input.order.triggerLevelPrice, triggerPrice: input.order.triggerPrice, triggerCount: input.order.triggerCount }),
    responseJson: JSON.stringify({ source: "MANUAL_GRID", requestedReferencePrice: input.referencePrice }),
    lifecycleId: input.lifecycleId ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
