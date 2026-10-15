import { liveOrderIsTerminal } from "./live-order-status.ts";

export function pendingOrderRestFallbackRequired(input: {
  status: unknown;
  lastLocalUpdateMs: number;
  nowMs: number;
  fallbackAfterMs: number;
}) {
  const status = String(input.status ?? "").trim().toUpperCase();
  if (liveOrderIsTerminal(status)) return false;
  if (!Number.isFinite(input.lastLocalUpdateMs)) return true;
  return input.nowMs - input.lastLocalUpdateMs >=
    Math.max(1_000, input.fallbackAfterMs);
}
