export const NEXUS_BRAIN_BRANCHES = ["LONG", "SHORT", "RELATIVE_STRENGTH"] as const;

export type NexusBrainBranch = (typeof NEXUS_BRAIN_BRANCHES)[number];
