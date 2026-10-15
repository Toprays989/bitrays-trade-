import type { StrategyTriggerWake } from "../strategy-trigger-wake.ts";

export const NEXUS_DIRECTION_WAKE_COHORT_VERSION =
  "nexus-direction-wake-cohort-v1" as const;

export type NexusDirectionWakeCohort = Readonly<{
  version: typeof NEXUS_DIRECTION_WAKE_COHORT_VERSION;
  symbol: string;
  factSnapshotId: string;
  sourceId: string;
  eventAt: number;
  receivedAt: number;
  expiresAt: number;
  referencePrice: number;
  wakes: readonly [StrategyTriggerWake, StrategyTriggerWake];
}>;

/**
 * Pairs LONG and SHORT wake requests that were produced from one immutable
 * market snapshot. Incomplete or inconsistent groups fail closed.
 */
export function buildCompetingDirectionWakeCohorts(
  wakes: readonly StrategyTriggerWake[],
) {
  const groups = new Map<string, StrategyTriggerWake[]>();
  for (const wake of wakes) {
    const key = [
      wake.strategyId,
      wake.configVersion,
      wake.ownerEmail.trim().toLowerCase(),
      wake.accountId.trim().toLowerCase(),
      wake.triggerKind,
      wake.symbol,
      wake.factSnapshotId,
      wake.sourceId,
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push(wake);
    groups.set(key, group);
  }

  const cohorts: NexusDirectionWakeCohort[] = [];
  const invalid: StrategyTriggerWake[] = [];
  for (const group of groups.values()) {
    const byDirection = new Map(group.map((wake) => [wake.direction, wake]));
    const long = byDirection.get("LONG");
    const short = byDirection.get("SHORT");
    const consistent =
      group.length === 2 &&
      Boolean(long) &&
      Boolean(short) &&
      long!.referencePrice === short!.referencePrice &&
      long!.eventAt === short!.eventAt &&
      long!.receivedAt === short!.receivedAt &&
      long!.expiresAt === short!.expiresAt;
    if (!consistent) {
      invalid.push(...group);
      continue;
    }
    cohorts.push(Object.freeze({
      version: NEXUS_DIRECTION_WAKE_COHORT_VERSION,
      symbol: long!.symbol,
      factSnapshotId: long!.factSnapshotId,
      sourceId: long!.sourceId,
      eventAt: long!.eventAt,
      receivedAt: long!.receivedAt,
      expiresAt: long!.expiresAt,
      referencePrice: long!.referencePrice,
      wakes: Object.freeze([long!, short!]) as readonly [
        StrategyTriggerWake,
        StrategyTriggerWake,
      ],
    }));
  }
  return Object.freeze({
    cohorts: Object.freeze(cohorts),
    invalid: Object.freeze(invalid),
  });
}
