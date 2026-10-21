import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { contractSymbols, spotWhitelistSymbols, spotWhitelistVersions } from "../../../../../db/schema";
import { fetchBinanceSpotCatalog } from "../../../../../lib/binance-spot-public";
import { isResponse, requirePermission } from "../../shared";

export const dynamic = "force-dynamic";

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const db = getDb();
  const versions = await db.select().from(spotWhitelistVersions).where(eq(spotWhitelistVersions.ownerEmail, user.email)).orderBy(desc(spotWhitelistVersions.updatedAt)).limit(50);
  const symbols = versions.length ? await db.select().from(spotWhitelistSymbols).where(inArray(spotWhitelistSymbols.versionId, versions.map((version) => version.id))) : [];
  return Response.json({ versions: versions.map((version) => ({ ...version, symbols: symbols.filter((symbol) => symbol.versionId === version.id) })) });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const body = bodyObject(await request.json().catch(() => null));
  if (!['SCAN', 'IMPORT_CONTRACT_SPOT', 'IMPORT_ELIGIBLE_SPOT'].includes(String(body?.action))) return Response.json({ error: "白名单扫描操作无效" }, { status: 400 });
  let catalog;
  try { catalog = await fetchBinanceSpotCatalog(); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "现货扫描失败" }, { status: 502 }); }
  if (body?.action === "IMPORT_CONTRACT_SPOT") {
    const db = getDb();
    const contracts = await db.select().from(contractSymbols).where(eq(contractSymbols.isActive, true));
    const contractBySymbol = new Map(contracts.filter((row) => row.listingGeneration === "CURRENT").map((row) => [row.symbol.toUpperCase(), row]));
    catalog = catalog.filter((row) => contractBySymbol.has(row.symbol.toUpperCase())).map((row) => {
      const contract = contractBySymbol.get(row.symbol.toUpperCase())!;
      return { ...row, minOrderQty: Math.max(row.minOrderQty, contract.minOrderQty), quantityStep: Math.max(row.quantityStep, contract.quantityStep), minNotionalUsdt: Math.max(row.minNotionalUsdt, contract.minNotionalUsdt) };
    });
    if (!catalog.length) return Response.json({ error: "系统合约名单与 Binance Spot 没有可用交集，请先同步合约名单" }, { status: 409 });
  }
  if (body?.action === "IMPORT_ELIGIBLE_SPOT") {
    catalog = catalog.filter((row) => row.status === "TRADING" && row.quoteVolume24h >= 5_000_000);
    if (!catalog.length) return Response.json({ error: "当前没有满足成交量和交易状态要求的现货交易对" }, { status: 409 });
  }
  const now = new Date();
  const db = getDb();
  // Keep one editable draft per operator. Published versions remain immutable;
  // repeated scans replace the symbols in the current draft instead of
  // creating another list on every click.
  const [existingDraft] = await db.select().from(spotWhitelistVersions).where(and(eq(spotWhitelistVersions.ownerEmail, user.email), eq(spotWhitelistVersions.status, "DRAFT"))).orderBy(desc(spotWhitelistVersions.updatedAt)).limit(1);
  let created = existingDraft;
  if (created) {
    await db.delete(spotWhitelistSymbols).where(eq(spotWhitelistSymbols.versionId, created.id));
    await db.update(spotWhitelistVersions).set({ updatedAt: now }).where(eq(spotWhitelistVersions.id, created.id));
  } else {
    const version = `spot-${now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
    [created] = await db.insert(spotWhitelistVersions).values({ ownerEmail: user.email, version, status: "DRAFT", createdAt: now, updatedAt: now }).returning();
  }
  if (!created) return Response.json({ error: "白名单版本创建失败" }, { status: 500 });
  const symbolValues = catalog.map((row) => ({
    versionId: created.id,
    symbol: row.symbol,
    baseAsset: row.baseAsset,
    quoteAsset: row.quoteAsset,
    tradingStatus: row.status,
    priceTickSize: row.priceTickSize,
    quantityStep: row.quantityStep,
    minOrderQty: row.minOrderQty,
    minNotionalUsdt: row.minNotionalUsdt,
    quoteVolume24h: row.quoteVolume24h,
    eligible: row.status === "TRADING" && row.quoteVolume24h >= 5_000_000,
    rejectionReason: row.status !== "TRADING" ? "交易状态不可用" : row.quoteVolume24h < 5_000_000 ? "24小时成交额低于500万USDT" : null,
    updatedAt: now,
  }));
  // D1/SQLite limits the number of bound variables per statement. Keep the
  // scan complete while writing in bounded batches instead of dropping rows.
  const symbols = [];
  // D1 deployments can enforce a very low bound-variable limit. Five rows
  // keeps each statement safe across the production and local runtimes.
  for (let index = 0; index < symbolValues.length; index += 5) {
    const batch = await db.insert(spotWhitelistSymbols).values(symbolValues.slice(index, index + 5)).returning();
    symbols.push(...batch);
  }
  return Response.json({ version: created, symbols, scannedCount: catalog.length, importedCount: symbols.length, batchSize: 5 }, { status: 201 });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const body = bodyObject(await request.json().catch(() => null));
  const versionId = Number(body?.versionId);
  const action = body?.action;
  if (!Number.isInteger(versionId) || !["SELECT", "PUBLISH", "RETIRE"].includes(String(action))) return Response.json({ error: "白名单操作无效" }, { status: 400 });
  const db = getDb();
  const [version] = await db.select().from(spotWhitelistVersions).where(and(eq(spotWhitelistVersions.id, versionId), eq(spotWhitelistVersions.ownerEmail, user.email))).limit(1);
  if (!version) return Response.json({ error: "白名单版本不存在" }, { status: 404 });
  const now = new Date();
  if (action === "SELECT") {
    const selectedIds = Array.isArray(body?.symbolIds) ? body.symbolIds.map(Number).filter((value) => Number.isInteger(value)) : [];
    const rows = await db.select({ id: spotWhitelistSymbols.id }).from(spotWhitelistSymbols).where(and(eq(spotWhitelistSymbols.versionId, versionId), eq(spotWhitelistSymbols.eligible, true)));
    const valid = new Set(rows.map((row) => row.id));
    await db.update(spotWhitelistSymbols).set({ operatorSelected: false, updatedAt: now }).where(eq(spotWhitelistSymbols.versionId, versionId));
    if (selectedIds.length) await db.update(spotWhitelistSymbols).set({ operatorSelected: true, updatedAt: now }).where(inArray(spotWhitelistSymbols.id, selectedIds.filter((id) => valid.has(id))));
  } else {
    const nextStatus = action === "PUBLISH" ? "PUBLISHED" : "RETIRED";
    if (action === "PUBLISH") {
      const selected = await db.select({ id: spotWhitelistSymbols.id }).from(spotWhitelistSymbols).where(and(eq(spotWhitelistSymbols.versionId, versionId), eq(spotWhitelistSymbols.eligible, true), eq(spotWhitelistSymbols.operatorSelected, true)));
      if (!selected.length) return Response.json({ error: "至少选择一个合格现货交易对后才能发布" }, { status: 409 });
    }
    await db.update(spotWhitelistVersions).set({ status: nextStatus, publishedBy: action === "PUBLISH" ? user.email : version.publishedBy, publishedAt: action === "PUBLISH" ? now : version.publishedAt, updatedAt: now }).where(eq(spotWhitelistVersions.id, versionId));
  }
  const [updated] = await db.select().from(spotWhitelistVersions).where(eq(spotWhitelistVersions.id, versionId)).limit(1);
  return Response.json({ version: updated });
}

export async function DELETE(request: Request) {
  const user = await requirePermission(request, "trade:strategy:edit");
  if (isResponse(user)) return user;
  const db = getDb();
  const versions = await db.select({ id: spotWhitelistVersions.id }).from(spotWhitelistVersions).where(and(eq(spotWhitelistVersions.ownerEmail, user.email), eq(spotWhitelistVersions.status, "DRAFT"))).orderBy(desc(spotWhitelistVersions.updatedAt));
  if (versions.length <= 1) return Response.json({ deleted: 0, kept: versions[0]?.id ?? null });
  // Keep the newest editable draft and remove only older duplicate drafts.
  const removeIds = versions.slice(1).map((version) => version.id);
  for (const id of removeIds) {
    await db.delete(spotWhitelistSymbols).where(eq(spotWhitelistSymbols.versionId, id));
    await db.delete(spotWhitelistVersions).where(and(eq(spotWhitelistVersions.id, id), eq(spotWhitelistVersions.ownerEmail, user.email), eq(spotWhitelistVersions.status, "DRAFT")));
  }
  return Response.json({ deleted: removeIds.length, kept: versions[0].id });
}
