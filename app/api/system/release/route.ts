import { env } from "cloudflare:workers";

export async function GET() {
  const releaseId =
    (env as unknown as { NQ_RELEASE_ID?: string }).NQ_RELEASE_ID ?? "unknown";
  return Response.json(
    { releaseId },
    { headers: { "cache-control": "no-store, no-cache, must-revalidate" } },
  );
}
