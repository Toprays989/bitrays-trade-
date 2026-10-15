import {
  STRATEGY_PLUGIN_IDS,
  rawStrategyPluginStamp,
  type StrategyPluginDefinition,
  type StrategyPluginId,
} from "./contract.ts";
import { fixedContractIntradayStrategyPlugin } from "./fixed-contract-intraday.ts";

const DEFINITIONS: ReadonlyMap<StrategyPluginId, StrategyPluginDefinition> =
  new Map([
    [fixedContractIntradayStrategyPlugin.id, fixedContractIntradayStrategyPlugin],
  ]);

export const STRATEGY_PLUGIN_CATALOG = Object.freeze(
  STRATEGY_PLUGIN_IDS.map((id) => {
    const definition = DEFINITIONS.get(id)!;
    return Object.freeze({
      id: definition.id,
      version: definition.version,
      label: definition.label,
      description: definition.description,
      triggerKind: definition.triggerKind,
      holdingHorizon: definition.holdingHorizon,
      minimumSymbols: definition.minimumSymbols,
      maximumSymbols: definition.maximumSymbols,
    });
  }),
);

export function resolveStrategyPlugin(
  id: StrategyPluginId,
): StrategyPluginDefinition {
  const definition = DEFINITIONS.get(id);
  if (!definition) throw new Error(`未注册的策略插件：${id}`);
  return definition;
}

export function strategyPluginId(value: unknown): StrategyPluginId | null {
  const stamp = rawStrategyPluginStamp(value);
  if (!stamp || !STRATEGY_PLUGIN_IDS.includes(stamp.id as StrategyPluginId))
    return null;
  return stamp.id as StrategyPluginId;
}

export function validateStrategyPluginConfig(value: unknown): string | null {
  const stamp = rawStrategyPluginStamp(value);
  if (!stamp) return null;
  if (!STRATEGY_PLUGIN_IDS.includes(stamp.id as StrategyPluginId))
    return "策略插件未注册，不能保存或发布";
  return resolveStrategyPlugin(stamp.id as StrategyPluginId).validate(value);
}

export type { StrategyPluginId } from "./contract.ts";
