import { env } from "cloudflare:workers";
import { nexusUnifiedMarketData } from "../../../../lib/nexus-unified-market-data-live";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "sys:audit:view");
  if (isResponse(user)) return user;
  const proxy = (
    env as unknown as { NQ_BINANCE_PROXY_URL?: string }
  ).NQ_BINANCE_PROXY_URL?.replace(/\/$/, "");
  if (!proxy)
    return Response.json(
      { error: "系统统一行情服务未配置" },
      { status: 503 },
    );
  try {
    const response = await fetch(`${proxy}/metrics`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok)
      return Response.json(
        { error: "系统行情访问统计暂不可用" },
        { status: 503 },
      );
    const payload = (await response.json()) as Record<string, unknown>;
    return Response.json({
      ...payload,
      unifiedMarketData: nexusUnifiedMarketData.metrics(),
    });
  } catch {
    return Response.json(
      { error: "系统行情访问统计暂不可用" },
      { status: 503 },
    );
  }
}
