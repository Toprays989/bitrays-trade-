export type WaveSymbolSelectionRow = {
  clusterId: string | null;
  symbol: string | null;
  entryComparisonEvidenceComplete: boolean;
  roe60mPercent: number | null;
  position72hPercent: number | null;
  volumeRatio3m: number | null;
  symbolLiquidationSharePercent: number | null;
  symbolContributionRank: number | null;
  entryDistanceAtr: number | null;
  largeTraderStatus:
    | "SUPPORTS_LONG"
    | "CONFLICTS_LONG"
    | "NEUTRAL"
    | "UNAVAILABLE"
    | null;
  liquiditySweepStatus:
    | "RECLAIMED"
    | "ACTIVE_CASCADE"
    | "UNCONFIRMED"
    | "DATA_STALE"
    | null;
};

export type WaveSymbolSelectionRelation = {
  feature: string;
  comparableClusters: number;
  medianWinnerMinusLoser: number | null;
  winnerHigherRate: number | null;
  winnerLowerRate: number | null;
  verdict:
    | "INSUFFICIENT_CLUSTERS"
    | "WINNERS_TEND_HIGHER"
    | "WINNERS_TEND_LOWER"
    | "NO_STABLE_RELATION";
};

export type WaveSymbolSelectionAttribution = {
  observationOnly: true;
  minimumClusters: number;
  totalMultiSymbolClusters: number;
  entryComparableClusters: number;
  excludedIncompleteEntryEvidenceClusters: number;
  selectedPairs: Array<{
    clusterId: string;
    winnerSymbol: string | null;
    loserSymbol: string | null;
    winnerRoe60mPercent: number;
    loserRoe60mPercent: number;
    spreadRoePercent: number;
  }>;
  numericRelations: WaveSymbolSelectionRelation[];
  largeTraderSupport: WaveSymbolSelectionRelation;
  reclaimedSweep: WaveSymbolSelectionRelation;
  verdict: "WAIT_FOR_COMPARABLE_WAVES" | "OBSERVATION_READY";
  summary: string;
};

const NUMERIC_FEATURES = [
  ["position72hPercent", "72小时价格位置"],
  ["volumeRatio3m", "3分钟量能"],
  ["symbolLiquidationSharePercent", "单币爆仓贡献"],
  ["symbolContributionRank", "爆仓贡献排名"],
  ["entryDistanceAtr", "入场距离ATR"],
] as const;

export function analyzeWaveSymbolSelection(input: {
  rows: WaveSymbolSelectionRow[];
  minimumClusters?: number;
  minimumRoeSpreadPercent?: number;
}): WaveSymbolSelectionAttribution {
  const minimumClusters = Math.max(
    3,
    Math.trunc(Number(input.minimumClusters) || 5),
  );
  const minimumSpread = Math.max(
    0.1,
    Number(input.minimumRoeSpreadPercent) || 0.5,
  );
  const groups = new Map<string, WaveSymbolSelectionRow[]>();
  for (const row of input.rows) {
    const clusterId = row.clusterId?.trim();
    if (!clusterId) continue;
    const group = groups.get(clusterId) ?? [];
    group.push(row);
    groups.set(clusterId, group);
  }
  const multiSymbol = [...groups.entries()].filter(
    ([, rows]) => rows.length >= 2,
  );
  const pairs = multiSymbol.flatMap(([clusterId, rows]) => {
    const comparable = rows
      .filter(
        (row) =>
          row.entryComparisonEvidenceComplete &&
          finite(row.roe60mPercent),
      )
      .sort(
        (left, right) =>
          Number(right.roe60mPercent) - Number(left.roe60mPercent),
      );
    if (comparable.length < 2) return [];
    const winner = comparable[0]!;
    const loser = comparable.at(-1)!;
    const spread =
      Number(winner.roe60mPercent) - Number(loser.roe60mPercent);
    if (spread < minimumSpread) return [];
    return [{
      clusterId,
      winner,
      loser,
      spread,
    }];
  });
  const relationForNumeric = (
    key: (typeof NUMERIC_FEATURES)[number][0],
    label: string,
  ) =>
    relation(
      label,
      pairs.flatMap((pair) => {
        const winner = pair.winner[key];
        const loser = pair.loser[key];
        return finite(winner) && finite(loser)
          ? [Number(winner) - Number(loser)]
          : [];
      }),
      minimumClusters,
    );
  const largeTraderSupport = relation(
    "大户持仓支持",
    pairs.map(
      (pair) =>
        supportScore(pair.winner.largeTraderStatus) -
        supportScore(pair.loser.largeTraderStatus),
    ),
    minimumClusters,
  );
  const reclaimedSweep = relation(
    "流动性扫盘收回",
    pairs.map(
      (pair) =>
        Number(pair.winner.liquiditySweepStatus === "RECLAIMED") -
        Number(pair.loser.liquiditySweepStatus === "RECLAIMED"),
    ),
    minimumClusters,
  );
  const ready = pairs.length >= minimumClusters;
  return {
    observationOnly: true,
    minimumClusters,
    totalMultiSymbolClusters: multiSymbol.length,
    entryComparableClusters: pairs.length,
    excludedIncompleteEntryEvidenceClusters: Math.max(
      0,
      multiSymbol.length - pairs.length,
    ),
    selectedPairs: pairs.map((pair) => ({
      clusterId: pair.clusterId,
      winnerSymbol: pair.winner.symbol,
      loserSymbol: pair.loser.symbol,
      winnerRoe60mPercent: round(Number(pair.winner.roe60mPercent)),
      loserRoe60mPercent: round(Number(pair.loser.roe60mPercent)),
      spreadRoePercent: round(pair.spread),
    })),
    numericRelations: NUMERIC_FEATURES.map(([key, label]) =>
      relationForNumeric(key, label)
    ),
    largeTraderSupport,
    reclaimedSweep,
    verdict: ready ? "OBSERVATION_READY" : "WAIT_FOR_COMPARABLE_WAVES",
    summary: ready
      ? `${pairs.length}个独立波段完成组内赢家/输家配对；这是控制同波段大盘背景后的入场特征关联，不宣称因果，也不自动改变实盘参数。`
      : `已有${multiSymbol.length}个同波段多合约组合，其中${pairs.length}个具备可比较的入场证据、真实60分钟价格结果和至少${minimumSpread.toFixed(2)}个ROE百分点的组内差异；至少需要${minimumClusters}个独立波段。`,
  };
}

function relation(
  feature: string,
  differences: number[],
  minimumClusters: number,
): WaveSymbolSelectionRelation {
  const values = differences.filter(finite);
  const positive = values.filter((value) => value > 0).length;
  const negative = values.filter((value) => value < 0).length;
  const winnerHigherRate = values.length ? positive / values.length : null;
  const winnerLowerRate = values.length ? negative / values.length : null;
  const middle = median(values);
  const enough = values.length >= minimumClusters;
  const verdict = !enough
    ? "INSUFFICIENT_CLUSTERS"
    : middle !== null &&
        middle > 0 &&
        (winnerHigherRate ?? 0) >= 0.6
      ? "WINNERS_TEND_HIGHER"
      : middle !== null &&
          middle < 0 &&
          (winnerLowerRate ?? 0) >= 0.6
        ? "WINNERS_TEND_LOWER"
        : "NO_STABLE_RELATION";
  return {
    feature,
    comparableClusters: values.length,
    medianWinnerMinusLoser: middle === null ? null : round(middle),
    winnerHigherRate:
      winnerHigherRate === null ? null : round(winnerHigherRate),
    winnerLowerRate:
      winnerLowerRate === null ? null : round(winnerLowerRate),
    verdict,
  };
}

function supportScore(
  value: WaveSymbolSelectionRow["largeTraderStatus"],
) {
  if (value === "SUPPORTS_LONG") return 1;
  if (value === "CONFLICTS_LONG") return -1;
  return 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
