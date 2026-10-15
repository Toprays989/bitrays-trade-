import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { livePositions } from "../../../../db/schema";
import {
  BinanceLiveError,
  getBinanceLiveContractRule,
  getBinanceLiveKlines,
  getBinanceLiveMarkPrices,
} from "../../../../lib/binance-usdm-live";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

const SYMBOL_RE = /^[A-Z0-9]{2,30}USDT$/;
const MAX_SYMBOLS = 6;

function requestedSymbols(request: Request) {
  return [
    ...new Set(
      (new URL(request.url).searchParams.get("symbols") ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => SYMBOL_RE.test(value)),
    ),
  ].slice(0, MAX_SYMBOLS);
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;

  const symbols = requestedSymbols(request);
  if (!symbols.length)
    return Response.json({ source: "BINANCE_LIVE", updatedAt: new Date().toISOString(), rows: [] });

  const accountId = new URL(request.url).searchParams.get("accountId")?.trim() ?? "";
  const includeCandles = new URL(request.url).searchParams.get("includeCandles") !== "0";
  const marksPromise = getBinanceLiveMarkPrices(symbols).catch(() => []);
  const marketRows = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const [ruleResult, candlesResult] = await Promise.all([
          getBinanceLiveContractRule(symbol).then((result) => ({ result, error: null as string | null })).catch((error) => ({
            result: null,
            error: error instanceof BinanceLiveError ? error.message : "合约规则暂时不可用",
          })),
          includeCandles
            ? getBinanceLiveKlines(symbol, "1m", 1440, { includeCurrent: true }).then((candles) => ({ candles, error: null as string | null })).catch((error) => ({
                candles: [],
                error: error instanceof BinanceLiveError ? error.message : "行情暂时不可用",
              }))
            : Promise.resolve({ candles: [], error: null as string | null }),
        ]);
        return {
          symbol,
          rule: ruleResult.result?.contract ?? null,
          candles: candlesResult.candles,
          error: candlesResult.error,
          ruleError: ruleResult.error,
        };
      } catch (error) {
        return {
          symbol,
          rule: null,
          candles: [],
          error: error instanceof BinanceLiveError ? error.message : "行情暂时不可用",
        };
      }
    }),
  );
  const marks = await marksPromise;
  const marksBySymbol = new Map(marks.map((row) => [row.symbol, row]));

  const positions = accountId
    ? await getDb()
        .select({
          symbol: livePositions.symbol,
          positionSide: livePositions.positionSide,
          quantity: livePositions.quantity,
          entryPrice: livePositions.entryPrice,
          markPrice: livePositions.markPrice,
          status: livePositions.status,
        })
        .from(livePositions)
        .where(
          and(
            eq(livePositions.ownerEmail, user.email),
            eq(livePositions.accountId, accountId),
            inArray(livePositions.symbol, symbols),
            eq(livePositions.status, "OPEN"),
          ),
        )
    : [];
  const positionsBySymbol = new Map<string, typeof positions>();
  for (const position of positions) {
    const current = positionsBySymbol.get(position.symbol) ?? [];
    current.push(position);
    positionsBySymbol.set(position.symbol, current);
  }

  const rows = marketRows.map((row) => {
    const mark = marksBySymbol.get(row.symbol);
    return {
      ...row,
      // Do not label the last traded price as a mark price. A missing mark
      // quote remains unavailable and the UI can still show the rule price
      // separately while the order endpoint rechecks mark price server-side.
      markPrice: Number(mark?.markPrice ?? 0),
      fundingRate: mark?.fundingRate ?? null,
      receivedAt: mark?.receivedAt ?? mark?.time ?? null,
      positions: positionsBySymbol.get(row.symbol) ?? [],
    };
  });
  return Response.json({
    source: "BINANCE_LIVE",
    updatedAt: new Date().toISOString(),
    rows,
  });
}
