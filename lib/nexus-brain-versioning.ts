export const NEXUS_BRAIN_VERSIONING_MODEL =
  "nexus-brain-versioning-v1";

export function nextNexusBrainDraftVersion(input: {
  configVersion: number;
  publishedVersion: number;
  draftVersion: number;
}) {
  return Math.max(
    nonNegativeInteger(input.configVersion),
    nonNegativeInteger(input.publishedVersion),
    nonNegativeInteger(input.draftVersion),
  ) + 1;
}

export function hasUnpublishedNexusBrainDraft(input: {
  publishedVersion: number;
  draftVersion: number;
  draftConfigJson: string | null;
}) {
  return (
    nonNegativeInteger(input.draftVersion) >
      nonNegativeInteger(input.publishedVersion) &&
    Boolean(input.draftConfigJson)
  );
}

export function positionBoundConfigVersion(input: {
  boundConfigVersion: number;
  currentPublishedVersion: number;
}) {
  const bound = nonNegativeInteger(input.boundConfigVersion);
  if (bound < 1)
    throw new Error("POSITION_BOUND_VERSION_MISSING");
  nonNegativeInteger(input.currentPublishedVersion);
  return bound;
}

function nonNegativeInteger(value: number) {
  if (!Number.isInteger(value) || value < 0)
    throw new Error("INVALID_BRAIN_VERSION");
  return value;
}
