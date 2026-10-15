import { isResponse, requirePermission, writeAudit } from "../shared";

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:position:close_all");
  if (isResponse(user)) return user;
  await writeAudit(user, "REJECT_RETIRED_EMERGENCY_FLATTEN", "account", user.accountId, {
    reason: "生产环境未配置经 Binance 实际仓位核对的专用全平通道",
  });
  return Response.json(
    { error: "生产环境已停用旧模拟全平接口；请在仓位管理逐笔核对并平仓", code: "LIVE_EMERGENCY_CHANNEL_NOT_CONFIGURED" },
    { status: 410 },
  );
}
