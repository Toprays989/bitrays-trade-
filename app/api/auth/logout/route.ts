import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { appSessions } from "../../../../db/schema";
import { SESSION_COOKIE, sessionCookie } from "../../../../lib/app-auth";

export async function POST(request: Request) {
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (token) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    let binary = ""; for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    await getDb().update(appSessions).set({ revokedAt: new Date() }).where(eq(appSessions.tokenHash, btoa(binary)));
  }
  return Response.json({ status: "SIGNED_OUT" }, { headers: { "set-cookie": sessionCookie("", 0) } });
}
