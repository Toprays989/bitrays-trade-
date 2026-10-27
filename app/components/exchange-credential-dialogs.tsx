"use client";

import type {
  ExchangeCredential,
  TradingAccount,
} from "../client/workspace-model";

export type ExchangeCredentialForm = {
  accountId: string;
  exchange: "BINANCE_USDM" | "BINANCE_SPOT";
  label: string;
  apiKey: string;
  secretKey: string;
};

type CredentialEditorDialogProps = {
  open: boolean;
  form: ExchangeCredentialForm;
  accounts: TradingAccount[];
  saving: boolean;
  onChange: (form: ExchangeCredentialForm) => void;
  onClose: () => void;
  onSave: () => void;
};

export function CredentialEditorDialog({
  open,
  form,
  accounts,
  saving,
  onChange,
  onClose,
  onSave,
}: CredentialEditorDialogProps) {
  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-modal-title"
    >
      <div className="modal strategy-config-modal live-credential-modal">
        <div className="config-title">
          <div>
            <h2 id="credential-modal-title">配置 Binance 实盘密钥</h2>
            <p>
              保存后 API Key 只显示掩码，Secret
              永不回显；重新配置会自动关闭该账户实盘开关。
            </p>
          </div>
          <button aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="config-grid">
          <label>
            <span>绑定站内账户</span>
            <select
              value={form.accountId}
              onChange={(event) =>
                onChange({ ...form, accountId: event.target.value })
              }
            >
              {accounts
                .filter((item) => item.isActive)
                .map((item) => (
                  <option key={item.id} value={item.accountId}>
                    {item.accountType === "MAIN" ? "主账户" : "策略子账户"} ·{" "}
                    {item.name}（{item.accountId}）
                  </option>
                ))}
            </select>
            <small>一账户只能绑定一组密钥，重新保存将替换旧密钥。</small>
          </label>
          <label>
            <span>密钥备注</span>
            <input
              value={form.label}
              maxLength={40}
              onChange={(event) =>
                onChange({ ...form, label: event.target.value })
              }
            />
          </label>
          <label>
            <span>凭证类型</span>
            <select value={form.exchange} onChange={(event) => onChange({ ...form, exchange: event.target.value as ExchangeCredentialForm["exchange"] })}>
              <option value="BINANCE_USDM">Binance 合约 USDM</option>
              <option value="BINANCE_SPOT">Binance 现货 Spot</option>
            </select>
          </label>
          <label>
            <span>API Key</span>
            <input
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(event) =>
                onChange({ ...form, apiKey: event.target.value.trim() })
              }
            />
          </label>
          <label>
            <span>Secret Key</span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.secretKey}
              onChange={(event) =>
                onChange({ ...form, secretKey: event.target.value.trim() })
              }
            />
          </label>
        </div>
        <div className="config-safety">
          <b>提交前检查</b>
          <span>
            Binance 侧仅开启合约交易权限、关闭提现、配置服务器 IP
            白名单；这里不设置交易额度和杠杆，所有下单参数由人工委托或各策略独立配置。
          </span>
        </div>
        <div className="config-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary-btn"
            disabled={
              saving || !form.apiKey || !form.secretKey || !form.label
            }
            onClick={onSave}
          >
            {saving ? "加密保存中…" : "加密保存并关闭实盘"}
          </button>
        </div>
      </div>
    </div>
  );
}

type CredentialAction = {
  credential: ExchangeCredential;
  action: "ENABLE" | "DISABLE" | "DELETE" | "HEDGE" | "ONE_WAY";
};

type CredentialActionDialogProps = {
  target: CredentialAction | null;
  confirmation: string;
  busy: boolean;
  onConfirmationChange: (confirmation: string) => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function CredentialActionDialog({
  target,
  confirmation,
  busy,
  onConfirmationChange,
  onClose,
  onConfirm,
}: CredentialActionDialogProps) {
  if (!target) return null;

  const expectedConfirmation =
    target.action === "ENABLE"
      ? `ENABLE LIVE ${target.credential.accountId}`
      : target.action === "DISABLE"
        ? `DISABLE LIVE ${target.credential.accountId}`
      : target.action === "HEDGE"
        ? `HEDGE ${target.credential.accountId}`
        : target.action === "ONE_WAY"
          ? `ONE WAY ${target.credential.accountId}`
      : `DELETE ${target.credential.accountId}`;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-action-title"
    >
      <div className="modal">
        <span className="modal-icon">!</span>
        <h2 id="credential-action-title">
          {target.action === "ENABLE"
            ? "确认启用人工实盘？"
            : target.action === "DISABLE"
              ? "确认关闭账户实盘授权？"
            : target.action === "HEDGE"
              ? "确认切换为双向持仓？"
              : target.action === "ONE_WAY"
                ? "确认切换为单向持仓？"
            : "确认永久移除密钥？"}
        </h2>
        <p>
          {target.credential.accountId} · {target.credential.label}。请输入{" "}
          <b className="mono">{expectedConfirmation}</b> 确认。
        </p>
        <input
          className="modal-confirm-input"
          value={confirmation}
          onChange={(event) => onConfirmationChange(event.target.value)}
          autoFocus
        />
        <div>
          <button onClick={onClose}>取消</button>
          <button
            className="danger-btn"
            disabled={busy || confirmation !== expectedConfirmation}
            onClick={onConfirm}
          >
            {target.action === "ENABLE"
              ? "确认启用"
              : target.action === "DISABLE"
                ? "确认关闭"
              : target.action === "HEDGE"
                ? "切换为双向"
                : target.action === "ONE_WAY"
                  ? "切换为单向"
                  : "永久移除"}
          </button>
        </div>
      </div>
    </div>
  );
}
