export const SIMPLE_REBOUND_LIVE_CONFIRMATION = "ENABLE SIMPLE REBOUND LIVE" as const;

export function assertSimpleReboundLiveConfirmation(value: unknown): asserts value is typeof SIMPLE_REBOUND_LIVE_CONFIRMATION {
  if (value !== SIMPLE_REBOUND_LIVE_CONFIRMATION)
    throw new Error(`必须输入 ${SIMPLE_REBOUND_LIVE_CONFIRMATION} 才能提交 Simple Rebound 实盘委托`);
}
