import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userAccess } from "../../../../db/schema";
import { createSession, derivePassword, getSession, resolveRequestEmail, revokeSessions, sessionCookie, validatePassword, verifyPassword } from "../../../../lib/app-auth";
import { ROLE_PERMISSIONS, writeAudit } from "../../control/shared";

export async function POST(request: Request) {
  const body = await request.json() as { email?: string; currentPassword?: string; newPassword?: string };
  const email = await resolveRequestEmail(request) || body.email?.trim().toLowerCase();
  if (!email || !body.newPassword) return Response.json({ error: "密码参数不完整" }, { status: 400 });
  const policyError = validatePassword(body.newPassword);
  if (policyError) return Response.json({ error: policyError }, { status: 400 });
  const db = getDb();
  let [user] = await db.select().from(userAccess).where(eq(userAccess.email, email)).limit(1);
  if (!user) {
    const anyUser = await db.select({ id: userAccess.id }).from(userAccess).limit(1);
    if (anyUser.length) return Response.json({ error: "账号尚未由管理员开通" }, { status: 403 });
    const now = new Date();
    [user] = await db.insert(userAccess).values({ email, role: "ADMIN", dataScope: "ALL", permissionsJson: JSON.stringify(ROLE_PERMISSIONS.ADMIN), createdAt: now, updatedAt: now }).returning();
  }
  if (!user?.isActive) return Response.json({ error: "账号不可用" }, { status: 403 });
  if (user.passwordHash) {
    const session = await getSession(request, email);
    if (!session || !body.currentPassword || !user.passwordSalt || !user.passwordIterations || !await verifyPassword(body.currentPassword, user.passwordHash, user.passwordSalt, user.passwordIterations)) {
      return Response.json({ error: "当前密码不正确" }, { status: 401 });
    }
    if (body.currentPassword === body.newPassword) return Response.json({ error: "新密码不能与当前密码相同" }, { status: 409 });
  }
  const password = await derivePassword(body.newPassword);
  const now = new Date();
  await revokeSessions(email);
  await db.update(userAccess).set({ passwordHash: password.hash, passwordSalt: password.salt, passwordIterations: password.iterations, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null, updatedAt: now }).where(eq(userAccess.id, user.id));
  await writeAudit({ email, accountId: "bys-main" }, "CHANGE_USER_PASSWORD", "user_access", email, { initialSetup: !user.passwordHash, sessionsRevoked: true });
  const session = await createSession(email);
  return Response.json({ status: "AUTHENTICATED", expiresAt: session.expiresAt }, { headers: { "set-cookie": sessionCookie(session.token) } });
}
