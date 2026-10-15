import {
  BinanceLiveError,
  getBinanceLiveKlines,
} from "../../../../../lib/binance-usdm-live";
import { isResponse, requirePermission } from "../../shared";

export const dynamic = "force-dynamic";

const SYMBOL_RE = /^[A-Z0-9]{2,30}USDT$/;

function requestedSymbols(request: Request) {
  return [
    ...new Set(
      (new URL(request.url).searchParams.get("symbols") ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => SYMBOL_RE.test(value)),
    ),
  ].slice(0, 6);
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;

  const symbols = requestedSymbols(request);
  if (!symbols.length)
    return Response.json({ source: "BINANCE_LIVE", updatedAt: new Date().toISOString(), rows: [] });

  const rows = await Promise.all(symbols.map(async (symbol) => {
    try {
      const candles = await getBinanceLiveKlines(symbol, "1m", 1440, { includeCurrent: true });
      return { symbol, candles, error: null as string | null };
    } catch (error) {
      return {
        symbol,
        candles: [],
        error: error instanceof BinanceLiveError ? error.message : "行情暂时不可用",
      };
    }
  }));

  return Response.json({
    source: "BINANCE_LIVE",
    updatedAt: new Date().toISOString(),
    rows,
  });
}
