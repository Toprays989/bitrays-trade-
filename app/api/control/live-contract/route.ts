import {
  BinanceLiveError,
  getBinanceLiveContractRule,
  warmNexusBookTicker,
} from "../../../../lib/binance-usdm-live";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { contractSymbols } from "../../../../db/schema";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const symbol = new URL(request.url).searchParams
    .get("symbol")
    ?.trim()
    .toUpperCase();
  if (!symbol || !/^[A-Z0-9]{2,30}USDT$/.test(symbol))
    return Response.json({ error: "请输入有效的 USDT 永续合约代码" }, { status: 400 });
  try {
    const [result] = await Promise.all([
      getBinanceLiveContractRule(symbol),
      // Symbol selection happens before order confirmation, so it is the safe
      // place to start the read-only order-flow window for manual orders.
      warmNexusBookTicker(symbol).catch(() => false),
    ]);
    const [cached] = await getDb()
      .select({ maxLeverage: contractSymbols.maxLeverage })
      .from(contractSymbols)
      .where(eq(contractSymbols.symbol, symbol))
      .limit(1);
    return Response.json({
      ...result,
      contract: {
        ...result.contract,
        maxLeverage: cached?.maxLeverage ?? null,
      },
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
      { error: `${symbol} Binance 合约规则暂不可用` },
      { status: 503 },
    );
  }
}
