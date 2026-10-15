export type NexusEntryAuthorizationMode =
  | "CONFIRMED_EYE"
  | "EXPLORATION_PROBE";

type NexusEntryAuthorizationBase = {
  version: 1;
  explorationProbe: boolean;
};

export type NexusEntryAuthorization = NexusEntryAuthorizationBase & (
  | {
      mode: NexusEntryAuthorizationMode;
      authorized: true;
      source:
        | "FROZEN_EXECUTION_DECISION"
        | "EXPLICIT_EXECUTION_AUTHORIZATION";
    }
  | {
      mode: "EXPLORATION_PROBE";
      authorized: false;
      source: "LEGACY_EXPLORATION_POLICY";
    }
  | {
      mode: null;
      authorized: false;
      source:
        | "MISSING_EXECUTION_AUTHORIZATION"
        | "DIRECTION_DECISION_MISMATCH";
    }
);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function modeFrom(value: unknown): NexusEntryAuthorizationMode | null {
  return value === "CONFIRMED_EYE" || value === "EXPLORATION_PROBE"
    ? value
    : null;
}

export function entryAuthorizationEvidence(
  mode: NexusEntryAuthorizationMode,
  detail: Record<string, unknown> = {},
) {
  return {
    version: 1 as const,
    mode,
    explorationProbe: mode === "EXPLORATION_PROBE",
    decidedAt: new Date().toISOString(),
    ...detail,
  };
}

/**
 * Resolve the identity that is allowed to submit the order.
 *
 * A trace may retain an earlier exploration candidate for learning. Once the
 * brain confirms the opportunity, the frozen decision is authoritative and
 * that retained candidate must never downgrade the real order to a probe.
 */
export function resolveNexusEntryAuthorization(
  evidence: unknown,
  options: {
    allowLegacy?: boolean;
    expectedPositionSide?: "LONG" | "SHORT";
  } = {},
): NexusEntryAuthorization {
  const source = record(evidence);
  const directionDecision = record(source.nexusDirectionDecision);
  if (
    options.expectedPositionSide &&
    Object.keys(directionDecision).length > 0 &&
    (
      directionDecision.outcome !== "SELECTED" ||
      directionDecision.selectedDirection !== options.expectedPositionSide
    )
  ) {
    return {
      version: 1,
      mode: null,
      authorized: false,
      explorationProbe: false,
      source: "DIRECTION_DECISION_MISMATCH",
    };
  }
  const frozen = record(source.frozenExecutionDecision);
  if (
    frozen.approved === true &&
    frozen.decisionFrozen === true &&
    frozen.retryWithoutReanalysis === true &&
    typeof frozen.approvedAt === "string" &&
    frozen.approvedAt.trim().length > 0 &&
    typeof frozen.approvalCode === "string" &&
    frozen.approvalCode.trim().length > 0
  ) {
    const explorationProbe = frozen.explorationProbe === true;
    return {
      version: 1,
      mode: explorationProbe ? "EXPLORATION_PROBE" : "CONFIRMED_EYE",
      authorized: true,
      explorationProbe,
      source: "FROZEN_EXECUTION_DECISION",
    };
  }

  const explicit = record(source.executionAuthorization);
  const explicitMode = modeFrom(explicit.mode);
  if (explicitMode !== null) {
    return {
      version: 1,
      mode: explicitMode,
      authorized: true,
      explorationProbe: explicitMode === "EXPLORATION_PROBE",
      source: "EXPLICIT_EXECUTION_AUTHORIZATION",
    };
  }

  const legacy = record(source.explorationOrderFirst);
  const legacyPhase = String(legacy.phase ?? "");
  const legacyPreEntryAnalysis = String(
    legacy.preEntryTechnicalAnalysis ?? "",
  );
  const legacyPersistedProbe =
    [
      "EXPLORATION_10",
      "EXPLORATION_100",
      "EXPLORATION_150",
      "DAILY_REINFORCEMENT",
    ].includes(legacyPhase) &&
    [
      "DEFERRED_TO_POST_ENTRY",
      "PARTIAL_DEFERRED_TO_POST_ENTRY",
    ].includes(legacyPreEntryAnalysis);
  if (
    options.allowLegacy === true &&
    (
      legacy.allowed === true ||
      legacy.orderFirstAllowed === true ||
      legacyPersistedProbe
    )
  ) {
    return {
      version: 1,
      mode: "EXPLORATION_PROBE",
      authorized: false,
      explorationProbe: true,
      source: "LEGACY_EXPLORATION_POLICY",
    };
  }

  return {
    version: 1,
    mode: null,
    authorized: false,
    explorationProbe: false,
    source: "MISSING_EXECUTION_AUTHORIZATION",
  };
}

export function isNexusExplorationEntry(evidence: unknown) {
  return resolveNexusEntryAuthorization(evidence, { allowLegacy: true })
    .explorationProbe;
}
