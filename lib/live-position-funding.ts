import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../db";
import { livePositions } from "../db/schema";
import type { ReductionSettlement } from "./live-reduction-accounting";
import { hasOverlappingFundingPosition } from "./live-position-funding-overlap";

export type FinalPositionFundingContext = {
  attribution: ReductionSettlement["fundingAttribution"];
  openedAtMs: number;
  closedAtMs: number;
};

export async function resolveFinalPositionFundingContext(input: {
  position: typeof livePositions.$inferSelect;
  isFinalReduction: boolean;
  closedAt: Date;
}): Promise<FinalPositionFundingContext | null> {
  if (!input.isFinalReduction) return null;
  const candidates = await getDb()
    .select({
      id: livePositions.id,
      openedAt: livePositions.openedAt,
      closedAt: livePositions.closedAt,
    })
    .from(livePositions)
    .where(and(
      eq(livePositions.ownerEmail, input.position.ownerEmail),
      eq(livePositions.accountId, input.position.accountId),
      eq(livePositions.symbol, input.position.symbol),
      lte(livePositions.openedAt, input.closedAt),
      or(
        isNull(livePositions.closedAt),
        gte(livePositions.closedAt, input.position.openedAt),
      ),
    ));
  const overlapping = hasOverlappingFundingPosition({
    positionId: input.position.id,
    openedAtMs: input.position.openedAt.getTime(),
    closedAtMs: input.closedAt.getTime(),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      openedAtMs: candidate.openedAt.getTime(),
      closedAtMs: candidate.closedAt?.getTime() ?? null,
    })),
  });
  return {
    attribution: overlapping
      ? "OVERLAPPING_POSITION"
      : "SYSTEM_UNIQUE_POSITION",
    openedAtMs: input.position.openedAt.getTime(),
    closedAtMs: input.closedAt.getTime(),
  };
}
