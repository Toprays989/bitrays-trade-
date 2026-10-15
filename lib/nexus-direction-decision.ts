export const NEXUS_DIRECTION_DECISION_VERSION =
  "nexus-direction-decision-v1" as const;

export type NexusTradeDirection = "LONG" | "SHORT";

export type NexusDirectionCapability =
  | "FIXED_DIRECTION"
  | "INDEPENDENT_DIRECTION_BRANCHES"
  | "COMPETING_DIRECTIONS"
  | "COORDINATED_PAIR";

export type NexusDirectionDecisionMode =
  | "TRIGGER_DIRECTED"
  | "COMPETING_DIRECTIONS";

export type NexusConfiguredDirection =
  | "LONG_ONLY"
  | "SHORT_ONLY"
  | "BOTH";

export type NexusDirectionBranchStatus =
  | "ELIGIBLE"
  | "WAIT"
  | "REJECTED";

export type NexusDirectionBranchEvaluation = Readonly<{
  direction: NexusTradeDirection;
  factSnapshotId: string;
  evaluatedAt: number;
  expiresAt: number;
  status: NexusDirectionBranchStatus;
  evidenceComplete: boolean;
  structureValid: boolean;
  netExpectancyRoePercent: number | null;
  expectedUpsideRoePercent: number | null;
  expectedDownsideRoePercent: number | null;
  uncertaintyRoePercent: number | null;
  reasonCodes: readonly string[];
}>;

export type NexusDirectionDecisionPolicy = Readonly<{
  minimumNetExpectancyRoePercent: number;
  minimumRewardRiskRatio: number;
  minimumDirectionAdvantageRoePercent: number;
  maximumUncertaintyRoePercent: number;
}>;

export type NexusDirectionDecisionIdentity = Readonly<{
  strategyId: number;
  brainKey: string;
  configVersion: number;
  ownerEmail: string;
  accountId: string;
  symbol: string;
  triggerKind: string;
  triggerSourceId: string;
  factSnapshotId: string;
}>;

export type NexusDirectionDecisionReason =
  | "DIRECTION_SELECTED"
  | "DECISION_CONTEXT_INVALID"
  | "DIRECTION_SCOPE_MISMATCH"
  | "POST_DECISION_DIRECTION_TRANSFORM_FORBIDDEN"
  | "COORDINATED_PAIR_REQUIRES_PAIR_DECISION"
  | "DIRECTION_BRANCH_MISSING"
  | "DIRECTION_BRANCH_INVALID"
  | "NO_POSITIVE_NET_EXPECTANCY"
  | "DIRECTION_ADVANTAGE_INSUFFICIENT";

export type NexusDirectionDecision = Readonly<{
  version: typeof NEXUS_DIRECTION_DECISION_VERSION;
  decisionGroupId: string;
  decisionAt: number;
  capability: NexusDirectionCapability;
  outcome: "SELECTED" | "WAIT";
  selectedDirection: NexusTradeDirection | null;
  reasonCode: NexusDirectionDecisionReason;
  reason: string;
  policy: NexusDirectionDecisionPolicy | null;
  branches: readonly NexusDirectionBranchEvaluation[];
  factSnapshotId: string | null;
  /** High multihour disagreement caps sizing at the exchange minimum; it
   * does not erase a current structure-valid candidate. */
  maximumQuantityMultiplier: 1 | 2;
  orderAffecting: false;
  canAuthorizeOrder: false;
  singleRealIntentPerDecisionGroup: true;
}>;

const INVALID_DECISION_GROUP_ID = "nqdd-invalid";
const EPSILON = 1e-9;

/**
 * Declares how a strategy may reason about direction. This is a brain-stage
 * capability only; Binance Hedge Mode never upgrades it to two real orders.
 */
export function resolveNexusDirectionCapability(input: {
  configuredDirection?: NexusConfiguredDirection | null;
  marketProfileMode?: string | null;
  decisionMode?: NexusDirectionDecisionMode | null;
}): NexusDirectionCapability {
  if (input.marketProfileMode === "RELATIVE_STRENGTH")
    return "COORDINATED_PAIR";
  if (input.configuredDirection !== "BOTH") return "FIXED_DIRECTION";
  return input.decisionMode === "COMPETING_DIRECTIONS"
    ? "COMPETING_DIRECTIONS"
    : "INDEPENDENT_DIRECTION_BRANCHES";
}

/**
 * Compares direction paths after both have evaluated one immutable market-fact
 * snapshot. The result still cannot authorize an order; it is consumed by the
 * existing entry-authorization stage.
 */
export function selectNexusDirectionDecision(input: Readonly<{
  identity: NexusDirectionDecisionIdentity;
  capability: NexusDirectionCapability;
  configuredDirection: NexusConfiguredDirection;
  executionDirectionMode?: "FOLLOW_BRAIN" | "INVERSE_BRAIN";
  decisionAt: number;
  policy: NexusDirectionDecisionPolicy;
  branches: readonly NexusDirectionBranchEvaluation[];
}>): NexusDirectionDecision {
  const identity = normalizeIdentity(input.identity);
  const decisionGroupId = identity
    ? nexusDirectionDecisionGroupId(identity)
    : INVALID_DECISION_GROUP_ID;
  const policy = normalizePolicy(input.policy);
  const branches = Object.freeze(input.branches.map(copyBranch));
  const base = {
    version: NEXUS_DIRECTION_DECISION_VERSION,
    decisionGroupId,
    decisionAt: input.decisionAt,
    capability: input.capability,
    policy,
    branches,
    factSnapshotId: identity?.factSnapshotId ?? null,
    maximumQuantityMultiplier: 1 as const,
    orderAffecting: false as const,
    canAuthorizeOrder: false as const,
    singleRealIntentPerDecisionGroup: true as const,
  };

  if (!identity || !validTimestamp(input.decisionAt) || !policy) {
    return waitDecision(
      base,
      "DECISION_CONTEXT_INVALID",
      "方向决策身份、时间或公共阈值无效，保持等待",
    );
  }

  if (input.capability === "COORDINATED_PAIR") {
    return waitDecision(
      base,
      "COORDINATED_PAIR_REQUIRES_PAIR_DECISION",
      "双腿配对策略必须进入独立的配对决策器，不能复用单方向胜者选择",
    );
  }

  if (input.capability === "INDEPENDENT_DIRECTION_BRANCHES") {
    return waitDecision(
      base,
      "DIRECTION_SCOPE_MISMATCH",
      "旧版独立多空监听不能进入同快照方向裁决，请继续使用原方向路由",
    );
  }

  if (input.executionDirectionMode === "INVERSE_BRAIN") {
    return waitDecision(
      base,
      "POST_DECISION_DIRECTION_TRANSFORM_FORBIDDEN",
      "完成多空比较后禁止再次翻转方向；反向实验必须作为独立方向路径参与同轮比较",
    );
  }

  if (!scopeMatchesCapability(
    input.capability,
    input.configuredDirection,
  )) {
    return waitDecision(
      base,
      "DIRECTION_SCOPE_MISMATCH",
      "策略方向范围与方向决策能力不一致，保持等待",
    );
  }

  const expectedDirections = configuredDirections(input.configuredDirection);
  const byDirection = new Map<NexusTradeDirection, NexusDirectionBranchEvaluation>();
  for (const branch of branches) {
    if (byDirection.has(branch.direction)) {
      return waitDecision(
        base,
        "DIRECTION_BRANCH_INVALID",
        "同一方向存在重复判断结果，无法形成唯一结论",
      );
    }
    byDirection.set(branch.direction, branch);
  }

  if (expectedDirections.some((direction) => !byDirection.has(direction))) {
    return waitDecision(
      base,
      "DIRECTION_BRANCH_MISSING",
      "配置要求的方向路径尚未全部完成判断",
    );
  }

  const expectedBranches = expectedDirections.map((direction) =>
    byDirection.get(direction)!
  );
  if (expectedBranches.some((branch) =>
    !validBranch(branch, identity.factSnapshotId, input.decisionAt)
  )) {
    return waitDecision(
      base,
      "DIRECTION_BRANCH_INVALID",
      "方向路径未使用同一事实快照，或判断结果已经过期",
    );
  }

  const eligible = expectedBranches
    .filter((branch) => passesSharedPolicy(branch, policy))
    .sort((left, right) =>
      Number(right.netExpectancyRoePercent) -
        Number(left.netExpectancyRoePercent) ||
      left.direction.localeCompare(right.direction)
    );

  if (eligible.length === 0) {
    return waitDecision(
      base,
      "NO_POSITIVE_NET_EXPECTANCY",
      "多空方向均未同时通过结构、成本、收益风险和不确定性要求",
    );
  }

  if (eligible.length > 1) {
    const advantage = Number(eligible[0].netExpectancyRoePercent) -
      Number(eligible[1].netExpectancyRoePercent);
    if (
      advantage <=
        policy.minimumDirectionAdvantageRoePercent + EPSILON
    ) {
      return waitDecision(
        base,
        "DIRECTION_ADVANTAGE_INSUFFICIENT",
        "多空净期望差距不足，无法证明任一方向具有明确优势",
      );
    }
  }

  const winner = eligible[0];
  return Object.freeze({
    ...base,
    outcome: "SELECTED" as const,
    selectedDirection: winner.direction,
    reasonCode: "DIRECTION_SELECTED" as const,
    reason: `已选择 ${winner.direction}，后续仍需通过统一入场授权`,
    maximumQuantityMultiplier: maximumQuantityMultiplier(
      winner,
      policy,
    ),
  });
}

export function nexusDirectionDecisionGroupId(
  identity: NexusDirectionDecisionIdentity,
) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error("方向决策身份无效");
  return `nqdd-${fnv1a64(stableSerialize(normalized))}`;
}

function waitDecision(
  base: Omit<
    NexusDirectionDecision,
    "outcome" | "selectedDirection" | "reasonCode" | "reason"
  >,
  reasonCode: Exclude<NexusDirectionDecisionReason, "DIRECTION_SELECTED">,
  reason: string,
): NexusDirectionDecision {
  return Object.freeze({
    ...base,
    outcome: "WAIT" as const,
    selectedDirection: null,
    reasonCode,
    reason,
  });
}

function scopeMatchesCapability(
  capability: NexusDirectionCapability,
  configuredDirection: NexusConfiguredDirection,
) {
  if (capability === "COMPETING_DIRECTIONS")
    return configuredDirection === "BOTH";
  return configuredDirection !== "BOTH";
}

function configuredDirections(
  configuredDirection: NexusConfiguredDirection,
): NexusTradeDirection[] {
  if (configuredDirection === "LONG_ONLY") return ["LONG"];
  if (configuredDirection === "SHORT_ONLY") return ["SHORT"];
  return ["LONG", "SHORT"];
}

function passesSharedPolicy(
  branch: NexusDirectionBranchEvaluation,
  policy: NexusDirectionDecisionPolicy,
) {
  if (
    branch.status !== "ELIGIBLE" ||
    !branch.evidenceComplete ||
    !branch.structureValid
  ) return false;
  const net = finiteNumber(branch.netExpectancyRoePercent);
  const upside = finiteNumber(branch.expectedUpsideRoePercent);
  const downside = finiteNumber(branch.expectedDownsideRoePercent);
  const uncertainty = finiteNumber(branch.uncertaintyRoePercent);
  if (
    net === null ||
    upside === null ||
    downside === null ||
    uncertainty === null ||
    upside <= 0 ||
    downside <= 0 ||
    uncertainty < 0
  ) return false;
  return net > policy.minimumNetExpectancyRoePercent + EPSILON &&
    upside / downside >= policy.minimumRewardRiskRatio;
}

function maximumQuantityMultiplier(
  branch: NexusDirectionBranchEvaluation,
  policy: NexusDirectionDecisionPolicy,
): 1 | 2 {
  const uncertainty = finiteNumber(branch.uncertaintyRoePercent);
  if (uncertainty === null) return 1;
  // The configured uncertainty threshold is now a full-size threshold. A
  // current structure-valid path remains eligible at the exchange minimum.
  return uncertainty <= policy.maximumUncertaintyRoePercent + EPSILON ? 2 : 1;
}

function validBranch(
  branch: NexusDirectionBranchEvaluation,
  factSnapshotId: string,
  decisionAt: number,
) {
  return (branch.direction === "LONG" || branch.direction === "SHORT") &&
    branch.factSnapshotId === factSnapshotId &&
    validTimestamp(branch.evaluatedAt) &&
    branch.evaluatedAt <= decisionAt &&
    validTimestamp(branch.expiresAt) &&
    branch.expiresAt > decisionAt &&
    Array.isArray(branch.reasonCodes);
}

function normalizePolicy(
  policy: NexusDirectionDecisionPolicy,
): NexusDirectionDecisionPolicy | null {
  const minimumNetExpectancyRoePercent = finiteNumber(
    policy.minimumNetExpectancyRoePercent,
  );
  const minimumRewardRiskRatio = finiteNumber(policy.minimumRewardRiskRatio);
  const minimumDirectionAdvantageRoePercent = finiteNumber(
    policy.minimumDirectionAdvantageRoePercent,
  );
  const maximumUncertaintyRoePercent = finiteNumber(
    policy.maximumUncertaintyRoePercent,
  );
  if (
    minimumNetExpectancyRoePercent === null ||
    minimumRewardRiskRatio === null ||
    minimumDirectionAdvantageRoePercent === null ||
    maximumUncertaintyRoePercent === null ||
    minimumRewardRiskRatio <= 0 ||
    minimumDirectionAdvantageRoePercent < 0 ||
    maximumUncertaintyRoePercent < 0
  ) return null;
  return Object.freeze({
    minimumNetExpectancyRoePercent,
    minimumRewardRiskRatio,
    minimumDirectionAdvantageRoePercent,
    maximumUncertaintyRoePercent,
  });
}

function normalizeIdentity(
  identity: NexusDirectionDecisionIdentity,
): NexusDirectionDecisionIdentity | null {
  const strategyId = Number(identity.strategyId);
  const configVersion = Number(identity.configVersion);
  const brainKey = requiredText(identity.brainKey);
  const ownerEmail = requiredText(identity.ownerEmail)?.toLowerCase() ?? null;
  const accountId = requiredText(identity.accountId);
  const symbol = requiredText(identity.symbol)?.toUpperCase() ?? null;
  const triggerKind = requiredText(identity.triggerKind);
  const triggerSourceId = requiredText(identity.triggerSourceId);
  const factSnapshotId = requiredText(identity.factSnapshotId);
  if (
    !Number.isInteger(strategyId) ||
    strategyId <= 0 ||
    !Number.isInteger(configVersion) ||
    configVersion <= 0 ||
    !brainKey ||
    !ownerEmail ||
    !accountId ||
    !symbol ||
    !triggerKind ||
    !triggerSourceId ||
    !factSnapshotId
  ) return null;
  return Object.freeze({
    strategyId,
    brainKey,
    configVersion,
    ownerEmail,
    accountId,
    symbol,
    triggerKind,
    triggerSourceId,
    factSnapshotId,
  });
}

function copyBranch(
  branch: NexusDirectionBranchEvaluation,
): NexusDirectionBranchEvaluation {
  return Object.freeze({
    ...branch,
    reasonCodes: Object.freeze(
      Array.isArray(branch.reasonCodes) ? [...branch.reasonCodes] : [],
    ),
  });
}

function requiredText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validTimestamp(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(",")}}`;
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
