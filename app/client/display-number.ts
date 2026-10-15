export function formatCompactDecimal(
  value: number | null | undefined,
  maximumFractionDigits = 8,
  fallback = "—",
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const digits = Math.max(0, Math.min(15, Math.trunc(maximumFractionDigits)));
  const fixed = value.toFixed(digits);
  const compact = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  return compact === "-0" ? "0" : compact;
}

export function formatCompactSignedDecimal(
  value: number | null | undefined,
  maximumFractionDigits = 8,
  fallback = "—",
) {
  const formatted = formatCompactDecimal(
    value,
    maximumFractionDigits,
    fallback,
  );
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? `+${formatted}`
    : formatted;
}
