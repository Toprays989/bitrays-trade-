import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { riskStates } from "../../../../db/schema";
import { ensureAccountState, isResponse, requirePermission, writeAudit } from "../shared";

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:risk:rearm");
  if (isResponse(user)) return user;
  const payload = await request.json() as { confirmation?: string; note?: string };
  if (payload.confirmation !== "REVIEW_COMPLETE" || !payload.note?.trim()) return Response.json({ error: "恢复交易前必须填写复核说明" }, { status: 400 });
  await ensureAccountState(user);
  const now = new Date();
  const db = getDb();
  await db.update(riskStates).set({
    tradingEnabled: true,
    circuitBreakerStatus: "ARMED",
    reason: null,
    updatedAt: now,
  }).where(and(
    eq(riskStates.ownerEmail, user.email),
    eq(riskStates.accountId, user.accountId),
  ));
  await writeAudit(
    user,
    "REARM_GLOBAL_CIRCUIT_BREAKER",
    "account",
    user.accountId,
    {
      note: payload.note.trim(),
      strategiesRemainPaused: true,
    },
  );
  return Response.json({
    mode: "LIVE",
    status: "ARMED",
    strategiesRemainPaused: true,
  });
}
