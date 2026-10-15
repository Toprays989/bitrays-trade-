import type {
  StrategyDirectionPathAdapter,
} from "./contract.ts";

/**
 * Builds an immutable, instance-local registry. Runtime correctness never
 * depends on mutable module globals, so multiple workers cannot diverge after
 * startup registration.
 */
export function createStrategyDirectionPathRegistry<
  TFacts,
  TConfig,
>(
  adapters: readonly StrategyDirectionPathAdapter<TFacts, TConfig>[],
) {
  const entries = new Map<string, StrategyDirectionPathAdapter<TFacts, TConfig>>();
  for (const adapter of adapters) {
    const kind = String(adapter.kind ?? "").trim();
    if (!kind) throw new Error("方向路径 kind 不能为空");
    if (entries.has(kind)) throw new Error(`方向路径重复注册：${kind}`);
    entries.set(kind, Object.freeze({
      ...adapter,
      supportedDirections: Object.freeze([...adapter.supportedDirections]),
    }));
  }
  const kinds = Object.freeze([...entries.keys()]);
  return Object.freeze({
    kinds: () => [...kinds],
    resolve: (kind: string) => {
      const adapter = entries.get(kind);
      if (!adapter) throw new Error(`未注册的方向路径：${kind}`);
      return adapter;
    },
  });
}
