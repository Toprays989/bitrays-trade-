import type {
  PositionHoldingMandate,
  PositionHoldingHorizon,
} from "./position-holding-mandate.ts";
import type { PostEntryTrendPathStatus } from "./post-entry-trend-path.ts";

export const POST_ENTRY_CONTRACT_TREND_VERSION =
  "post-entry-contract-trend-v7" as const;

type JsonRecord = Record<string, unknown>;
type Direction = "UP" | "DOWN" | "RANGE" | "INSUFFICIENT";

export type PostEntryContractTrendProfile = {
  version: typeof POST_ENTRY_CONTRACT_TREND_VERSION;
  requiredForDecision: boolean;
  status:
    | "ALIGNED"
    | "PULLBACK"
    | "TRANSITION"
    | "OPPOSED"
    | "RANGE"
    | "UNAVAILABLE";
  baseHorizon: PositionHoldingHorizon;
  effectiveHorizon:
    | PositionHoldingHorizon
    | "SWING_EXTENSION";
  swingExtensionEligible: boolean;
  swingExtensionState: "INACTIVE" | "EARNED" | "PERSISTED" | "REVOKED";
  swingExtensionEvidenceCertified: boolean;
  swingExtensionEvidenceStatus:
    | "CONFIRMED"
    | "INCOMPLETE"
    | "UNCONFIRMED"
    | "OPPOSED";
  currentGrossRoePercent: number;
  estimatedRoundTripCostRoePercent: number;
  currentNetRoePercent: number;
  observedMinutes: number | null;
  maximumObservationMinutes: number | null;
  observationHorizonState:
    | "OPEN"
    | "EXPIRED"
    | "SWING_EXTENSION"
    | "NOT_APPLICABLE";
  observationHorizonExpired: boolean;
  shortCycleExitAuthorized: boolean;
  riskIncreaseAllowed: boolean;
  profitProtectionBias:
    | "ALLOW_NORMAL_PULLBACK"
    | "TIGHTEN_ON_GIVEBACK"
    | "NEUTRAL";
  alignedHorizonCount: number;
  opposedHorizonCount: number;
  availableHorizonCount: number;
  decisiveHorizonCount: number;
  currentRegime: string | null;
  entryRegime: string | null;
  priceVolumeBehavior: string | null;
  evidenceCodes: string[];
  reason: string;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function horizonDirection(context: JsonRecord, key: string): Direction {
  const direction = String(record(context[key]).direction ?? "");
  return ["UP", "DOWN", "RANGE", "INSUFFICIENT"].includes(direction)
    ? direction as Direction
    : "INSUFFICIENT";
}

function regimeAligned(side: "LONG" | "SHORT", regime: string | null) {
  return side === "LONG" ? regime === "BULLISH" : regime === "BEARISH";
}

function regimeOpposed(side: "LONG" | "SHORT", regime: string | null) {
  return side === "LONG" ? regime === "BEARISH" : regime === "BULLISH";
}

function adversePriceVolume(
  side: "LONG" | "SHORT",
  behavior: string | null,
) {
  return side === "LONG"
    ? ["LOW_BREAKDOWN_ACCEPTED", "HIGH_REJECTION_DISTRIBUTION"].includes(
        behavior ?? "",
      )
    : ["HIGH_BREAKOUT_ACCEPTED", "LOW_RECLAIM_ACCUMULATION"].includes(
        behavior ?? "",
      );
}

/**
 * Convert the shared closed 15m/1h facts into a horizon-aware post-fill view.
 * This layer interprets evidence only; it neither submits orders nor replaces
 * deterministic stop, take-profit or liquidation protection.
 */
export function analyzePostEntryContractTrend(input: {
  positionSide: "LONG" | "SHORT";
  currentRoePercent: number;
  holdingMandate: PositionHoldingMandate;
  entryContext?: unknown;
  currentContext?: unknown;
  previousProfile?: unknown;
  observedMinutes?: number | null;
  waveStructureState?:
    | "NORMAL_RANGE"
    | "UPSIDE_BREAKOUT"
    | "SUPPORT_BREAK"
    | "UNAVAILABLE";
  tradeVolumeStatus?:
    | "DIRECTIONAL_EXPANSION"
    | "OPPOSITE_EXPANSION"
    | "CONTRACTING"
    | "MIXED"
    | "UNAVAILABLE";
  trendPathStatus?: PostEntryTrendPathStatus | null;
  estimatedRoundTripCostRoePercent?: number | null;
}): PostEntryContractTrendProfile {
  const entryContext = record(input.entryContext);
  const currentContext = record(input.currentContext);
  const currentRegime = nonEmptyString(currentContext.decisionRegime);
  const entryRegime = nonEmptyString(entryContext.decisionRegime) ??
    input.holdingMandate.entryMultiHourRegime;
  const behavior = nonEmptyString(
    record(currentContext.priceVolumeBehavior).kind,
  );
  const expectedDirection = input.positionSide === "LONG" ? "UP" : "DOWN";
  const oppositeDirection = input.positionSide === "LONG" ? "DOWN" : "UP";
  const directions = [
    horizonDirection(currentContext, "horizon1h"),
    horizonDirection(currentContext, "horizon2h"),
    horizonDirection(currentContext, "horizon3h"),
    horizonDirection(currentContext, "horizon4h"),
  ];
  const decisive = directions.filter(
    (direction) => direction === "UP" || direction === "DOWN",
  );
  const availableHorizonCount = directions.filter(
    (direction) => direction !== "INSUFFICIENT",
  ).length;
  const alignedHorizonCount = decisive.filter(
    (direction) => direction === expectedDirection,
  ).length;
  const opposedHorizonCount = decisive.filter(
    (direction) => direction === oppositeDirection,
  ).length;
  const adverseFlow = adversePriceVolume(input.positionSide, behavior);
  // RANGE 是完整、有效的市场事实，不等同于没有数据。只有周期样本
  // 真正不足或共享上下文没有给出制度状态时才失败关闭。
  const hasCurrentFacts =
    currentRegime !== null &&
    currentRegime !== "INSUFFICIENT" &&
    availableHorizonCount >= 2;
  const aligned = hasCurrentFacts &&
    regimeAligned(input.positionSide, currentRegime) &&
    alignedHorizonCount >= 2 &&
    !adverseFlow;
  // The aggregate regime/price-volume label is intentionally conservative and
  // can remain RANGE while every decisive 1h/2h/3h/4h direction has already
  // moved against the position.  That complete directional consensus is
  // sufficient multi-hour confirmation for the downstream *local* invalidation
  // sequence; it still cannot close a position by itself.
  const decisiveHorizonOpposition =
    decisive.length >= 3 &&
    alignedHorizonCount === 0 &&
    opposedHorizonCount === decisive.length;
  const opposed = hasCurrentFacts &&
    (
      (
        regimeOpposed(input.positionSide, currentRegime) &&
        opposedHorizonCount >= 2 &&
        adverseFlow
      ) ||
      decisiveHorizonOpposition
    );
  const status: PostEntryContractTrendProfile["status"] = !hasCurrentFacts
    ? "UNAVAILABLE"
    : opposed
      ? "OPPOSED"
      : aligned
        ? "ALIGNED"
        : currentRegime === "RANGE"
          ? "RANGE"
          : currentRegime === "TRANSITION"
            ? adverseFlow
              ? "TRANSITION"
              : "PULLBACK"
            : adverseFlow
              ? "TRANSITION"
              : "PULLBACK";
  const baseHorizon = input.holdingMandate.baseHorizon;
  const currentGrossRoePercent = finite(input.currentRoePercent) ?? 0;
  const estimatedRoundTripCostRoePercent = Math.max(
    0,
    finite(input.estimatedRoundTripCostRoePercent) ?? 0,
  );
  const currentNetRoePercent =
    currentGrossRoePercent - estimatedRoundTripCostRoePercent;
  const profitable = currentNetRoePercent > 0;
  const entryWasAligned = regimeAligned(
    input.positionSide,
    entryRegime,
  );
  const waveStructureState = input.waveStructureState ?? "UNAVAILABLE";
  const tradeVolumeStatus = input.tradeVolumeStatus ?? "UNAVAILABLE";
  const trendPathStatus = input.trendPathStatus ?? "UNAVAILABLE";
  const swingExtensionEvidenceStatus =
    waveStructureState === "SUPPORT_BREAK" ||
        tradeVolumeStatus === "OPPOSITE_EXPANSION" ||
        ["MOMENTUM_DECAY", "REVERSAL_PRESSURE"].includes(trendPathStatus)
        ? "OPPOSED" as const
        : waveStructureState === "UNAVAILABLE" ||
            tradeVolumeStatus === "UNAVAILABLE" ||
            ["UNAVAILABLE", "EARLY_PROBE"].includes(trendPathStatus)
          ? "INCOMPLETE" as const
          : waveStructureState === "UPSIDE_BREAKOUT" &&
              tradeVolumeStatus === "DIRECTIONAL_EXPANSION" &&
              trendPathStatus === "CONTINUATION_CONFIRMED"
            ? "CONFIRMED" as const
            : "UNCONFIRMED" as const;
  const swingExtensionEvidenceConfirmed =
    swingExtensionEvidenceStatus === "CONFIRMED";
  const swingExtensionEarnedNow =
    baseHorizon === "INTRADAY" &&
    profitable &&
    aligned &&
    entryWasAligned &&
    swingExtensionEvidenceConfirmed &&
    input.holdingMandate.swingUpgradePolicy ===
      "PROFIT_AND_MULTI_HOUR_CONFIRMATION";
  const horizon4h = horizonDirection(currentContext, "horizon4h");
  const swingReversalConfirmed =
    opposed &&
    opposedHorizonCount >= 3 &&
    horizon4h === oppositeDirection;
  const previousProfile = record(input.previousProfile);
  const previousSwingExtensionEvidenceCertified =
    previousProfile.version === POST_ENTRY_CONTRACT_TREND_VERSION &&
    previousProfile.swingExtensionEvidenceCertified === true;
  const previousSwingExtensionActive =
    previousProfile.effectiveHorizon === "SWING_EXTENSION" &&
    previousProfile.swingExtensionEligible === true &&
    previousProfile.baseHorizon === baseHorizon &&
    previousSwingExtensionEvidenceCertified;
  // 波段延展是一项已经由费用后盈利、多小时同向和持仓后连续趋势
  // 共同挣得的授权。普通回撤不能瞬间撤销它；只有费用后转亏、数据
  // 失效或包含4小时方向的完整反转才降回冻结的日内周期。
  const swingExtensionPersisted =
    baseHorizon === "INTRADAY" &&
    profitable &&
    previousSwingExtensionActive &&
    hasCurrentFacts &&
    !swingReversalConfirmed;
  const swingExtensionEligible =
    swingExtensionEarnedNow || swingExtensionPersisted;
  const swingExtensionEvidenceCertified =
    swingExtensionEarnedNow ||
    (swingExtensionPersisted && previousSwingExtensionEvidenceCertified);
  const swingExtensionState = previousSwingExtensionActive
    ? swingExtensionEligible
      ? "PERSISTED" as const
      : "REVOKED" as const
    : swingExtensionEligible
      ? "EARNED" as const
      : "INACTIVE" as const;
  const effectiveHorizon = swingExtensionEligible
    ? "SWING_EXTENSION" as const
    : baseHorizon;
  const observedMinutes = Number.isFinite(input.observedMinutes)
    ? Math.max(0, Number(input.observedMinutes))
    : null;
  const maximumObservationMinutes = Number.isFinite(
      input.holdingMandate.maximumObservationMinutes,
    )
    ? Math.max(0, Number(input.holdingMandate.maximumObservationMinutes))
    : null;
  // 3-minute positions retain their dedicated deterministic round exit. The
  // generic post-entry brain only consumes the INTRADAY horizon: expiry does
  // not close a position by itself, but it removes the extra multi-hour veto
  // once the complete local invalidation sequence has formed.
  const observationHorizonExpired =
    baseHorizon === "INTRADAY" &&
    effectiveHorizon !== "SWING_EXTENSION" &&
    observedMinutes !== null &&
    maximumObservationMinutes !== null &&
    observedMinutes >= maximumObservationMinutes;
  const observationHorizonState = effectiveHorizon === "SWING_EXTENSION"
    ? "SWING_EXTENSION" as const
    : baseHorizon === "INTRADAY" && maximumObservationMinutes !== null
      ? observationHorizonExpired
        ? "EXPIRED" as const
        : "OPEN" as const
      : "NOT_APPLICABLE" as const;
  const shortCycleExitAuthorized =
    baseHorizon === "SCALP" ||
    baseHorizon === "UNSPECIFIED" ||
    (baseHorizon === "INTRADAY" &&
      effectiveHorizon !== "SWING_EXTENSION" &&
      (status === "OPPOSED" || observationHorizonExpired)) ||
    ((baseHorizon === "SWING" || effectiveHorizon === "SWING_EXTENSION") &&
      swingReversalConfirmed);
  const riskIncreaseAllowed = !observationHorizonExpired &&
    status === "ALIGNED" &&
    baseHorizon !== "UNSPECIFIED" &&
    (baseHorizon !== "INTRADAY" || swingExtensionEvidenceCertified);
  const profitProtectionBias =
    observationHorizonExpired
      ? "TIGHTEN_ON_GIVEBACK" as const
      : (effectiveHorizon === "SWING" ||
      effectiveHorizon === "SWING_EXTENSION") &&
      ["ALIGNED", "PULLBACK"].includes(status)
      ? "ALLOW_NORMAL_PULLBACK" as const
      : status === "OPPOSED" ||
          (status === "TRANSITION" && adverseFlow)
        ? "TIGHTEN_ON_GIVEBACK" as const
        : "NEUTRAL" as const;
  const evidenceCodes = [
    aligned ? "MULTI_HOUR_TREND_ALIGNED" : null,
    opposed ? "MULTI_HOUR_TREND_OPPOSED" : null,
    decisiveHorizonOpposition
      ? "MULTI_HOUR_DECISIVE_HORIZONS_OPPOSED"
      : null,
    status === "PULLBACK" ? "MULTI_HOUR_NORMAL_PULLBACK" : null,
    adverseFlow ? "MULTI_HOUR_PRICE_VOLUME_ADVERSE" : null,
    profitable && aligned && swingExtensionEvidenceStatus === "INCOMPLETE"
      ? "SWING_EXTENSION_EVIDENCE_INCOMPLETE"
      : null,
    profitable && aligned && swingExtensionEvidenceStatus === "UNCONFIRMED"
      ? "SWING_EXTENSION_EVIDENCE_UNCONFIRMED"
      : null,
    profitable && aligned && swingExtensionEvidenceStatus === "OPPOSED"
      ? "SWING_EXTENSION_EVIDENCE_OPPOSED"
      : null,
    swingExtensionState === "EARNED"
      ? "PROFITABLE_SWING_EXTENSION_EARNED"
      : null,
    swingExtensionState === "PERSISTED"
      ? "PROFITABLE_SWING_EXTENSION_PERSISTED"
      : null,
    swingExtensionState === "REVOKED"
      ? "PROFITABLE_SWING_EXTENSION_REVOKED"
      : null,
    !profitable && baseHorizon === "INTRADAY"
      ? "NET_LOSS_CANNOT_EXTEND_HORIZON"
      : null,
    observationHorizonExpired
      ? "INTRADAY_OBSERVATION_HORIZON_EXPIRED"
      : null,
  ].filter((code): code is string => Boolean(code));

  return {
    version: POST_ENTRY_CONTRACT_TREND_VERSION,
    requiredForDecision: baseHorizon !== "UNSPECIFIED",
    status,
    baseHorizon,
    effectiveHorizon,
    swingExtensionEligible,
    swingExtensionState,
    swingExtensionEvidenceCertified,
    swingExtensionEvidenceStatus,
    currentGrossRoePercent,
    estimatedRoundTripCostRoePercent,
    currentNetRoePercent,
    observedMinutes,
    maximumObservationMinutes,
    observationHorizonState,
    observationHorizonExpired,
    shortCycleExitAuthorized,
    riskIncreaseAllowed,
    profitProtectionBias,
    alignedHorizonCount,
    opposedHorizonCount,
    availableHorizonCount,
    decisiveHorizonCount: decisive.length,
    currentRegime,
    entryRegime,
    priceVolumeBehavior: behavior,
    evidenceCodes,
    reason: status === "UNAVAILABLE"
      ? "共享闭合15分钟/1小时事实不足；不得据此新增风险，既有硬止损与强平保护继续生效。"
      : swingExtensionState === "EARNED"
        ? "仓位扣除预估往返成本后仍盈利，1至4小时结构同向，且持仓后连续5分钟顺势路径、结构突破与1分钟真实成交扩量共同确认，获得波段延展；短周期回撤只作预警。"
        : swingExtensionState === "PERSISTED"
          ? "已获得的波段延展仍有效；普通回撤或未完成的多小时反转只作预警，不把仓位悄然降回日内周期。"
          : swingExtensionState === "REVOKED"
            ? "波段延展已因费用后转亏、数据失效或完整多小时反转撤销，后续按冻结的基础周期继续管理。"
          : observationHorizonExpired
            ? `日内仓已达到 ${maximumObservationMinutes} 分钟观察上限且未获得波段延展；时间本身不触发平仓，但禁止扩大风险、收紧盈利保护，并允许完整短周期失效证据执行退出。`
        : profitable && aligned &&
            swingExtensionEvidenceStatus !== "CONFIRMED"
          ? "仓位扣除预估往返成本后仍盈利且多小时方向同向，但持仓后连续5分钟趋势路径、波段结构与1分钟真实成交量尚未共同确认；继续按日内仓管理，不提前放宽利润保护或增加风险。"
        : status === "OPPOSED"
          ? "1至4小时结构与量价已转向持仓反面，允许短周期完整失效证据升级为退出候选。"
          : status === "ALIGNED"
            ? "合约多小时方向仍与持仓一致，局部回撤不单独证明波段失效。"
            : "合约多小时结构处于回撤、震荡或转换，保持观察并禁止仅凭单一短周期证据扩大风险。",
  };
}
