export type EntryPolicyName =
  | "ACTUAL_ENTRY"
  | "DEEPER_LIMIT"
  | "DELAYED_RECLAIM";

export type EntryPolicyMetrics = {
  policy: EntryPolicyName;
  opportunities: number;
  entered: number;
  skipped: number;
  averageNetRoePerOpportunity: number;
  medianNetRoePerOpportunity: number;
  positiveOpportunityRate: number;
  lossOpportunityRate: number;
};

export type EntryPolicyComparison = {
  sampleCount: number;
  estimatedFeeRoePercent: number;
  policies: EntryPolicyMetrics[];
  preferredPolicy:
    | EntryPolicyName
    | "NO_CLEAR_EDGE"
    | "INSUFFICIENT";
  edgeVsActualRoePercent: number | null;
  pairedEvidence: {
    beatActualRate: number;
    beatActualWilsonLowerRate: number;
    averageDeltaVsActualRoePercent: number;
    medianDeltaVsActualRoePercent: number;
    medianDeltaVsSecondRoePercent: number;
  } | null;
  summary: string;
};

export function compareEntryPolicies(input: {
  estimatedFeeRoePercent: number;
  minimumSamples: number;
  opportunities: Array<{
    actualRoePercent: number;
    deeperLimit:
      | { status: "FILLED"; candidateRoePercent: number }
      | { status: "NOT_FILLED" };
    delayedReclaim:
      | { status: "ENTERED"; candidateRoePercent: number }
      | { status: "NO_CONFIRMATION" };
  }>;
}): EntryPolicyComparison {
  const fee = Math.max(
    0,
    Number.isFinite(input.estimatedFeeRoePercent)
      ? input.estimatedFeeRoePercent
      : 0,
  );
  const opportunities = input.opportunities.filter(
    (item) => Number.isFinite(item.actualRoePercent),
  );
  const minimumSamples = Math.max(1, Math.trunc(input.minimumSamples));
  const netValuesByPolicy = new Map<EntryPolicyName, number[]>();
  const buildMetrics = (
    policy: EntryPolicyName,
    values: Array<number | null>,
  ): EntryPolicyMetrics => {
    const netValues = values.map((value) =>
      value === null ? 0 : value - fee
    );
    const entered = values.filter((value) => value !== null).length;
    netValuesByPolicy.set(policy, netValues);
    return {
      policy,
      opportunities: values.length,
      entered,
      skipped: values.length - entered,
      averageNetRoePerOpportunity:
        netValues.reduce((sum, value) => sum + value, 0) /
        Math.max(1, netValues.length),
      medianNetRoePerOpportunity: median(netValues) ?? 0,
      positiveOpportunityRate:
        netValues.filter((value) => value > 0).length /
        Math.max(1, netValues.length),
      lossOpportunityRate:
        netValues.filter((value) => value < 0).length /
        Math.max(1, netValues.length),
    };
  };
  const policies = [
    buildMetrics(
      "ACTUAL_ENTRY",
      opportunities.map((item) => item.actualRoePercent),
    ),
    buildMetrics(
      "DEEPER_LIMIT",
      opportunities.map((item) =>
        item.deeperLimit.status === "FILLED"
          ? item.deeperLimit.candidateRoePercent
          : null
      ),
    ),
    buildMetrics(
      "DELAYED_RECLAIM",
      opportunities.map((item) =>
        item.delayedReclaim.status === "ENTERED"
          ? item.delayedReclaim.candidateRoePercent
          : null
      ),
    ),
  ];
  if (opportunities.length < minimumSamples) {
    return {
      sampleCount: opportunities.length,
      estimatedFeeRoePercent: fee,
      policies,
      preferredPolicy: "INSUFFICIENT",
      edgeVsActualRoePercent: null,
      pairedEvidence: null,
      summary: `仅有 ${opportunities.length} 个同口径机会，未达到 ${minimumSamples} 个最低样本。`,
    };
  }
  const actual = policies[0]!;
  const candidates = policies.slice(1).sort(
    (left, right) =>
      right.averageNetRoePerOpportunity -
      left.averageNetRoePerOpportunity,
  );
  const best = candidates[0]!;
  const second = candidates[1]!;
  const edgeVsActual =
    best.averageNetRoePerOpportunity -
    actual.averageNetRoePerOpportunity;
  const actualValues = netValuesByPolicy.get("ACTUAL_ENTRY")!;
  const bestValues = netValuesByPolicy.get(best.policy)!;
  const secondValues = netValuesByPolicy.get(second.policy)!;
  const deltasVsActual = bestValues.map(
    (value, index) => value - actualValues[index]!,
  );
  const deltasVsSecond = bestValues.map(
    (value, index) => value - secondValues[index]!,
  );
  const beatActualCount = deltasVsActual.filter((value) => value > 0).length;
  const beatActualRate = beatActualCount / opportunities.length;
  const beatActualWilsonLowerRate = wilsonLowerBound(
    beatActualCount,
    opportunities.length,
  );
  const averageDeltaVsActual =
    deltasVsActual.reduce((sum, value) => sum + value, 0) /
    deltasVsActual.length;
  const medianDeltaVsActual = median(deltasVsActual) ?? 0;
  const medianDeltaVsSecond = median(deltasVsSecond) ?? 0;
  const clearCandidateEdge =
    edgeVsActual >= 0.5 &&
    best.lossOpportunityRate <= actual.lossOpportunityRate - 0.1 &&
    best.averageNetRoePerOpportunity >=
      second.averageNetRoePerOpportunity + 0.25 &&
    medianDeltaVsActual >= 0.25 &&
    medianDeltaVsSecond >= 0.1 &&
    beatActualWilsonLowerRate > 0.5;
  return {
    sampleCount: opportunities.length,
    estimatedFeeRoePercent: fee,
    policies,
    preferredPolicy: clearCandidateEdge
      ? best.policy
      : "NO_CLEAR_EDGE",
    edgeVsActualRoePercent: edgeVsActual,
    pairedEvidence: {
      beatActualRate,
      beatActualWilsonLowerRate,
      averageDeltaVsActualRoePercent: averageDeltaVsActual,
      medianDeltaVsActualRoePercent: medianDeltaVsActual,
      medianDeltaVsSecondRoePercent: medianDeltaVsSecond,
    },
    summary: clearCandidateEdge
      ? `${best.policy} 按全部机会计入未成交为0并扣除估算往返手续费后，单机会平均净ROE比实际入场高 ${edgeVsActual.toFixed(2)} 个百分点，中位配对优势 ${medianDeltaVsActual.toFixed(2)}，逐机会胜出率 ${(beatActualRate * 100).toFixed(1)}%、95%保守下界 ${(beatActualWilsonLowerRate * 100).toFixed(1)}%，且亏损机会率至少下降10个百分点。`
      : "计入手续费和未成交机会成本后，没有替代方案同时通过平均优势、中位配对优势、保守胜率下界、下行改善及相对另一影子方案的领先门槛。",
  };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function wilsonLowerBound(successes: number, total: number) {
  if (total <= 0) return 0;
  const z = 1.959963984540054;
  const rate = successes / total;
  const denominator = 1 + z * z / total;
  const center = rate + z * z / (2 * total);
  const margin = z * Math.sqrt(
    rate * (1 - rate) / total + z * z / (4 * total * total),
  );
  return Math.max(0, (center - margin) / denominator);
}
