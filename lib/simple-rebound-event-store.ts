import { getDb } from "../db/index.ts";
import { strategyExecutionEvents } from "../db/schema.ts";
import { isSimpleReboundEventType, type SimpleReboundEventType } from "./simple-rebound-events.ts";

export type PersistableSimpleReboundEvent = Readonly<{
  eventType: SimpleReboundEventType;
  stage: "SIGNAL" | "ORDER" | "POSITION_MANAGEMENT";
  outcome: "PASSED" | "PENDING" | "REJECTED" | "INFO" | "ERROR";
  symbol: string;
  eventAt: number;
  message: string;
  detail?: unknown;
}>;

/**
 * Persist only the new strategy's event namespace. Legacy event types cannot
 * enter this store, which keeps reporting and replay boundaries explicit.
 */
export async function appendSimpleReboundEvents(input: Readonly<{
  strategyId: number;
  traceId: string;
  events: readonly PersistableSimpleReboundEvent[];
}>) {
  const events = input.events.filter((event) => isSimpleReboundEventType(event.eventType));
  if (!events.length) return [];
  const now = new Date();
  return getDb()
    .insert(strategyExecutionEvents)
    .values(
      events.map((event, index) => ({
        traceId: input.traceId,
        strategyId: input.strategyId,
        sequence: index + 1,
        eventType: event.eventType,
        stage: event.stage,
        outcome: event.outcome,
        message: event.message,
        detailJson: JSON.stringify({
          symbol: event.symbol,
          detail:
            event.detail && typeof event.detail === "object" ? event.detail : event.detail ?? null,
        }),
        eventAt: new Date(event.eventAt),
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning();
}
