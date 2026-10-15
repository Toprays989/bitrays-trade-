import type {
  NexusPureMachineKind,
  NexusPureMachineState,
} from "./nexus-brain-state-machines";
import type { NexusMarketRegime } from "./nexus-market-regime";
import type { NexusBtcRelationshipState } from "./nexus-btc-relationship";
import type { NexusVolumeTimingConcordance } from "./nexus-volume-timing-concordance";
import type { LiquidationFactorBrainDecision } from "./liquidation-derived-factors";

export const NEXUS_MARKET_EYE_DECISION_VERSION =
  "nexus-market-eye-decision-v13" as const;

const RANGE_ENTRY_VOLUME_EXHAUSTION_MULTIPLIER = 2.5;

/**
 * 使用最新一根已闭合执行周期K线，对比此前固定数量的已闭合K线。
 * 固定窗口避免长历史中的异常放量扭曲当前入场节奏。
 */
export function calculateNexusClosedEntryRelativeVolume(
  candles: Array<{ volume?: number | null }>,
  baselineCount = 10,
) {
  const count = Math.max(2, Math.trunc(baselineCount));
  const volumes = candles
    .map((candle) => Number(candle.volume))
    .filter((volume) => Number.isFinite(volume) && volume >= 0);
  if (volumes.length < count + 1) return null;
  const window = volumes.slice(-(count + 1));
  const latest = window.at(-1)!;
  const baseline = window.slice(0, -1);
  const average =
    baseline.reduce((sum, volume) => sum + volume, 0) / baseline.length;
  return average > 0 ? latest / average : null;
}

export type NexusMarketEyeVerdict =
  | "CONFIRMED"
  | "WAIT"
  | "BLOCKED"
  | "INSUFFICIENT";

export type NexusMarketEyePath = {
  machine: NexusPureMachineKind;
  direction: "LONG" | "SHORT";
  state: NexusPureMachineState;
  changedAt: number;
  evidenceFactIds: string[];
  missing: string[];
};

export type NexusMarketEyeDecision = {
  version: typeof NEXUS_MARKET_EYE_DECISION_VERSION;
  direction: "LONG" | "SHORT";
  verdict: NexusMarketEyeVerdict;
  code:
    | "EYE_PATH_INVALIDATED"
    | "EYE_PATH_PENDING"
    | "EYE_DECISION_SNAPSHOT_INCOMPLETE"
    | "EYE_SELF_MACRO_TREND_INSUFFICIENT"
    | "EYE_SELF_MACRO_TREND_CONFLICT"
    | "EYE_ENTRY_TREND_INSUFFICIENT"
    | "EYE_ENTRY_TREND_CONFLICT"
    | "EYE_ENTRY_TREND_TRANSITION"
    | "EYE_REVERSAL_WAIT_ENTRY_TRANSITION"
    | "EYE_VOLUME_TIMING_INVALID"
    | "EYE_IMPULSE_FOLLOW_THROUGH_MISSING"
    | "EYE_CURRENT_ENTRY_VOLUME_UNCONFIRMED"
    | "EYE_RANGE_VOLUME_EXHAUSTION_WAIT"
    | "EYE_BTC_MACRO_TREND_INSUFFICIENT"
    | "EYE_BTC_MACRO_TREND_CONFLICT"
    | "EYE_BTC_MACRO_TREND_TRANSITION"
    | "EYE_INDEPENDENT_VOLUME_CONFIRMED"
    | "EYE_BTC_FOLLOWING_CONFIRMED"
    | "EYE_OWN_EVIDENCE_CONFIRMED";
  summary: string;
  selectedPath: NexusPureMachineKind | null;
  missing: string[];
  evidence: {
    ownMacroRegime: NexusMarketRegime;
    ownEntryRegime: NexusMarketRegime;
    btcMacroRegime: NexusMarketRegime;
    btcRelationship: NexusBtcRelationshipState;
    /** 1分钟执行窗口量能；用于判断此刻能否承接背景趋势。 */
    relativeVolume: number | null;
    /** 15分钟背景窗口量能；只解释波段环境，不代替1分钟执行确认。 */
    contextRelativeVolume: number | null;
    requiredRelativeVolume: number;
    maximumRangeEntryRelativeVolume: number;
    entryVolumeConfirmed: boolean;
    contextVolumeConfirmed: boolean;
    volumeTiming: NexusVolumeTimingConcordance | null;
    liquidationFactorDecision: LiquidationFactorBrainDecision | null;
    paths: NexusMarketEyePath[];
  };
  orderAffecting: true;
};

export function decideNexusMarketEye(input: {
  direction: "LONG" | "SHORT";
  ownMacroRegime: NexusMarketRegime;
  ownEntryRegime: NexusMarketRegime;
  btcMacroRegime: NexusMarketRegime;
  btcRelationship?: NexusBtcRelationshipState;
  relativeVolume: number | null;
  contextRelativeVolume?: number | null;
  volumeTiming?: NexusVolumeTimingConcordance | null;
  liquidationFactorDecision?: LiquidationFactorBrainDecision | null;
  paths: NexusMarketEyePath[];
  minimumIndependentRelativeVolume?: number;
}): NexusMarketEyeDecision {
  const paths = input.paths
    .filter((path) => path.direction === input.direction)
    .map((path) => ({
      ...path,
      evidenceFactIds: [...new Set(path.evidenceFactIds)].sort(),
    }));
  const readyPaths = paths.filter((path) => path.state === "READY_SHADOW");
  const entryRelativeVolume = finiteOrNull(input.relativeVolume);
  const contextRelativeVolume = finiteOrNull(
    input.contextRelativeVolume ?? null,
  );
  const requiredRelativeVolume = Math.max(
    0.1,
    finiteOrNull(input.minimumIndependentRelativeVolume ?? null) ?? 1.2,
  );
  const maximumRangeEntryRelativeVolume =
    requiredRelativeVolume * RANGE_ENTRY_VOLUME_EXHAUSTION_MULTIPLIER;
  const evidence = {
    ownMacroRegime: input.ownMacroRegime,
    ownEntryRegime: input.ownEntryRegime,
    btcMacroRegime: input.btcMacroRegime,
    btcRelationship: input.btcRelationship ?? "INSUFFICIENT",
    relativeVolume: entryRelativeVolume,
    contextRelativeVolume,
    requiredRelativeVolume,
    maximumRangeEntryRelativeVolume,
    entryVolumeConfirmed:
      entryRelativeVolume !== null &&
      entryRelativeVolume >= requiredRelativeVolume,
    contextVolumeConfirmed:
      contextRelativeVolume !== null &&
      contextRelativeVolume >= requiredRelativeVolume,
    volumeTiming: input.volumeTiming ?? null,
    liquidationFactorDecision: input.liquidationFactorDecision ?? null,
    paths,
  };
  const result = (
    verdict: NexusMarketEyeVerdict,
    code: NexusMarketEyeDecision["code"],
    summary: string,
    selectedPath: NexusPureMachineKind | null = null,
    missing: string[] = [],
  ): NexusMarketEyeDecision => ({
    version: NEXUS_MARKET_EYE_DECISION_VERSION,
    direction: input.direction,
    verdict,
    code,
    summary,
    selectedPath,
    missing,
    evidence,
    orderAffecting: true,
  });

  if (
    paths.length > 0 &&
    paths.every((path) => path.state === "INVALIDATED")
  )
    return result(
      "BLOCKED",
      "EYE_PATH_INVALIDATED",
      "本方向所有候选路径均已失效",
    );
  if (readyPaths.length === 0) {
    const pathMissing = [
      ...new Set(paths.flatMap((path) => path.missing)),
    ];
    const volumeContext = describePendingVolume({
      missing: pathMissing,
      entryRelativeVolume,
      contextRelativeVolume,
      requiredRelativeVolume,
    });
    return result(
      "WAIT",
      "EYE_PATH_PENDING",
      `状态机仍在等待：${
        pathMissing.join("、") ||
        "结构与动量证据闭合"
      }${volumeContext ? `；${volumeContext}` : ""}`,
      null,
      [
        ...pathMissing,
        "至少一条具名入场路径进入 READY_SHADOW",
      ],
    );
  }

  const oppositeRegime =
    input.direction === "LONG" ? "BEARISH" : "BULLISH";
  const reversalPath = readyPaths.find(
    (path) => path.machine === "SUPPORT_REVERSAL",
  );
  const continuationPath = readyPaths.find(
    (path) => path.machine === "DOWNTREND_CONTINUATION",
  );
  const breakoutPath = readyPaths.find(
    (path) => path.machine === "TREND_BREAKOUT",
  );
  const selectedPath =
    selectPath({
      direction: input.direction,
      ownMacroRegime: input.ownMacroRegime,
      ownEntryRegime: input.ownEntryRegime,
      reversalPath,
      continuationPath,
      breakoutPath,
    });

  if (!selectedPath) {
    if (
      reversalPath &&
      input.ownMacroRegime === oppositeRegime &&
      [oppositeRegime, "RANGE"].includes(input.ownEntryRegime)
    )
      return result(
        "WAIT",
        "EYE_REVERSAL_WAIT_ENTRY_TRANSITION",
        "反转结构已形成，但5分钟进场节奏尚未从原趋势转出",
        reversalPath.machine,
        ["5分钟趋势进入转换或同向状态"],
      );
    if (input.ownMacroRegime === "INSUFFICIENT")
      return result(
        "INSUFFICIENT",
        "EYE_SELF_MACRO_TREND_INSUFFICIENT",
        "目标合约1/2/3小时方向背景样本不足",
        null,
        ["目标合约1/2/3小时已闭合K线与磨盘阶段"],
      );
    if (input.ownEntryRegime === "INSUFFICIENT")
      return result(
        "INSUFFICIENT",
        "EYE_ENTRY_TREND_INSUFFICIENT",
        "目标合约5分钟进场节奏样本不足",
        null,
        ["目标合约5分钟趋势"],
      );
    return result(
      "WAIT",
      "EYE_ENTRY_TREND_CONFLICT",
      "已就绪路径与目标合约1/2/3小时方向及价格成交量节奏不一致",
      null,
      ["等待价格结构与集中成交量形成同向执行节奏"],
    );
  }

  const volumeTiming = input.volumeTiming ?? null;
  if (
    volumeTiming &&
    [
      "TIME_MISALIGNED",
      "POST_TRIGGER_EXECUTION_PENDING",
      "CURRENT_FACT_STALE",
      "DATA_INCOMPLETE",
    ].includes(volumeTiming.state)
  )
    return result(
      "WAIT",
      "EYE_VOLUME_TIMING_INVALID",
      volumeTiming.summary,
      selectedPath.machine,
      ["同一决策时点的最新1分钟与15分钟闭合量价事实"],
    );
  if (
    volumeTiming?.continuationRequiresFreshExecution &&
    selectedPath.machine !== "SUPPORT_REVERSAL"
  )
    return result(
      "WAIT",
      "EYE_IMPULSE_FOLLOW_THROUGH_MISSING",
      `${pathLabel(selectedPath.machine)}已形成，但${volumeTiming.summary}`,
      selectedPath.machine,
      ["当前1分钟闭合成交量重新确认资金接力"],
    );

  if (!evidence.entryVolumeConfirmed)
    return result(
      "WAIT",
      "EYE_CURRENT_ENTRY_VOLUME_UNCONFIRMED",
      `${pathLabel(selectedPath.machine)}已经就绪，但最新闭合1分钟真实成交量仅 ${formatVolume(entryRelativeVolume)}` +
        `，未达到本策略 ${requiredRelativeVolume.toFixed(2)}× 的执行阈值；错误机会不入场，等待资金真正接力。`,
      selectedPath.machine,
      ["最新闭合1分钟真实成交量达到本策略阈值"],
    );

  if (
    input.ownMacroRegime === "RANGE" &&
    entryRelativeVolume !== null &&
    entryRelativeVolume > maximumRangeEntryRelativeVolume
  )
    return result(
      "WAIT",
      "EYE_RANGE_VOLUME_EXHAUSTION_WAIT",
      `${pathLabel(selectedPath.machine)}已经就绪，但震荡区最新闭合1分钟真实成交量达到 ${formatVolume(entryRelativeVolume)}` +
        `，超过本策略 ${maximumRangeEntryRelativeVolume.toFixed(2)}× 的冲击耗尽边界；等待下一根闭合1分钟量能回落后再确认，避免追在冲击末端。`,
      selectedPath.machine,
      ["下一根闭合1分钟量能回落且原价格路径仍然有效"],
    );

  const btcRelationship = input.btcRelationship ?? "INSUFFICIENT";
  if (btcRelationship === "INDEPENDENT_VOLUME_DRIVEN")
    return result(
      "CONFIRMED",
      "EYE_INDEPENDENT_VOLUME_CONFIRMED",
      `${pathLabel(selectedPath.machine)}、目标币自身节奏及与BTC脱钩的独立资金流共同确认${directionLabel(input.direction)}${volumeTimingSuffix(volumeTiming)}`,
      selectedPath.machine,
    );
  return result(
    "CONFIRMED",
    "EYE_OWN_EVIDENCE_CONFIRMED",
    `${pathLabel(selectedPath.machine)}已由目标币自身多周期结构、价格路径和成交量闭合${volumeTimingSuffix(volumeTiming)}；BTC关系与大盘方向仅记录为归因背景，不参与下单放行或否决`,
    selectedPath.machine,
  );
}

function selectPath(input: {
  direction: "LONG" | "SHORT";
  ownMacroRegime: NexusMarketRegime;
  ownEntryRegime: NexusMarketRegime;
  reversalPath?: NexusMarketEyePath;
  continuationPath?: NexusMarketEyePath;
  breakoutPath?: NexusMarketEyePath;
}) {
  const aligned =
    input.direction === "LONG" ? "BULLISH" : "BEARISH";
  const opposite =
    input.direction === "LONG" ? "BEARISH" : "BULLISH";

  if (
    input.continuationPath &&
    input.ownMacroRegime === aligned &&
    [aligned, "TRANSITION"].includes(input.ownEntryRegime)
  )
    return input.continuationPath;
  if (
    input.breakoutPath &&
    (
      input.ownMacroRegime === aligned ||
      ["RANGE", "TRANSITION"].includes(input.ownMacroRegime)
    ) &&
    [aligned, "TRANSITION"].includes(input.ownEntryRegime)
  )
    return input.breakoutPath;
  if (
    input.reversalPath &&
    (
      input.ownEntryRegime === aligned ||
      (
        input.ownMacroRegime === opposite &&
        input.ownEntryRegime === "TRANSITION"
      ) ||
      (
        ["RANGE", "TRANSITION"].includes(input.ownMacroRegime) &&
        ["TRANSITION", aligned].includes(input.ownEntryRegime)
      )
    )
  )
    return input.reversalPath;
  return null;
}

function pathLabel(machine: NexusPureMachineKind) {
  return {
    TREND_BREAKOUT: "趋势突破路径",
    SUPPORT_REVERSAL: "支撑反转路径",
    DOWNTREND_CONTINUATION: "下跌延续路径",
  }[machine];
}

function directionLabel(direction: "LONG" | "SHORT") {
  return direction === "LONG" ? "做多" : "做空";
}

function finiteOrNull(value: number | null) {
  return Number.isFinite(value) ? Number(value) : null;
}

function describePendingVolume(input: {
  missing: string[];
  entryRelativeVolume: number | null;
  contextRelativeVolume: number | null;
  requiredRelativeVolume: number;
}) {
  if (!input.missing.some((item) => item.includes("成交量"))) return "";
  const entry = formatVolume(input.entryRelativeVolume);
  const context = formatVolume(input.contextRelativeVolume);
  if (
    input.contextRelativeVolume !== null &&
    input.contextRelativeVolume >= input.requiredRelativeVolume &&
    (input.entryRelativeVolume === null ||
      input.entryRelativeVolume < input.requiredRelativeVolume)
  )
    return (
      `15分钟背景量能已扩张至 ${context}，但1分钟执行量能仅 ${entry}` +
      `（要求 ${input.requiredRelativeVolume.toFixed(2)}×），等待短线量能接力`
    );
  if (
    input.entryRelativeVolume !== null &&
    input.entryRelativeVolume >= input.requiredRelativeVolume
  )
    return (
      `1分钟执行量能已达 ${entry}，等待闭合K线量能事实进入状态机，` +
      "不使用未闭合成交量抢跑"
    );
  return (
    `15分钟背景量能 ${context}，1分钟执行量能 ${entry}` +
    `（要求 ${input.requiredRelativeVolume.toFixed(2)}×），当前尚未形成可执行放量`
  );
}

function formatVolume(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}×`;
}

function volumeTimingSuffix(
  timing: NexusVolumeTimingConcordance | null,
) {
  if (!timing) return "";
  if (timing.state === "IMPULSE_DECAYED")
    return `；量价时序识别为冲击衰减，当前路径按反转衰竭证据解释（${timing.summary}）`;
  return `；量价时序：${timing.summary}`;
}
