export const NEXUS_COMPATIBILITY_REGISTRY = {
  DIRECTION_WORKER_DISPATCH: {
    purpose: "统一大脑调度器调用确定性的多空方向工作器",
    removalGate: "多空状态机完成单引擎合并并通过确定性回放",
  },
  RETIRED_CONFIG_FIELD_READ: {
    purpose: "读取后立即丢弃历史容量和价格位置字段",
    removalGate: "保留回滚窗口内的全部配置版本均已迁移",
  },
} as const;

export type NexusCompatibilitySurface =
  keyof typeof NEXUS_COMPATIBILITY_REGISTRY;

export type NexusCompatibilityHit = {
  surface: NexusCompatibilitySurface;
  count: number;
  detail?: string;
};

export function compatibilityHit(
  surface: NexusCompatibilitySurface,
  count = 1,
  detail?: string,
): NexusCompatibilityHit {
  return {
    surface,
    count: Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0)),
    ...(detail ? { detail } : {}),
  };
}

export function summarizeCompatibilityHits(
  hits: NexusCompatibilityHit[],
) {
  const totals = new Map<NexusCompatibilitySurface, number>();
  for (const hit of hits) {
    if (hit.count <= 0) continue;
    totals.set(hit.surface, (totals.get(hit.surface) ?? 0) + hit.count);
  }
  return {
    total: [...totals.values()].reduce((sum, count) => sum + count, 0),
    hits: [...totals.entries()].map(([surface, count]) => ({
      surface,
      count,
      purpose: NEXUS_COMPATIBILITY_REGISTRY[surface].purpose,
      removalGate: NEXUS_COMPATIBILITY_REGISTRY[surface].removalGate,
    })),
  };
}

type RetiredLiquidationShape = {
  marketPosition: Record<string, unknown>;
  execution: Record<string, unknown>;
  risk: Record<string, unknown>;
};

const RETIRED_LIQUIDATION_FIELDS = {
  marketPosition: ["maxPosition24hPercent"],
  execution: ["maxOpenPositions", "maxOrdersPerDay"],
  risk: ["maxMarginUsageUsdt"],
} as const;

/**
 * Historical strategy JSON may still contain fields that no longer own a
 * trading decision. They are consumed in one place and never leak back into
 * normalized executable configuration.
 */
export function stripRetiredLiquidationFields(
  input: RetiredLiquidationShape,
) {
  const marketPosition = { ...input.marketPosition };
  const execution = { ...input.execution };
  const risk = { ...input.risk };
  const retiredFields: string[] = [];

  for (const field of RETIRED_LIQUIDATION_FIELDS.marketPosition) {
    if (field in marketPosition) retiredFields.push(`marketPosition.${field}`);
    delete marketPosition[field];
  }
  for (const field of RETIRED_LIQUIDATION_FIELDS.execution) {
    if (field in execution) retiredFields.push(`execution.${field}`);
    delete execution[field];
  }
  for (const field of RETIRED_LIQUIDATION_FIELDS.risk) {
    if (field in risk) retiredFields.push(`risk.${field}`);
    delete risk[field];
  }

  return {
    marketPosition,
    execution,
    risk,
    compatibility: summarizeCompatibilityHits([
      compatibilityHit(
        "RETIRED_CONFIG_FIELD_READ",
        retiredFields.length,
        retiredFields.join(","),
      ),
    ]),
  };
}
