import { rebalanceRiskPlan } from "./risk-plan-rebalance.ts";

export const NEXUS_POSITION_STATE_MACHINE_VERSION =
  "nexus-position-state-machine-v1" as const;

export type NexusPositionState =
  | "PROBE"
  | "CONFIRMING"
  | "CONTINUING"
  | "PROFIT_PROTECT"
  | "RISK_FROZEN"
  | "RISK_REDUCED"
  | "INVALIDATED"
  | "EXITING"
  | "CLOSED";

export type NexusPositionAction =
  | "HOLD"
  | "WAIT_CONFIRMATION"
  | "HOLD_CONTINUATION"
  | "EMIT_ENTRY_CANDIDATE"
  | "TIGHTEN_PROTECTION"
  | "REDUCE_RISK"
  | "EXIT_BY_RISK_PLAN"
  | "WAIT_REDUCTION_FILL"
  | "COMPLETE";

export type NexusPositionStateSnapshot = {
  modelVersion: typeof NEXUS_POSITION_STATE_MACHINE_VERSION;
  positionKey: string;
  state: NexusPositionState;
  previousState: NexusPositionState | null;
  action: NexusPositionAction;
  consecutiveConfirmationCount: number;
  lastConfirmationEvidenceKey: string | null;
  protectionFloorRoePercent: number | null;
  lastAdditionEvidenceKey: string | null;
  additionCandidate: boolean;
  orderAffecting: false;
  evidenceCodes: string[];
  blockedReasons: string[];
  reason: string;
  observedAtMs: number;
};

const NEXUS_POSITION_STATES = new Set<NexusPositionState>([
  "PROBE",
  "CONFIRMING",
  "CONTINUING",
  "PROFIT_PROTECT",
  "RISK_FROZEN",
  "RISK_REDUCED",
  "INVALIDATED",
  "EXITING",
  "CLOSED",
]);

export function parseNexusPositionStateSnapshot(
  value: unknown,
): NexusPositionStateSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.modelVersion !== NEXUS_POSITION_STATE_MACHINE_VERSION ||
    typeof record.positionKey !== "string" ||
    !NEXUS_POSITION_STATES.has(record.state as NexusPositionState)
  )
    return null;
  const previousState = NEXUS_POSITION_STATES.has(
      record.previousState as NexusPositionState,
    )
    ? record.previousState as NexusPositionState
    : null;
  return {
    ...record,
    previousState,
  } as NexusPositionStateSnapshot;
}

export function nexusManagedPositionKey(input: {
  ownerEmail: string;
  accountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  sourceEventId: number | string;
}) {
  return [
    input.ownerEmail.trim().toLowerCase(),
    input.accountId.trim(),
    input.symbol.trim().toUpperCase(),
    input.positionSide,
    String(input.sourceEventId),
  ].join(":");
}

/**
 * 仓位状态机只负责解释证据和约束合法转换。
 * 它不会直接补仓、减仓或改写生产保护参数。
 */
export function advanceNexusPositionState(input: {
  positionKey: string;
  previous?: NexusPositionStateSnapshot | null;
  observedAtMs: number;
  positionClosed?: boolean;
  pendingReduction?: boolean;
  managementState:
    | "PROFIT_CONTINUATION"
    | "PROFIT_HOLD_OBSERVE"
    | "PROFIT_PROTECT"
    | "LOSS_WAIT_BOTTOM"
    | "BOTTOM_REBOUND_CONFIRMED"
    | "EVIDENCE_DEGRADING"
    | "TREND_INVALIDATED"
    | "NEUTRAL";
  managementAction:
    | "HOLD_FOR_EXTENSION"
    | "HOLD_AND_OBSERVE"
    | "TIGHTEN_PROFIT_PROTECTION"
    | "WAIT_NO_ADD"
    | "ADD_ELIGIBLE"
    | "SCALE_IN_ELIGIBLE"
    | "REDUCE_RISK_BY_EVIDENCE"
    | "EXIT_OR_REDUCE_BY_RISK_PLAN";
  dataFresh: boolean;
  evidenceComplete: boolean;
  currentRoePercent: number;
  confirmationEvidence?: boolean;
  profitScaleInEnabled?: boolean;
  confirmationEvidenceKey?: string | null;
  additionEvidenceKey?: string | null;
  candidateProtectionFloorRoePercent?: number | null;
  evidenceRiskReductionExecuted?: boolean;
  probeExitAuthorized?: boolean;
  fullExitAuthorized?: boolean;
}): NexusPositionStateSnapshot {
  const previous = normalizePrevious(input);
  const evidenceCodes = [
    input.dataFresh ? "MARKET_DATA_FRESH" : null,
    input.evidenceComplete ? "POSITION_EVIDENCE_COMPLETE" : null,
    input.confirmationEvidence ? "STAGE_CONFIRMATION_PRESENT" : null,
    input.managementState === "TREND_INVALIDATED"
      ? "STRUCTURE_INVALIDATED"
      : null,
    input.managementState === "PROFIT_PROTECT"
      ? "PROFIT_PROTECTION_REQUIRED"
      : null,
  ].filter((item): item is string => Boolean(item));
  const blockedReasons = [
    !input.dataFresh ? "STALE_MARKET_DATA" : null,
    !input.evidenceComplete ? "INCOMPLETE_POSITION_EVIDENCE" : null,
  ].filter((item): item is string => Boolean(item));
  const protectionFloorRoePercent = tightenOnlyFloor(
    previous.protectionFloorRoePercent,
    input.candidateProtectionFloorRoePercent,
  );
  const common = {
    modelVersion: NEXUS_POSITION_STATE_MACHINE_VERSION,
    positionKey: input.positionKey,
    previousState: previous.state,
    protectionFloorRoePercent,
    orderAffecting: false as const,
    evidenceCodes,
    blockedReasons,
    observedAtMs: finite(input.observedAtMs, Date.now()),
  };

  if (input.positionClosed)
    return {
      ...common,
      state: "CLOSED",
      action: "COMPLETE",
      consecutiveConfirmationCount: previous.consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      reason: "交易所真实仓位已经关闭，仓位周期完成。",
    };

  if (input.pendingReduction)
    return {
      ...common,
      state: "EXITING",
      action: "WAIT_REDUCTION_FILL",
      consecutiveConfirmationCount: previous.consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      reason: "减仓委托已经存在，等待成交或撤单核对，禁止重复提交。",
    };

  if (
    previous.state === "CLOSED" ||
    previous.state === "EXITING"
  )
    return {
      ...common,
      state: previous.state,
      action:
        previous.state === "CLOSED" ? "COMPLETE" : "WAIT_REDUCTION_FILL",
      consecutiveConfirmationCount: previous.consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      blockedReasons: [...blockedReasons, "TERMINAL_STATE_CANNOT_REOPEN"],
      reason: "终态仓位不能被行情轮询重新打开。",
    };

  const observationMovesForward =
    !input.previous ||
    input.previous.positionKey !== input.positionKey ||
    common.observedAtMs > previous.observedAtMs;
  if (!input.dataFresh || !input.evidenceComplete || !observationMovesForward)
    return {
      ...common,
      state: previous.state,
      action: "HOLD",
      consecutiveConfirmationCount: previous.consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      blockedReasons: observationMovesForward
        ? blockedReasons
        : [...blockedReasons, "NON_MONOTONIC_POSITION_FACT"],
      reason: "事实过期或因果证据不完整，本轮保持仓位状态且不创建新动作。",
    };

  if (input.probeExitAuthorized || input.fullExitAuthorized)
    return {
      ...common,
      state: "INVALIDATED",
      action: "EXIT_BY_RISK_PLAN",
      consecutiveConfirmationCount: previous.consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      reason:
        input.probeExitAuthorized
          ? "开仓试探已由冻结边界和连续秒级反向事实确认失败；立即退出，避免把错误入场拖到硬止损。"
          : "已完成首次减险后，策略明确允许因持续失效退出余仓；禁止补仓或放宽保护。",
    };

  if (
    input.managementState === "TREND_INVALIDATED" ||
    input.managementAction === "EXIT_OR_REDUCE_BY_RISK_PLAN"
  )
    return {
      ...common,
      state: input.evidenceRiskReductionExecuted
        ? "RISK_REDUCED"
        : "RISK_FROZEN",
      action: input.evidenceRiskReductionExecuted ? "HOLD" : "REDUCE_RISK",
      consecutiveConfirmationCount: 0,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      reason: input.evidenceRiskReductionExecuted
        ? "普通仓位的结构证据转弱，但策略未授权退出余仓；保持已经减险后的仓位，仅由盈利保护或硬止损退出。"
        : "普通仓位的结构证据转弱；先按一次性减险规则降低风险，不能把首次冲突直接解释为全平。",
    };

  if (
    input.managementState === "EVIDENCE_DEGRADING" ||
    input.managementAction === "REDUCE_RISK_BY_EVIDENCE"
  )
    return {
      ...common,
      state: input.evidenceRiskReductionExecuted
        ? "RISK_REDUCED"
        : "RISK_FROZEN",
      action: input.managementAction === "REDUCE_RISK_BY_EVIDENCE"
        ? "REDUCE_RISK"
        : "HOLD",
      consecutiveConfirmationCount: 0,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      reason: input.evidenceRiskReductionExecuted
        ? "部分减险已经获得真实成交回执；继续收集结构证据，不新增风险。"
        : input.managementAction === "REDUCE_RISK_BY_EVIDENCE"
          ? "早期费用后亏损与多源逆向证据共振；部分减险已授权但尚未成交，禁止补仓。"
          : "风险已经预警但尚未执行减仓；冻结新增风险并继续收集结构证据。",
    };

  if (
    input.managementState === "PROFIT_PROTECT" ||
    input.managementAction === "TIGHTEN_PROFIT_PROTECTION"
  )
    return {
      ...common,
      state: "PROFIT_PROTECT",
      action: "TIGHTEN_PROTECTION",
      consecutiveConfirmationCount: previous.consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      reason:
        "盈利回撤或环境转弱，只允许收紧保护线；保护线不能向亏损方向放宽。",
    };

  const confirmationEvidenceKey = cleanKey(input.confirmationEvidenceKey);
  const confirmationPresent =
    Boolean(input.confirmationEvidence) &&
    confirmationEvidenceKey !== null &&
    confirmationEvidenceKey !== previous.lastConfirmationEvidenceKey &&
    (input.managementState === "BOTTOM_REBOUND_CONFIRMED" ||
      (input.profitScaleInEnabled === true &&
        input.managementState === "PROFIT_CONTINUATION"));
  const consecutiveConfirmationCount = confirmationPresent
    ? previous.consecutiveConfirmationCount + 1
    : 0;
  const continuationConfirmed =
    consecutiveConfirmationCount >= 2 ||
    previous.state === "CONTINUING";
  // Rebound additions and profitable continuation additions share the same
  // causal state machine, but profit scale-in requires its own explicit,
  // default-off strategy switch.
  const additionRequested =
    input.managementAction === "ADD_ELIGIBLE" ||
    (input.profitScaleInEnabled === true &&
      input.managementAction === "SCALE_IN_ELIGIBLE");
  const additionEvidenceKey = cleanKey(input.additionEvidenceKey);
  const newAdditionEvidence =
    additionEvidenceKey !== null &&
    additionEvidenceKey !== previous.lastAdditionEvidenceKey;
  const additionCandidate =
    continuationConfirmed &&
    additionRequested &&
    newAdditionEvidence &&
    Number.isFinite(Number(input.currentRoePercent));

  if (continuationConfirmed)
    return {
      ...common,
      state: "CONTINUING",
      action: additionCandidate
        ? "EMIT_ENTRY_CANDIDATE"
        : "HOLD_CONTINUATION",
      consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: confirmationPresent
        ? confirmationEvidenceKey
        : previous.lastConfirmationEvidenceKey,
      lastAdditionEvidenceKey: additionCandidate
        ? additionEvidenceKey
        : previous.lastAdditionEvidenceKey,
      additionCandidate,
      blockedReasons:
        additionRequested && !newAdditionEvidence
          ? [...blockedReasons, "NO_NEW_ADDITION_EVIDENCE"]
          : blockedReasons,
      reason: additionCandidate
        ? "连续证据确认原方向延续；仅形成一次新的加仓候选，仍需资金、最小量和执行幂等门禁。"
        : "原方向已经连续确认，继续持有并等待新的独立证据。",
    };

  if (confirmationPresent)
    return {
      ...common,
      state: "CONFIRMING",
      action: "WAIT_CONFIRMATION",
      consecutiveConfirmationCount,
      lastConfirmationEvidenceKey: confirmationEvidenceKey,
      lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
      additionCandidate: false,
      reason:
        "首次出现方向确认证据，等待下一份独立事实确认，不能直接跳到加仓。",
    };

  return {
    ...common,
    state: "PROBE",
    action: "HOLD",
    consecutiveConfirmationCount: 0,
    lastConfirmationEvidenceKey: previous.lastConfirmationEvidenceKey,
    lastAdditionEvidenceKey: previous.lastAdditionEvidenceKey,
    additionCandidate: false,
    reason: "仓位仍处于探针阶段，保持既定保护并继续收集证据。",
  };
}

export function validateNexusTakeProfitReduction(input: {
  exactNetPnlStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  exactNetPnlUsdt?: number | null;
  minimumNetProfitUsdt?: number;
}) {
  const threshold = Math.max(
    0,
    finite(input.minimumNetProfitUsdt, 0),
  );
  const exactNetPnlUsdt = Number(input.exactNetPnlUsdt);
  if (
    input.exactNetPnlStatus !== "COMPLETE" ||
    !Number.isFinite(exactNetPnlUsdt)
  )
    return {
      allowed: false,
      reason: "EXACT_NET_PROFIT_INCOMPLETE" as const,
      exactNetPnlUsdt: null,
    };
  if (exactNetPnlUsdt <= threshold)
    return {
      allowed: false,
      reason: "EXACT_NET_PROFIT_NOT_POSITIVE" as const,
      exactNetPnlUsdt,
    };
  return {
    allowed: true,
    reason: "EXACT_NET_PROFIT_CONFIRMED" as const,
    exactNetPnlUsdt,
  };
}

export function reconcileNexusPositionAfterFill(input: {
  exchangeQuantity: number;
  exchangeEntryPrice: number;
  exchangeMarkPrice: number;
  exchangeLiquidationPrice?: number | null;
  riskPlan: Record<string, unknown>;
  executedRiskPlan?: Record<string, unknown>;
  minOrderQty: number;
  quantityStep: number;
}) {
  const quantity = positive(input.exchangeQuantity, "交易所仓位数量");
  const entryPrice = positive(input.exchangeEntryPrice, "交易所开仓均价");
  const markPrice = positive(input.exchangeMarkPrice, "交易所标记价格");
  const rebalanced = rebalanceRiskPlan(
    input.riskPlan,
    quantity,
    positive(input.minOrderQty, "最小下单量"),
    positive(input.quantityStep, "数量步长"),
    input.executedRiskPlan ?? {},
  );
  return {
    quantity,
    entryPrice,
    markPrice,
    liquidationPrice:
      Number.isFinite(Number(input.exchangeLiquidationPrice)) &&
      Number(input.exchangeLiquidationPrice) > 0
        ? Number(input.exchangeLiquidationPrice)
        : null,
    favorablePrice: markPrice,
    riskPlan: rebalanced.plan,
    riskGrid: {
      takeProfit: rebalanced.takeProfitGrids,
      stopLoss: rebalanced.stopLossGrids,
    },
    source: "BINANCE_POSITION_SNAPSHOT" as const,
  };
}

function normalizePrevious(input: {
  positionKey: string;
  previous?: NexusPositionStateSnapshot | null;
  observedAtMs: number;
}): NexusPositionStateSnapshot {
  if (
    input.previous &&
    input.previous.positionKey === input.positionKey
  )
    return {
      ...input.previous,
      lastConfirmationEvidenceKey:
        cleanKey(input.previous.lastConfirmationEvidenceKey),
    };
  return {
    modelVersion: NEXUS_POSITION_STATE_MACHINE_VERSION,
    positionKey: input.positionKey,
    state: "PROBE",
    previousState: null,
    action: "HOLD",
    consecutiveConfirmationCount: 0,
    lastConfirmationEvidenceKey: null,
    protectionFloorRoePercent: null,
    lastAdditionEvidenceKey: null,
    additionCandidate: false,
    orderAffecting: false,
    evidenceCodes: [],
    blockedReasons: [],
    reason: "仓位首次进入状态机。",
    observedAtMs: finite(input.observedAtMs, Date.now()),
  };
}

function tightenOnlyFloor(
  previous: number | null,
  candidate: number | null | undefined,
) {
  const previousValue = Number(previous);
  const candidateValue = Number(candidate);
  const hasPrevious =
    previous !== null &&
    previous !== undefined &&
    Number.isFinite(previousValue);
  const hasCandidate =
    candidate !== null &&
    candidate !== undefined &&
    Number.isFinite(candidateValue);
  if (!hasPrevious && !hasCandidate) return null;
  if (!hasPrevious) return candidateValue;
  if (!hasCandidate) return previousValue;
  return Math.max(previousValue, candidateValue);
}

function cleanKey(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function positive(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${label}必须大于 0`);
  return number;
}

function finite(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
