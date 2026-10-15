import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { contractSymbols } from "../../../../db/schema";
import {
  AUTO_VOLUME_THRESHOLD_USDT,
  synchronizeBinanceContractPool,
} from "../../../../lib/contract-pool-sync";
import { ensureSeedData, isResponse, requirePermission, writeAudit } from "../shared";
import { buildInstrumentId } from "../../../../lib/position-protection-version";
import {
  effectiveMarketMinimumOrderQuantity,
  effectiveMinimumOrderQuantity,
} from "../../../../lib/order-quantity";

type SymbolPayload = {
  symbol?: string;
  minOrderQty?: number;
  minVolume24h?: number;
  isActive?: boolean;
};

function normalizeSymbol(value?: string) {
  return value?.trim().toUpperCase() ?? "";
}

function effectiveOrderMinimums(input: {
  minOrderQty: number;
  quantityStep: number;
  minNotionalUsdt: number;
  lastPrice: number | null;
}) {
  const price = input.lastPrice ?? 0;
  if (!Number.isFinite(price) || price <= 0)
    return {
      effectiveMinOrderQty: null,
      effectiveMarketMinOrderQty: null,
    };
  return {
    effectiveMinOrderQty: effectiveMinimumOrderQuantity(
      input.minOrderQty,
      input.quantityStep,
      input.minNotionalUsdt,
      price,
    ),
    effectiveMarketMinOrderQty: effectiveMarketMinimumOrderQuantity(
      input.minOrderQty,
      input.quantityStep,
      input.minNotionalUsdt,
      price,
    ),
  };
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:symbol_pool:view");
  if (isResponse(user)) return user;
  await ensureSeedData();
  const db = getDb();
  let marketError: string | null = null;
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    if (forceRefresh) await synchronizeBinanceContractPool();
  } catch (error) {
    marketError = error instanceof Error ? error.message : "Binance 合约池同步失败";
  }
  const catalog = await db.select().from(contractSymbols).orderBy(asc(contractSymbols.symbol));
  const symbols = catalog.filter(
    (symbol) =>
      symbol.source !== "MANUAL_EXCLUDE" &&
      symbol.source !== "AUTO_VOLUME_EXCLUDE" &&
      symbol.listingGeneration === "CURRENT",
  );
  const lastSyncedAt = catalog.reduce<Date | null>((latestAt, item) => item.marketSyncedAt && (!latestAt || item.marketSyncedAt > latestAt) ? item.marketSyncedAt : latestAt, null);
  return Response.json({
    marketStatus: { reachable: Boolean(lastSyncedAt), error: marketError, updatedAt: lastSyncedAt?.toISOString() ?? new Date(0).toISOString(), source: "BINANCE_USDM_LIVE_CACHE", thresholdUsdt: AUTO_VOLUME_THRESHOLD_USDT },
    symbols: symbols.map((symbol) => ({
      ...symbol,
      ...effectiveOrderMinimums(symbol),
      market: symbol.lastPrice ? { price: symbol.lastPrice, change: symbol.priceChangePercent ?? 0, high: symbol.highPrice ?? 0, low: symbol.lowPrice ?? 0, quoteVolume: symbol.quoteVolume24h ?? 0 } : null,
    })),
    catalog: catalog.filter((symbol) => symbol.listingGeneration === "CURRENT").map((symbol) => ({
      symbol: symbol.symbol,
      displayName: symbol.displayName,
      source: symbol.source,
      isIncluded:
        symbol.source !== "MANUAL_EXCLUDE" &&
        symbol.source !== "AUTO_VOLUME_EXCLUDE",
      minOrderQty: symbol.minOrderQty,
      quantityStep: symbol.quantityStep,
      minNotionalUsdt: symbol.minNotionalUsdt,
      priceTickSize: symbol.priceTickSize,
      maxLeverage: symbol.maxLeverage,
      leverageSyncedAt: symbol.leverageSyncedAt,
      ...effectiveOrderMinimums(symbol),
      market: symbol.lastPrice ? {
        price: symbol.lastPrice,
        change: symbol.priceChangePercent ?? 0,
        high: symbol.highPrice ?? 0,
        low: symbol.lowPrice ?? 0,
        quoteVolume: symbol.quoteVolume24h ?? 0,
      } : null,
    })),
  });
}

export async function PUT(request: Request) {
  const user = await requirePermission(request, "trade:symbol_pool:edit");
  if (isResponse(user)) return user;
  try {
    const result = await synchronizeBinanceContractPool();
    await writeAudit(user, "SYNC_BINANCE_CONTRACT_POOL", "contract_symbol", "AUTO_FILTER", { thresholdUsdt: AUTO_VOLUME_THRESHOLD_USDT, ...result });
    return Response.json({ ok: true, thresholdUsdt: AUTO_VOLUME_THRESHOLD_USDT, ...result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Binance 合约池同步失败" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:symbol_pool:edit");
  if (isResponse(user)) return user;
  const body = await request.json() as SymbolPayload;
  const symbol = normalizeSymbol(body.symbol);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !symbol.endsWith("USDT"))
    return Response.json({ error: "请选择有效的 Binance USDT 永续合约" }, { status: 400 });
  const db = getDb();
  const [existing] = await db.select().from(contractSymbols).where(eq(contractSymbols.symbol, symbol)).limit(1);
  if (
    (existing?.source === "MANUAL_EXCLUDE" ||
      existing?.source === "AUTO_VOLUME_EXCLUDE") &&
    existing.listingGeneration === "CURRENT"
  ) {
    const now = new Date();
    const [restored] = await db.update(contractSymbols).set({
      source: "MANUAL_INCLUDE",
      isProtected: false,
      isActive: true,
      updatedAt: now,
    }).where(eq(contractSymbols.id, existing.id)).returning();
    await writeAudit(user, "RESTORE_SYMBOL", "contract_symbol", symbol, {
      source: restored.source,
      isActive: restored.isActive,
    });
    return Response.json({ symbol: restored });
  }
  if (!existing || existing.listingGeneration !== "CURRENT")
    return Response.json(
      { error: `${symbol} 当前不在 Binance USDT 永续合约目录` },
      { status: 409 },
    );
  return Response.json({ error: "该合约已在合约池中" }, { status: 409 });
}

export async function DELETE(request: Request) {
  const user = await requirePermission(request, "trade:symbol_pool:edit");
  if (isResponse(user)) return user;
  const symbol = normalizeSymbol(new URL(request.url).searchParams.get("symbol") ?? "");
  if (!symbol)
    return Response.json({ error: "请选择要移除的合约" }, { status: 400 });
  const db = getDb();
  const [existing] = await db.select().from(contractSymbols).where(eq(contractSymbols.symbol, symbol)).limit(1);
  if (
    !existing ||
    existing.source === "MANUAL_EXCLUDE" ||
    existing.source === "AUTO_VOLUME_EXCLUDE"
  )
    return Response.json({ error: "该合约已不在合约池中" }, { status: 404 });
  const [removed] = await db.update(contractSymbols).set({
    source: "MANUAL_EXCLUDE",
    isProtected: false,
    isActive: false,
    updatedAt: new Date(),
  }).where(eq(contractSymbols.id, existing.id)).returning();
  await writeAudit(user, "REMOVE_SYMBOL", "contract_symbol", symbol, {
    previousSource: existing.source,
    stopsNewMonitoringAndTrading: true,
    existingPositionsRemainProtected: true,
  });
  return Response.json({ symbol: removed });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:symbol_pool:edit");
  if (isResponse(user)) return user;
  const body = await request.json() as SymbolPayload;
  const symbol = normalizeSymbol(body.symbol);
  if (!symbol) return Response.json({ error: "缺少合约代码" }, { status: 400 });
  const db = getDb();
  const [existing] = await db.select().from(contractSymbols).where(eq(contractSymbols.symbol, symbol)).limit(1);
  if (!existing) return Response.json({ error: "合约不存在" }, { status: 404 });
  const now = new Date();
  const [updated] = await db.update(contractSymbols).set({
    instrumentId: existing.instrumentId ?? buildInstrumentId({ symbol }),
    ruleVersion:
      Number.isFinite(body.minOrderQty) &&
        body.minOrderQty! > 0 &&
        body.minOrderQty !== existing.minOrderQty
        ? existing.ruleVersion + 1
        : existing.ruleVersion,
    isProtected: false,
    source:
      existing.source === "MANUAL_PROTECT"
        ? "MANUAL_INCLUDE"
        : existing.source,
    isActive: body.isActive ?? existing.isActive,
    minOrderQty: Number.isFinite(body.minOrderQty) && body.minOrderQty! > 0 ? body.minOrderQty : existing.minOrderQty,
    minVolume24h: Number.isFinite(body.minVolume24h) && body.minVolume24h! >= 0 ? body.minVolume24h : existing.minVolume24h,
    updatedAt: now,
  }).where(eq(contractSymbols.id, existing.id)).returning();
  await writeAudit(user, "UPDATE_SYMBOL", "contract_symbol", symbol, { isActive: updated.isActive, minOrderQty: updated.minOrderQty });
  return Response.json({ symbol: updated });
}
