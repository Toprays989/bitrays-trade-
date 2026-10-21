import { combinePositionAddition } from "../live-position-addition.ts";
import { reanchorProgressAfterAddition, type ExecutedRiskProgress } from "../risk-execution-progress.ts";
import { rebuildProtectionAfterAddition } from "../position-protection-version.ts";
import { rebalanceRiskPlan } from "../risk-plan-rebalance.ts";

type JsonRecord = Record<string, unknown>;

export function settlePositionAdditionBasis(input: {
  currentQuantity: number;
  currentEntryPrice: number;
  addedQuantity: number;
  addedEntryPrice: number;
  exchangeQuantity?: number | null;
  exchangeEntryPrice?: number | null;
  riskPlan: JsonRecord;
  executedRiskProgress: ExecutedRiskProgress;
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
  trailingStopPercent: number;
  positionVersion: number;
  protectionVersion: number;
  nowMs: number;
  source?: "MANUAL_ADD_ON" | "AUTO_ADD_ON" | "RECONCILIATION";
}) {
  const combined = combinePositionAddition({
    currentQuantity: input.currentQuantity,
    currentEntryPrice: input.currentEntryPrice,
    addedQuantity: input.addedQuantity,
    addedEntryPrice: input.addedEntryPrice,
  });
  const syncedQuantity = Number.isFinite(input.exchangeQuantity) && Number(input.exchangeQuantity) > 0
    ? Number(input.exchangeQuantity)
    : combined.combinedQuantity;
  const syncedEntryPrice = Number.isFinite(input.exchangeEntryPrice) && Number(input.exchangeEntryPrice) > 0
    ? Number(input.exchangeEntryPrice)
    : combined.combinedEntryPrice;
  const rebalanced = rebalanceRiskPlan(
    input.riskPlan,
    syncedQuantity,
    input.minOrderQty,
    input.quantityStep,
    input.executedRiskProgress,
    input.trailingStopPercent,
  );
  const nextPositionVersion = input.positionVersion + 1;
  const nextProtectionVersion = input.protectionVersion + 1;
  const protectionPlan = rebuildProtectionAfterAddition({
    plan: rebalanced.plan,
    rebalancedTakeProfits: rebalanced.plan.takeProfits,
    rebalancedStopLosses: rebalanced.plan.stopLosses,
    nextPositionVersion,
    nextProtectionVersion,
    nowMs: input.nowMs,
    source: input.source ?? "MANUAL_ADD_ON",
  });
  return {
    combinedQuantity: combined.combinedQuantity,
    combinedEntryPrice: combined.combinedEntryPrice,
    syncedQuantity,
    syncedEntryPrice,
    nextPositionVersion,
    nextProtectionVersion,
    riskPlan: protectionPlan,
    executedRiskProgress: reanchorProgressAfterAddition({
      progress: input.executedRiskProgress,
      newPositionQuantity: syncedQuantity,
    }),
    takeProfitGrids: rebalanced.takeProfitGrids,
    stopLossGrids: rebalanced.stopLossGrids,
  };
}
