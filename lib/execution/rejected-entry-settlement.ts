import {
  settleNexusExecutionIntentWithLiveOrder,
} from "../nexus-execution-intent-store.ts";
import {
  buildUnfilledTerminalOrderFact,
} from "./unfilled-terminal-order.ts";

export const REJECTED_ENTRY_SETTLEMENT_VERSION =
  "rejected-entry-settlement-v1" as const;

export function buildRejectedAutomatedEntryFact(input: {
  clientOrderId: string;
  errorMessage: string;
  rejectedAt: Date;
}) {
  const detail = {
    clientOrderId: input.clientOrderId,
    error: input.errorMessage,
    submissionAcknowledged: false,
    confirmedNoExchangeExecution: true,
  };
  return {
    detail,
    terminalFact: buildUnfilledTerminalOrderFact({
      exchangeStatus: "REJECTED",
      executedQuantity: 0,
      reasonCode: "EXCHANGE_ORDER_REJECTED",
      source: "EXCHANGE",
      terminalAt: input.rejectedAt,
      exchangeResponse: { error: input.errorMessage },
      detail,
    }),
  };
}

export async function settleRejectedAutomatedEntry(input: {
  intentKey: string;
  liveOrderEventId: number;
  clientOrderId: string;
  errorMessage: string;
  traceDatabaseId: number;
  traceResultCode: string;
  rejectedAt?: Date;
}) {
  const rejectedAt = input.rejectedAt ?? new Date();
  const { detail, terminalFact } = buildRejectedAutomatedEntryFact({
    clientOrderId: input.clientOrderId,
    errorMessage: input.errorMessage,
    rejectedAt,
  });
  await settleNexusExecutionIntentWithLiveOrder({
    intentKey: input.intentKey,
    liveOrderEventId: input.liveOrderEventId,
    nextStatus: terminalFact.intentStatus,
    liveOrderStatus: terminalFact.liveOrderStatus,
    responseJson: JSON.stringify(terminalFact.response),
    detail,
    reasonCode: terminalFact.reasonCode,
    reasonMessage: input.errorMessage,
    traceSettlement: {
      databaseId: input.traceDatabaseId,
      expectedStates: ["ORDER_READY"],
      state: "REJECTED",
      resultCode: input.traceResultCode,
      resultMessage: input.errorMessage,
      completedAt: rejectedAt,
    },
  });
  return terminalFact;
}
