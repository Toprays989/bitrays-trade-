"use client";

export type TradingAccountForm = {
  accountId: string;
  name: string;
  accountType: "MAIN" | "STRATEGY";
  operatorName: string;
  note: string;
  apiKey: string;
  secretKey: string;
};

type AddTradingAccountDialogProps = {
  open: boolean;
  form: TradingAccountForm;
  error: string;
  busy: boolean;
  onChange: (form: TradingAccountForm) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function AddTradingAccountDialog({
  open,
  form,
  error,
  busy,
  onChange,
  onClose,
  onSubmit,
}: AddTradingAccountDialogProps) {
  if (!open) return null;

  const update = <K extends keyof TradingAccountForm>(
    key: K,
    value: TradingAccountForm[K],
  ) => onChange({ ...form, [key]: value });
  const hasCompleteCredential = Boolean(form.apiKey) === Boolean(form.secretKey);
  const canSubmit =
    Boolean(form.accountId) && form.name.length >= 2 && hasCompleteCredential;

  return (
    <div
      className="modal-backdrop add-account-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-account-title"
    >
      <div className="modal strategy-config-modal add-account-modal">
        <div className="config-title add-account-title">
          <div>
            <h2 id="add-account-title">新增账户</h2>
            <p>先配置账户基础信息，再按需录入该账户的 Binance AppKey</p>
          </div>
          <button aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <section className="add-account-basic">
          <div className="add-account-grid">
            <label>
              <span>
                <i>*</i> 账户ID
              </span>
              <input
                value={form.accountId}
                onChange={(event) =>
                  update("accountId", event.target.value.toLowerCase())
                }
                placeholder="例如 bys03"
              />
            </label>
            <label>
              <span>
                <i>*</i> 账户名称
              </span>
              <input
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder="例如 币安交易账户 bys03"
              />
            </label>
            <label>
              <span>
                <i>*</i> 交易所
              </span>
              <select disabled>
                <option>Binance</option>
              </select>
            </label>
            <label>
              <span>
                <i>*</i> 账户类型
              </span>
              <select
                value={form.accountType}
                onChange={(event) =>
                  update(
                    "accountType",
                    event.target.value as TradingAccountForm["accountType"],
                  )
                }
              >
                <option value="MAIN">主账户（只配置，不下单）</option>
                <option value="STRATEGY">子账户（用于交易）</option>
              </select>
            </label>
            <label>
              <span>
                <i>*</i> 运营账号
              </span>
              <input
                value={form.operatorName}
                onChange={(event) =>
                  update("operatorName", event.target.value)
                }
                placeholder="管理员（op-admin）"
              />
            </label>
            <label>
              <span>账户状态</span>
              <div className="segmented add-account-status">
                <button type="button" className="selected">
                  启用
                </button>
                <button type="button" disabled>
                  停用
                </button>
              </div>
            </label>
            <label className="add-account-note">
              <span>备注</span>
              <input
                maxLength={80}
                value={form.note}
                onChange={(event) => update("note", event.target.value)}
                placeholder="请输入备注"
              />
              <small>{form.note.length} / 80</small>
            </label>
          </div>
        </section>

        <div className="add-account-divider">
          <div>
            <b>AppKey 明细</b>
            <small>每个账户当前绑定一组密钥；可稍后在账户列表中配置或更换</small>
          </div>
          <span>1 / 1</span>
        </div>
        <div className="appkey-toolbar">
          <label>
            <span>AppKey 前缀</span>
            <input value={form.accountId || "bys03"} readOnly />
          </label>
          <div className="appkey-count">
            <span>数量</span>
            <button type="button" disabled>
              −
            </button>
            <b>1</b>
            <button type="button" disabled>
              ＋
            </button>
          </div>
          <button
            type="button"
            className="appkey-add-btn"
            onClick={() => onChange({ ...form, apiKey: "", secretKey: "" })}
          >
            ＋ 新增 AppKey
          </button>
          <span className="appkey-total">共 1 条</span>
        </div>
        <div className="appkey-table-wrap">
          <table className="appkey-table">
            <thead>
              <tr>
                <th>AppKey ID</th>
                <th>显示名称</th>
                <th>模式</th>
                <th>环境</th>
                <th>API Key</th>
                <th>API Secret</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">{form.accountId || "bys03"}-01</td>
                <td>{form.name ? `${form.name} AppKey` : "bys03-01"}</td>
                <td>
                  <span className="source-tag protect">合约</span>
                </td>
                <td>
                  <span className="source-tag auto">正式</span>
                </td>
                <td>
                  <input
                    aria-label="API Key"
                    type="password"
                    autoComplete="off"
                    value={form.apiKey}
                    onChange={(event) =>
                      update("apiKey", event.target.value.trim())
                    }
                    placeholder="请输入 API Key"
                  />
                </td>
                <td>
                  <input
                    aria-label="API Secret"
                    type="password"
                    autoComplete="new-password"
                    value={form.secretKey}
                    onChange={(event) =>
                      update("secretKey", event.target.value.trim())
                    }
                    placeholder="请输入 API Secret"
                  />
                </td>
                <td>
                  <span
                    className={
                      form.apiKey && form.secretKey
                        ? "source-tag auto"
                        : "source-tag protect"
                    }
                  >
                    {form.apiKey && form.secretKey ? "待校验" : "未配置"}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="text-action danger-text"
                    onClick={() =>
                      onChange({ ...form, apiKey: "", secretKey: "" })
                    }
                    disabled={!form.apiKey && !form.secretKey}
                  >
                    删除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="config-safety">
          <b>账户边界</b>
          <span>
            {form.accountType === "MAIN"
              ? "主账户只用于独立配置与资产查看，系统禁止它进入人工或自动下单流程。"
              : "子账户完成密钥校验后可启用实盘；资金、杠杆、交易币种和风控参数全部由人工下单或各自动策略独立控制。"}
          </span>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="config-actions add-account-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary-btn"
            disabled={busy || !canSubmit}
            onClick={onSubmit}
          >
            {busy ? "创建中…" : "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
