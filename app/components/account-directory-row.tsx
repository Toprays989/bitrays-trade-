"use client";

import {
  credentialVerifiedRecently,
  type ExchangeCredential,
  type TradingAccount,
} from "../client/workspace-model";
import { accountFundingSnapshot } from "../../lib/account-funding-snapshot";

type AccountDirectoryRowProps = {
  account: TradingAccount;
  credential?: ExchangeCredential;
  canManageAccount: boolean;
  canManageExchange: boolean;
  credentialBusy: boolean;
  accountBusy: boolean;
  onChange: (account: TradingAccount) => void;
  onConfigureCredential: (accountId: string, promptForSave: boolean) => void;
  onVerifyCredential: (credential: ExchangeCredential) => void;
  onToggleLive: (credential: ExchangeCredential) => void;
  onChangePositionMode: (credential: ExchangeCredential) => void;
  onSave: (account: TradingAccount) => void;
  onToggleAvailability: (account: TradingAccount) => void;
  onDelete: (account: TradingAccount) => void;
};

function credentialStatus(credential?: ExchangeCredential) {
  if (!credential) return "未配置";
  if (credentialVerifiedRecently(credential)) {
    return `已校验 · ${credential.positionMode === "HEDGE" ? "双向" : "单向"} · ${credential.liveTradingEnabled ? "实盘授权已启用" : "实盘授权未启用"}`;
  }
  if (credential.connectionStatus === "FAILED") return "校验失败";
  if (credential.connectionStatus === "VERIFIED") return "校验已过期";
  return "待校验";
}

function formatBalance(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

export function AccountDirectoryRow({
  account,
  credential,
  canManageAccount,
  canManageExchange,
  credentialBusy,
  accountBusy,
  onChange,
  onConfigureCredential,
  onVerifyCredential,
  onToggleLive,
  onChangePositionMode,
  onSave,
  onToggleAvailability,
  onDelete,
}: AccountDirectoryRowProps) {
  const funding = credential ? accountFundingSnapshot(credential) : null;
  const hasLiveBalance = Boolean(funding?.complete);
  const isMainAccount = account.accountType === "MAIN";

  return (
    <tr className={isMainAccount ? "main-account-row" : ""}>
      <td>
        <b>{account.name}</b>
        <small className="mono">{account.accountId}</small>
        <span className={`source-tag ${isMainAccount ? "protect" : "auto"}`}>
          {isMainAccount ? "主账户 · 禁止下单" : "交易子账户"}
        </span>
      </td>
      <td>
        Binance<small>{credential?.exchange === "BINANCE_SPOT" ? "现货 Spot" : "USDⓈ-M 合约"}</small>
      </td>
      <td>
        <input
          className="account-name-input"
          value={account.operatorName || "管理员"}
          disabled={!canManageAccount}
          onChange={(event) =>
            onChange({ ...account, operatorName: event.target.value })
          }
        />
      </td>
      <td>
        <span
          className={`source-tag ${account.isActive ? "auto" : "danger-source"}`}
        >
          {account.isActive ? "已启用" : "已停用"}
        </span>
        <small>{account.isActive ? "账户可用状态" : "账户不可用"}</small>
        {!isMainAccount && (
          <button
            type="button"
            className="text-action"
            disabled={!canManageAccount || accountBusy}
            onClick={() => onToggleAvailability(account)}
          >
            {account.isActive ? "停用账户" : "启用账户"}
          </button>
        )}
      </td>
      <td>
        {hasLiveBalance
          ? `权益 ${formatBalance(funding!.marginEquityUsdt!)} USDT`
          : "--"}
        <small>
          {hasLiveBalance
            ? credential?.exchange === "BINANCE_SPOT"
              ? `总资产 ${formatBalance(funding!.walletBalanceUsdt!)}（含非 USDT） · 可用 USDT ${formatBalance(funding!.availableToOpenUsdt!)}${funding!.fresh ? "" : " · 数据过期"}`
              : `钱包 ${formatBalance(funding!.walletBalanceUsdt!)} · 可再开仓 ${formatBalance(funding!.availableToOpenUsdt!)} USDT${funding!.fresh ? "" : " · 数据过期"}`
            : credential
              ? "请校验密钥以同步 Binance 合约余额"
              : "配置并校验密钥后显示实盘余额"}
        </small>
        {hasLiveBalance ? <small>
          未实现 {formatBalance(funding!.unrealizedPnlUsdt!)} · 持仓占用 {formatBalance(funding!.positionInitialMarginUsdt!)} · 挂单占用 {formatBalance(funding!.openOrderInitialMarginUsdt!)}
        </small> : null}
      </td>
      <td>
        {credential ? (
          <>
            <span className="mono">{credential.apiKeyMask}</span>
            <small>{credentialStatus(credential)}</small>
          </>
        ) : (
          <span className="muted">未配置</span>
        )}
      </td>
      <td>
        {isMainAccount ? (
          <span className="source-tag protect">不下单</span>
        ) : (
          <div className="account-live-control">
            <span
              className={`source-tag ${
                credential?.liveTradingEnabled ? "auto" : "protect"
              }`}
            >
              {credential?.liveTradingEnabled
                ? "实盘交易已授权"
                : credentialVerifiedRecently(credential)
                  ? "已校验 · 待启用授权"
                  : "待完成实盘校验"}
            </span>
            <small>策略运行由页面人工控制</small>
          </div>
        )}
      </td>
      <td>
        <input
          className="account-name-input"
          value={account.note ?? ""}
          placeholder="填写备注"
          disabled={!canManageAccount}
          onChange={(event) => onChange({ ...account, note: event.target.value })}
        />
      </td>
      <td>
        <div className="member-actions">
          <button
            className="text-action"
            disabled={!canManageExchange}
            onClick={() => onConfigureCredential(account.accountId, false)}
          >
            配置密钥
          </button>
          <button
            className="text-action"
            disabled={credentialBusy || !canManageExchange}
            onClick={() => {
              if (credential) onVerifyCredential(credential);
              else onConfigureCredential(account.accountId, true);
            }}
          >
            {credentialBusy ? "校验中…" : "校验密钥"}
          </button>
          {credential && !isMainAccount && (
            <button
              className="text-action"
              disabled={
                credentialBusy ||
                !canManageExchange ||
                !credentialVerifiedRecently(credential)
              }
              onClick={() => onToggleLive(credential)}
            >
              {credential.liveTradingEnabled ? "关闭实盘授权" : "启用实盘授权"}
            </button>
          )}
          {credential && (
            <button
              className="text-action"
              disabled={credentialBusy || !canManageExchange}
              onClick={() => onChangePositionMode(credential)}
            >
              切换为{credential.positionMode === "HEDGE" ? "单向" : "双向"}
            </button>
          )}
          <button
            className="text-action"
            disabled={accountBusy}
            onClick={() => onSave(account)}
          >
            保存
          </button>
          {account.accountId !== "bys-main" && (
            <button
              className="text-action danger-text"
              disabled={accountBusy}
              onClick={() => onDelete(account)}
            >
              删除
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
