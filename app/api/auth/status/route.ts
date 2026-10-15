import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userAccess } from "../../../../db/schema";
import { getSession, getSessionByRequest } from "../../../../lib/app-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const db = getDb();
  const platformEmail = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  const cookieSession = await getSessionByRequest(request);
  const email = platformEmail || cookieSession?.email?.trim().toLowerCase();
  if (!email) {
    const anyUser = await db.select({ id: userAccess.id }).from(userAccess).limit(1);
    return Response.json({ status: anyUser.length ? "LOGIN_REQUIRED" : "BOOTSTRAP_ADMIN", requiresEmail: true }, { status: anyUser.length ? 401 : 200 });
  }
  const session = await getSession(request, email);
  const [user] = await db.select().from(userAccess).where(eq(userAccess.email, email)).limit(1);
  if (!user) {
    const anyUser = await db.select({ id: userAccess.id }).from(userAccess).limit(1);
    return Response.json({ email, status: anyUser.length ? "ACCOUNT_NOT_PROVISIONED" : "BOOTSTRAP_ADMIN" }, { status: anyUser.length ? 403 : 200 });
  }
  if (!user.isActive) return Response.json({ email, status: "ACCOUNT_DISABLED" }, { status: 403 });
  if (!user.passwordHash) return Response.json({ email, displayName: user.displayName, status: "PASSWORD_NOT_SET" });
  if (!session && !platformEmail) return Response.json({ status: "LOGIN_REQUIRED", requiresEmail: true }, { status: 401 });
  if (!session) return Response.json({ email, displayName: user.displayName, status: "LOGIN_REQUIRED" }, { status: 401 });
  return Response.json({ email, displayName: user.displayName, status: user.mustChangePassword ? "CHANGE_REQUIRED" : "AUTHENTICATED", expiresAt: session.expiresAt });
}
