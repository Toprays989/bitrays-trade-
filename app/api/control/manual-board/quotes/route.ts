import {
  BinanceLiveError,
  getBinanceLiveMarkPrices,
} from "../../../../../lib/binance-usdm-live";
import { isResponse, requirePermission } from "../../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  void user;
  const symbols = [
    ...new Set(
      (new URL(request.url).searchParams.get("symbols") ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => /^[A-Z0-9]{2,30}USDT$/.test(value))
        .slice(0, 6),
    ),
  ];
  if (!symbols.length) return Response.json({ rows: [], updatedAt: new Date().toISOString() });
  try {
    const rows = await getBinanceLiveMarkPrices(symbols, { timeoutMs: 5_000 });
    return Response.json({ rows, updatedAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof BinanceLiveError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "实时标记价格暂时不可用" }, { status: 503 });
  }
}
