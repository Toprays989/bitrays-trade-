import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { runtimeControls } from "../db/schema";

export const SERVER_LIVE_TRADING_KEY = "SERVER_LIVE_TRADING";

export async function readServerLiveTradingControl() {
  const db = getDb();
  let [row] = await db
    .select()
    .from(runtimeControls)
    .where(eq(runtimeControls.controlKey, SERVER_LIVE_TRADING_KEY))
    .limit(1);
  if (!row) {
    const now = new Date();
    await db
      .insert(runtimeControls)
      .values({
        controlKey: SERVER_LIVE_TRADING_KEY,
        enabled: false,
        updatedBy: "database-default",
        updatedAt: now,
      })
      .onConflictDoNothing({ target: runtimeControls.controlKey });
    [row] = await db
      .select()
      .from(runtimeControls)
      .where(eq(runtimeControls.controlKey, SERVER_LIVE_TRADING_KEY))
      .limit(1);
  }
  return {
    enabled: row?.enabled ?? false,
    updatedBy: row?.updatedBy ?? "database-default",
    updatedAt: row?.updatedAt ?? null,
    source: "database" as const,
  };
}

export async function liveTradingAllowedByServer() {
  return (await readServerLiveTradingControl()).enabled;
}

export async function setServerLiveTradingControl(enabled: boolean, updatedBy: string) {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .insert(runtimeControls)
    .values({
      controlKey: SERVER_LIVE_TRADING_KEY,
      enabled,
      updatedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: runtimeControls.controlKey,
      set: { enabled, updatedBy, updatedAt: now },
    })
    .returning();
  return row;
}
