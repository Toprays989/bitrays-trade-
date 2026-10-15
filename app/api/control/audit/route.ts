import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "sys:audit:view");
  if (isResponse(user)) return user;
  return Response.json({ events: [], hasMore: false, nextCursor: null });
}
