import { synchronizeReservedNexusOrder } from
  "../nexus-execution-intent-store.ts";

export const UNCERTAIN_ENTRY_SETTLEMENT_VERSION =
  "uncertain-entry-settlement-v1" as const;

export async function recordUncertainAutomatedEntry(input: {
  intentKey: string;
  liveOrderEventId: number;
  clientOrderId: string;
  traceDatabaseId: number;
  resultCode: string;
  resultMessage: string;
}) {
  await synchronizeReservedNexusOrder({
    intentKey: input.intentKey,
    liveOrderEventId: input.liveOrderEventId,
    nextStatus: "EXECUTION_UNKNOWN",
    liveOrderStatus: "EXECUTION_UNKNOWN",
    responseJson: JSON.stringify({ error: input.resultMessage }),
    detail: {
      liveOrderEventId: input.liveOrderEventId,
      clientOrderId: input.clientOrderId,
      error: input.resultMessage,
      noAutomaticRetry: true,
    },
    reasonCode: "EXCHANGE_EXECUTION_UNKNOWN",
    reasonMessage: input.resultMessage,
    traceSettlement: {
      databaseId: input.traceDatabaseId,
      expectedStates: [
        "ORDER_READY",
        "ORDER_PENDING",
        "EXECUTION_UNKNOWN",
      ],
      state: "EXECUTION_UNKNOWN",
      resultCode: input.resultCode,
      resultMessage: input.resultMessage,
      completedAt: null,
    },
  });
}
