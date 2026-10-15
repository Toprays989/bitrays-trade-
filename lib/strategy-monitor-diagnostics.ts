export type StrategyMonitorDiagnostic = Readonly<{
  status: string;
  message: string;
}>;

export function threeMinuteRoundFailureDiagnostic(
  error: unknown,
): StrategyMonitorDiagnostic & Readonly<{ error: string }> {
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "未知运行错误";
  const normalized = rawMessage.replace(/\s+/g, " ").trim().slice(0, 500) ||
    "未知运行错误";
  return Object.freeze({
    status: "ERROR",
    error: normalized,
    message:
      `3分钟轮次运行失败：${normalized}。本轮未产生候选，下一个完整轮次自动重试。`,
  });
}

export function shortMonitorIdleDiagnostic(
  triggerKind: string,
): StrategyMonitorDiagnostic {
  if (triggerKind === "HIGH_POSITION_PRICE_VOLUME_STRUCTURE")
    return Object.freeze({
      status: "WAIT_HIGH_POSITION_PRICE_VOLUME_STRUCTURE",
      message:
        "本轮没有同时满足72小时高位、成交量放大和价格转弱结构的候选，继续监听。",
    });
  if (triggerKind === "PRICE_VOLUME_STRUCTURE")
    return Object.freeze({
      status: "WAIT_PRICE_VOLUME_STRUCTURE",
      message: "本轮没有同时满足价格结构与成交量确认的做空候选，继续监听。",
    });
  if (triggerKind === "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE")
    return Object.freeze({
      status: "WAIT_LIQUIDATION_OR_PRICE_MOMENTUM",
      message: "本轮没有满足爆仓或价格动量唤醒条件的做空候选，继续监听。",
    });
  return Object.freeze({
    status: "WAIT_RECENT_LONG_LIQUIDATION",
    message:
      "本轮没有满足单合约金额、方向与传输延迟要求的新爆仓候选，继续监听。",
  });
}
