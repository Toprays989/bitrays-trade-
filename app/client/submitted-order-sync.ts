import type { LiveOrderEvent, LivePosition } from "./workspace-model";

export function submittedOrderHasBoundPosition(input: {
  clientOrderId: string;
  orders: LiveOrderEvent[];
  positions: LivePosition[];
}) {
  const order = input.orders.find(
    (item) => item.clientOrderId === input.clientOrderId,
  );
  return Boolean(
    order?.status === "FILLED" &&
      input.positions.some((position) => position.sourceEventId === order.id),
  );
}

export function submittedOrderIsVisible(input: {
  clientOrderId: string;
  orders: LiveOrderEvent[];
}) {
  return input.orders.some(
    (item) => item.clientOrderId === input.clientOrderId,
  );
}

export function upsertSubmittedPosition(
  positions: LivePosition[],
  submitted: LivePosition,
) {
  const index = positions.findIndex((position) => position.id === submitted.id);
  if (index < 0) return [submitted, ...positions];
  return positions.map((position, currentIndex) =>
    currentIndex === index ? { ...position, ...submitted } : position,
  );
}
