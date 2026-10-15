export const NEXUS_BRAIN_NAME_PREFIX = "NEXUS大脑 · ";

export type NexusBrainTemplate =
  | "LEGACY_LIQUIDATION"
  | "NEXUS_MARKET_BRAIN"
  | "TREND_BREAKOUT"
  | "SUPPORT_REVERSAL"
  | "DOWNTREND_CONTINUATION";

export const NEXUS_PRODUCTION_BRAIN_TEMPLATE =
  "NEXUS_MARKET_BRAIN" as const;

export type NexusBrainRuntimeMode =
  | "SHADOW"
  | "CONFIRM_REQUIRED"
  | "LIVE";

export type NexusBrainLifecycleStatus =
  | "DRAFT"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "DRAINING"
  | "BLOCKED"
  | "ERROR"
  | "ARCHIVED";

export function normalizeBrainCustomName(value: unknown) {
  const name = String(value ?? "").trim();
  return name.startsWith(NEXUS_BRAIN_NAME_PREFIX)
    ? name.slice(NEXUS_BRAIN_NAME_PREFIX.length).trim()
    : name;
}

export function nexusBrainDisplayName(value: unknown) {
  const customName = normalizeBrainCustomName(value);
  return customName ? `${NEXUS_BRAIN_NAME_PREFIX}${customName}` : "NEXUS大脑";
}

export function createBrainKey(randomUuid = crypto.randomUUID()) {
  return `brain-${randomUuid}`;
}

export function requireNexusBrainKey(value: unknown) {
  const brainKey = String(value ?? "").trim();
  if (!brainKey)
    throw new Error("策略缺少不可变 brainKey，禁止进入配置或执行链");
  return brainKey;
}
