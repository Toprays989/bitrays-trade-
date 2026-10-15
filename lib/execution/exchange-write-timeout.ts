export function exchangeWriteTimeoutIsExecutionUnknown(
  error: unknown,
  enabled: boolean,
) {
  if (!enabled || !error || typeof error !== "object") return false;
  return Number((error as { status?: unknown }).status) === 504;
}
