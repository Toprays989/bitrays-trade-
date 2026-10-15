export function maximumAllowedLeverageFromError(
  error: unknown,
): number | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const value = Number(
    /当前最多允许\s+(\d+)x\s+杠杆/i.exec(message)?.[1] ??
      /restricted from using leverage greater than\s+(\d+)x/i.exec(message)?.[1] ??
      0,
  );
  return Number.isInteger(value) && value >= 1 ? value : null;
}
