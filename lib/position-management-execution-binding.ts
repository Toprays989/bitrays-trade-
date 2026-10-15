import type {
  PositionManagementAction,
} from "./post-entry-position-management.ts";

export type PositionManagementExecutionBinding = {
  action: PositionManagementAction;
  status:
    | "BOUND"
    | "WAITING_FOR_TRIGGER"
    | "DISABLED"
    | "OBSERVATION_ONLY"
    | "NO_ACTION_REQUIRED";
  executor:
    | "POSITION_ADDITION"
    | "TRAILING_STOP"
    | "EVIDENCE_RISK_REDUCTION"
    | "DISCIPLINARY_MARKET_EXIT"
    | "CONFIGURED_RISK_PLAN"
    | "NONE";
  changesPositionImmediately: boolean;
  summary: string;
};

/**
 * 把持仓判断与真正能够改变仓位的执行器明确绑定。
 *
 * 分析结论本身不能冒充已执行动作：补仓仍需经过补仓执行器，利润保护仍由
 * 已配置的移动止损触发，趋势失效仍由既定止损/强平保护执行。
 */
export function bindPositionManagementExecution(input: {
  action: PositionManagementAction;
  addOnEnabled: boolean;
  profitScaleInEnabled?: boolean;
  trailingActivationRoePercent: number;
  trailingDrawdownRoePercent: number;
  favorableRoePercent: number;
  stopLossLevelCount: number;
  liquidationGuardBufferPercent: number;
  structureExitAuthorized?: boolean;
  evidenceRiskReductionAuthorized?: boolean;
  expiredHorizonProfitProtectionAuthorized?: boolean;
}): PositionManagementExecutionBinding {
  if (input.action === "REDUCE_RISK_BY_EVIDENCE")
    return input.evidenceRiskReductionAuthorized
      ? {
          action: input.action,
          status: "BOUND",
          executor: "EVIDENCE_RISK_REDUCTION",
          changesPositionImmediately: true,
          summary:
            "早期费用后亏损持续扩大，且局部结构、真实成交量和独立周期证据已经共振；后台只执行一次策略配置比例的部分减险。",
        }
      : {
          action: input.action,
          status: "OBSERVATION_ONLY",
          executor: "NONE",
          changesPositionImmediately: false,
          summary:
            "证据减险候选已记录，但行情时效、因果完整性或一次性执行条件未通过，本轮不创建订单。",
        };
  if (input.action === "SCALE_IN_ELIGIBLE") {
    if (input.profitScaleInEnabled)
      return {
        action: input.action,
        status: "BOUND",
        executor: "POSITION_ADDITION",
        changesPositionImmediately: false,
        summary:
          "已绑定盈利延续加仓执行器；仍须通过两份独立延续证据、实时盈利复核、账户、额度、冷却、最小量和幂等校验。",
      };
    return {
      action: input.action,
      status: "DISABLED",
      executor: "NONE",
      changesPositionImmediately: false,
      summary:
        "策略未启用盈利延续自动加仓；该判断只保留为学习证据。",
    };
  }

  if (input.action === "ADD_ELIGIBLE") {
    if (input.addOnEnabled)
      return {
        action: input.action,
        status: "BOUND",
        executor: "POSITION_ADDITION",
        changesPositionImmediately: false,
        summary:
          "已绑定触底反弹补仓执行器；仍须通过连续独立确认、账户、额度、冷却、最小量和幂等校验，成交确认后才改变仓位。",
      };
    return {
      action: input.action,
      status: "DISABLED",
      executor: "NONE",
      changesPositionImmediately: false,
      summary:
        "策略未启用触底反弹自动补仓；该判断仅保留为复盘证据，不会创建订单。",
    };
  }

  if (input.action === "TIGHTEN_PROFIT_PROTECTION") {
    if (!positive(input.trailingDrawdownRoePercent))
      return {
        action: input.action,
        status: "OBSERVATION_ONLY",
        executor: "NONE",
        changesPositionImmediately: false,
        summary:
          "利润保护判断已记录，但该仓位未配置移动止损；系统不会据此临时改写参数或直接平仓。",
      };
    if (
      !input.expiredHorizonProfitProtectionAuthorized &&
      positive(input.trailingActivationRoePercent) &&
      input.favorableRoePercent < input.trailingActivationRoePercent
    )
      return {
        action: input.action,
        status: "WAITING_FOR_TRIGGER",
        executor: "TRAILING_STOP",
        changesPositionImmediately: false,
        summary:
          `已绑定移动止损，但峰值ROE ${format(input.favorableRoePercent)}% 尚未达到 ` +
          `${format(input.trailingActivationRoePercent)}% 启动线；保持原参数等待触发。`,
      };
    return {
      action: input.action,
      status: "BOUND",
      executor: "TRAILING_STOP",
      changesPositionImmediately: false,
      summary:
        input.expiredHorizonProfitProtectionAuthorized
          ? `日内观察周期已结束，且费用后盈利已按配置回撤；移动止损提前启用，保护线按峰值ROE回撤 ${format(input.trailingDrawdownRoePercent)} 个百分点计算。`
          : `移动止损已启动；保护线按峰值ROE回撤 ${format(input.trailingDrawdownRoePercent)} 个百分点计算。`,
    };
  }

  if (input.action === "EXIT_OR_REDUCE_BY_RISK_PLAN") {
    if (input.structureExitAuthorized)
      return {
        action: input.action,
        status: "BOUND",
        executor: "DISCIPLINARY_MARKET_EXIT",
        changesPositionImmediately: true,
        summary:
          "入场结构已由连续完整1分钟收盘确认失效；后台风控将以幂等市价减仓指令退出当前方向仓位。",
      };
    if (
      input.stopLossLevelCount > 0 ||
      positive(input.liquidationGuardBufferPercent)
    )
      return {
        action: input.action,
        status: "BOUND",
        executor: "CONFIGURED_RISK_PLAN",
        changesPositionImmediately: false,
        summary:
          "趋势失效判断已绑定既定止损/强平保护；不会绕过用户参数立即平仓，达到配置触发线后才减仓。",
      };
    return {
      action: input.action,
      status: "OBSERVATION_ONLY",
      executor: "NONE",
      changesPositionImmediately: false,
      summary:
        "趋势失效判断已记录，但仓位没有可执行的止损或强平保护配置；本轮只保留复盘证据。",
    };
  }

  return {
    action: input.action,
    status: "NO_ACTION_REQUIRED",
    executor: "NONE",
    changesPositionImmediately: false,
    summary: "当前判断要求继续持有或观察，不创建订单，也不修改既有风险参数。",
  };
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function format(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}
