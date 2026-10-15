export const CONTROL_STRATEGY_TYPES = ["LIQ_CHASE", "SENTINEL", "SIMPLE_REBOUND"] as const;
export const CREATABLE_CONTROL_STRATEGY_TYPES = ["LIQ_CHASE", "SIMPLE_REBOUND"] as const;

export type ControlStrategyType = (typeof CONTROL_STRATEGY_TYPES)[number];

export function isControlStrategyType(
  value: unknown,
): value is ControlStrategyType {
  return CONTROL_STRATEGY_TYPES.includes(value as ControlStrategyType);
}

export function isCreatableControlStrategyType(
  value: unknown,
): value is (typeof CREATABLE_CONTROL_STRATEGY_TYPES)[number] {
  return CREATABLE_CONTROL_STRATEGY_TYPES.includes(
    value as (typeof CREATABLE_CONTROL_STRATEGY_TYPES)[number],
  );
}
