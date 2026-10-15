import { sentinelDuplicateExposure } from "./multi-account-sentinel.ts";

type ExposureRow = {
  ownerEmail: string;
  accountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
};

type OrderExposureRow = ExposureRow & { status: string };

export type GlobalSentinelProbeFeedback = {
  factId: string;
  accountId: string | null;
  symbol: string | null;
  positionSide: "LONG" | "SHORT" | null;
  exactNetPnlUsdt: number | null;
  eyeCalibration: string;
};

export function buildGlobalSentinelObservation(input: {
  ownerEmail: string;
  observerAccountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  observedAt: number;
  positions: ExposureRow[];
  orders: OrderExposureRow[];
  probeFeedback?: GlobalSentinelProbeFeedback[];
}) {
  const oppositeDirection = input.positionSide === "LONG" ? "SHORT" : "LONG";
  const sameDirectionExposure = sentinelDuplicateExposure({
    ownerEmail: input.ownerEmail,
    sentinelAccountId: input.observerAccountId,
    symbol: input.symbol,
    positionSide: input.positionSide,
    positions: input.positions,
    orders: input.orders,
  });
  const oppositeDirectionExposure = sentinelDuplicateExposure({
    ownerEmail: input.ownerEmail,
    sentinelAccountId: input.observerAccountId,
    symbol: input.symbol,
    positionSide: oppositeDirection,
    positions: input.positions,
    orders: input.orders,
  });
  const sameDirectionAccountIds = sameDirectionExposure.duplicateAccountIds;
  const oppositeDirectionAccountIds =
    oppositeDirectionExposure.duplicateAccountIds;
  const directionalContext = sameDirectionAccountIds.length >= 2 &&
      sameDirectionAccountIds.length > oppositeDirectionAccountIds.length
    ? "SAME_DIRECTION_CROWDED" as const
    : oppositeDirectionAccountIds.length >= 2 &&
        oppositeDirectionAccountIds.length > sameDirectionAccountIds.length
      ? "OPPOSITE_DIRECTION_DOMINANT" as const
      : sameDirectionAccountIds.length > 0 &&
          oppositeDirectionAccountIds.length > 0
        ? "TWO_SIDED" as const
        : "SPARSE" as const;
  const matchingProbeFeedback = (input.probeFeedback ?? []).filter(
    (item) =>
      item.symbol?.trim().toUpperCase() === input.symbol.trim().toUpperCase() &&
      item.positionSide === input.positionSide,
  );
  const exactProbeResults = matchingProbeFeedback
    .map((item) => Number(item.exactNetPnlUsdt))
    .filter((value) => Number.isFinite(value));
  const probeOutcomeContext = Object.freeze({
    sampleCount: exactProbeResults.length,
    profitableCount: exactProbeResults.filter((value) => value > 0).length,
    losingCount: exactProbeResults.filter((value) => value < 0).length,
    exactNetPnlUsdt: Number(
      exactProbeResults.reduce((sum, value) => sum + value, 0).toFixed(8),
    ),
    eyeVerifiedCount: matchingProbeFeedback.filter(
      (item) => item.eyeCalibration === "EVIDENCE_VERIFIED",
    ).length,
    eyeContradictedCount: matchingProbeFeedback.filter(
      (item) => item.eyeCalibration === "EVIDENCE_CONTRADICTED",
    ).length,
  });
  return Object.freeze({
    version: 1 as const,
    id: [
      "nqsentinel",
      input.symbol.trim().toUpperCase(),
      input.positionSide,
      Math.max(0, Math.trunc(input.observedAt)),
    ].join(":"),
    authority: "OBSERVATION_ONLY" as const,
    orderAffecting: false as const,
    canAuthorizeOrder: false as const,
    source: "GLOBAL_MULTI_ACCOUNT_EXPOSURE" as const,
    observedAt: input.observedAt,
    symbol: input.symbol.trim().toUpperCase(),
    positionSide: input.positionSide,
    observerAccountId: input.observerAccountId,
    sameDirectionAccountIds: Object.freeze([...sameDirectionAccountIds]),
    oppositeDirectionAccountIds: Object.freeze([
      ...oppositeDirectionAccountIds,
    ]),
    directionalContext,
    sameDirectionExposure,
    oppositeDirectionExposure,
    probeOutcomeContext,
    summary:
      `跨账户同向 ${sameDirectionAccountIds.length}、反向 ${oppositeDirectionAccountIds.length}；` +
      `同合约同方向完整探针 ${probeOutcomeContext.sampleCount} 笔；` +
      "仅作为各大脑的实时价值尺度对照，不单独批准或拒绝订单",
  });
}
