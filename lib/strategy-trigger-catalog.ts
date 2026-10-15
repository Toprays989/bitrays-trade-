export type StrategyTriggerKind =
  | "LIQUIDATION_WINDOW"
  | "PRICE_VOLUME_STRUCTURE"
  | "RELATIVE_STRENGTH_CONTINUATION"
  | "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
  | "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
  | "LOW_POSITION_WINDOW"
  | "THREE_MINUTE_PROBABILITY"
  | "SIMPLE_REBOUND"
  | "GRID_PRICE_LEVEL"
  | "SCHEDULED_SCAN"
  | "BREAKOUT_RETEST";

export type StrategyTriggerAvailability =
  | "NEW_STRATEGY"
  | "EXISTING_ONLY"
  | "PLANNED";

export type StrategyTriggerCatalogEntry = Readonly<{
  kind: StrategyTriggerKind;
  label: string;
  stepLabel: string;
  description: string;
  availability: StrategyTriggerAvailability;
}>;

export const STRATEGY_TRIGGER_CATALOG: readonly StrategyTriggerCatalogEntry[] =
  Object.freeze([
    {
      kind: "LIQUIDATION_WINDOW",
      label: "爆仓窗口",
      stepLabel: "爆仓与趋势",
      description: "按单币种爆仓窗口唤醒，再交由统一大脑确认趋势与入场。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "PRICE_VOLUME_STRUCTURE",
      label: "量价结构",
      stepLabel: "量价与趋势",
      description: "按成交量、价格结构和共享闭合行情唤醒 TradFi 合约分析。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "RELATIVE_STRENGTH_CONTINUATION",
      label: "相对强弱延续",
      stepLabel: "强弱与趋势",
      description: "比较强弱两腿的量价延续证据，按双向配对模式执行。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE",
      label: "爆仓或动量唤醒",
      stepLabel: "唤醒与趋势",
      description: "爆仓或价格动量均可唤醒，再等待趋势回踩和入场确认。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "HIGH_POSITION_PRICE_VOLUME_STRUCTURE",
      label: "高位量价转弱",
      stepLabel: "高位与趋势",
      description: "高位价格出现卖量和结构转弱后唤醒，仅执行做空判断。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "LOW_POSITION_WINDOW",
      label: "低位价格",
      stepLabel: "低位与趋势",
      description: "按共享72小时位置唤醒做多分析，再由统一趋势、量能和入场大脑确认。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "THREE_MINUTE_PROBABILITY",
      label: "3分钟概率轮次",
      stepLabel: "滚动概率执行",
      description: "连续轮转扫描币安当前在架合约，按最新统一行情直接计算多空概率，达到策略门槛即进入统一下单。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "SIMPLE_REBOUND",
      label: "简单反弹",
      stepLabel: "2秒下跌与1分钟回升",
      description: "仅扫描成交量前30合约，按固定下跌与回升规则做多。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "GRID_PRICE_LEVEL",
      label: "网格价位",
      stepLabel: "网格与价格",
      description: "指定单个合约和价格区间，价格靠近网格线时唤醒共享大脑复核。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "SCHEDULED_SCAN",
      label: "定时扫描",
      stepLabel: "周期与趋势",
      description: "按策略周期轮转扫描合约范围，并把最新闭合量价事实交给共享大脑。",
      availability: "NEW_STRATEGY",
    },
    {
      kind: "BREAKOUT_RETEST",
      label: "突破回踩",
      stepLabel: "突破与回踩",
      description: "识别放量突破后限定窗口内的回踩事实，再交由共享大脑确认。",
      availability: "NEW_STRATEGY",
    },
  ] satisfies StrategyTriggerCatalogEntry[]);

type StrategyTriggerDiscriminator = Readonly<{
  trigger?: Readonly<{ kind?: unknown }>;
  marketProfile?: Readonly<{
    mode?: unknown;
    triggerPolicy?: unknown;
  }>;
}>;

const triggerCatalogByKind = new Map(
  STRATEGY_TRIGGER_CATALOG.map((entry) => [entry.kind, entry]),
);

export function strategyTriggerCatalogEntry(
  kind: StrategyTriggerKind,
): StrategyTriggerCatalogEntry {
  return triggerCatalogByKind.get(kind)!;
}

export function isStrategyTriggerKind(
  value: unknown,
): value is StrategyTriggerKind {
  return typeof value === "string" && triggerCatalogByKind.has(
    value as StrategyTriggerKind,
  );
}

export function isNewStrategyTriggerKind(
  kind: StrategyTriggerKind,
): boolean {
  return strategyTriggerCatalogEntry(kind).availability === "NEW_STRATEGY";
}

export function inferStrategyTriggerKind(
  value: StrategyTriggerDiscriminator,
): StrategyTriggerKind {
  const mode = value.marketProfile?.mode;
  if (mode === "RELATIVE_STRENGTH")
    return "RELATIVE_STRENGTH_CONTINUATION";
  if (mode === "TREND_PULLBACK")
    return "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE";
  if (mode === "HIGH_POSITION_SHORT")
    return "HIGH_POSITION_PRICE_VOLUME_STRUCTURE";
  if (mode === "LOW_POSITION_LONG") return "LOW_POSITION_WINDOW";
  if (mode === "THREE_MINUTE_PROBABILITY")
    return "THREE_MINUTE_PROBABILITY";
  if (mode === "SIMPLE_REBOUND") return "SIMPLE_REBOUND";
  if (mode === "GRID_PRICE") return "GRID_PRICE_LEVEL";
  if (mode === "SCHEDULED_SCAN") return "SCHEDULED_SCAN";
  if (mode === "BREAKOUT_RETEST") return "BREAKOUT_RETEST";
  if (
    mode === "TRADFI" &&
    value.marketProfile?.triggerPolicy === "PRICE_VOLUME_STRUCTURE"
  ) return "PRICE_VOLUME_STRUCTURE";
  return "LIQUIDATION_WINDOW";
}

export function validateStrategyTriggerIdentity(
  value: StrategyTriggerDiscriminator,
): string | null {
  const explicitKind = value.trigger?.kind;
  if (explicitKind === undefined) return null;
  if (!isStrategyTriggerKind(explicitKind))
    return "策略触发器类型无效或未注册";
  const entry = strategyTriggerCatalogEntry(explicitKind);
  if (entry.availability === "PLANNED")
    return `策略触发器“${entry.label}”尚未开放`;
  const inferredKind = inferStrategyTriggerKind(value);
  if (explicitKind !== inferredKind)
    return "策略触发器与市场模式不一致";
  return null;
}
