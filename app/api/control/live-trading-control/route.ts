import { isSecureCredentialRequest } from "../../../../lib/credential-vault";
import {
  readServerLiveTradingControl,
  setServerLiveTradingControl,
} from "../../../../lib/live-trading-control";
import { isResponse, requirePermission, writeAudit } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "sys:account:view");
  if (isResponse(user)) return user;
  return Response.json(await readServerLiveTradingControl());
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "sys:account:manage");
  if (isResponse(user)) return user;
  const body = (await request.json()) as {
    enabled?: boolean;
    confirmation?: string;
  };
  if (typeof body.enabled !== "boolean")
    return Response.json({ error: "服务器实盘开关参数无效" }, { status: 400 });
  const expected = body.enabled ? "ENABLE SERVER LIVE" : "DISABLE SERVER LIVE";
  if (body.confirmation !== expected)
    return Response.json({ error: `请输入 ${expected} 确认` }, { status: 400 });
  if (body.enabled && !isSecureCredentialRequest(request))
    return Response.json(
      { error: "开启服务器实盘只能通过可信 HTTPS 连接完成" },
      { status: 426 },
    );
  const row = await setServerLiveTradingControl(body.enabled, user.email);
  await writeAudit(user, body.enabled ? "ENABLE_SERVER_LIVE_TRADING" : "DISABLE_SERVER_LIVE_TRADING", "runtime_control", "SERVER_LIVE_TRADING", {
    enabled: body.enabled,
    source: "ACCOUNT_MANAGEMENT_UI",
  });
  return Response.json({
    enabled: row.enabled,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    source: "database",
  });
}
