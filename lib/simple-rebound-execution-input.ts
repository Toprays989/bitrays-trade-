import type { SimpleReboundOrderPlan } from "./simple-rebound-order-plan.ts";

export function parseSimpleReboundOrderPlan(value: unknown): SimpleReboundOrderPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
  const source = input.source;
  const side = input.side;
  const clientOrderId = typeof input.clientOrderId === "string" ? input.clientOrderId.trim() : "";
  const notionalUsdt = input.notionalUsdt;
  const leverage = input.leverage;
  const referencePrice = input.referencePrice;
  const slotId = input.slotId;
  const openedAtMs = input.openedAtMs;
  if (source !== "SIMPLE_REBOUND" || side !== "LONG") return null;
  if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) return null;
  if (!/^srb_[A-Za-z0-9_-]{8,80}$/.test(clientOrderId)) return null;
  if (notionalUsdt !== 20 || leverage !== 5) return null;
  if (typeof referencePrice !== "number" || !Number.isFinite(referencePrice) || referencePrice <= 0) return null;
  if (typeof slotId !== "number" || !Number.isInteger(slotId) || slotId < 1 || slotId > 5) return null;
  if (typeof openedAtMs !== "number" || !Number.isFinite(openedAtMs) || openedAtMs <= 0) return null;
  return { source, clientOrderId, symbol, side, notionalUsdt, leverage, referencePrice, slotId, openedAtMs };
}
