export const SIMPLE_REBOUND_CONFIG = Object.freeze({
  universeSize: 30,
  maxSlots: 5,
  orderNotionalUsdt: 20,
  leverage: 5,
  minimumHoldSeconds: 180,
  secondDeclinesRequired: 10,
  minimumBearishMinutes: 2,
  maximumBearishMinutes: 3,
  entryDirection: "LONG_ONLY" as const,
});

export function validateSimpleReboundConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.universeSize === SIMPLE_REBOUND_CONFIG.universeSize &&
    input.maxSlots === SIMPLE_REBOUND_CONFIG.maxSlots &&
    input.orderNotionalUsdt === SIMPLE_REBOUND_CONFIG.orderNotionalUsdt &&
    input.leverage === SIMPLE_REBOUND_CONFIG.leverage &&
    input.minimumHoldSeconds === SIMPLE_REBOUND_CONFIG.minimumHoldSeconds &&
    input.secondDeclinesRequired === SIMPLE_REBOUND_CONFIG.secondDeclinesRequired &&
    input.minimumBearishMinutes === SIMPLE_REBOUND_CONFIG.minimumBearishMinutes &&
    input.maximumBearishMinutes === SIMPLE_REBOUND_CONFIG.maximumBearishMinutes &&
    input.entryDirection === SIMPLE_REBOUND_CONFIG.entryDirection;
}
