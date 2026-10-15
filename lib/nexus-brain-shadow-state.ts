import type {
  NexusMarketFact,
  NexusMarketFactKind,
} from "./nexus-market-facts";

export type NexusBrainDirection = "LONG" | "SHORT";
export type NexusBrainShadowState =
  | "OBSERVING"
  | "ARMED"
  | "CONFIRMING"
  | "READY_SHADOW"
  | "INVALIDATED"
  | "DATA_STALE";

export type NexusBrainShadowReason = {
  code: string;
  message: string;
  factIds: string[];
};

export type NexusBrainShadowSnapshot = {
  version: 1;
  state: NexusBrainShadowState;
  previousState: NexusBrainShadowState | null;
  direction: NexusBrainDirection;
  evaluatedAt: number;
  changedAt: number;
  triggerFactId: string | null;
  confirmationFactIds: string[];
  reasons: NexusBrainShadowReason[];
  orderAffecting: false;
};

export function deriveNexusBrainShadowState(input: {
  direction: NexusBrainDirection;
  triggerLiquidationSide?: "BUY" | "SELL";
  triggerFactId?: string | null;
  facts: NexusMarketFact[];
  now?: number;
  previous?: unknown;
}): NexusBrainShadowSnapshot {
  const now = input.now ?? Date.now();
  const previous = validPrevious(input.previous, input.direction);
  const symbolFacts = input.facts
    .filter(
      (fact) =>
        fact.eventAt <= now &&
        fact.receivedAt <= now &&
        fact.expiresAt > now,
    )
    .sort(
      (left, right) =>
        left.eventAt - right.eventAt || left.id.localeCompare(right.id),
    );
  const mark = latest(symbolFacts, "MARK_PRICE_UPDATED");
  const liquidationSide =
    input.triggerLiquidationSide ??
    (input.direction === "LONG" ? "SELL" : "BUY");
  const matchingTriggers = symbolFacts.filter(
      (fact) =>
        (fact.kind === "LIQUIDATION_AGGREGATED" ||
          fact.kind === "MARKET_STRUCTURE_WAKE") &&
        fact.payload.side === liquidationSide,
    );
  const trigger =
    (input.triggerFactId
      ? matchingTriggers.find((fact) => fact.id === input.triggerFactId)
      : undefined) ?? matchingTriggers.at(-1);
  const sameTriggerPrevious =
    trigger && previous?.triggerFactId === trigger.id
      ? previous
      : null;
  let state: NexusBrainShadowState;
  let reasons: NexusBrainShadowReason[];
  let confirmations: NexusMarketFact[] = [];

  if (!mark) {
    state = "DATA_STALE";
    reasons = [
      reason(
        "MARK_PRICE_STALE",
        "缺少新鲜统一标记价格，只观察，不允许形成时机结论",
      ),
    ];
  } else if (!trigger) {
    state = "OBSERVING";
    reasons = [
      reason(
        "DIRECTIONAL_WAKE_NOT_SEEN",
        liquidationSide === "SELL"
          ? input.direction === "SHORT"
            ? "尚未看到做空续跌分支所需的方向唤醒事实"
            : "尚未看到做多反弹分支所需的方向唤醒事实"
          : "尚未看到本方向所需的方向唤醒事实",
      ),
    ];
  } else {
    const afterTrigger = symbolFacts.filter(
      (fact) =>
        fact.eventAt >= trigger.eventAt &&
        fact.kind !== "LIQUIDATION_AGGREGATED" &&
        fact.kind !== "MARKET_STRUCTURE_WAKE" &&
        fact.kind !== "MARK_PRICE_UPDATED",
    );
    const volume = latest(afterTrigger, "VOLUME_EXPANDED");
    const reclaim =
      input.direction === "LONG"
        ? latest(afterTrigger, "SUPPORT_RECLAIMED")
        : latest(afterTrigger, "FAILED_RETEST_CONFIRMED");
    const shortBreak =
      input.direction === "SHORT"
        ? latest(afterTrigger, "SUPPORT_BROKEN")
        : undefined;
    const adverseBreak =
      input.direction === "LONG"
        ? latest(afterTrigger, "PRICE_NEW_LOW")
        : latest(afterTrigger, "PRICE_NEW_HIGH");
    const invalidated =
      reclaim &&
      adverseBreak &&
      adverseBreak.eventAt > reclaim.eventAt;

    if (invalidated) {
      state = "INVALIDATED";
      confirmations = [reclaim, adverseBreak];
      reasons = [
        reason(
          "STRUCTURE_CONFIRMATION_FAILED",
          input.direction === "LONG"
            ? "支撑收回后再次形成新低，本轮影子机会失效"
            : "反抽失败确认后再次形成新高，本轮做空影子机会失效",
          confirmations,
        ),
      ];
    } else if (reclaim && volume) {
      state = "READY_SHADOW";
      confirmations = [reclaim, volume];
      reasons = [
        reason(
          "STRUCTURE_AND_VOLUME_CONFIRMED",
          input.direction === "LONG"
            ? "支撑收回与成交量扩张同时成立，形成只读影子时机"
            : "支撑跌破、反抽失败与成交量扩张成立，形成只读做空影子时机",
          confirmations,
        ),
      ];
    } else if (reclaim) {
      state = "CONFIRMING";
      confirmations = [reclaim];
      reasons = [
        reason(
          "WAIT_VOLUME_CONFIRMATION",
          "结构事实已经成立，等待独立成交量确认",
          confirmations,
        ),
      ];
    } else if (adverseBreak || shortBreak || afterTrigger.length) {
      state = "CONFIRMING";
      confirmations = adverseBreak ? [adverseBreak] : [];
      reasons = [
        reason(
          "WAIT_STRUCTURE_CONFIRMATION",
          input.direction === "LONG"
            ? "方向唤醒后正在观察支撑扫盘与闭合收回"
            : "方向唤醒后正在观察支撑跌破与反抽失败",
          adverseBreak ? [adverseBreak] : shortBreak ? [shortBreak] : [],
        ),
      ];
    } else {
      state = "ARMED";
      reasons = [
        reason(
          "DIRECTIONAL_WAKE_ARMED",
          "方向匹配的唤醒事实已触发，等待闭合K线结构",
          [trigger],
        ),
      ];
    }
  }

  if (
    sameTriggerPrevious?.state === "READY_SHADOW" &&
    state !== "INVALIDATED" &&
    state !== "DATA_STALE"
  ) {
    state = "READY_SHADOW";
    reasons = [
      reason(
        "READY_SHADOW_HELD",
        "已确认的影子时机保持有效，直到出现明确结构失效",
        confirmations,
      ),
    ];
  }
  const previousState = previous?.state ?? null;
  return {
    version: 1,
    state,
    previousState,
    direction: input.direction,
    evaluatedAt: now,
    changedAt:
      sameTriggerPrevious && sameTriggerPrevious.state === state
        ? sameTriggerPrevious.changedAt
        : now,
    triggerFactId: trigger?.id ?? null,
    confirmationFactIds: confirmations.map((fact) => fact.id),
    reasons,
    orderAffecting: false,
  };
}

export class NexusBrainShadowStateMemory {
  private readonly states = new Map<
    string,
    { snapshot: NexusBrainShadowSnapshot; touchedAt: number }
  >();
  private readonly maximumSize: number;
  private readonly retentionMs: number;

  constructor(maximumSize = 1_000, retentionMs = 30 * 60_000) {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 1)
      throw new Error("brain state memory maximumSize must be positive");
    if (!Number.isFinite(retentionMs) || retentionMs < 1)
      throw new Error("brain state memory retentionMs must be positive");
    this.maximumSize = maximumSize;
    this.retentionMs = retentionMs;
  }

  evaluate(input: {
    key: string;
    direction: NexusBrainDirection;
    triggerLiquidationSide?: "BUY" | "SELL";
    facts: NexusMarketFact[];
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    this.prune(now);
    const key = input.key.trim();
    if (!key) throw new Error("brain state memory key is required");
    const previous = this.states.get(key)?.snapshot;
    const snapshot = deriveNexusBrainShadowState({
      direction: input.direction,
      triggerLiquidationSide: input.triggerLiquidationSide,
      facts: input.facts,
      now,
      previous,
    });
    const changed =
      !previous ||
      previous.state !== snapshot.state ||
      (
        snapshot.state === "READY_SHADOW" &&
        previous.triggerFactId !== snapshot.triggerFactId
      );
    this.states.set(key, { snapshot, touchedAt: now });
    this.trim();
    return { snapshot, changed };
  }

  size(now = Date.now()) {
    this.prune(now);
    return this.states.size;
  }

  private prune(now: number) {
    const oldest = now - this.retentionMs;
    for (const [key, value] of this.states)
      if (value.touchedAt < oldest) this.states.delete(key);
  }

  private trim() {
    const excess = this.states.size - this.maximumSize;
    if (excess <= 0) return;
    const oldest = [...this.states.entries()]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          left.touchedAt - right.touchedAt ||
          leftKey.localeCompare(rightKey),
      )
      .slice(0, excess);
    for (const [key] of oldest) this.states.delete(key);
  }
}

export const nexusBrainShadowStateMemory =
  new NexusBrainShadowStateMemory();

function latest(facts: NexusMarketFact[], kind: NexusMarketFactKind) {
  return [...facts].reverse().find((fact) => fact.kind === kind);
}

function reason(
  code: string,
  message: string,
  facts: NexusMarketFact[] = [],
): NexusBrainShadowReason {
  return { code, message, factIds: facts.map((fact) => fact.id) };
}

function validPrevious(
  value: unknown,
  direction: NexusBrainDirection,
): NexusBrainShadowSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<NexusBrainShadowSnapshot>;
  if (
    row.version !== 1 ||
    row.direction !== direction ||
    ![
      "OBSERVING",
      "ARMED",
      "CONFIRMING",
      "READY_SHADOW",
      "INVALIDATED",
      "DATA_STALE",
    ].includes(String(row.state)) ||
    !Number.isFinite(row.changedAt)
  ) return null;
  return row as NexusBrainShadowSnapshot;
}
