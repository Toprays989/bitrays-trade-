import type {
  NexusMarketFact,
  NexusMarketFactKind,
} from "./nexus-market-facts";

export const NEXUS_PURE_STATE_MACHINE_VERSION =
  "nexus-pure-state-machine-v4";

export type NexusPureMachineKind =
  | "TREND_BREAKOUT"
  | "SUPPORT_REVERSAL"
  | "DOWNTREND_CONTINUATION";
export type NexusPureMachineDirection = "LONG" | "SHORT";
export type NexusPureMachineState =
  | "WAIT_DATA"
  | "WATCHING"
  | "TRIGGERED"
  | "STRUCTURE_CONFIRMED"
  | "MOMENTUM_CONFIRMED"
  | "READY_SHADOW"
  | "INVALIDATED";

export type NexusPureMachineTransition = {
  from: NexusPureMachineState;
  to: NexusPureMachineState;
  factId: string;
  factKind: NexusMarketFactKind;
  eventAt: number;
  message: string;
};

export type NexusPureMachineSnapshot = {
  version: typeof NEXUS_PURE_STATE_MACHINE_VERSION;
  machine: NexusPureMachineKind;
  direction: NexusPureMachineDirection;
  state: NexusPureMachineState;
  triggerFactId: string | null;
  evidenceFactIds: string[];
  missing: string[];
  transitions: NexusPureMachineTransition[];
  evaluatedAt: number;
  changedAt: number;
  orderAffecting: false;
};

export function nexusPureStateMachineMessage(
  snapshot: Pick<
    NexusPureMachineSnapshot,
    "machine" | "state" | "missing"
  >,
) {
  const prefix = `${snapshot.machine} 状态机：${snapshot.state}；`;
  if (snapshot.missing.length)
    return `${prefix}仍等待${snapshot.missing.join("、")}`;
  if (snapshot.state === "INVALIDATED") return `${prefix}结构已经失效`;
  if (snapshot.state === "READY_SHADOW") return `${prefix}影子证据已闭合`;
  return `${prefix}当前阶段证据已记录`;
}

export function nexusLifecycleTriggerExpiry(
  traceExpiresAt: number,
  evaluatedAt: number,
) {
  if (!Number.isFinite(traceExpiresAt) || !Number.isFinite(evaluatedAt))
    throw new Error("大脑生命周期时间无效");
  return Math.max(traceExpiresAt, evaluatedAt + 1);
}

const FACT_ORDER: Partial<Record<NexusMarketFactKind, number>> = {
  MARK_PRICE_UPDATED: 0,
  LIQUIDATION_AGGREGATED: 10,
  MARKET_STRUCTURE_WAKE: 10,
  PRICE_IMPULSE_UP: 15,
  PRICE_IMPULSE_DOWN: 15,
  PRICE_NEW_HIGH: 20,
  PRICE_NEW_LOW: 20,
  SUPPORT_SWEPT: 30,
  SUPPORT_BROKEN: 30,
  SUPPORT_RECLAIMED: 40,
  RESISTANCE_REJECTED: 40,
  FAILED_RETEST_CONFIRMED: 40,
  VOLUME_EXPANDED: 50,
};

export function replayNexusPureStateMachine(input: {
  machine: NexusPureMachineKind;
  direction: NexusPureMachineDirection;
  symbol?: string;
  triggerLiquidationSide?: "BUY" | "SELL";
  triggerFactId?: string | null;
  facts: NexusMarketFact[];
  now?: number;
  previous?: Partial<NexusPureMachineSnapshot> | Record<string, unknown> | null;
}): NexusPureMachineSnapshot {
  const now = input.now ?? Date.now();
  if (
    input.machine === "DOWNTREND_CONTINUATION" &&
    input.direction !== "SHORT"
  )
    throw new Error("下跌延续状态机只允许做空方向");
  const facts = input.facts
    .filter(
      (fact) =>
        (!input.symbol || fact.symbol === input.symbol) &&
        fact.eventAt <= now &&
        fact.receivedAt <= now &&
        fact.expiresAt > now,
    )
    .sort(
      (left, right) =>
        left.eventAt - right.eventAt ||
        (FACT_ORDER[left.kind] ?? 100) - (FACT_ORDER[right.kind] ?? 100) ||
        left.id.localeCompare(right.id),
    );
  const previous = terminalPreviousSnapshot(input);
  if (previous) {
    const invalidation = facts.find(
      (fact) =>
        // A fact from the candle that produced READY has already been
        // consumed by the deterministic replay.  Re-reading that same
        // closed candle must not invalidate the state it just confirmed.
        // Only a strictly newer market fact can invalidate a terminal path.
        fact.eventAt > previous.changedAt &&
        invalidates(input.direction, fact),
    );
    if (previous.state === "READY_SHADOW" && invalidation) {
      return {
        version: NEXUS_PURE_STATE_MACHINE_VERSION,
        machine: input.machine,
        direction: input.direction,
        state: "INVALIDATED",
        triggerFactId: previous.triggerFactId,
        evidenceFactIds: [
          ...new Set([...previous.evidenceFactIds, invalidation.id]),
        ].sort(),
        missing: [],
        transitions: [
          {
            from: "READY_SHADOW",
            to: "INVALIDATED",
            factId: invalidation.id,
            factKind: invalidation.kind,
            eventAt: invalidation.eventAt,
            message: "确认后出现反向结构失效",
          },
        ],
        evaluatedAt: now,
        changedAt: invalidation.eventAt,
        orderAffecting: false,
      };
    }
    return {
      version: NEXUS_PURE_STATE_MACHINE_VERSION,
      machine: input.machine,
      direction: input.direction,
      state: previous.state,
      triggerFactId: previous.triggerFactId,
      evidenceFactIds: previous.evidenceFactIds,
      missing: [],
      transitions: [],
      evaluatedAt: now,
      changedAt: previous.changedAt,
      orderAffecting: false,
    };
  }
  const mark = latest(facts, "MARK_PRICE_UPDATED");
  if (!mark)
    return {
      version: NEXUS_PURE_STATE_MACHINE_VERSION,
      machine: input.machine,
      direction: input.direction,
      state: "WAIT_DATA",
      triggerFactId: null,
      evidenceFactIds: [],
      missing: ["新鲜统一标记价格"],
      transitions: [],
      evaluatedAt: now,
      changedAt: now,
      orderAffecting: false,
    };

  const triggerSide =
    input.triggerLiquidationSide ??
    defaultTriggerSide(input.machine, input.direction);
  const matchingTriggers = facts.filter(
      (fact) =>
        (fact.kind === "LIQUIDATION_AGGREGATED" ||
          fact.kind === "MARKET_STRUCTURE_WAKE") &&
        fact.payload.side === triggerSide,
    );
  const trigger =
    (input.triggerFactId
      ? matchingTriggers.find((fact) => fact.id === input.triggerFactId)
      : undefined) ?? matchingTriggers.at(-1);
  if (!trigger)
    return {
      version: NEXUS_PURE_STATE_MACHINE_VERSION,
      machine: input.machine,
      direction: input.direction,
      state: "WATCHING",
      triggerFactId: null,
      evidenceFactIds: [mark.id],
      missing: [
        triggerSide === "SELL"
          ? "本方向多头爆仓卖出事实"
          : "本方向空头爆仓买入事实",
      ],
      transitions: [],
      evaluatedAt: now,
      changedAt: mark.eventAt,
      orderAffecting: false,
    };

  let state: NexusPureMachineState = "WATCHING";
  let changedAt = trigger.eventAt;
  const evidence = new Set<string>([mark.id, trigger.id]);
  const transitions: NexusPureMachineTransition[] = [];
  transition("TRIGGERED", trigger, "方向触发事实成立");

  const afterTrigger = facts.filter(
    (fact) =>
      fact.eventAt >= trigger.eventAt &&
      fact.kind !== "MARK_PRICE_UPDATED" &&
      fact.kind !== "LIQUIDATION_AGGREGATED" &&
      fact.kind !== "MARKET_STRUCTURE_WAKE",
  );
  const expectedImpulse =
    triggerSide === "SELL" ? "PRICE_IMPULSE_DOWN" : "PRICE_IMPULSE_UP";
  const impulse = afterTrigger.find((fact) => fact.kind === expectedImpulse);
  // The liquidation event is already the directional trigger. The derived
  // 1-3 minute impulse is useful evidence, but it must not become a second
  // mandatory trigger: exchange event time and candle close time can straddle
  // a minute boundary and otherwise leave a valid lifecycle permanently
  // stuck in TRIGGERED. Entry still requires the named structure and volume
  // transitions below, so removing this hard prerequisite does not bypass
  // confirmation.
  if (impulse) {
    evidence.add(impulse.id);
    changedAt = Math.max(changedAt, impulse.eventAt);
  }
  for (const fact of afterTrigger) {
    if (
      fact.kind === "PRICE_IMPULSE_UP" ||
      fact.kind === "PRICE_IMPULSE_DOWN"
    )
      continue;
    const next = nextTransition(input.machine, input.direction, state, fact);
    if (!next) continue;
    transition(next.state, fact, next.message);
    if (
      input.machine === "TREND_BREAKOUT" &&
      (state as NexusPureMachineState) === "MOMENTUM_CONFIRMED" &&
      fact.kind === "VOLUME_EXPANDED"
    )
      transition("READY_SHADOW", fact, "突破结构与独立量能全部闭合");
  }

  const missing = missingFor(input.machine, input.direction, state);
  return {
    version: NEXUS_PURE_STATE_MACHINE_VERSION,
    machine: input.machine,
    direction: input.direction,
    state,
    triggerFactId: trigger.id,
    evidenceFactIds: [...evidence].sort(),
    missing,
    transitions,
    evaluatedAt: now,
    changedAt,
    orderAffecting: false,
  };

  function transition(
    nextState: NexusPureMachineState,
    fact: NexusMarketFact,
    message: string,
  ) {
    if (!legalTransition(state, nextState))
      throw new Error(`非法状态转换 ${state} -> ${nextState}`);
    transitions.push({
      from: state,
      to: nextState,
      factId: fact.id,
      factKind: fact.kind,
      eventAt: fact.eventAt,
      message,
    });
    state = nextState;
    changedAt = fact.eventAt;
    evidence.add(fact.id);
  }
}

function terminalPreviousSnapshot(input: {
  machine: NexusPureMachineKind;
  direction: NexusPureMachineDirection;
  triggerFactId?: string | null;
  previous?: Partial<NexusPureMachineSnapshot> | Record<string, unknown> | null;
}) {
  const previous = input.previous;
  if (!previous || typeof previous !== "object") return null;
  if (
    previous.version !== NEXUS_PURE_STATE_MACHINE_VERSION ||
    previous.machine !== input.machine ||
    previous.direction !== input.direction ||
    !["READY_SHADOW", "INVALIDATED"].includes(String(previous.state))
  )
    return null;
  const triggerFactId =
    typeof previous.triggerFactId === "string"
      ? previous.triggerFactId
      : null;
  if (
    input.triggerFactId &&
    triggerFactId &&
    input.triggerFactId !== triggerFactId
  )
    return null;
  const changedAt = Number(previous.changedAt);
  if (!Number.isFinite(changedAt)) return null;
  const evidenceFactIds = Array.isArray(previous.evidenceFactIds)
    ? previous.evidenceFactIds.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    state: previous.state as "READY_SHADOW" | "INVALIDATED",
    triggerFactId,
    evidenceFactIds,
    changedAt,
  };
}

function nextTransition(
  machine: NexusPureMachineKind,
  direction: NexusPureMachineDirection,
  state: NexusPureMachineState,
  fact: NexusMarketFact,
): { state: NexusPureMachineState; message: string } | null {
  if (state === "INVALIDATED" || state === "READY_SHADOW") {
    if (invalidates(direction, fact))
      return state === "INVALIDATED"
        ? null
        : { state: "INVALIDATED", message: "确认后出现反向结构失效" };
    return null;
  }
  if (
    ["STRUCTURE_CONFIRMED", "MOMENTUM_CONFIRMED"].includes(state) &&
    invalidates(direction, fact)
  )
    return { state: "INVALIDATED", message: "确认过程中结构失效" };

  if (machine === "TREND_BREAKOUT") {
    const breakout =
      direction === "LONG" ? "PRICE_NEW_HIGH" : "PRICE_NEW_LOW";
    if (
      state === "TRIGGERED" &&
      fact.kind === breakout &&
      closedBreakoutConfirmed(direction, fact)
    )
      return { state: "STRUCTURE_CONFIRMED", message: "趋势突破结构成立" };
  } else if (machine === "SUPPORT_REVERSAL") {
    const first =
      direction === "LONG" ? "SUPPORT_SWEPT" : "PRICE_NEW_HIGH";
    const second =
      direction === "LONG"
        ? "SUPPORT_RECLAIMED"
        : "RESISTANCE_REJECTED";
    if (state === "TRIGGERED" && fact.kind === first)
      return { state: "STRUCTURE_CONFIRMED", message: "反转前置结构成立" };
    if (state === "STRUCTURE_CONFIRMED" && fact.kind === second)
      return { state: "MOMENTUM_CONFIRMED", message: "反转闭合确认成立" };
  } else {
    if (state === "TRIGGERED" && fact.kind === "SUPPORT_BROKEN")
      return { state: "STRUCTURE_CONFIRMED", message: "支撑跌破成立" };
    if (
      state === "STRUCTURE_CONFIRMED" &&
      fact.kind === "FAILED_RETEST_CONFIRMED"
    )
      return { state: "MOMENTUM_CONFIRMED", message: "反抽失败确认成立" };
  }

  if (
    state === "STRUCTURE_CONFIRMED" &&
    machine === "TREND_BREAKOUT" &&
    fact.kind === "VOLUME_EXPANDED"
  )
    return { state: "MOMENTUM_CONFIRMED", message: "突破成交量确认成立" };
  if (
    state === "MOMENTUM_CONFIRMED" &&
    fact.kind === "VOLUME_EXPANDED"
  )
    return { state: "READY_SHADOW", message: "结构与独立量能全部闭合" };
  return null;
}

function legalTransition(
  from: NexusPureMachineState,
  to: NexusPureMachineState,
) {
  if (to === "INVALIDATED")
    return ["STRUCTURE_CONFIRMED", "MOMENTUM_CONFIRMED", "READY_SHADOW"].includes(
      from,
    );
  const allowed: Partial<Record<NexusPureMachineState, NexusPureMachineState[]>> = {
    WATCHING: ["TRIGGERED"],
    TRIGGERED: ["STRUCTURE_CONFIRMED"],
    STRUCTURE_CONFIRMED: ["MOMENTUM_CONFIRMED"],
    MOMENTUM_CONFIRMED: ["READY_SHADOW"],
  };
  return allowed[from]?.includes(to) ?? false;
}

function invalidates(
  direction: NexusPureMachineDirection,
  fact: NexusMarketFact,
) {
  return fact.kind === (direction === "LONG" ? "PRICE_NEW_LOW" : "PRICE_NEW_HIGH");
}

function closedBreakoutConfirmed(
  direction: NexusPureMachineDirection,
  fact: NexusMarketFact,
) {
  const close = Number(fact.payload.price);
  const boundary = Number(
    direction === "LONG"
      ? fact.payload.priorHigh
      : fact.payload.priorLow,
  );
  // Older persisted facts did not carry the close/boundary pair. Preserve
  // their replay behavior; all current closed-candle facts use the strict
  // close-through-boundary rule below.
  if (!Number.isFinite(close) || !Number.isFinite(boundary)) return true;
  return direction === "LONG" ? close > boundary : close < boundary;
}

function defaultTriggerSide(
  machine: NexusPureMachineKind,
  direction: NexusPureMachineDirection,
) {
  if (machine === "DOWNTREND_CONTINUATION") return "SELL" as const;
  return direction === "LONG" ? ("SELL" as const) : ("BUY" as const);
}

function missingFor(
  machine: NexusPureMachineKind,
  direction: NexusPureMachineDirection,
  state: NexusPureMachineState,
) {
  if (state === "READY_SHADOW" || state === "INVALIDATED") return [];
  if (state === "TRIGGERED") {
    if (machine === "TREND_BREAKOUT")
      return [direction === "LONG" ? "向上突破闭合事实" : "向下突破闭合事实"];
    if (machine === "SUPPORT_REVERSAL")
      return [direction === "LONG" ? "支撑扫盘事实" : "阻力冲高事实"];
    return ["支撑跌破事实"];
  }
  if (state === "STRUCTURE_CONFIRMED") {
    if (machine === "SUPPORT_REVERSAL")
      return [direction === "LONG" ? "支撑收回事实" : "阻力拒绝事实"];
    if (machine === "DOWNTREND_CONTINUATION") return ["反抽失败事实"];
    return ["目标币3/5分钟已闭合成交量扩张事实"];
  }
  if (state === "MOMENTUM_CONFIRMED")
    return ["目标币3/5分钟已闭合成交量扩张事实"];
  return [];
}

function latest(facts: NexusMarketFact[], kind: NexusMarketFactKind) {
  return [...facts].reverse().find((fact) => fact.kind === kind);
}
