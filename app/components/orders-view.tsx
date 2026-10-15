"use client";

import { useState, type ReactNode } from "react";
import type { LiveOrderEvent } from "../client/workspace-model";
import {
  liveOrderActionLabel,
  liveOrderPurposeLabel,
} from "../client/live-order-display";
import { formatCompactDecimal } from "../client/display-number";

type OrdersViewProps = {
  liveOrders: LiveOrderEvent[];
  strategyNames: Record<number, string>;
  portfolioAccountFilter: string;
  orderStatus: string;
  orderDateRange: string;
  orderQuery: string;
  setOrderQuery: (value: string) => void;
  setOrderStatus: (value: string) => void;
  setOrderDateRange: (value: string) => void;
  accountFilterControl: ReactNode;
  loadLiveOrders: () => Promise<void>;
  loadingOrders: boolean;
  currentTime: number;
  liveCancelBusy: boolean;
  can: (permission: string) => boolean;
  liveCancelOrderTarget: LiveOrderEvent | null;
  setLiveCancelOrderTarget: (value: LiveOrderEvent | null) => void;
  cancelLivePendingOrder: () => Promise<void>;
};

export function OrdersView({
  liveOrders,
  strategyNames,
  portfolioAccountFilter,
  orderStatus,
  orderDateRange,
  orderQuery,
  setOrderQuery,
  setOrderStatus,
  setOrderDateRange,
  accountFilterControl,
  loadLiveOrders,
  loadingOrders,
  currentTime,
  liveCancelBusy,
  can,
  liveCancelOrderTarget,
  setLiveCancelOrderTarget,
  cancelLivePendingOrder,
}: OrdersViewProps) {
  const [purposeFilter, setPurposeFilter] = useState("ALL");
  const cutoff = currentTime - Number(orderDateRange) * 86_400_000;
  const scoped = liveOrders.filter(
      (order) =>
        (portfolioAccountFilter === "ALL" ||
          order.accountId === portfolioAccountFilter) &&
        new Date(order.createdAt).getTime() >= cutoff &&
        `${order.clientOrderId} ${order.exchangeOrderId ?? ""} ${order.symbol}`
          .toLowerCase()
          .includes(orderQuery.trim().toLowerCase()),
    );
    const visible = scoped.filter(
      (order) =>
        (orderStatus === "ALL" || order.status === orderStatus) &&
        (purposeFilter === "ALL" || order.purpose === purposeFilter),
    );
    const filledCount = scoped.filter(
      (order) => ["FILLED", "SUBMITTED"].includes(order.status),
    ).length;
    const pendingCount = scoped.filter(
      (order) =>
        ["PENDING", "NEW", "PARTIALLY_FILLED", "CANCEL_PENDING"].includes(
          order.status,
        ),
    ).length;
    const unknownCount = scoped.filter(
      (order) => order.status === "EXECUTION_UNKNOWN",
    ).length;
    const statusLabel = (status: LiveOrderEvent["status"]) =>
      status === "FILLED" || status === "SUBMITTED"
        ? "已全部成交"
        : status === "PARTIALLY_FILLED"
          ? "已部分成交"
          : status === "NEW"
            ? "交易所挂单中"
            : status === "CANCEL_PENDING"
              ? "撤单确认中"
              : status === "PENDING"
                ? "发送确认中"
          : status === "CANCELED"
            ? "已撤销"
          : status === "EXPIRED"
            ? "已过期"
          : status === "REJECTED"
            ? "已拒绝"
            : status === "EXECUTION_UNKNOWN"
              ? "状态待人工核对"
              : "已接受";
    return (
      <div className="work-page">
        <section className="panel control-panel">
          <div className="panel-head">
            <div>
              <h2>Binance 实盘订单</h2>
              <p>等待限价单按有效期自动撤销，也可人工确认撤单；成交与撤单历史永久留痕</p>
            </div>
            <div className="panel-actions">
              <div className="detail-account-toolbar">
                {accountFilterControl}
                <span>当前 {visible.length} 笔</span>
              </div>
              <button
                onClick={() => void loadLiveOrders()}
                disabled={loadingOrders}
              >
                {loadingOrders ? "同步中…" : "刷新订单"}
              </button>
            </div>
          </div>
          <div className="order-status-strip">
            <span>范围内 <b>{scoped.length}</b> 笔</span>
            <span className="positive">已确认成交 <b>{filledCount}</b></span>
            <span className={pendingCount ? "warning-text" : ""}>
              等待成交 <b>{pendingCount}</b>
            </span>
            <span className={unknownCount ? "negative" : ""}>
              待核对 <b>{unknownCount}</b>
            </span>
            <small>最多读取最近 500 条实盘订单，不增加 Binance 请求</small>
          </div>
          <div className="filterbar">
            <label>
              ⌕{" "}
              <input
                value={orderQuery}
                onChange={(event) => setOrderQuery(event.target.value)}
                placeholder="订单号 / 合约"
              />
            </label>
            <select
              value={orderStatus}
              onChange={(event) => setOrderStatus(event.target.value)}
            >
              <option value="ALL">全部状态</option>
              <option value="FILLED">已全部成交</option>
              <option value="PARTIALLY_FILLED">已部分成交</option>
              <option value="NEW">交易所挂单中</option>
              <option value="PENDING">发送确认中</option>
              <option value="CANCEL_PENDING">撤单确认中</option>
              <option value="CANCELED">已撤销</option>
              <option value="EXPIRED">已过期</option>
              <option value="REJECTED">已拒绝</option>
              <option value="EXECUTION_UNKNOWN">状态待核对</option>
            </select>
            <select
              value={purposeFilter}
              onChange={(event) => setPurposeFilter(event.target.value)}
            >
              <option value="ALL">全部类型</option>
              <option value="ENTRY">开仓</option>
              <option value="ADDITION">补仓</option>
              <option value="REDUCTION">平仓</option>
              <option value="UNKNOWN">历史未归属</option>
            </select>
            <select
              value={orderDateRange}
              onChange={(event) => setOrderDateRange(event.target.value)}
            >
              <option value="1">今日</option>
              <option value="7">近 7 天</option>
              <option value="30">近 30 天</option>
            </select>
          </div>
          <div className="data-table">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>账户</th>
                  <th>本地订单号</th>
                  <th>交易所订单号</th>
                  <th>合约</th>
                  <th>类型</th>
                  <th>归属大脑</th>
                  <th>方向</th>
                  <th>委托 / 成交 / 剩余</th>
                  <th>参考价</th>
                  <th>名义价值</th>
                  <th>保证金投入</th>
                  <th>状态</th>
                  <th>自动撤单</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((order) => (
                  <tr key={order.id}>
                    <td>
                      {new Date(order.createdAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </td>
                    <td>{order.accountId}</td>
                    <td className="mono">{order.clientOrderId}</td>
                    <td className="mono">{order.exchangeOrderId ?? "--"}</td>
                    <td>
                      <b>{order.symbol}</b>
                    </td>
                    <td>{liveOrderPurposeLabel(order.purpose)}</td>
                    <td>
                      {order.strategyId
                        ? strategyNames[order.strategyId] ??
                          `NEXUS 大脑 #${order.strategyId}`
                        : "--"}
                    </td>
                    <td>
                      {liveOrderActionLabel(order)}
                    </td>
                    <td>
                      {order.quantity} / {order.executedQuantity ?? 0} /{" "}
                      {order.remainingQuantity ?? order.quantity}
                    </td>
                    <td>{formatCompactDecimal(order.referencePrice, 8, "--")}</td>
                    <td>{order.estimatedNotional.toFixed(2)} USDT</td>
                    <td>
                      {order.initialMarginUsdt === null ||
                          order.initialMarginUsdt === undefined
                        ? "--"
                        : `${order.initialMarginUsdt.toFixed(2)} USDT`}
                      {order.leverage ? <small>{order.leverage}×</small> : null}
                    </td>
                    <td>
                      <span
                        className={`source-tag ${order.status === "FILLED" || order.status === "SUBMITTED" ? "auto" : order.status === "REJECTED" || order.status === "EXPIRED" || order.status === "EXECUTION_UNKNOWN" ? "danger-source" : "protect"}`}
                      >
                        {statusLabel(order.status)}
                      </span>
                    </td>
                    <td>
                      {["PENDING", "NEW", "PARTIALLY_FILLED"].includes(
                        order.status,
                      ) && order.expiresAt
                        ? `${Math.max(0, Math.ceil((new Date(order.expiresAt).getTime() - currentTime) / 1000))} 秒`
                        : order.status === "CANCELED"
                          ? order.cancelReason === "USER_REQUESTED"
                            ? "人工撤单"
                            : order.cancelReason === "ORDER_TTL_EXPIRED"
                              ? "到期自动撤单"
                              : order.cancelReason === "STRUCTURE_INVALIDATED"
                                ? "结构失效撤单"
                                : "已清除"
                          : "--"}
                    </td>
                    <td>
                      {order.canCancel ? (
                        <button
                          className="text-action danger-text"
                          disabled={
                            liveCancelBusy ||
                            !can("trade:order:cancel")
                          }
                          onClick={() => setLiveCancelOrderTarget(order)}
                        >
                          撤单
                        </button>
                      ) : (
                        <span>--</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loadingOrders && visible.length === 0 && (
              <div className="empty">没有符合筛选条件的实盘订单。</div>
            )}
          </div>
        </section>
        {liveCancelOrderTarget && (
          <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="live-cancel-order-title"
          >
            <div className="modal compact-modal">
              <button
                className="modal-close"
                aria-label="关闭"
                disabled={liveCancelBusy}
                onClick={() => setLiveCancelOrderTarget(null)}
              >
                ×
              </button>
              <h2 id="live-cancel-order-title">确认撤销实盘限价单</h2>
              <p>
                {liveCancelOrderTarget.symbol} ·{" "}
                {liveCancelOrderTarget.clientOrderId}
              </p>
              <div className="live-close-summary-table">
                <span>账户</span>
                <b>{liveCancelOrderTarget.accountId}</b>
                <span>方向</span>
                <b>
                  {liveCancelOrderTarget.positionSide === "LONG"
                    ? "买入做多"
                    : "卖出做空"}
                </b>
                <span>数量</span>
                <b>{formatCompactDecimal(liveCancelOrderTarget.quantity, 8, "--")}</b>
                <span>限价</span>
                <b>{formatCompactDecimal(liveCancelOrderTarget.referencePrice, 8, "--")}</b>
              </div>
              <p className="inline-hint">
                确认后立即向 Binance 撤单，并清除系统待执行引用；订单历史与审计记录继续保留。
              </p>
              <div className="modal-actions">
                <button
                  disabled={liveCancelBusy}
                  onClick={() => setLiveCancelOrderTarget(null)}
                >
                  取消
                </button>
                <button
                  className="danger-btn"
                  disabled={liveCancelBusy}
                  onClick={() => void cancelLivePendingOrder()}
                >
                  {liveCancelBusy ? "撤单中…" : "确认撤单"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  
}

