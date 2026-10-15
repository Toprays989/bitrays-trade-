/** Event names owned exclusively by the Simple Rebound runtime. */
export const SIMPLE_REBOUND_EVENT_TYPES = Object.freeze({
  SCAN: "SIMPLE_REBOUND_SCAN",
  SIGNAL: "SIMPLE_REBOUND_SIGNAL",
  ORDER: "SIMPLE_REBOUND_ORDER",
  EXIT: "SIMPLE_REBOUND_EXIT",
} as const);

export type SimpleReboundEventType =
  (typeof SIMPLE_REBOUND_EVENT_TYPES)[keyof typeof SIMPLE_REBOUND_EVENT_TYPES];

export function isSimpleReboundEventType(value: unknown): value is SimpleReboundEventType {
  return Object.values(SIMPLE_REBOUND_EVENT_TYPES).includes(value as SimpleReboundEventType);
}
