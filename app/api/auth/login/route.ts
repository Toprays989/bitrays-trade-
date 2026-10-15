import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userAccess } from "../../../../db/schema";
import { createSession, sessionCookie, verifyPassword } from "../../../../lib/app-auth";

export async function POST(request: Request) {
  const body = await request.json() as { email?: string; password?: string };
  const workspaceEmail = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() || body.email?.trim().toLowerCase();
  if (!workspaceEmail || !body.password) return Response.json({ error: "邮箱或密码不正确" }, { status: 401 });
  const db = getDb();
  const [user] = await db.select().from(userAccess).where(eq(userAccess.email, workspaceEmail)).limit(1);
  const now = new Date();
  if (!user?.isActive || !user.passwordHash || !user.passwordSalt || !user.passwordIterations) return Response.json({ error: "邮箱或密码不正确" }, { status: 401 });
  if (user.lockedUntil && user.lockedUntil > now) return Response.json({ error: "登录失败次数过多，请稍后再试", lockedUntil: user.lockedUntil }, { status: 423 });
  const valid = await verifyPassword(body.password, user.passwordHash, user.passwordSalt, user.passwordIterations);
  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const lockedUntil = attempts >= 5 ? new Date(now.getTime() + 15 * 60 * 1000) : null;
    await db.update(userAccess).set({ failedLoginAttempts: attempts >= 5 ? 0 : attempts, lockedUntil, updatedAt: now }).where(eq(userAccess.id, user.id));
    return Response.json({ error: lockedUntil ? "登录失败次数过多，账号已锁定 15 分钟" : "邮箱或密码不正确" }, { status: lockedUntil ? 423 : 401 });
  }
  const session = await createSession(user.email);
  await db.update(userAccess).set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now }).where(eq(userAccess.id, user.id));
  return Response.json({ status: user.mustChangePassword ? "CHANGE_REQUIRED" : "AUTHENTICATED", mustChangePassword: user.mustChangePassword, expiresAt: session.expiresAt }, { headers: { "set-cookie": sessionCookie(session.token) } });
}
