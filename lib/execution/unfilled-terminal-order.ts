import {
  liveOrderStatusFromExchange,
  type TerminalLiveOrderStatus,
} from "../live-order-status.ts";

export const UNFILLED_TERMINAL_ORDER_VERSION =
  "unfilled-terminal-order-v1" as const;

type JsonRecord = Record<string, unknown>;
type UnfilledTerminalLiveOrderStatus = Exclude<
  TerminalLiveOrderStatus,
  "FILLED"
>;

export function unfilledTerminalLiveOrderStatus(
  exchangeStatus: unknown,
  executedQuantity: unknown,
): UnfilledTerminalLiveOrderStatus | null {
  const quantity = Math.max(0, Number(executedQuantity) || 0);
  if (quantity > 0) return null;
  const status = liveOrderStatusFromExchange(exchangeStatus, quantity);
  return status === "CANCELED" || status === "EXPIRED" || status === "REJECTED"
    ? status
    : null;
}

export function buildUnfilledTerminalOrderFact(input: {
  exchangeStatus: unknown;
  executedQuantity: unknown;
  reasonCode: string;
  source: "EXCHANGE" | "SYSTEM";
  terminalAt: Date;
  storedResponse?: JsonRecord;
  exchangeResponse?: JsonRecord;
  detail?: JsonRecord;
}) {
  const liveOrderStatus = unfilledTerminalLiveOrderStatus(
    input.exchangeStatus,
    input.executedQuantity,
  );
  if (!liveOrderStatus)
    throw new Error("订单尚未确认无成交终态，禁止释放订单或资金预留");

  const terminalAt = input.terminalAt.toISOString();
  const intentStatus = liveOrderStatus === "REJECTED"
    ? "REJECTED" as const
    : "CANCELED" as const;
  return {
    liveOrderStatus,
    intentStatus,
    executedQuantity: 0,
    reasonCode: input.reasonCode,
    terminalAt,
    response: {
      ...(input.storedResponse ?? {}),
      ...(input.exchangeResponse ?? {}),
      ...(input.detail ?? {}),
      cancelSource: input.source,
      cancelReason: input.reasonCode,
      canceledAt: terminalAt,
      nexusTerminalOrderLifecycle: {
        outcome: "UNFILLED_TERMINAL",
        liveOrderStatus,
        intentStatus,
        executedQuantity: 0,
        source: input.source,
        reasonCode: input.reasonCode,
        terminalAt,
      },
    },
  };
}
