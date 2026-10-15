import { DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG } from "../strategy-triggers/scheduled-scan-config.ts";
import {
  isRecord,
  rawStrategyPluginStamp,
  type StrategyPluginDefinition,
} from "./contract.ts";

export const FIXED_CONTRACT_INTRADAY_PLUGIN_VERSION =
  "nexus-fixed-contract-intraday-2026-08-30-v2";
const FIXED_CONTRACT_INTRADAY_LEGACY_VERSION =
  "nexus-fixed-contract-intraday-2026-08-30-v1";

const MINIMUM_SYMBOLS = 1;
const MAXIMUM_SYMBOLS = 8;

export const fixedContractIntradayStrategyPlugin: StrategyPluginDefinition =
  Object.freeze({
    id: "FIXED_CONTRACT_INTRADAY",
    version: FIXED_CONTRACT_INTRADAY_PLUGIN_VERSION,
    label: "固定合约日内",
    description:
      "固定 1–8 个合约每 15 分钟循环扫描，多空分别估算后由共享大脑确认；默认日内持有，不使用快进快出轮次。",
    triggerKind: "SCHEDULED_SCAN",
    holdingHorizon: "INTRADAY",
    minimumSymbols: MINIMUM_SYMBOLS,
    maximumSymbols: MAXIMUM_SYMBOLS,
    apply<T extends object>(value: T): T {
      const source = value as Record<string, unknown>;
      const trigger = record(source.trigger);
      const scheduledScan = record(trigger.scheduledScan);
      const execution = record(source.execution);
      const risk = record(source.risk);
      const positionManagement = record(risk.positionManagement);
      const evidenceRisk = record(positionManagement.evidenceRisk);
      const selectedSymbols = normalizedSymbols(source.selectedSymbols);
      return {
        ...source,
        strategyPlugin: {
          id: "FIXED_CONTRACT_INTRADAY",
          version: FIXED_CONTRACT_INTRADAY_PLUGIN_VERSION,
        },
        direction: "BOTH",
        directionDecision: {
          mode: "COMPETING_DIRECTIONS",
          minimumRewardRiskRatio: 1.2,
          minimumDirectionAdvantageRoePercent: 0.15,
          maximumUncertaintyRoePercent: 1.5,
        },
        assetClassScope: "CUSTOM",
        selectedSymbols,
        maxSymbols: selectedSymbols.length,
        trigger: {
          ...trigger,
          kind: "SCHEDULED_SCAN",
          analysisValiditySeconds: Math.max(
            1_200,
            positiveInteger(trigger.analysisValiditySeconds, 1_200),
          ),
          scheduledScan: {
            ...DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG,
            ...scheduledScan,
            intervalSeconds: 900,
            maxFactAgeMs: 900_000,
            maxWakeCandidatesPerCycle: 1,
            scanAllSymbols: true,
          },
        },
        marketProfile: {
          ...record(source.marketProfile),
          mode: "SCHEDULED_SCAN",
          contractType: "PERPETUAL",
          triggerPolicy: "SCHEDULED_SCAN",
          orderSizing: "EXCHANGE_MINIMUM",
        },
        execution: {
          ...execution,
          directionMode: "FOLLOW_BRAIN",
          sameLegWorkingOrderPolicy: "BLOCK",
          existingPositionPolicy: "BLOCK",
        },
        risk: {
          ...risk,
          minimumObservationMinutes: 30,
          positionManagement: {
            ...positionManagement,
            evidenceRisk: {
              ...evidenceRisk,
              enabled: true,
              warningMinute: 10,
              reductionMinute: 20,
              exitMinute: 45,
              reductionPercent: 30,
              minimumDeteriorationRoePoints: 0.5,
              postReductionExitDelaySeconds: 15,
              exitRemainingOnPersistentInvalidation: false,
            },
          },
        },
      } as T;
    },
    validate(value: unknown): string | null {
      if (!isRecord(value)) return "固定合约日内插件参数无效";
      const stamp = rawStrategyPluginStamp(value);
      if (!stamp || stamp.id !== "FIXED_CONTRACT_INTRADAY")
        return "固定合约日内插件标识无效";
      if (!stamp.version) return "固定合约日内插件版本无效";
      const currentVersion =
        stamp.version === FIXED_CONTRACT_INTRADAY_PLUGIN_VERSION;
      const legacyVersion =
        stamp.version === FIXED_CONTRACT_INTRADAY_LEGACY_VERSION;
      if (!currentVersion && !legacyVersion)
        return "固定合约日内插件版本不受支持";
      if (!isRecord(value.trigger) || value.trigger.kind !== "SCHEDULED_SCAN")
        return "固定合约日内插件必须使用定时扫描触发器";
      const minimumAnalysisValiditySeconds = currentVersion ? 1_200 : 900;
      if (
        Number(value.trigger.analysisValiditySeconds) <
          minimumAnalysisValiditySeconds
      )
        return currentVersion
          ? "固定合约日内插件分析窗口不得短于 20 分钟"
          : "固定合约日内历史插件分析窗口不得短于 15 分钟";
      if (
        currentVersion &&
        (
          !isRecord(value.trigger.scheduledScan) ||
          value.trigger.scheduledScan.scanAllSymbols !== true
        )
      ) return "固定合约日内插件必须每轮覆盖全部固定合约";
      if (
        !isRecord(value.marketProfile) ||
        value.marketProfile.mode !== "SCHEDULED_SCAN" ||
        value.marketProfile.triggerPolicy !== "SCHEDULED_SCAN"
      ) return "固定合约日内插件市场模式无效";
      if (value.assetClassScope !== "CUSTOM")
        return "固定合约日内插件必须使用固定自定义合约范围";
      const symbols = normalizedSymbols(value.selectedSymbols);
      if (
        symbols.length < MINIMUM_SYMBOLS ||
        symbols.length > MAXIMUM_SYMBOLS
      ) return `固定合约日内插件需要选择 ${MINIMUM_SYMBOLS}–${MAXIMUM_SYMBOLS} 个合约`;
      if (value.direction !== "BOTH")
        return "固定合约日内插件必须允许多空双向比较";
      if (
        !isRecord(value.directionDecision) ||
        value.directionDecision.mode !== "COMPETING_DIRECTIONS"
      ) return "固定合约日内插件必须使用同快照多空竞争裁决";
      if (
        !isRecord(value.execution) ||
        value.execution.directionMode !== "FOLLOW_BRAIN" ||
        value.execution.sameLegWorkingOrderPolicy !== "BLOCK" ||
        value.execution.existingPositionPolicy !== "BLOCK"
      ) return "固定合约日内插件执行互斥参数无效";
      return null;
    },
  });

function normalizedSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((symbol): symbol is string => typeof symbol === "string")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function positiveInteger(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}
