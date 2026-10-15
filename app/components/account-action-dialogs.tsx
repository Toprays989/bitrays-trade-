"use client";

import type { TradingAccount } from "../client/workspace-model";

type AccountDeleteDialogProps = {
  target: TradingAccount | null;
  confirmation: string;
  busy: boolean;
  onConfirmationChange: (confirmation: string) => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function AccountDeleteDialog({
  target,
  confirmation,
  busy,
  onConfirmationChange,
  onClose,
  onConfirm,
}: AccountDeleteDialogProps) {
  if (!target) return null;
  const expectedConfirmation = `DELETE ACCOUNT ${target.accountId}`;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-account-title"
    >
      <div className="modal">
        <span className="modal-icon">!</span>
        <h2 id="delete-account-title">确认删除子账户？</h2>
        <p>
          将删除 <b>{target.name}</b>（{target.accountId}
          ）及其尚未使用的密钥。已有任何交易或策略历史的账户会被服务端拒绝删除。
        </p>
        <label className="field">
          <span>
            请输入 <b className="mono">{expectedConfirmation}</b>
          </span>
          <input
            className="modal-confirm-input"
            value={confirmation}
            onChange={(event) => onConfirmationChange(event.target.value)}
            autoFocus
          />
        </label>
        <div>
          <button onClick={onClose}>取消</button>
          <button
            className="danger-btn"
            disabled={busy || confirmation !== expectedConfirmation}
            onClick={onConfirm}
          >
            {busy ? "删除中…" : "确认删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

type AccountDisableDialogProps = {
  target: TradingAccount | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function AccountDisableDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: AccountDisableDialogProps) {
  if (!target) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disable-account-title"
    >
      <div className="modal">
        <span className="modal-icon">!</span>
        <h2 id="disable-account-title">确认停用交易子账户？</h2>
        <p>
          {target.name}（{target.accountId}）停用后，将自动暂停{" "}
          {target.stats.runningStrategies} 个运行策略并撤销{" "}
          {target.stats.pendingOrders}{" "}
          笔等待订单。已有仓位不会被强制平仓，仍可修改止盈止损并继续接受风控巡检。
        </p>
        <div>
          <button onClick={onClose}>取消</button>
          <button
            className="danger-btn"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "停用中…" : "确认停用"}
          </button>
        </div>
      </div>
    </div>
  );
}

type AccountPauseDialogProps = {
  target: TradingAccount | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function AccountPauseDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: AccountPauseDialogProps) {
  if (!target) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pause-account-title"
    >
      <div className="modal">
        <span className="modal-icon">!</span>
        <h2 id="pause-account-title">确认安全暂停账户自动化？</h2>
        <p>
          {target.name} 将暂停 {target.stats.runningStrategies} 个运行策略并撤销{" "}
          {target.stats.pendingOrders} 笔等待订单。账户仍保持启用，已有{" "}
          {target.stats.openPositions} 个仓位继续接受止盈止损和风控管理。
        </p>
        <div>
          <button onClick={onClose}>取消</button>
          <button
            className="danger-btn"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "暂停中…" : "确认安全暂停"}
          </button>
        </div>
      </div>
    </div>
  );
}
