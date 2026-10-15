import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { contractSymbols } from "../../../../../db/schema";
import {
  getBinanceLiveKlines,
  getBinanceLiveOpenInterestHistory,
} from "../../../../../lib/binance-usdm-live";
import {
  isResponse,
  requirePermission,
} from "../../shared";

function normalizeSymbol(value: string | null) {
  return value?.trim().toUpperCase() ?? "";
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;

  const symbol = normalizeSymbol(new URL(request.url).searchParams.get("symbol"));
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !symbol.endsWith("USDT"))
    return Response.json({ error: "请选择有效的 USDT 永续合约" }, { status: 400 });

  const [enabledSymbol] = await getDb()
    .select({ symbol: contractSymbols.symbol })
    .from(contractSymbols)
    .where(
      and(
        eq(contractSymbols.symbol, symbol),
        eq(contractSymbols.isActive, true),
      ),
    )
    .limit(1);
  if (!enabledSymbol)
    return Response.json({ error: "该币种不在已启用合约池" }, { status: 404 });

  try {
    const now = Date.now();
    const cutoff = now - 96 * 60 * 60_000;
    const [klines, openInterest] = await Promise.all([
      getBinanceLiveKlines(symbol, "30m", 192, { includeCurrent: true }),
      getBinanceLiveOpenInterestHistory(symbol, "30m", 192),
    ]);
    const interestByTime = new Map(
      openInterest.map((point) => [point.timestamp, point.value]),
    );
    const points = klines.map((candle) => {
      const exactInterest = interestByTime.get(candle.openTime);
      const nearestInterest =
        exactInterest ??
        openInterest.reduce<{ distance: number; value: number } | null>(
          (nearest, point) => {
            const distance = Math.abs(point.timestamp - candle.openTime);
            if (distance > 15 * 60_000) return nearest;
            return !nearest || distance < nearest.distance
              ? { distance, value: point.value }
              : nearest;
          },
          null,
        )?.value ??
        null;
      return {
        time: candle.openTime,
        price: candle.close,
        volumeUsdt:
          Number.isFinite(candle.quoteVolume) && candle.quoteVolume >= 0
            ? candle.quoteVolume
            : candle.volume * candle.close,
        openInterestUsdt: nearestInterest,
      };
    })
      .filter((point) => point.time >= cutoff && point.time <= now)
      .slice(-192);
    return Response.json(
      {
        symbol,
        interval: "30m",
        hours: 96,
        points,
        updatedAt: new Date().toISOString(),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "96小时合约走势暂不可用",
      },
      { status: 502 },
    );
  }
}
