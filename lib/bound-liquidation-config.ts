import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  strategies,
  strategyConfigVersions,
} from "../db/schema";
import { type LiquidationTrendConfig } from "./liquidation-trend-config";
import { resolveBoundLiquidationTrendConfigCandidate } from "./bound-liquidation-config-selection";

export type BoundStrategyConfigRef = {
  strategyId: number;
  configVersion: number;
  configSnapshotJson: string;
};

/**
 * Runtime decisions must be bound to the exact strategy version that created
 * the order or position. Legacy branch-local snapshots are display evidence
 * only and can never be used as an executable configuration.
 */
export async function loadBoundLiquidationTrendConfig(
  reference: BoundStrategyConfigRef,
): Promise<LiquidationTrendConfig> {
  const snapshot = resolveBoundLiquidationTrendConfigCandidate({
    snapshotJson: reference.configSnapshotJson,
    traceConfigVersion: reference.configVersion,
  });
  if (snapshot) return snapshot;

  const db = getDb();
  const [versionRow] = await db
    .select({
      configJson: strategyConfigVersions.configJson,
    })
    .from(strategyConfigVersions)
    .where(
      and(
        eq(strategyConfigVersions.strategyId, reference.strategyId),
        eq(strategyConfigVersions.version, reference.configVersion),
      ),
    )
    .limit(1);
  const versionConfig = resolveBoundLiquidationTrendConfigCandidate({
    snapshotJson: reference.configSnapshotJson,
    versionConfigJson: versionRow?.configJson,
    traceConfigVersion: reference.configVersion,
  });
  if (versionConfig) return versionConfig;

  const [currentStrategy] = await db
    .select({
      configVersion: strategies.configVersion,
      configJson: strategies.configJson,
    })
    .from(strategies)
    .where(eq(strategies.id, reference.strategyId))
    .limit(1);
  const currentConfig = resolveBoundLiquidationTrendConfigCandidate({
    snapshotJson: reference.configSnapshotJson,
    versionConfigJson: versionRow?.configJson,
    currentConfigJson: currentStrategy?.configJson,
    traceConfigVersion: reference.configVersion,
    currentConfigVersion: currentStrategy?.configVersion,
  });
  if (currentConfig) return currentConfig;

  throw new Error(
    `BOUND_STRATEGY_CONFIG_MISSING:${reference.strategyId}:v${reference.configVersion}`,
  );
}
