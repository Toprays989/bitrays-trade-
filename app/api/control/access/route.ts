import { isResponse, requirePermission } from "../shared";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userAccess } from "../../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "sys:access:view");
  if (isResponse(user)) return user;
  const [profile] = await getDb().select({ displayName: userAccess.displayName }).from(userAccess).where(eq(userAccess.email, user.email)).limit(1);
  return Response.json({ email: user.email, displayName: profile?.displayName ?? null, role: user.role, dataScope: user.dataScope, permissions: user.permissions });
}
