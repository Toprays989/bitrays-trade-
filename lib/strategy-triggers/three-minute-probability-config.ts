export type ThreeMinuteProbabilityTriggerConfig = Readonly<{
  roundSeconds: 180;
  evaluationCadenceSeconds: number;
  timeExitSeconds: number;
  maxFactAgeMs: number;
  maxCandidatesPerRound: number;
  minimumProbabilityPercent: number;
  minimumNetEdgeBps: number;
  estimatedRoundTripFeeBps: number;
  estimatedSlippageBps: number;
  calibrationRounds: number;
  calibrationMode: "MINIMUM_ORDER" | "OBSERVE_ONLY";
  negativeExpectancyMode: "OBSERVE_ONLY" | "MINIMUM_ORDER";
  batchSize: number;
  earlyStopEnabled: boolean;
  earlyTakeProfitEnabled: boolean;
  profitCaptureNetRoePercent: number;
}>;

export const DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG:
  ThreeMinuteProbabilityTriggerConfig = Object.freeze({
  roundSeconds: 180,
  evaluationCadenceSeconds: 9,
  timeExitSeconds: 180,
    maxFactAgeMs: 3_000,
    maxCandidatesPerRound: 5,
    minimumProbabilityPercent: 56,
    minimumNetEdgeBps: 8,
    estimatedRoundTripFeeBps: 8,
    estimatedSlippageBps: 5,
    calibrationRounds: 20,
    // Calibration samples currently come from completed real position
    // lifecycles.  OBSERVE_ONLY cannot create one of those samples, so using it
    // as the default leaves a new strategy permanently unable to finish
    // calibration.  Keep the existing exchange-minimum sizing path as the
    // bounded bootstrap, while negative batches still fall back to
    // OBSERVE_ONLY for operator review.
    calibrationMode: "MINIMUM_ORDER",
    negativeExpectancyMode: "OBSERVE_ONLY",
    batchSize: 20,
    earlyStopEnabled: true,
    earlyTakeProfitEnabled: true,
    profitCaptureNetRoePercent: 4,
  });

export function normalizeThreeMinuteProbabilityTriggerConfig(
  value: unknown,
): ThreeMinuteProbabilityTriggerConfig {
  const input = isRecord(value) ? value : {};
  return {
    roundSeconds: 180,
    evaluationCadenceSeconds: integerOr(
      input.evaluationCadenceSeconds,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.evaluationCadenceSeconds,
    ),
    timeExitSeconds: integerOr(
      input.timeExitSeconds,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.timeExitSeconds,
    ),
    maxFactAgeMs: integerOr(
      input.maxFactAgeMs,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.maxFactAgeMs,
    ),
    // Candidate admission is a system capability: every scan may enqueue at
    // most three candidates into the durable twelve-slot queue. Old strategy
    // versions are normalized instead of being rejected after a restart.
    maxCandidatesPerRound: 5,
    minimumProbabilityPercent: finiteOr(
      input.minimumProbabilityPercent,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.minimumProbabilityPercent,
    ),
    minimumNetEdgeBps: finiteOr(
      input.minimumNetEdgeBps,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.minimumNetEdgeBps,
    ),
    estimatedRoundTripFeeBps: finiteOr(
      input.estimatedRoundTripFeeBps,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.estimatedRoundTripFeeBps,
    ),
    estimatedSlippageBps: finiteOr(
      input.estimatedSlippageBps,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.estimatedSlippageBps,
    ),
    calibrationRounds: integerOr(
      input.calibrationRounds,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.calibrationRounds,
    ),
    calibrationMode:
      input.calibrationMode === "MINIMUM_ORDER" ||
          input.calibrationMode === "OBSERVE_ONLY"
        ? input.calibrationMode
        : DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.calibrationMode,
    negativeExpectancyMode:
      input.negativeExpectancyMode === "MINIMUM_ORDER"
        ? "MINIMUM_ORDER"
        : "OBSERVE_ONLY",
    batchSize: integerOr(
      input.batchSize,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.batchSize,
    ),
    earlyStopEnabled: input.earlyStopEnabled === true,
    earlyTakeProfitEnabled: input.earlyTakeProfitEnabled === true,
    profitCaptureNetRoePercent: finiteOr(
      input.profitCaptureNetRoePercent,
      DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.profitCaptureNetRoePercent,
    ),
  };
}

export function validateThreeMinuteProbabilityTriggerConfig(value: unknown) {
  if (!isRecord(value)) return "请配置3分钟概率轮次参数";
  if (Number(value.roundSeconds) !== 180) return "概率轮次必须固定为180秒";
  if (!integerInRange(value.evaluationCadenceSeconds, 3, 60))
    return "滚动重评估间隔需为3至60秒";
  if (!integerInRange(value.timeExitSeconds, 60, 900))
    return "成交后固定退出需为60至900秒";
  if (!integerInRange(value.maxFactAgeMs, 1_000, 30_000))
    return "轮次事实最大延迟需为1000至30000毫秒";
  if (Number(value.maxCandidatesPerRound) !== 5)
    return "每轮候选数必须固定为5个";
  if (!finiteInRange(value.minimumProbabilityPercent, 50, 99))
    return "最低方向概率需为50%至99%";
  if (!finiteInRange(value.minimumNetEdgeBps, 0, 1_000))
    return "最低费用后净优势需为0至1000个基点";
  if (!finiteInRange(value.estimatedRoundTripFeeBps, 0, 100))
    return "预估双边手续费需为0至100个基点";
  if (!finiteInRange(value.estimatedSlippageBps, 0, 100))
    return "预估滑点需为0至100个基点";
  if (!integerInRange(value.calibrationRounds, 0, 100))
    return "初始校准轮次需为0至100轮";
  if (!["MINIMUM_ORDER", "OBSERVE_ONLY"].includes(String(value.calibrationMode)))
    return "初始校准方式无效";
  if (!["MINIMUM_ORDER", "OBSERVE_ONLY"].includes(String(value.negativeExpectancyMode)))
    return "负期望处理方式无效";
  if (!integerInRange(value.batchSize, 5, 100))
    return "学习批次需为5至100轮";
  if (typeof value.earlyStopEnabled !== "boolean") return "提前止损开关无效";
  if (typeof value.earlyTakeProfitEnabled !== "boolean") return "提前止盈开关无效";
  if (!finiteInRange(value.profitCaptureNetRoePercent, 0.1, 100))
    return "费用后盈利封顶需为0.1%至100%";
  return null;
}

function finiteOr(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integerOr(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function finiteInRange(value: unknown, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function integerInRange(value: unknown, min: number, max: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
