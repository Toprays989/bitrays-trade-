import {
  type LiquidationTrendConfig,
  resolveLiquidationTrendConfig,
} from "./liquidation-trend-config.ts";

export function isCanonicalLiquidationTrendConfig(
  value: unknown,
): value is LiquidationTrendConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(
    record.trigger &&
      record.execution &&
      record.risk &&
      record.trend &&
      record.validation &&
      Array.isArray(record.selectedSymbols),
  );
}

function parseConfigJson(value: string | null | undefined): unknown {
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    return null;
  }
}

function normalizedCanonicalConfig(
  value: unknown,
): LiquidationTrendConfig | null {
  if (!isCanonicalLiquidationTrendConfig(value)) return null;
  const resolved = resolveLiquidationTrendConfig(value, {
    allowHistoricalLeverage: true,
  });
  return resolved.config;
}

export function resolveBoundLiquidationTrendConfigCandidate(input: {
  snapshotJson: string | null | undefined;
  versionConfigJson?: string | null;
  currentConfigJson?: string | null;
  traceConfigVersion: number;
  currentConfigVersion?: number | null;
}): LiquidationTrendConfig | null {
  const snapshot = normalizedCanonicalConfig(
    parseConfigJson(input.snapshotJson),
  );
  if (snapshot) return snapshot;

  const versionConfig = normalizedCanonicalConfig(
    parseConfigJson(input.versionConfigJson),
  );
  if (versionConfig) return versionConfig;

  if (input.currentConfigVersion === input.traceConfigVersion) {
    return normalizedCanonicalConfig(
      parseConfigJson(input.currentConfigJson),
    );
  }
  return null;
}
