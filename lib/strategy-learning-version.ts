// This version describes how already-recorded evidence is interpreted.
// Changing it must not isolate trades that were produced by the same decision
// engine; those trades can be re-analyzed under the latest learning schema.
export const STRATEGY_LEARNING_SCHEMA_VERSION =
  "post-entry-nexus-cycle-20260726-v35";

export function learningSchemaVersionFromEvidence(
  evidence: Record<string, unknown>,
) {
  const value = evidence.learningSchemaVersion;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
