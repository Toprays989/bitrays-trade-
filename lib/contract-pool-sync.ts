import { asc, eq, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../db";
import { contractSymbols } from "../db/schema";
import {
  getBinanceLiveContractUniverse,
  getBinanceLiveMaximumLeverageUniverse,
} from "./binance-usdm-live";
import { buildInstrumentId } from "./position-protection-version";
import {
  AUTO_VOLUME_THRESHOLD_USDT,
  resolveContractPoolVolumeMembership,
} from "./contract-pool-membership";
export { AUTO_VOLUME_THRESHOLD_USDT } from "./contract-pool-membership";
export const CONTRACT_POOL_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;
export const CONTRACT_POOL_WRITE_BATCH_SIZE = 100;

export async function synchronizeBinanceContractMaximumLeverages(
  credentials: Array<{ apiKey: string; secretKey: string }>,
) {
  if (!credentials.length)
    return { credentialCount: 0, updatedCount: 0, missingCount: 0 };
  const accountMaximums = await Promise.all(
    credentials.map((item) => getBinanceLiveMaximumLeverageUniverse(item)),
  );
  const db = getDb();
  const current = await db.select({
    id: contractSymbols.id,
    symbol: contractSymbols.symbol,
    maxLeverage: contractSymbols.maxLeverage,
  }).from(contractSymbols).where(eq(contractSymbols.listingGeneration, "CURRENT"));
  const now = new Date();
  const writes: BatchItem<"sqlite">[] = [];
  let missingCount = 0;
  for (const item of current) {
    const available = accountMaximums
      .map((maximums) => maximums.get(item.symbol) ?? 0)
      .filter((value) => Number.isInteger(value) && value > 0);
    if (!available.length) {
      missingCount += 1;
      continue;
    }
    const maxLeverage = Math.min(...available);
    writes.push(
      db.update(contractSymbols).set({
        maxLeverage,
        leverageSyncedAt: now,
        updatedAt: now,
      }).where(eq(contractSymbols.id, item.id)),
    );
  }
  for (
    let offset = 0;
    offset < writes.length;
    offset += CONTRACT_POOL_WRITE_BATCH_SIZE
  ) {
    const batch = writes.slice(offset, offset + CONTRACT_POOL_WRITE_BATCH_SIZE);
    if (batch.length)
      await db.batch(
        batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
      );
  }
  return {
    credentialCount: credentials.length,
    updatedCount: writes.length,
    missingCount,
  };
}

export async function synchronizeBinanceContractPool() {
  // The dedicated contract-data runner owns scheduling. Never retain its
  // request-bound upstream Promise in module-global state.
  return synchronizeNow();
}

export async function ensureFreshBinanceContractPool() {
  const db = getDb();
  const [[oldestAutomatic], [outdatedThreshold]] = await Promise.all([
    db
      .select({ marketSyncedAt: contractSymbols.marketSyncedAt })
      .from(contractSymbols)
      // Every automatic row must carry the same completed refresh timestamp.
      // Using the newest row would falsely declare a partially-written refresh
      // healthy if the database failed halfway through the universe.
      .orderBy(asc(contractSymbols.marketSyncedAt))
      .limit(1),
    db
      .select({ id: contractSymbols.id })
      .from(contractSymbols)
      .where(ne(contractSymbols.minVolume24h, AUTO_VOLUME_THRESHOLD_USDT))
      .limit(1),
  ]);
  const stale =
    Boolean(outdatedThreshold) ||
    !oldestAutomatic?.marketSyncedAt ||
    Date.now() - oldestAutomatic.marketSyncedAt.getTime() >
      CONTRACT_POOL_CACHE_MAX_AGE_MS;
  if (!stale)
    return {
      refreshed: false,
      syncedAt: oldestAutomatic.marketSyncedAt,
    };
  return {
    refreshed: true,
    ...(await synchronizeBinanceContractPool()),
  };
}

async function synchronizeNow() {
  const universe = await getBinanceLiveContractUniverse();
  const listedNames = new Set(universe.map((item) => item.symbol));
  const db = getDb();
  const existing = await db.select().from(contractSymbols);
  const existingMap = new Map(existing.map((item) => [item.symbol, item]));
  const now = new Date();
  const writes: BatchItem<"sqlite">[] = [];
  for (const item of universe) {
    const current = existingMap.get(item.symbol);
    const instrumentId = buildInstrumentId({
      symbol: item.symbol,
      contractType: item.contractType,
    });
    const ruleChanged = Boolean(current) && (
      current!.minOrderQty !== item.minOrderQty ||
      current!.quantityStep !== item.quantityStep ||
      current!.minNotionalUsdt !== item.minNotionalUsdt ||
      current!.priceTickSize !== item.priceTickSize ||
      current!.contractType !== item.contractType
    );
    const quoteVolume24h =
      item.quoteVolume > 0
        ? item.quoteVolume
        : current?.quoteVolume24h ?? 0;
    const membership = resolveContractPoolVolumeMembership({
      currentSource: current?.source ?? null,
      quoteVolume24h,
    });
    const values = {
      instrumentId,
      contractType: item.contractType,
      listingGeneration: "CURRENT",
      ruleVersion: current
        ? current.ruleVersion + (ruleChanged ? 1 : 0)
        : 1,
      displayName: item.displayName,
      minOrderQty: item.minOrderQty,
      quantityStep: item.quantityStep,
      minNotionalUsdt: item.minNotionalUsdt,
      priceTickSize: item.priceTickSize,
      minVolume24h: AUTO_VOLUME_THRESHOLD_USDT,
      lastPrice: item.price > 0 ? item.price : current?.lastPrice ?? 0,
      priceChangePercent:
        item.price > 0 ? item.change : current?.priceChangePercent ?? 0,
      highPrice: item.high > 0 ? item.high : current?.highPrice ?? 0,
      lowPrice: item.low > 0 ? item.low : current?.lowPrice ?? 0,
      quoteVolume24h,
      marketSyncedAt: now,
      updatedAt: now,
    };
    if (current)
      writes.push(
        db
          .update(contractSymbols)
          .set({
            ...values,
            source: membership.source,
            isProtected: false,
            // An operator exclusion is a durable allow-list decision. Binance
            // synchronization still refreshes its rules and market snapshot,
            // but must never silently put the contract back into scanning.
            isActive: membership.isActive,
          })
          .where(eq(contractSymbols.id, current.id)),
      );
    else
      writes.push(
        db.insert(contractSymbols).values({
          symbol: item.symbol,
          source: membership.source,
          isProtected: false,
          isActive: membership.isActive,
          ...values,
        }),
      );
  }
  for (const current of existing.filter(
    (item) => !listedNames.has(item.symbol),
  ))
    writes.push(
      db
        .update(contractSymbols)
        .set({
          isActive: false,
          listingGeneration: "RETIRED",
          minVolume24h: AUTO_VOLUME_THRESHOLD_USDT,
          marketSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(contractSymbols.id, current.id)),
    );

  for (
    let offset = 0;
    offset < writes.length;
    offset += CONTRACT_POOL_WRITE_BATCH_SIZE
  ) {
    const batch = writes.slice(
      offset,
      offset + CONTRACT_POOL_WRITE_BATCH_SIZE,
    );
    if (batch.length)
      await db.batch(
        batch as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
      );
  }
  return {
    qualifiedCount: universe.filter(
      (item) => item.quoteVolume >= AUTO_VOLUME_THRESHOLD_USDT,
    ).length,
    scannedCount: universe.length,
    syncedAt: now,
  };
}
