export const STRATEGY_ASSET_CLASS_SCOPES = [
  "ALL",
  "CRYPTO_NATIVE",
  "TRADFI",
  "CUSTOM",
] as const;

export type StrategyAssetClassScope =
  (typeof STRATEGY_ASSET_CLASS_SCOPES)[number];

export type StrategyAssetScopeContract = {
  symbol: string;
  contractType: string | null | undefined;
};

export function normalizeStrategyAssetClassScope(input: {
  value: unknown;
  selectedSymbols?: readonly string[];
}): StrategyAssetClassScope {
  if (
    typeof input.value === "string" &&
    STRATEGY_ASSET_CLASS_SCOPES.includes(
      input.value as StrategyAssetClassScope,
    )
  ) return input.value as StrategyAssetClassScope;
  return input.selectedSymbols?.length ? "CUSTOM" : "ALL";
}

export function strategyAssetScopeAllowsContract(input: {
  scope: StrategyAssetClassScope;
  contract: StrategyAssetScopeContract;
  selectedSymbols?: ReadonlySet<string>;
}) {
  const symbol = input.contract.symbol.trim().toUpperCase();
  const explicitlySelected = input.selectedSymbols?.has(symbol) ?? false;
  if (input.scope === "CUSTOM") return explicitlySelected;
  // Explicit symbol lists predate asset scopes. Keep their exact universe
  // until the operator deliberately changes the scope.
  if (input.selectedSymbols?.size) return explicitlySelected;
  const isTradfi = input.contract.contractType === "TRADIFI_PERPETUAL";
  if (input.scope === "CRYPTO_NATIVE") return !isTradfi;
  if (input.scope === "TRADFI") return isTradfi;
  return true;
}

export function filterContractsByStrategyAssetScope<
  T extends StrategyAssetScopeContract,
>(input: {
  contracts: readonly T[];
  scope: StrategyAssetClassScope;
  selectedSymbols?: readonly string[];
}): T[] {
  const selectedSymbols = new Set(
    (input.selectedSymbols ?? []).map((symbol) =>
      symbol.trim().toUpperCase()
    ),
  );
  return input.contracts.filter((contract) =>
    strategyAssetScopeAllowsContract({
      scope: input.scope,
      contract,
      selectedSymbols,
    })
  );
}

export function strategyAssetClassScopeLabel(
  scope: StrategyAssetClassScope,
) {
  if (scope === "CRYPTO_NATIVE") return "原生加密";
  if (scope === "TRADFI") return "TradFi 合约";
  if (scope === "CUSTOM") return "自定义合约";
  return "全部合约";
}
