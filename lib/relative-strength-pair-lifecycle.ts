export type RelativeStrengthPairLeg = {
  id: number;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  leverage: number;
  openedAt: Date;
  riskPlanJson: string | null;
};

export type RelativeStrengthPairMark = {
  symbol: string;
  markPrice: number;
  time: number;
};

export type RelativeStrengthPairLifecycle = {
  version: "relative-strength-pair-lifecycle-v1";
  pairId: string;
  pairKey: string | null;
  state: "BALANCED" | "RECOVERING" | "IMBALANCED";
  observedAtMs: number;
  strongPositionId: number | null;
  weakPositionId: number | null;
  strongSymbol: string | null;
  weakSymbol: string | null;
  grossUnrealizedPnlUsdt: number | null;
  initialMarginUsdt: number | null;
  combinedRoePercent: number | null;
  entrySpreadRatio: number | null;
  currentSpreadRatio: number | null;
  spreadChangePercent: number | null;
  closeRequired: boolean;
  reasonCode: "PAIR_BALANCED" | "PAIR_RECOVERY_GRACE" | "PAIR_LEG_IMBALANCE";
};

export function relativeStrengthPairMetadata(planJson: string | null | undefined) {
  const plan = record(parse(planJson));
  const metadata = record(plan.relativeStrengthPair);
  return {
    pairId: text(metadata.pairId),
    pairKey: text(metadata.pairKey),
    peerSymbol: text(metadata.peerSymbol),
    leg: metadata.leg === "STRONG_LONG" || metadata.leg === "WEAK_SHORT"
      ? metadata.leg
      : null,
  } as const;
}

export function evaluateRelativeStrengthPairLifecycles(input: {
  positions: RelativeStrengthPairLeg[];
  marks: RelativeStrengthPairMark[];
  nowMs: number;
  recoveryGraceMs?: number;
}) {
  const graceMs = Math.max(5_000, input.recoveryGraceMs ?? 30_000);
  const marks = new Map(input.marks.map((row) => [row.symbol, row]));
  const groups = new Map<string, RelativeStrengthPairLeg[]>();
  for (const position of input.positions) {
    const metadata = relativeStrengthPairMetadata(position.riskPlanJson);
    if (!metadata.pairId) continue;
    const group = groups.get(metadata.pairId) ?? [];
    group.push(position);
    groups.set(metadata.pairId, group);
  }

  const byPositionId = new Map<number, RelativeStrengthPairLifecycle>();
  for (const [pairId, positions] of groups) {
    const strong = positions.find((position) =>
      relativeStrengthPairMetadata(position.riskPlanJson).leg === "STRONG_LONG"
    ) ?? null;
    const weak = positions.find((position) =>
      relativeStrengthPairMetadata(position.riskPlanJson).leg === "WEAK_SHORT"
    ) ?? null;
    const oldestOpenedAt = Math.min(
      ...positions.map((position) => position.openedAt.getTime()),
    );
    const complete = positions.length === 2 && Boolean(strong && weak);
    const withinGrace = input.nowMs - oldestOpenedAt < graceMs;
    const pairKey = positions
      .map((position) => relativeStrengthPairMetadata(position.riskPlanJson).pairKey)
      .find(Boolean) ?? null;
    const lifecycle = complete
      ? balancedLifecycle({ pairId, pairKey, strong: strong!, weak: weak!, marks, nowMs: input.nowMs })
      : {
          version: "relative-strength-pair-lifecycle-v1" as const,
          pairId,
          pairKey,
          state: withinGrace ? "RECOVERING" as const : "IMBALANCED" as const,
          observedAtMs: input.nowMs,
          strongPositionId: strong?.id ?? null,
          weakPositionId: weak?.id ?? null,
          strongSymbol: strong?.symbol ?? null,
          weakSymbol: weak?.symbol ?? null,
          grossUnrealizedPnlUsdt: null,
          initialMarginUsdt: null,
          combinedRoePercent: null,
          entrySpreadRatio: null,
          currentSpreadRatio: null,
          spreadChangePercent: null,
          closeRequired: !withinGrace,
          reasonCode: withinGrace
            ? "PAIR_RECOVERY_GRACE" as const
            : "PAIR_LEG_IMBALANCE" as const,
        };
    for (const position of positions) byPositionId.set(position.id, lifecycle);
  }
  return byPositionId;
}

function balancedLifecycle(input: {
  pairId: string;
  pairKey: string | null;
  strong: RelativeStrengthPairLeg;
  weak: RelativeStrengthPairLeg;
  marks: Map<string, RelativeStrengthPairMark>;
  nowMs: number;
}): RelativeStrengthPairLifecycle {
  const strongMark = input.marks.get(input.strong.symbol)?.markPrice ?? null;
  const weakMark = input.marks.get(input.weak.symbol)?.markPrice ?? null;
  const validMarks = positive(strongMark) && positive(weakMark);
  const strongPnl = validMarks
    ? (strongMark! - input.strong.entryPrice) * input.strong.quantity
    : null;
  const weakPnl = validMarks
    ? (input.weak.entryPrice - weakMark!) * input.weak.quantity
    : null;
  const margin =
    input.strong.entryPrice * input.strong.quantity / Math.max(1, input.strong.leverage) +
    input.weak.entryPrice * input.weak.quantity / Math.max(1, input.weak.leverage);
  const pnl = strongPnl === null || weakPnl === null ? null : strongPnl + weakPnl;
  const entrySpreadRatio = positive(input.weak.entryPrice)
    ? input.strong.entryPrice / input.weak.entryPrice
    : null;
  const currentSpreadRatio = validMarks ? strongMark! / weakMark! : null;
  const spreadChangePercent = positive(entrySpreadRatio) && positive(currentSpreadRatio)
    ? (currentSpreadRatio! / entrySpreadRatio! - 1) * 100
    : null;
  return {
    version: "relative-strength-pair-lifecycle-v1",
    pairId: input.pairId,
    pairKey: input.pairKey,
    state: "BALANCED",
    observedAtMs: input.nowMs,
    strongPositionId: input.strong.id,
    weakPositionId: input.weak.id,
    strongSymbol: input.strong.symbol,
    weakSymbol: input.weak.symbol,
    grossUnrealizedPnlUsdt: pnl,
    initialMarginUsdt: positive(margin) ? margin : null,
    combinedRoePercent: pnl !== null && positive(margin) ? pnl / margin * 100 : null,
    entrySpreadRatio,
    currentSpreadRatio,
    spreadChangePercent,
    closeRequired: false,
    reasonCode: "PAIR_BALANCED",
  };
}

function parse(value: string | null | undefined): unknown {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positive(value: number | null | undefined): value is number {
  return Number.isFinite(value) && Number(value) > 0;
}
