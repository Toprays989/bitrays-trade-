export function accountDailyUnrealizedPnlChange(
  currentUnrealizedPnl: number,
  dayStartUnrealizedPnl: number,
) {
  if (
    !Number.isFinite(currentUnrealizedPnl) ||
    !Number.isFinite(dayStartUnrealizedPnl)
  )
    return 0;
  return currentUnrealizedPnl - dayStartUnrealizedPnl;
}
