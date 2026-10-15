export const ACTUAL_POSITION_EVIDENCE_TASK =
  "ACTUAL_POSITION_EVIDENCE" as const;

export type BackgroundRepairStatus =
  | "PENDING"
  | "RETRY_WAIT"
  | "COMPLETED"
  | "TERMINAL";

export type BackgroundRepairTaskView = {
  status: BackgroundRepairStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  lastErrorCode: string | null;
  lastError: string | null;
  completedAt: Date | null;
};

export function backgroundRepairRetryDelayMs(attemptCount: number) {
  const safeAttempt = Math.max(1, Math.trunc(attemptCount));
  return Math.min(30 * 60_000, 15_000 * 2 ** (safeAttempt - 1));
}

export function backgroundRepairFailure(input: {
  attemptCount: number;
  nowMs: number;
  permanent: boolean;
}) {
  const attemptCount = Math.max(1, Math.trunc(input.attemptCount));
  return input.permanent
    ? {
        status: "TERMINAL" as const,
        nextAttemptAtMs: input.nowMs,
        completedAtMs: input.nowMs,
      }
    : {
        status: "RETRY_WAIT" as const,
        nextAttemptAtMs:
          input.nowMs + backgroundRepairRetryDelayMs(attemptCount),
        completedAtMs: null,
      };
}

export function positionSampleCollectionLabel(input: {
  sampleCount: number;
  complete: boolean;
  task: BackgroundRepairTaskView | null;
}) {
  if (input.complete)
    return {
      state: "COMPLETE" as const,
      label: "完整样本",
      nextAction: "继续记录长周期观察，不需要人工操作",
    };
  if (input.sampleCount > 0)
    return {
      state: "COLLECTING" as const,
      label: `已采集 ${input.sampleCount} 个节点`,
      nextAction: "后台将在下一个检查点自动补充",
    };
  if (input.task?.status === "TERMINAL")
    return {
      state: "UNAVAILABLE" as const,
      label: "历史样本不可补",
      nextAction:
        input.task.lastError ??
        "交易所已无对应历史行情；该仓位不参与参数学习",
    };
  if (input.task?.status === "RETRY_WAIT")
    return {
      state: "RETRY_WAIT" as const,
      label: `补样重试中（第 ${input.task.attemptCount} 次）`,
      nextAction: `后台将在 ${input.task.nextAttemptAt.toLocaleString(
        "zh-CN",
      )} 自动重试；失败项不会阻塞其他仓位`,
    };
  if (input.task?.status === "COMPLETED")
    return {
      state: "SUMMARY_SYNC_REQUIRED" as const,
      label: "样本已完成，摘要同步中",
      nextAction:
        "后台将重新读取已完成样本；无需重新下单或人工刷新",
    };
  return {
    state: "PENDING" as const,
    label: "样本已排队",
    nextAction: "后台将自动采集，不需要人工刷新或重新下单",
  };
}
