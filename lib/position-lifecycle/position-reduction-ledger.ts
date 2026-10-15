import { getDb } from "../../db/index.ts";
import { livePositionReductions } from "../../db/schema.ts";

export const POSITION_REDUCTION_LEDGER_VERSION =
  "position-reduction-ledger-v1" as const;

export async function recordLivePositionReduction(
  values: typeof livePositionReductions.$inferInsert,
  options: { idempotent: boolean },
) {
  const statement = getDb().insert(livePositionReductions).values(values);
  if (options.idempotent) {
    await statement.onConflictDoNothing();
    return;
  }
  await statement;
}
