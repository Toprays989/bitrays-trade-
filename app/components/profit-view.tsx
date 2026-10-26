"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  liveReductionAccounting,
  type LivePosition,
  type LivePositionReduction,
} from "../client/workspace-model";
import {
  buildClosedPositionHistory,
  positionHistoryRoePercent,
} from "../client/position-history";
import {
  buildAccountLedgerSummary,
} from "../client/account-ledger-summary";
import {
  buildPositionLedgerStatusRows,
  type PositionLedgerStatusRow,
} from "../client/position-ledger-status";
import type {
  ExchangeCredential,
  TradingAccount,
} from "../client/workspace-model";
import {
  formatCompactDecimal,
  formatCompactSignedDecimal,
} from "../client/display-number";
import { liveOpenPositionAccounting } from "../../lib/live-open-position-accounting";

type HistoryTab = "LIVE" | "HISTORY" | "FILLS" | "FEES" | "SYSTEM";

type ProfitViewProps = {
  livePositionReductions: LivePositionReduction[];
  livePositions: LivePosition[];
  strategyNames: Record<number, string>;
  tradingAccounts: TradingAccount[];
  exchangeCredentials: ExchangeCredential[];
  portfolioAccountFilter: string;
  accountFilterControl: ReactNode;
  positionsBusy: boolean;
  loadPositions: () => Promise<void>;
  syncReductionSettlements: () => Promise<void>;
  openCurrentPositions: () => void;
};

export function ProfitView({
  livePositionReductions,
  livePositions,
  strategyNames,
  tradingAccounts,
  exchangeCredentials,
  portfolioAccountFilter,
  accountFilterControl,
  positionsBusy,
  loadPositions,
  syncReductionSettlements,
  openCurrentPositions,
}: ProfitViewProps) {
  const [tab, setTab] = useState<HistoryTab>("HISTORY");
  const [symbolQuery, setSymbolQuery] = useState("");
  const [recordType, setRecordType] = useState("ALL");
  const visiblePositions = useMemo(
    () =>
      livePositions.filter(
        (position) =>
          portfolioAccountFilter === "ALL" ||
          position.accountId === portfolioAccountFilter,
      ),
    [livePositions, portfolioAccountFilter],
  );
  const reductions = useMemo(
    () =>
      livePositionReductions.filter(
        (item) =>
          portfolioAccountFilter === "ALL" ||
          item.accountId === portfolioAccountFilter,
      ),
    [livePositionReductions, portfolioAccountFilter],
  );
  const closed = visiblePositions.filter(
    (position) => position.status === "CLOSED",
  );
  const openAccountingRows = visiblePositions
    .filter((position) => position.status === "OPEN")
    .map((position) => ({
      position,
      accounting: liveOpenPositionAccounting({
        positionSide: position.positionSide,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
        leverage: position.leverage,
        estimatedRoundTripFeePercent:
          position.openAccountingPolicy?.estimatedRoundTripFeePercent,
        fundingRate: position.liveMarket?.fundingRate,
      }),
    }))
    .filter(
      (row): row is {
        position: LivePosition;
        accounting: NonNullable<ReturnType<typeof liveOpenPositionAccounting>>;
      } => row.accounting !== null,
    );
  const openEstimatedNetPnl = openAccountingRows.reduce(
    (sum, row) => sum + row.accounting.netPnlAfterTradingFeesUsdt,
    0,
  );
  const openEstimatedFees = openAccountingRows.reduce(
    (sum, row) => sum + row.accounting.estimatedTradingFeesUsdt,
    0,
  );
  const nextFundingProjection = openAccountingRows.reduce<number | null>(
    (sum, row) =>
      row.accounting.projectedNextFundingPnlUsdt === null
        ? sum
        : (sum ?? 0) + row.accounting.projectedNextFundingPnlUsdt,
    null,
  );
  const exactNetPnl = reductions.reduce((sum, item) => {
    const accounting = liveReductionAccounting(item);
    return accounting.exactNetAvailable
      ? sum + (accounting.netRealizedPnl ?? 0)
      : sum;
  }, 0);
  const exactNetCount = reductions.filter(
    (item) => liveReductionAccounting(item).exactNetAvailable,
  ).length;
  const actionableSettlementCount = reductions.filter((item) => {
    const status = liveReductionAccounting(item).settlementStatus;
    return status === "TRADE_DETAILS_PENDING" || status === "FUNDING_PENDING";
  }).length;
  const query = symbolQuery.trim().toUpperCase();
  const filteredReductions = reductions.filter(
    (item) =>
      (!query || item.symbol.includes(query)) &&
      (recordType === "ALL" || item.reason === recordType),
  );
  const historyRows = buildClosedPositionHistory(
    visiblePositions,
    reductions,
  ).filter(
    (item) =>
      (!query || item.symbol.includes(query)) &&
      (recordType === "ALL" || item.reason === recordType),
  );
  const visibleAccountIds = new Set(
    tradingAccounts
      .filter(
        (account) =>
          portfolioAccountFilter === "ALL" ||
          account.accountId === portfolioAccountFilter,
      )
      .map((account) => account.accountId),
  );
  const systemRows = buildPositionLedgerStatusRows(
    tradingAccounts.filter((account) =>
      visibleAccountIds.has(account.accountId),
    ),
    exchangeCredentials.filter((credential) =>
      visibleAccountIds.has(credential.accountId),
    ),
    visiblePositions,
    reductions,
  );
  const accountSummary = buildAccountLedgerSummary(
    tradingAccounts,
    exchangeCredentials,
    portfolioAccountFilter,
  );

  return (
    <div className="work-page position-history-page">
      <section className="panel position-account-summary">
        <div className="position-account-name">
          <span>资金账户</span>
          <b>{accountSummary.accountLabel}</b>
          <small>
            {accountSummary.syncedAccountCount}/{accountSummary.accountCount}
            {" "}个账户余额已同步
          </small>
        </div>
        <SummaryMetric
          label="合约钱包余额"
          value={balanceValue(accountSummary.walletBalance, accountSummary.hasBalanceData)}
          detail={accountSummary.balanceComplete ? "余额完整" : "部分账户待同步"}
        />
        <SummaryMetric
          label="保证金余额 / 权益"
          value={balanceValue(accountSummary.marginBalance, accountSummary.hasBalanceData)}
          detail="钱包余额 + 未实现盈亏"
        />
        <SummaryMetric
          label="可再开仓余额"
          value={balanceValue(accountSummary.availableBalance, accountSummary.hasBalanceData)}
          detail={accountSummary.balanceComplete ? "Binance 实时可用" : "仅汇总已同步账户"}
        />
        <SummaryMetric
          label="浮动盈亏"
          value={
            accountSummary.hasBalanceData
              ? `${signed(accountSummary.unrealizedPnl, 4)} USDT`
              : "--"
          }
          tone={
            accountSummary.hasBalanceData
              ? accountSummary.unrealizedPnl >= 0
                ? "positive"
                : "negative"
              : undefined
          }
        />
        <SummaryMetric
          label="实时费用后盈亏"
          value={`${signed(openEstimatedNetPnl, 4)} USDT`}
          detail={`浮盈亏 - 预估手续费 ${openEstimatedFees.toFixed(4)}`}
          tone={openEstimatedNetPnl >= 0 ? "positive" : "negative"}
        />
        <SummaryMetric
          label="下一次资金费预计"
          value={
            nextFundingProjection === null
              ? "--"
              : `${signed(nextFundingProjection, 4)} USDT`
          }
          detail="仅在持仓跨越下一结算时发生，不计入已实现收益"
          tone={
            nextFundingProjection === null
              ? undefined
              : nextFundingProjection >= 0
                ? "positive"
                : "negative"
          }
        />
        <SummaryMetric
          label="持仓 / 挂单占用保证金"
          value={
            accountSummary.hasBalanceData
              ? `${accountSummary.positionInitialMargin.toFixed(4)} / ${accountSummary.openOrderInitialMargin.toFixed(4)}`
              : "-- / --"
          }
          detail="两项均由 Binance 返回"
        />
        <SummaryMetric
          label="当前持仓"
          value={`${accountSummary.openPositions}`}
          detail={`${closed.length} 笔历史完整平仓`}
        />
        <SummaryMetric
          label="更新时间"
          value={
            accountSummary.oldestBalanceSyncedAt
              ? new Date(accountSummary.oldestBalanceSyncedAt).toLocaleString("zh-CN", {
                  hour12: false,
                })
              : "--"
          }
          detail={`${exactNetCount} 笔费用已核对 · 净收益 ${signed(exactNetPnl, 4)}`}
        />
      </section>

      <section className="panel position-history-workspace">
        <div className="position-history-tabs" role="tablist">
          <button type="button" onClick={openCurrentPositions}>
            当前持仓 <TabCount value={accountSummary.openPositions} />
          </button>
          <TabButton
            active={tab === "LIVE"}
            onClick={() => setTab("LIVE")}
          >
            实时收益 <TabCount value={openAccountingRows.length} />
          </TabButton>
          <TabButton
            active={tab === "HISTORY"}
            onClick={() => setTab("HISTORY")}
          >
            历史仓位 <TabCount value={historyRows.length} />
          </TabButton>
          <TabButton
            active={tab === "FILLS"}
            onClick={() => setTab("FILLS")}
          >
            分批成交 <TabCount value={filteredReductions.length} />
          </TabButton>
          <TabButton
            active={tab === "FEES"}
            onClick={() => setTab("FEES")}
          >
            费用核对{" "}
            <TabCount
              value={actionableSettlementCount}
              warning
            />
          </TabButton>
          <TabButton
            active={tab === "SYSTEM"}
            onClick={() => setTab("SYSTEM")}
          >
            系统状态{" "}
            <TabCount
              value={systemRows.length}
              warning={systemRows.length > 0}
            />
          </TabButton>
          <button
            className="position-history-refresh"
            type="button"
            onClick={() =>
              void (
                tab === "FEES"
                  ? syncReductionSettlements()
                  : loadPositions()
              )
            }
            disabled={positionsBusy}
          >
            {positionsBusy
              ? "同步中…"
              : tab === "FEES"
                ? "立即核对成交明细"
                : "刷新"}
          </button>
        </div>

        {tab !== "SYSTEM" && (
          <div className="position-history-filters">
            {accountFilterControl}
            <label>
              <span>交易对</span>
              <input
                value={symbolQuery}
                onChange={(event) => setSymbolQuery(event.target.value)}
                placeholder="搜索合约，例如 BTC"
              />
            </label>
            <label>
              <span>退出原因</span>
              <select
                value={recordType}
                onChange={(event) => setRecordType(event.target.value)}
              >
                <option value="ALL">全部原因</option>
                <option value="TAKE_PROFIT">止盈</option>
                <option value="STOP_LOSS">止损</option>
                <option value="TRAILING_STOP">移动止损</option>
                <option value="MANUAL">人工平仓</option>
                <option value="EXTERNAL">外部成交</option>
              </select>
            </label>
          </div>
        )}

        {tab === "LIVE" && (
          <LiveProfitTable rows={openAccountingRows} />
        )}
        {tab === "HISTORY" && (
          <HistoryTable
            rows={historyRows}
            positions={visiblePositions}
            strategyNames={strategyNames}
            loading={positionsBusy}
          />
        )}
        {tab === "FILLS" && (
          <ReductionTable reductions={filteredReductions} mode="FILLS" />
        )}
        {tab === "FEES" && (
          <ReductionTable reductions={filteredReductions} mode="FEES" />
        )}
        {tab === "SYSTEM" && (
          <SystemStatusTable positions={systemRows} />
        )}
      </section>
    </div>
  );
}

function LiveProfitTable({
  rows,
}: {
  rows: Array<{
    position: LivePosition;
    accounting: NonNullable<ReturnType<typeof liveOpenPositionAccounting>>;
  }>;
}) {
  return (
    <div className="data-table position-history-table">
      <table>
        <thead>
          <tr>
            <th>账户</th>
            <th>合约</th>
            <th>方向</th>
            <th>毛浮盈亏</th>
            <th>预估手续费</th>
            <th>实时费用后盈亏</th>
            <th>下一资金费预计</th>
            <th>费用依据</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ position, accounting }) => (
            <tr key={position.id}>
              <td><span className="position-account-chip">{position.accountId}</span></td>
              <td><b>{position.symbol}</b></td>
              <td><SideTag side={position.positionSide} /></td>
              <td className={accounting.grossUnrealizedPnlUsdt >= 0 ? "positive" : "negative"}>
                {signed(accounting.grossUnrealizedPnlUsdt, 4)} USDT
              </td>
              <td className="negative">
                −{accounting.estimatedTradingFeesUsdt.toFixed(4)} USDT
              </td>
              <td className={accounting.netPnlAfterTradingFeesUsdt >= 0 ? "positive" : "negative"}>
                {signed(accounting.netPnlAfterTradingFeesUsdt, 4)} USDT
                <small> {signed(accounting.netRoeAfterTradingFeesPercent, 3)}% ROE</small>
              </td>
              <td className={
                accounting.projectedNextFundingPnlUsdt === null
                  ? ""
                  : accounting.projectedNextFundingPnlUsdt >= 0
                    ? "positive"
                    : "negative"
              }>
                {accounting.projectedNextFundingPnlUsdt === null
                  ? "--"
                  : `${signed(accounting.projectedNextFundingPnlUsdt, 4)} USDT`}
                <small> 未结算</small>
              </td>
              <td>
                {position.openAccountingPolicy?.source === "FROZEN_STRATEGY_CONFIG"
                  ? `策略冻结费率 ${accounting.feeRatePercent.toFixed(3)}%`
                  : `默认费率 ${accounting.feeRatePercent.toFixed(3)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="empty">当前没有可计算实时净收益的开放仓位。</div>
      )}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="position-summary-metric">
      <span>{label}</span>
      <b className={tone}>{value}</b>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TabCount({
  value,
  warning = false,
}: {
  value: number;
  warning?: boolean;
}) {
  return (
    <span
      className={`position-tab-count ${warning && value > 0 ? "warning" : ""}`}
    >
      {value}
    </span>
  );
}

function HistoryTable({
  rows,
  positions,
  strategyNames,
  loading,
}: {
  rows: ReturnType<typeof buildClosedPositionHistory>;
  positions: LivePosition[];
  strategyNames: Record<number, string>;
  loading: boolean;
}) {
  const positionsById = new Map(
    positions.map((position) => [position.id, position]),
  );
  const ownership = (position?: LivePosition) => {
    if (!position || position.learning?.source !== "STRATEGY")
      return "人工单";
    const strategyId = position.learning.strategyId;
    return strategyId
      ? strategyNames[strategyId] ?? `NEXUS 大脑 #${strategyId}`
      : "NEXUS 大脑";
  };
  return (
    <div className="data-table position-history-table">
      <table>
        <thead>
          <tr>
            <th>账户</th>
            <th>归属大脑</th>
            <th>合约</th>
            <th>方向</th>
            <th>状态</th>
            <th>平仓时间</th>
            <th>开仓数量</th>
            <th>平仓数量</th>
            <th>开仓均价</th>
            <th>平仓均价</th>
            <th>手续费</th>
            <th>资金费</th>
            <th>已实现净盈亏</th>
            <th>收益率</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const position = positionsById.get(row.positionId);
            const roi = positionHistoryRoePercent(row);
            return (
              <tr key={row.positionId}>
                <td>
                  <span className="position-account-chip">{row.accountId}</span>
                </td>
                <td>
                  <span className="position-owner-chip">{ownership(position)}</span>
                </td>
                <td><b>{row.symbol}</b></td>
                <td><SideTag side={row.side} /></td>
                <td><span className="position-status-chip">完整平仓</span></td>
                <td>{formatTime(row.closedAt)}</td>
                <td>{formatNumber(row.openQuantity)}</td>
                <td>{formatNumber(row.closeQuantity)}</td>
                <td>{formatNumber(row.entryPrice)}</td>
                <td>{formatNumber(row.exitPrice)}</td>
                <td>
                  {row.exactNetAvailable
                    ? feeValue(
                        (row.exitCommission ?? 0) +
                          (row.entryCommissionAllocated ?? 0),
                      )
                    : "--"}
                </td>
                <td className={
                  row.fundingIncome === null
                    ? ""
                    : row.fundingIncome >= 0
                      ? "positive"
                      : "negative"
                }>
                  {row.fundingIncome === null
                    ? "--"
                    : signed(row.fundingIncome, 8)}
                </td>
                <td className={row.displayPnl >= 0 ? "positive" : "negative"}>
                  {signed(row.displayPnl, 4)} USDT
                  <small>{row.exactNetAvailable ? " 净" : " 毛·待补"}</small>
                </td>
                <td className={roi === null ? "" : roi >= 0 ? "positive" : "negative"}>
                  {roi === null ? "--" : `${signed(roi, 3)}%`}
                </td>
                <td>
                  <span>{reasonLabel(row.reason, row.reasonDetail)}</span>
                  {row.reasonDetail && (
                    <small className="position-exit-reason-detail">{row.reasonDetail}</small>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="empty">
          {loading ? "正在加载收益账本…" : "暂无匹配的历史仓位。"}
        </div>
      )}
    </div>
  );
}

function ReductionTable({
  reductions,
  mode,
}: {
  reductions: LivePositionReduction[];
  mode: "FILLS" | "FEES";
}) {
  return (
    <div className="data-table position-history-table">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>账户</th>
            <th>合约</th>
            <th>方向</th>
            <th>数量</th>
            <th>成交价</th>
            {mode === "FEES" ? (
              <>
                <th>平仓手续费</th>
                <th>分摊开仓手续费</th>
                <th>资金费</th>
                <th>净收益</th>
                <th>核对状态</th>
              </>
            ) : (
              <>
                <th>原因</th>
                <th>已实现净盈亏</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {reductions.map((item) => {
            const accounting = liveReductionAccounting(item);
            return (
              <tr key={item.id}>
                <td>{formatTime(item.createdAt)}</td>
                <td><span className="position-account-chip">{item.accountId}</span></td>
                <td><b>{item.symbol}</b></td>
                <td><SideTag side={item.positionSide} /></td>
                <td>{formatNumber(item.quantity)}</td>
                <td>{formatNumber(item.exitPrice)}</td>
                {mode === "FEES" ? (
                  <>
                    <td>{feeValue(accounting.exitCommission)}</td>
                    <td>{feeValue(accounting.entryCommissionAllocated)}</td>
                    <td className={
                      accounting.fundingIncome === null
                        ? ""
                        : accounting.fundingIncome >= 0
                          ? "positive"
                          : "negative"
                    }>
                      {accounting.fundingIncome === null
                        ? "--"
                        : formatCompactSignedDecimal(
                            accounting.fundingIncome,
                            8,
                            "--",
                          )}
                    </td>
                    <td className={accounting.pnl >= 0 ? "positive" : "negative"}>
                      {accounting.exactNetAvailable
                        ? `${signed(accounting.netRealizedPnl ?? 0, 4)} USDT`
                        : "--"}
                    </td>
                    <td>
                      <span className={`position-status-chip ${
                        accounting.settlementStatus === "EXACT_NET"
                          ? "verified"
                          : accounting.settlementStatus === "TRADE_DETAILS_PENDING"
                            ? "warning"
                            : "funding-shared"
                      }`}>
                        {
                          accounting.settlementStatus === "EXACT_NET"
                            ? "费用已齐"
                            : accounting.settlementStatus === "TRADE_DETAILS_PENDING"
                              ? "待补成交明细"
                              : accounting.settlementStatus === "FUNDING_SHARED"
                                ? "成交已齐·资金费共享"
                                : "成交已齐·资金费待核"
                        }
                      </span>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{reasonLabel(item.reason, null)}</td>
                    <td className={accounting.pnl >= 0 ? "positive" : "negative"}>
                      {signed(accounting.pnl, 4)} USDT
                      <small>{accounting.exactNetAvailable ? " 净" : " 毛·待补"}</small>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {reductions.length === 0 && <div className="empty">暂无匹配记录。</div>}
    </div>
  );
}

function SystemStatusTable({
  positions,
}: {
  positions: PositionLedgerStatusRow[];
}) {
  return (
    <div className="data-table position-history-table">
      <table>
        <thead>
          <tr>
            <th>账户</th>
            <th>合约</th>
            <th>类型</th>
            <th>级别</th>
            <th>说明</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.id}>
              <td><span className="position-account-chip">{position.accountId}</span></td>
              <td><b>{position.symbol ?? "账户级"}</b></td>
              <td>{statusCategoryLabel(position.category)}</td>
              <td>
                <span className={`position-status-chip ${position.severity.toLowerCase()}`}>
                  {position.severity === "ERROR" ? "需处理" : "待核对"}
                </span>
              </td>
              <td>{position.message}</td>
              <td>{position.updatedAt ? formatTime(position.updatedAt) : "--"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {positions.length === 0 && (
        <div className="empty positive">当前没有异常或未知执行仓位。</div>
      )}
    </div>
  );
}

function statusCategoryLabel(
  value: PositionLedgerStatusRow["category"],
) {
  return {
    BALANCE: "余额同步",
    EXECUTION: "仓位执行",
    ACCOUNTING: "费用账本",
  }[value];
}

function SideTag({ side }: { side: "LONG" | "SHORT" }) {
  return (
    <span className={`position-side-chip ${side.toLowerCase()}`}>
      {side}
    </span>
  );
}

function reasonLabel(value: string, detail: string | null) {
  if (detail) return detail;
  return (
    {
      TAKE_PROFIT: "止盈",
      STOP_LOSS: "止损",
      TRAILING_STOP: "移动止损",
      MANUAL: "人工平仓",
      EXTERNAL: "外部成交",
    }[value] ?? value
  );
}

function formatTime(value: string | number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 8,
  }).format(value);
}

function signed(value: number, digits: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function feeValue(value: number | null) {
  return formatCompactDecimal(value, 8, "--");
}

function balanceValue(value: number, available: boolean) {
  return available ? `${formatCompactDecimal(value, 4, "--")} USDT` : "--";
}
