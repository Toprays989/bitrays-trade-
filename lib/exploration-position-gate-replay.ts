export type ExplorationPositionGateReplayRow = {
  clusterId: string | null;
  symbol: string | null;
  orderFirst: boolean;
  position72hPercent: number | null;
  roe60mPercent: number | null;
};

export type ExplorationPositionGateReplay = {
  observationOnly: true;
  gate: "MAX_POSITION_72H_PERCENT";
  currentLimitPercent: number;
  minimumComparableClusters: number;
  totalExplorationRows: number;
  comparableRows: number;
  comparableClusters: number;
  medianAdmittedRoe60mPercent: number | null;
  medianExcludedRoe60mPercent: number | null;
  medianWithinWaveAdvantageRoePercent: number | null;
  admittedBetterClusterRate: number | null;
  verdict:
    | "INSUFFICIENT_COMPARABLE_WAVES"
    | "SUPPORTS_CURRENT_LIMIT"
    | "CONTRADICTS_CURRENT_LIMIT"
    | "MIXED";
  clusters: Array<{
    clusterId: string;
    admittedSymbols: string[];
    excludedSymbols: string[];
    admittedMedianRoe60mPercent: number;
    excludedMedianRoe60mPercent: number;
    admittedAdvantageRoePercent: number;
  }>;
};

const MINIMUM_COMPARABLE_CLUSTERS = 5;
const MEANINGFUL_ADVANTAGE_ROE_PERCENT = 1;

export function analyzeExplorationPositionGateReplay(input: {
  rows: ExplorationPositionGateReplayRow[];
  currentLimitPercent: number;
}): ExplorationPositionGateReplay {
  const currentLimitPercent = finite(input.currentLimitPercent)
    ? input.currentLimitPercent
    : 35;
  const explorationRows = input.rows.filter((row) => row.orderFirst);
  const comparableRows = explorationRows.filter(
    (row) =>
      Boolean(row.clusterId) &&
      finite(row.position72hPercent) &&
      finite(row.roe60mPercent),
  );
  const grouped = new Map<string, ExplorationPositionGateReplayRow[]>();
  for (const row of comparableRows) {
    const rows = grouped.get(row.clusterId!) ?? [];
    rows.push(row);
    grouped.set(row.clusterId!, rows);
  }
  const clusters = [...grouped.entries()].flatMap(([clusterId, rows]) => {
    const admitted = rows.filter(
      (row) => row.position72hPercent! <= currentLimitPercent,
    );
    const excluded = rows.filter(
      (row) => row.position72hPercent! > currentLimitPercent,
    );
    if (!admitted.length || !excluded.length) return [];
    const admittedMedian = median(admitted.map((row) => row.roe60mPercent!));
    const excludedMedian = median(excluded.map((row) => row.roe60mPercent!));
    return [{
      clusterId,
      admittedSymbols: admitted.flatMap((row) => row.symbol ? [row.symbol] : []),
      excludedSymbols: excluded.flatMap((row) => row.symbol ? [row.symbol] : []),
      admittedMedianRoe60mPercent: round(admittedMedian),
      excludedMedianRoe60mPercent: round(excludedMedian),
      admittedAdvantageRoePercent: round(admittedMedian - excludedMedian),
    }];
  });
  const admittedValues = clusters.map(
    (cluster) => cluster.admittedMedianRoe60mPercent,
  );
  const excludedValues = clusters.map(
    (cluster) => cluster.excludedMedianRoe60mPercent,
  );
  const advantages = clusters.map(
    (cluster) => cluster.admittedAdvantageRoePercent,
  );
  const medianAdvantage = advantages.length ? median(advantages) : null;
  const admittedBetterClusterRate = advantages.length
    ? advantages.filter(
        (value) => value >= MEANINGFUL_ADVANTAGE_ROE_PERCENT,
      ).length / advantages.length
    : null;
  const enough = clusters.length >= MINIMUM_COMPARABLE_CLUSTERS;
  const verdict = !enough
    ? "INSUFFICIENT_COMPARABLE_WAVES"
    : medianAdvantage !== null &&
        medianAdvantage >= MEANINGFUL_ADVANTAGE_ROE_PERCENT &&
        admittedBetterClusterRate! >= 0.6
      ? "SUPPORTS_CURRENT_LIMIT"
      : medianAdvantage !== null &&
          medianAdvantage <= -MEANINGFUL_ADVANTAGE_ROE_PERCENT &&
          admittedBetterClusterRate! <= 0.4
        ? "CONTRADICTS_CURRENT_LIMIT"
        : "MIXED";
  return {
    observationOnly: true,
    gate: "MAX_POSITION_72H_PERCENT",
    currentLimitPercent,
    minimumComparableClusters: MINIMUM_COMPARABLE_CLUSTERS,
    totalExplorationRows: explorationRows.length,
    comparableRows: comparableRows.length,
    comparableClusters: clusters.length,
    medianAdmittedRoe60mPercent: admittedValues.length
      ? round(median(admittedValues))
      : null,
    medianExcludedRoe60mPercent: excludedValues.length
      ? round(median(excludedValues))
      : null,
    medianWithinWaveAdvantageRoePercent:
      medianAdvantage === null ? null : round(medianAdvantage),
    admittedBetterClusterRate:
      admittedBetterClusterRate === null
        ? null
        : round(admittedBetterClusterRate),
    verdict,
    clusters,
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
