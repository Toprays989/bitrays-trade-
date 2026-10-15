import type { StrategyTriggerKind } from "../strategy-trigger-catalog.ts";

export const STRATEGY_PLUGIN_IDS = ["FIXED_CONTRACT_INTRADAY"] as const;

export type StrategyPluginId = typeof STRATEGY_PLUGIN_IDS[number];

export type StrategyPluginStamp = Readonly<{
  id: StrategyPluginId;
  version: string;
}>;

export type StrategyPluginDefinition = Readonly<{
  id: StrategyPluginId;
  version: string;
  label: string;
  description: string;
  triggerKind: StrategyTriggerKind;
  holdingHorizon: "INTRADAY";
  minimumSymbols: number;
  maximumSymbols: number;
  apply<T extends object>(value: T): T;
  validate(value: unknown): string | null;
}>;

export function strategyPluginStamp(value: unknown): StrategyPluginStamp | null {
  if (!isRecord(value)) return null;
  const raw = value.strategyPlugin;
  if (!isRecord(raw)) return null;
  if (!STRATEGY_PLUGIN_IDS.includes(raw.id as StrategyPluginId)) return null;
  if (typeof raw.version !== "string" || !raw.version.trim()) return null;
  return {
    id: raw.id as StrategyPluginId,
    version: raw.version.trim(),
  };
}

export function rawStrategyPluginStamp(value: unknown): Readonly<{
  id: string;
  version: string;
}> | null {
  if (!isRecord(value) || !isRecord(value.strategyPlugin)) return null;
  return {
    id: String(value.strategyPlugin.id ?? ""),
    version: String(value.strategyPlugin.version ?? ""),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
