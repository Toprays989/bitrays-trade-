import { breakoutRetestTriggerAdapter } from "./breakout-retest.ts";
import { gridPriceLevelTriggerAdapter } from "./grid-price-level.ts";
import { liquidationWindowTriggerAdapter } from "./liquidation-window.ts";
import { lowPositionWindowTriggerAdapter } from "./low-position-window.ts";
import { scheduledScanTriggerAdapter } from "./scheduled-scan.ts";
import { threeMinuteProbabilityTriggerAdapter } from "./three-minute-probability.ts";
import { simpleReboundTriggerAdapter } from "./simple-rebound.ts";

const strategyTriggerRegistry = Object.freeze({
  LIQUIDATION_WINDOW: liquidationWindowTriggerAdapter,
  LOW_POSITION_WINDOW: lowPositionWindowTriggerAdapter,
  THREE_MINUTE_PROBABILITY: threeMinuteProbabilityTriggerAdapter,
  SIMPLE_REBOUND: simpleReboundTriggerAdapter,
  GRID_PRICE_LEVEL: gridPriceLevelTriggerAdapter,
  SCHEDULED_SCAN: scheduledScanTriggerAdapter,
  BREAKOUT_RETEST: breakoutRetestTriggerAdapter,
});

export type RegisteredStrategyTriggerKind = keyof typeof strategyTriggerRegistry;
export type { StrategyTriggerKind } from "../strategy-trigger-catalog.ts";

export function registeredStrategyTriggerKinds(): RegisteredStrategyTriggerKind[] {
  return Object.keys(strategyTriggerRegistry) as RegisteredStrategyTriggerKind[];
}

export function resolveStrategyTriggerAdapter<K extends RegisteredStrategyTriggerKind>(
  kind: K,
): (typeof strategyTriggerRegistry)[K];
export function resolveStrategyTriggerAdapter(kind: string) {
  const adapter = strategyTriggerRegistry[kind as RegisteredStrategyTriggerKind];
  if (!adapter) throw new Error(`未注册的策略触发器：${kind}`);
  return adapter;
}
