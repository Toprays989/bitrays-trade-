"use client";

import type { TradingAccount } from "../client/workspace-model";

type AccountRiskPanelProps = {
  accounts: TradingAccount[];
  canManage: boolean;
  busyAccountId: string | null;
  onPause: (account: TradingAccount) => void;
};

function riskLevelLabel(account: TradingAccount) {
  switch (account.stats.riskLevel) {
    case "HIGH":
      return "高占用";
    case "WATCH":
      return "需关注";
    case "DISABLED":
      return "已停用";
    default:
      return "正常";
  }
}

function riskLevelClass(account: TradingAccount) {
  switch (account.stats.riskLevel) {
    case "HIGH":
      return "negative";
    case "WATCH":
      return "warning";
    case "DISABLED":
      return "muted";
    default:
      return "positive";
  }
}

function formatUsdt(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function AccountRiskPanel({
  accounts,
  canManage,
  busyAccountId,
  onPause,
}: AccountRiskPanelProps) {
  return (
    <section className="panel control-panel">
      <div className="panel-head">
        <div>
          <h2>账户可用状态</h2>
          <p>这里只管理账户是否可用及连接状态；下单、杠杆、资金和止盈止损参数由各策略独立配置</p>
        </div>
      </div>
      <div className="mini-metrics account-utilization-grid">
        {accounts.map((account) => {
          const disabled =
            !canManage ||
            !account.isActive ||
            busyAccountId === account.accountId;
          return (
            <article key={account.id}>
              <span>
                {account.name} · {riskLevelLabel(account)}
              </span>
              <b className={riskLevelClass(account)}>
                {account.stats.utilizationPercent.toFixed(2)}%
              </b>
              <small>
                Binance 可再开仓 {formatUsdt(account.stats.availableMargin)} ·
                持仓占用 {formatUsdt(account.stats.marginUsed)} · 挂单占用{" "}
                {formatUsdt(account.stats.reservedMargin)} USDT
              </small>
              <div className="reserve-setting">
                <span>当前运行状态</span>
                <b>
                  运行策略 {account.stats.runningStrategies} 个 · 已持仓{" "}
                  {account.stats.openPositions} 个 · 等待订单{" "}
                  {account.stats.pendingOrders} 笔
                </b>
                <small>
                  账户停用会暂停其运行策略；已有仓位仍由原绑定策略参数继续管理
                </small>
              </div>
              <small>
                浮动{" "}
                <em
                  className={
                    account.stats.unrealizedPnl >= 0 ? "positive" : "negative"
                  }
                >
                  {account.stats.unrealizedPnl >= 0 ? "+" : ""}
                  {account.stats.unrealizedPnl.toFixed(2)}
                </em>{" "}
                · 已实现{" "}
                <em
                  className={
                    account.stats.realizedPnl >= 0 ? "positive" : "negative"
                  }
                >
                  {account.stats.realizedPnl >= 0 ? "+" : ""}
                  {account.stats.realizedPnl.toFixed(2)}
                </em>{" "}
                USDT
              </small>
              <button
                className="text-action"
                disabled={
                  disabled ||
                  (account.stats.runningStrategies === 0 &&
                    account.stats.pendingOrders === 0)
                }
                onClick={() => onPause(account)}
              >
                安全暂停自动化
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
