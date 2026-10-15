export const THREE_MINUTE_ROUND_SECONDS = 180 as const;
export const THREE_MINUTE_ROUND_MS = THREE_MINUTE_ROUND_SECONDS * 1_000;

export type ThreeMinuteRound = Readonly<{
  roundId: string;
  startedAt: number;
  endsAt: number;
}>;

export type ThreeMinutePositionPlan = Readonly<{
  version: "three-minute-position-plan-v1";
  timeExitSeconds: number;
  earlyStopEnabled: boolean;
  earlyTakeProfitEnabled: boolean;
  profitCaptureNetRoePercent: number | null;
  estimatedRoundTripCostBps: number;
}>;

export function resolveThreeMinutePositionPlan(
  value: unknown,
): ThreeMinutePositionPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as Record<string, unknown>;
  if (plan.version !== "three-minute-position-plan-v1") return null;
  const timeExitSeconds = Number(plan.timeExitSeconds);
  return Object.freeze({
    version: "three-minute-position-plan-v1",
    timeExitSeconds:
      Number.isFinite(timeExitSeconds) && timeExitSeconds > 0
        ? timeExitSeconds
        : THREE_MINUTE_ROUND_SECONDS,
    earlyStopEnabled: plan.earlyStopEnabled === true,
    earlyTakeProfitEnabled: plan.earlyTakeProfitEnabled === true,
    profitCaptureNetRoePercent: finiteInRange(
      plan.profitCaptureNetRoePercent,
      0.1,
      100,
    ),
    estimatedRoundTripCostBps: finiteInRange(
      plan.estimatedRoundTripCostBps,
      0,
      200,
    ) ?? 0,
  });
}

export function threeMinuteProfitCaptureHit(input: {
  currentGrossRoePercent: number;
  leverage: number;
  plan: ThreeMinutePositionPlan | null;
}) {
  if (!input.plan || input.plan.profitCaptureNetRoePercent === null)
    return false;
  const grossRoePercent = Number(input.currentGrossRoePercent);
  const leverage = Number(input.leverage);
  if (
    !Number.isFinite(grossRoePercent) ||
    !Number.isFinite(leverage) ||
    leverage <= 0
  ) return false;
  const estimatedNetRoePercent = grossRoePercent -
    leverage * input.plan.estimatedRoundTripCostBps / 100;
  return estimatedNetRoePercent >= input.plan.profitCaptureNetRoePercent;
}

export function threeMinuteRoundAt(timestampMs: number): ThreeMinuteRound {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0)
    throw new Error("3分钟轮次时间无效");
  const startedAt = Math.floor(timestampMs / THREE_MINUTE_ROUND_MS) *
    THREE_MINUTE_ROUND_MS;
  return Object.freeze({
    roundId: `3m-${startedAt}`,
    startedAt,
    endsAt: startedAt + THREE_MINUTE_ROUND_MS,
  });
}

export function nextCompleteThreeMinuteRound(timestampMs: number) {
  const current = threeMinuteRoundAt(timestampMs);
  return Object.freeze({
    roundId: `3m-${current.endsAt}`,
    startedAt: current.endsAt,
    endsAt: current.endsAt + THREE_MINUTE_ROUND_MS,
  });
}

export function threeMinuteRollingEvaluationDue(input: {
  nowMs: number;
  lastEvaluatedAtMs?: number | null;
  cadenceSeconds: number;
}) {
  if (!Number.isFinite(input.nowMs) || input.nowMs <= 0) return false;
  const cadenceMs = Math.max(1, Math.trunc(input.cadenceSeconds)) * 1_000;
  const lastEvaluatedAtMs = Number(input.lastEvaluatedAtMs);
  return !Number.isFinite(lastEvaluatedAtMs) ||
    lastEvaluatedAtMs <= 0 ||
    input.nowMs - lastEvaluatedAtMs >= cadenceMs;
}

export function threeMinuteRoundExecutionKey(input: {
  strategyId: number;
  configVersion: number;
  symbol: string;
  roundId: string;
}) {
  if (!Number.isInteger(input.strategyId) || input.strategyId <= 0)
    throw new Error("轮次策略编号无效");
  if (!Number.isInteger(input.configVersion) || input.configVersion <= 0)
    throw new Error("轮次配置版本无效");
  const symbol = input.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error("轮次合约无效");
  if (!/^3m-\d+$/.test(input.roundId)) throw new Error("轮次编号无效");
  return `${input.strategyId}:${input.configVersion}:${symbol}:${input.roundId}`;
}

export function threeMinuteTimeExitDue(input: {
  openedAtMs: number;
  nowMs: number;
  holdSeconds?: number;
}) {
  const holdSeconds = input.holdSeconds ?? THREE_MINUTE_ROUND_SECONDS;
  return Number.isFinite(input.openedAtMs) &&
    Number.isFinite(input.nowMs) &&
    holdSeconds > 0 &&
    input.nowMs >= input.openedAtMs + holdSeconds * 1_000;
}

export function threeMinuteEarlyExitCounterfactualDue(input: {
  openedAtMs: number;
  closedAtMs: number;
  nowMs: number;
  holdSeconds?: number;
}) {
  const holdSeconds = input.holdSeconds ?? THREE_MINUTE_ROUND_SECONDS;
  const dueAtMs = input.openedAtMs + holdSeconds * 1_000;
  return Number.isFinite(input.openedAtMs) &&
    Number.isFinite(input.closedAtMs) &&
    Number.isFinite(input.nowMs) &&
    holdSeconds > 0 &&
    input.closedAtMs >= input.openedAtMs &&
    input.closedAtMs < dueAtMs &&
    input.nowMs >= dueAtMs;
}

function finiteInRange(value: unknown, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}
