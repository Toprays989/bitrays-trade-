export function hasOverlappingFundingPosition(input: {
  positionId: number;
  openedAtMs: number;
  closedAtMs: number;
  candidates: Array<{
    id: number;
    openedAtMs: number;
    closedAtMs: number | null;
  }>;
}) {
  return input.candidates.some((candidate) =>
    candidate.id !== input.positionId &&
    candidate.openedAtMs <= input.closedAtMs &&
    (
      candidate.closedAtMs === null ||
      candidate.closedAtMs >= input.openedAtMs
    )
  );
}
