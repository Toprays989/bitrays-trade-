export const NEXUS_EXECUTION_COORDINATOR_VERSION =
  "nexus-execution-coordinator-v1";
export const NEXUS_EXECUTION_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export type NexusIntentSide = "LONG" | "SHORT";
export type NexusPositionMode = "ONE_WAY" | "HEDGE";
export type NexusIntentOrderType = "MARKET" | "LIMIT";
export type NexusIntentRiskClass = "STANDARD" | "LEARNING_PROBE";
export type NexusIntentStatus =
  | "PROPOSED"
  | "SELECTED"
  | "RESERVED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "CANCELED"
  | "REJECTED"
  | "EXECUTION_UNKNOWN"
  | "CONFLICTED"
  | "EXPIRED";

export type NexusExecutionIntentCandidate = {
  strategyId: number;
  brainKey: string;
  configVersion: number;
  traceId: string;
  intentPurpose: ExecutionIntentPurpose;
  authoritySource: ExecutionIntentAuthoritySource;
  livePositionId?: number | null;
  positionHandoffKey?: string | null;
  ownerEmail: string;
  accountId: string;
  symbol: string;
  positionSide: NexusIntentSide;
  positionMode: NexusPositionMode;
  orderType: NexusIntentOrderType;
  quantity: number;
  limitPrice?: number | null;
  requiredMarginUsdt: number;
  riskBudgetUsdt?: number;
  riskClass?: NexusIntentRiskClass;
  priority: number;
  observedAt: number;
  expiresAt: number;
};

export type NexusActiveIntent = {
  intentKey: string;
  ownerEmail: string;
  accountId: string;
  symbol: string;
  positionSide: NexusIntentSide;
  positionMode: NexusPositionMode;
  requiredMarginUsdt: number;
  riskBudgetUsdt?: number;
  riskClass?: NexusIntentRiskClass;
  status: NexusIntentStatus;
};

export type NexusIntentDecision = NexusExecutionIntentCandidate & {
  intentKey: string;
  conflictKey: string;
  status: "RESERVED" | "CONFLICTED" | "EXPIRED" | "REJECTED";
  reasonCode:
    | "CAPACITY_RESERVED"
    | "DUPLICATE_OPPORTUNITY"
    | "OPPOSITE_DIRECTION_CONFLICT"
    | "ACTIVE_EXECUTION_LOCK"
    | "INSUFFICIENT_AVAILABLE_MARGIN"
    | "INTENT_EXPIRED"
    | "INVALID_INTENT";
  reason: string;
  reservationUsdt: number;
  executionOwner: boolean;
};

export type NexusCoordinatorSnapshot = {
  version: typeof NEXUS_EXECUTION_COORDINATOR_VERSION;
  evaluatedAt: number;
  orderAffecting: true;
  availableMarginUsdt: number;
  alreadyReservedMarginUsdt: number;
  newlyReservedMarginUsdt: number;
  remainingMarginUsdt: number;
  decisions: NexusIntentDecision[];
};

export type NexusExchangeOrderObservation = {
  exchangeStatus:
    | "NEW"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCELED"
    | "EXPIRED"
    | "REJECTED"
    | "UNKNOWN";
  executedQuantity: number;
};

const LOCKING_STATUSES = new Set<NexusIntentStatus>([
  "RESERVED",
  "SUBMITTING",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "EXECUTION_UNKNOWN",
  "CANCEL_REQUESTED",
]);

const TERMINAL_STATUSES = new Set<NexusIntentStatus>([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "CONFLICTED",
  "EXPIRED",
]);

const LEGAL_TRANSITIONS: Record<NexusIntentStatus, NexusIntentStatus[]> = {
  PROPOSED: ["SELECTED", "CONFLICTED", "REJECTED", "EXPIRED"],
  SELECTED: ["RESERVED", "CONFLICTED", "REJECTED", "EXPIRED"],
  RESERVED: ["SUBMITTING", "CANCEL_REQUESTED", "REJECTED", "EXPIRED"],
  SUBMITTING: ["SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "EXECUTION_UNKNOWN"],
  SUBMITTED: ["PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "CANCELED", "REJECTED", "EXECUTION_UNKNOWN"],
  PARTIALLY_FILLED: ["FILLED", "CANCEL_REQUESTED", "CANCELED", "EXECUTION_UNKNOWN"],
  CANCEL_REQUESTED: ["CANCELED", "PARTIALLY_FILLED", "FILLED", "EXECUTION_UNKNOWN"],
  EXECUTION_UNKNOWN: ["SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED"],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  CONFLICTED: [],
  EXPIRED: [],
};

export function nexusIntentKey(
  input: Pick<
    NexusExecutionIntentCandidate,
    "brainKey" | "configVersion" | "traceId" | "ownerEmail" | "accountId" | "symbol" | "positionSide"
  >,
) {
  return [
    "nxi",
    cleanKeyPart(input.brainKey),
    input.configVersion,
    collisionResistantTraceKeyPart(input.traceId),
    cleanKeyPart(input.ownerEmail.toLowerCase()),
    cleanKeyPart(input.accountId),
    input.symbol.toUpperCase(),
    input.positionSide,
  ].join(":");
}

export function nexusIntentConflictKey(
  input: Pick<
    NexusExecutionIntentCandidate,
    "ownerEmail" | "accountId" | "symbol" | "positionSide" | "positionMode"
  >,
) {
  const parts = [
    cleanKeyPart(input.ownerEmail.toLowerCase()),
    cleanKeyPart(input.accountId),
    input.symbol.toUpperCase(),
  ];
  if (input.positionMode === "HEDGE") parts.push(input.positionSide);
  return parts.join(":");
}

export function arbitrateNexusExecutionIntents(input: {
  candidates: NexusExecutionIntentCandidate[];
  activeIntents?: NexusActiveIntent[];
  availableMarginUsdt: number;
  evaluatedAt: number;
}): NexusCoordinatorSnapshot {
  const availableMarginUsdt = positiveOrZero(input.availableMarginUsdt);
  const active = (input.activeIntents ?? []).filter((item) =>
    LOCKING_STATUSES.has(item.status)
  );
  const alreadyReservedMarginUsdt = active.reduce(
    (sum, item) => sum + positiveOrZero(item.requiredMarginUsdt),
    0,
  );
  const activeLocks = new Map(
    active.map((item) => [nexusIntentConflictKey(item), item]),
  );
  const decisions: NexusIntentDecision[] = [];
  const grouped = new Map<string, NexusExecutionIntentCandidate[]>();

  for (const candidate of [...input.candidates].sort(compareCandidates)) {
    const validation = validateCandidate(candidate, input.evaluatedAt);
    if (validation) {
      decisions.push(toDecision(candidate, validation.status, validation.code, validation.reason));
      continue;
    }
    const conflictKey = nexusIntentConflictKey(candidate);
    const items = grouped.get(conflictKey) ?? [];
    items.push(candidate);
    grouped.set(conflictKey, items);
  }

  let remainingMarginUsdt = Math.max(
    0,
    availableMarginUsdt - alreadyReservedMarginUsdt,
  );
  for (const [conflictKey, candidates] of [...grouped.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const ordered = [...candidates].sort(compareCandidates);
    const existingLock = activeLocks.get(conflictKey);
    if (existingLock) {
      for (const candidate of ordered) {
        decisions.push(
          toDecision(
            candidate,
            "CONFLICTED",
            "ACTIVE_EXECUTION_LOCK",
            `已有 ${existingLock.status} 意图占用该账户与合约执行权`,
          ),
        );
      }
      continue;
    }

    const winner = ordered[0];
    if (winner.requiredMarginUsdt > remainingMarginUsdt) {
      decisions.push(
        toDecision(
          winner,
          "REJECTED",
          "INSUFFICIENT_AVAILABLE_MARGIN",
          "统一协调器可用保证金不足，未建立资金预留",
        ),
      );
    } else {
      remainingMarginUsdt -= winner.requiredMarginUsdt;
      decisions.push({
        ...toDecision(
          winner,
          "RESERVED",
          "CAPACITY_RESERVED",
          "已取得该账户与合约的唯一执行权并预留资金",
        ),
        reservationUsdt: winner.requiredMarginUsdt,
        executionOwner: true,
      });
      activeLocks.set(conflictKey, {
        intentKey: nexusIntentKey(winner),
        ownerEmail: winner.ownerEmail,
        accountId: winner.accountId,
        symbol: winner.symbol,
        positionSide: winner.positionSide,
        positionMode: winner.positionMode,
        requiredMarginUsdt: winner.requiredMarginUsdt,
        status: "RESERVED",
      });
    }

    for (const candidate of ordered.slice(1)) {
      const opposite = candidate.positionSide !== winner.positionSide;
      decisions.push(
        toDecision(
          candidate,
          "CONFLICTED",
          opposite
            ? "OPPOSITE_DIRECTION_CONFLICT"
            : "DUPLICATE_OPPORTUNITY",
          opposite
            ? "同一账户与合约出现相反方向，优先级较低意图未取得执行权"
            : "同一机会已有更高优先级大脑取得执行权",
        ),
      );
    }
  }

  const orderedDecisions = decisions.sort((a, b) =>
    a.intentKey.localeCompare(b.intentKey)
  );
  const newlyReservedMarginUsdt = orderedDecisions.reduce(
    (sum, item) => sum + item.reservationUsdt,
    0,
  );
  return {
    version: NEXUS_EXECUTION_COORDINATOR_VERSION,
    evaluatedAt: input.evaluatedAt,
    orderAffecting: true,
    availableMarginUsdt,
    alreadyReservedMarginUsdt,
    newlyReservedMarginUsdt,
    remainingMarginUsdt,
    decisions: orderedDecisions,
  };
}

export function transitionNexusExecutionIntent(
  current: NexusIntentStatus,
  next: NexusIntentStatus,
) {
  if (current === next) return next;
  if (!LEGAL_TRANSITIONS[current].includes(next))
    throw new Error(`非法执行意图状态转换：${current} -> ${next}`);
  return next;
}

export function nexusIntentHoldsReservation(status: NexusIntentStatus) {
  return LOCKING_STATUSES.has(status);
}

export function nexusIntentIsTerminal(status: NexusIntentStatus) {
  return TERMINAL_STATUSES.has(status);
}

export function nexusTerminalIntentNeedsBindingRepair(input: {
  status: NexusIntentStatus;
  liveOrderEventId?: number | null;
  livePositionId?: number | null;
  filledQuantity?: number | null;
}) {
  if (input.status !== "FILLED") return false;
  const liveOrderEventId = Number(input.liveOrderEventId);
  if (!Number.isInteger(liveOrderEventId) || liveOrderEventId <= 0)
    return false;
  const livePositionId = Number(input.livePositionId);
  const filledQuantity = Number(input.filledQuantity);
  return (
    !Number.isInteger(livePositionId) ||
    livePositionId <= 0 ||
    !Number.isFinite(filledQuantity) ||
    filledQuantity <= 0
  );
}

export function nexusIntentMaySubmit(status: NexusIntentStatus) {
  return status === "RESERVED";
}

export function reconcileNexusExecutionIntent(
  current: NexusIntentStatus,
  observation: NexusExchangeOrderObservation,
) {
  const executedQuantity = positiveOrZero(observation.executedQuantity);
  let next: NexusIntentStatus;
  if (observation.exchangeStatus === "UNKNOWN")
    next = "EXECUTION_UNKNOWN";
  else if (observation.exchangeStatus === "NEW")
    next = "SUBMITTED";
  else if (observation.exchangeStatus === "PARTIALLY_FILLED")
    next = executedQuantity > 0 ? "PARTIALLY_FILLED" : "SUBMITTED";
  else if (observation.exchangeStatus === "FILLED")
    next = executedQuantity > 0 ? "FILLED" : "EXECUTION_UNKNOWN";
  else if (observation.exchangeStatus === "REJECTED")
    next = executedQuantity > 0 ? "CANCELED" : "REJECTED";
  else
    next = "CANCELED";

  return {
    status: transitionNexusExecutionIntent(current, next),
    filledQuantity: executedQuantity,
    holdsReservation: nexusIntentHoldsReservation(next),
    positionBindingRequired: executedQuantity > 0,
    automaticRetryAllowed: false,
  };
}

function validateCandidate(
  candidate: NexusExecutionIntentCandidate,
  evaluatedAt: number,
) {
  let ownershipError: string | null = null;
  try {
    buildExecutionIntentOwnership({
      intentPurpose: candidate.intentPurpose ?? "OPEN_POSITION",
      authoritySource: candidate.authoritySource ?? "ENTRY_BRAIN",
      livePositionId: candidate.livePositionId,
      positionHandoffKey: candidate.positionHandoffKey,
    });
  } catch (error) {
    ownershipError = error instanceof Error ? error.message : String(error);
  }
  const invalidReason = ownershipError ??
    (!Number.isInteger(candidate.strategyId) || candidate.strategyId <= 0
      ? "执行意图策略编号无效"
      : !candidate.brainKey.trim()
        ? "执行意图缺少不可变大脑标识"
        : !Number.isInteger(candidate.configVersion) ||
            candidate.configVersion <= 0
          ? "执行意图配置版本无效"
          : !candidate.traceId.trim()
            ? "执行意图缺少生命周期编号"
            : !candidate.accountId.trim()
              ? "执行意图缺少交易账户"
              : !/^[A-Z0-9]{1,26}USDT$/.test(
                    candidate.symbol.toUpperCase(),
                  )
                ? "执行意图合约代码无效"
                : !Number.isFinite(candidate.quantity) ||
                    candidate.quantity <= 0
                  ? "执行意图下单数量无效"
                  : !Number.isFinite(candidate.requiredMarginUsdt) ||
                      candidate.requiredMarginUsdt <= 0
                    ? "执行意图所需保证金无效"
                    : !Number.isFinite(candidate.priority)
                      ? "执行意图优先级无效"
                      : !Number.isFinite(candidate.observedAt) ||
                          !Number.isFinite(candidate.expiresAt)
                        ? "执行意图时间字段无效"
                        : candidate.observedAt >
                            evaluatedAt +
                              NEXUS_EXECUTION_CLOCK_SKEW_TOLERANCE_MS
                          ? "执行意图观察时间晚于协调器当前时间"
                          : null);
  if (invalidReason)
    return {
      status: "REJECTED" as const,
      code: "INVALID_INTENT" as const,
      reason: invalidReason,
    };
  if (candidate.expiresAt <= evaluatedAt)
    return {
      status: "EXPIRED" as const,
      code: "INTENT_EXPIRED" as const,
      reason: "执行意图已超过有效期",
    };
  return null;
}

function compareCandidates(
  left: NexusExecutionIntentCandidate,
  right: NexusExecutionIntentCandidate,
) {
  return (
    right.priority - left.priority ||
    left.observedAt - right.observedAt ||
    left.strategyId - right.strategyId ||
    nexusIntentKey(left).localeCompare(nexusIntentKey(right))
  );
}

function toDecision(
  candidate: NexusExecutionIntentCandidate,
  status: NexusIntentDecision["status"],
  reasonCode: NexusIntentDecision["reasonCode"],
  reason: string,
): NexusIntentDecision {
  return {
    ...candidate,
    intentPurpose: candidate.intentPurpose ?? "OPEN_POSITION",
    authoritySource: candidate.authoritySource ?? "ENTRY_BRAIN",
    livePositionId: candidate.livePositionId ?? null,
    positionHandoffKey: candidate.positionHandoffKey ?? null,
    symbol: candidate.symbol.toUpperCase(),
    intentKey: nexusIntentKey(candidate),
    conflictKey: nexusIntentConflictKey(candidate),
    status,
    reasonCode,
    reason,
    reservationUsdt: 0,
    executionOwner: false,
  };
}

function cleanKeyPart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
}

function collisionResistantTraceKeyPart(value: string) {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (cleaned.length <= 80) return cleaned;
  const digest = fnv1a64(cleaned);
  return `${cleaned.slice(0, 63)}-${digest}`;
}

function fnv1a64(value: string) {
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function positiveOrZero(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
import {
  buildExecutionIntentOwnership,
  type ExecutionIntentAuthoritySource,
  type ExecutionIntentPurpose,
} from "./execution/execution-intent-ownership.ts";
