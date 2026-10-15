import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { livePositions } from "../../../../db/schema";
import {
  BinanceLiveError,
  getBinanceLiveMarkPrices,
} from "../../../../lib/binance-usdm-live";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;

  const rows = await getDb()
    .select({
      symbol: livePositions.symbol,
      status: livePositions.status,
    })
    .from(livePositions)
    .where(eq(livePositions.ownerEmail, user.email));
  const requestedSymbol = new URL(request.url).searchParams
    .get("symbol")
    ?.trim()
    .toUpperCase();
  const symbols = [
    ...new Set(
      [
        ...rows
          .filter((row) => row.status === "OPEN")
          .map((row) => row.symbol.trim().toUpperCase()),
        requestedSymbol ?? "",
      ].filter((symbol) => /^[A-Z0-9]{2,30}USDT$/.test(symbol)),
    ),
  ];
  if (!symbols.length)
    return Response.json({
      source: "BINANCE_WEBSOCKET",
      updatedAt: new Date().toISOString(),
      rows: [],
    });

  try {
    const marks = await getBinanceLiveMarkPrices(symbols);
    const updatedAt = Math.min(
      ...marks.map((mark) => mark.receivedAt || mark.time),
    );
    return Response.json({
      source: "BINANCE_WEBSOCKET",
      updatedAt: new Date(updatedAt).toISOString(),
      rows: marks,
    });
  } catch (error) {
    if (error instanceof BinanceLiveError)
      return Response.json(
        { error: error.message },
        {
          status: error.status,
          headers: error.retryAfterSeconds
            ? { "retry-after": String(error.retryAfterSeconds) }
            : undefined,
        },
      );
    return Response.json(
      { error: "实盘标记价格暂时不可用" },
      { status: 503 },
    );
  }
}
