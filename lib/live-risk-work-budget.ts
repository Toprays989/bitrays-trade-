export function selectRotatingWorkIds(input: {
  ids: number[];
  cursor: number;
  budget: number;
  priorityIds?: number[];
}) {
  const ids = [...new Set(input.ids.filter(Number.isInteger))];
  const budget = Math.max(0, Math.trunc(input.budget));
  if (!ids.length || budget === 0)
    return { selectedIds: [] as number[], nextCursor: 0 };

  const idSet = new Set(ids);
  const selectedIds: number[] = [];
  for (const id of input.priorityIds ?? []) {
    if (
      Number.isInteger(id) &&
      idSet.has(id) &&
      !selectedIds.includes(id)
    )
      selectedIds.push(id);
    if (selectedIds.length >= budget)
      return {
        selectedIds,
        nextCursor: Math.abs(Math.trunc(input.cursor)) % ids.length,
      };
  }

  const start = Math.abs(Math.trunc(input.cursor)) % ids.length;
  let visited = 0;
  while (selectedIds.length < budget && visited < ids.length) {
    const id = ids[(start + visited) % ids.length];
    if (!selectedIds.includes(id)) selectedIds.push(id);
    visited += 1;
  }

  return {
    selectedIds,
    nextCursor: (start + Math.max(1, visited)) % ids.length,
  };
}

/**
 * Deep position analysis must prefer positions that have never been sampled,
 * then the least recently sampled position. Persisted observation time makes
 * the order survive runner or application restarts; the in-memory cursor is
 * only a secondary tie-breaker after this ordering is applied.
 */
export function prioritizeLeastRecentlyObservedWorkIds(input: {
  ids: number[];
  lastObservedAtById: ReadonlyMap<number, number>;
}) {
  return [...new Set(input.ids.filter(Number.isInteger))].sort(
    (left, right) => {
      const leftObservedAt = input.lastObservedAtById.get(left) ?? 0;
      const rightObservedAt = input.lastObservedAtById.get(right) ?? 0;
      return leftObservedAt - rightObservedAt || left - right;
    },
  );
}

/**
 * All due positions retain fairness, while positions close to a configured
 * stop or an armed trailing giveback are inspected first inside the same
 * overdue window. This changes analysis order only; deterministic protection
 * remains independent and authoritative.
 */
export function prioritizePositionIntelligenceWorkIds(input: {
  ids: number[];
  lastObservedAtById: ReadonlyMap<number, number>;
  scheduledAtById: ReadonlyMap<number, number>;
  urgencyById: ReadonlyMap<number, number>;
  nowMs: number;
  overdueBucketMs?: number;
}) {
  const overdueBucketMs = Math.max(
    1_000,
    Math.trunc(input.overdueBucketMs ?? 30_000),
  );
  return [...new Set(input.ids.filter(Number.isInteger))].sort(
    (left, right) => {
      const leftObservedAt = input.lastObservedAtById.get(left) ?? 0;
      const rightObservedAt = input.lastObservedAtById.get(right) ?? 0;
      if ((leftObservedAt === 0) !== (rightObservedAt === 0))
        return leftObservedAt === 0 ? -1 : 1;
      const leftOverdueBucket = Math.floor(
        Math.max(
          0,
          input.nowMs - (input.scheduledAtById.get(left) ?? input.nowMs),
        ) / overdueBucketMs,
      );
      const rightOverdueBucket = Math.floor(
        Math.max(
          0,
          input.nowMs - (input.scheduledAtById.get(right) ?? input.nowMs),
        ) / overdueBucketMs,
      );
      return rightOverdueBucket - leftOverdueBucket ||
        (input.urgencyById.get(right) ?? 0) -
          (input.urgencyById.get(left) ?? 0) ||
        leftObservedAt - rightObservedAt ||
        left - right;
    },
  );
}

export function positionIntelligenceUrgency(input: {
  currentRoePercent: number;
  capitalStopRoePercent: number | null;
  favorableRoePercent: number;
  trailingActivationRoePercent: number;
  trailingGivebackRoePoints: number;
}) {
  const current = finite(input.currentRoePercent);
  const capitalStop = positive(input.capitalStopRoePercent);
  const stopUrgency = current < 0 && capitalStop !== null
    ? Math.min(100, Math.abs(current) / capitalStop * 100)
    : current < 0
      ? Math.min(60, Math.abs(current))
      : 0;
  const activation = positive(input.trailingActivationRoePercent);
  const givebackThreshold = positive(input.trailingGivebackRoePoints);
  const favorable = finite(input.favorableRoePercent);
  const giveback = Math.max(0, favorable - current);
  const trailingUrgency =
      activation !== null &&
      givebackThreshold !== null &&
      favorable >= activation
    ? Math.min(100, giveback / givebackThreshold * 100)
    : 0;
  return Math.round(Math.max(stopUrgency, trailingUrgency) * 1_000) / 1_000;
}

function finite(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Hard protection work must never wait behind routine position maintenance.
 * Priority and maintenance work therefore have independent rotating budgets:
 * a market-wide trigger cannot make one heartbeat unbounded, while routine
 * maintenance can never consume the capacity reserved for close protection.
 */
export function selectProtectionWorkIds(input: {
  ids: number[];
  cursor: number;
  maintenanceBudget: number;
  priorityCursor?: number;
  priorityBudget?: number;
  priorityIds?: number[];
  maintenancePriorityIds?: number[];
}) {
  const ids = [...new Set(input.ids.filter(Number.isInteger))];
  const idSet = new Set(ids);
  const priorityIds = [...new Set(
    (input.priorityIds ?? []).filter(
      (id) => Number.isInteger(id) && idSet.has(id),
    ),
  )];
  const priority = selectRotatingWorkIds({
    ids: priorityIds,
    cursor: input.priorityCursor ?? 0,
    budget: input.priorityBudget ?? priorityIds.length,
  });
  const prioritySet = new Set(priorityIds);
  const maintenance = selectRotatingWorkIds({
    ids: ids.filter((id) => !prioritySet.has(id)),
    cursor: input.cursor,
    budget: input.maintenanceBudget,
    priorityIds: input.maintenancePriorityIds,
  });
  return {
    selectedIds: [...priority.selectedIds, ...maintenance.selectedIds],
    priorityIds: priority.selectedIds,
    maintenanceIds: maintenance.selectedIds,
    nextCursor: maintenance.nextCursor,
    nextPriorityCursor: priority.nextCursor,
  };
}
