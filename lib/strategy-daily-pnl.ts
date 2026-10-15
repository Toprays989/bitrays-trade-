import { reductionAccountingPnl } from "./live-reduction-accounting.ts";
import { readNexusPositionMemory } from "./nexus-position-memory.ts";

type StrategyPnlPosition = {
  id: number;
  status: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  realizedPnl: number;
  riskPlanJson: string | null;
  lifecycleId: string | null;
  entryDecisionHandoffJson: string | null;
  closedAt: Date | null;
};

type StrategyPnlReduction = {
  positionId: number;
  realizedPnl: number;
  responseJson: string | null;
};

export function calculateTradingStrategyDailyPnl(input: {
  strategyId: number;
  dayStartedAt: Date;
  positions: StrategyPnlPosition[];
  reductionsToday: StrategyPnlReduction[];
  strategyTraceIds?: Iterable<string>;
}) {
  const strategyTraceIds = new Set(input.strategyTraceIds ?? []);
  const positions = input.positions.filter((position) => {
    const memory = readNexusPositionMemory(position.riskPlanJson, {
      lifecycleId: position.lifecycleId,
      entryDecisionHandoffJson: position.entryDecisionHandoffJson,
    });
    return memory.strategyId === input.strategyId ||
      (memory.strategyId === null &&
        Boolean(position.lifecycleId) &&
        strategyTraceIds.has(position.lifecycleId!));
  });
  const attributedPositionIds = new Set(positions.map((position) => position.id));
  const reductionsToday = input.reductionsToday.filter((reduction) =>
    attributedPositionIds.has(reduction.positionId)
  );
  const openPositions = positions.filter((position) => position.status === "OPEN");
  const unrealizedPnl = openPositions.reduce(
    (sum, position) =>
      sum +
      (position.markPrice - position.entryPrice) *
        position.quantity *
        (position.positionSide === "LONG" ? 1 : -1),
    0,
  );
  const reducedPositionIds = new Set(
    reductionsToday.map((reduction) => reduction.positionId),
  );
  const standaloneClosedToday = positions.filter(
    (position) =>
      position.status === "CLOSED" &&
      Boolean(position.closedAt) &&
      position.closedAt! >= input.dayStartedAt &&
      !reducedPositionIds.has(position.id),
  );
  const dailyRealizedPnl =
    reductionsToday.reduce(
      (sum, reduction) => sum + reductionAccountingPnl(reduction).pnl,
      0,
    ) +
    standaloneClosedToday.reduce(
      (sum, position) => sum + position.realizedPnl,
      0,
    );

  return {
    openPositions,
    unrealizedPnl,
    dailyRealizedPnl,
    dailyPnl: dailyRealizedPnl + unrealizedPnl,
  };
}
