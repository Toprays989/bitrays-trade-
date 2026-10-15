export const EXECUTION_INTENT_OWNERSHIP_CONTRACT_VERSION =
  "execution-intent-ownership-v1" as const;

export type ExecutionIntentPurpose =
  | "OPEN_POSITION"
  | "INCREASE_POSITION"
  | "REDUCE_POSITION"
  | "CLOSE_POSITION";

export type ExecutionIntentAuthoritySource =
  | "ENTRY_BRAIN"
  | "POSITION_BRAIN"
  | "EMERGENCY_PROTECTION"
  | "MANUAL_OPERATOR";

export type ExecutionIntentRiskEffect =
  | "INCREASE_EXPOSURE"
  | "DECREASE_EXPOSURE";

export type ExecutionIntentOwnership = Readonly<{
  contractVersion: typeof EXECUTION_INTENT_OWNERSHIP_CONTRACT_VERSION;
  intentPurpose: ExecutionIntentPurpose;
  authoritySource: ExecutionIntentAuthoritySource;
  riskEffect: ExecutionIntentRiskEffect;
  livePositionId: number | null;
  positionHandoffKey: string | null;
}>;

const ENTRY_PURPOSES = new Set<ExecutionIntentPurpose>([
  "OPEN_POSITION",
  "INCREASE_POSITION",
]);

const ENTRY_AUTHORITIES = new Set<ExecutionIntentAuthoritySource>([
  "ENTRY_BRAIN",
  "MANUAL_OPERATOR",
]);

const POSITION_AUTHORITIES = new Set<ExecutionIntentAuthoritySource>([
  "POSITION_BRAIN",
  "EMERGENCY_PROTECTION",
  "MANUAL_OPERATOR",
]);

export function buildExecutionIntentOwnership(input: {
  intentPurpose: ExecutionIntentPurpose;
  authoritySource: ExecutionIntentAuthoritySource;
  livePositionId?: number | null;
  positionHandoffKey?: string | null;
}): ExecutionIntentOwnership {
  const ownership: ExecutionIntentOwnership = {
    contractVersion: EXECUTION_INTENT_OWNERSHIP_CONTRACT_VERSION,
    intentPurpose: input.intentPurpose,
    authoritySource: input.authoritySource,
    riskEffect: ENTRY_PURPOSES.has(input.intentPurpose)
      ? "INCREASE_EXPOSURE"
      : "DECREASE_EXPOSURE",
    livePositionId: positiveIntegerOrNull(input.livePositionId),
    positionHandoffKey: optionalString(input.positionHandoffKey),
  };
  const validation = validateExecutionIntentOwnership(ownership);
  if (!validation.valid) throw new Error(validation.issues[0]);
  return ownership;
}

export function validateExecutionIntentOwnership(
  ownership: ExecutionIntentOwnership,
) {
  const issues: string[] = [];
  const entryPurpose = ENTRY_PURPOSES.has(ownership.intentPurpose);

  if (entryPurpose && !ENTRY_AUTHORITIES.has(ownership.authoritySource))
    issues.push("持仓域不能创建新增风险意图");
  if (!entryPurpose && !POSITION_AUTHORITIES.has(ownership.authoritySource))
    issues.push("入场域不能创建减仓或平仓意图");

  if (ownership.intentPurpose === "OPEN_POSITION") {
    if (ownership.livePositionId !== null)
      issues.push("首次开仓意图不能绑定既有仓位");
    if (ownership.positionHandoffKey !== null)
      issues.push("首次开仓意图不能绑定既有成交交接");
  } else {
    if (ownership.livePositionId === null)
      issues.push("非开仓意图必须绑定真实仓位");
    if (ownership.positionHandoffKey === null)
      issues.push("非开仓意图必须绑定成交交接");
  }

  return {
    valid: issues.length === 0,
    issues,
  } as const;
}

/**
 * Compatibility is limited to execution intents created before the ownership
 * contract existed. All TypeScript callers must now provide the two fields;
 * persisted legacy rows are interpreted as entry-brain open intents.
 */
export function executionIntentOwnershipOrLegacyEntry(input: {
  intentPurpose?: ExecutionIntentPurpose | null;
  authoritySource?: ExecutionIntentAuthoritySource | null;
  livePositionId?: number | null;
  positionHandoffKey?: string | null;
}) {
  return buildExecutionIntentOwnership({
    intentPurpose: input.intentPurpose ?? "OPEN_POSITION",
    authoritySource: input.authoritySource ?? "ENTRY_BRAIN",
    livePositionId: input.livePositionId,
    positionHandoffKey: input.positionHandoffKey,
  });
}

function positiveIntegerOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

