export type StrategySymbolOption = Readonly<{
  symbol: string;
  name?: string;
  enabled: boolean;
}>;

const STRATEGY_SYMBOL_PATTERN = /^[A-Z0-9]{3,30}$/;

export function canonicalStrategyScopeSymbols(values: readonly string[]) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const symbol = normalizeStrategyScopeSymbol(value);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    result.push(symbol);
  }
  return result;
}

export function addStrategyScopeSymbol(
  selectedSymbols: readonly string[],
  value: string,
) {
  return canonicalStrategyScopeSymbols([...selectedSymbols, value]);
}

export function removeStrategyScopeSymbol(
  selectedSymbols: readonly string[],
  value: string,
) {
  const removed = normalizeStrategyScopeSymbol(value);
  return canonicalStrategyScopeSymbols(selectedSymbols).filter(
    (symbol) => symbol !== removed,
  );
}

export function searchStrategyScopeSymbols<T extends StrategySymbolOption>(
  options: readonly T[],
  rawQuery: string,
  selectedSymbols: readonly string[],
  limit = 12,
) {
  const query = rawQuery.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const selected = new Set(canonicalStrategyScopeSymbols(selectedSymbols));
  const seen = new Set<string>();
  return options
    .map((option) => {
      const symbol = normalizeStrategyScopeSymbol(option.symbol);
      if (
        !symbol ||
        !option.enabled ||
        selected.has(symbol) ||
        seen.has(symbol)
      ) return null;
      seen.add(symbol);
      const score = Math.min(
        fuzzyStrategySymbolScore(symbol, query) ?? Number.POSITIVE_INFINITY,
        fuzzyStrategySymbolScore(option.name ?? "", query) ??
          Number.POSITIVE_INFINITY,
      );
      return Number.isFinite(score) ? { option, symbol, score } : null;
    })
    .filter(
      (row): row is { option: T; symbol: string; score: number } => row !== null,
    )
    .sort(
      (left, right) =>
        left.score - right.score || left.symbol.localeCompare(right.symbol),
    )
    .slice(0, Math.max(0, Math.trunc(limit)))
    .map(({ option }) => option);
}

function normalizeStrategyScopeSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  return STRATEGY_SYMBOL_PATTERN.test(symbol) ? symbol : "";
}

function fuzzyStrategySymbolScore(value: string, query: string) {
  const candidate = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!query) return 0;
  if (candidate.startsWith(query)) return 0;
  const directIndex = candidate.indexOf(query);
  if (directIndex >= 0) return 10 + directIndex;
  let candidateIndex = 0;
  let gapScore = 0;
  for (const character of query) {
    const matchedIndex = candidate.indexOf(character, candidateIndex);
    if (matchedIndex < 0) return null;
    gapScore += matchedIndex - candidateIndex;
    candidateIndex = matchedIndex + 1;
  }
  return 50 + gapScore;
}
