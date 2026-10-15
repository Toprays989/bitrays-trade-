export function pruneLiquidationFingerprints(
  fingerprints,
  now,
  retentionMs,
  maximumEntries,
) {
  for (const [fingerprint, receivedAt] of fingerprints) {
    if (receivedAt < now - retentionMs) fingerprints.delete(fingerprint);
  }
  while (fingerprints.size > maximumEntries) {
    const oldestFingerprint = fingerprints.keys().next().value;
    if (typeof oldestFingerprint !== "string") break;
    fingerprints.delete(oldestFingerprint);
  }
}

export function rememberLiquidationFingerprint(
  fingerprints,
  fingerprint,
  receivedAt,
  options,
) {
  if (fingerprints.has(fingerprint)) return false;
  fingerprints.set(fingerprint, receivedAt);
  pruneLiquidationFingerprints(
    fingerprints,
    receivedAt,
    options.retentionMs,
    options.maximumEntries,
  );
  return true;
}
