"use client";

/* eslint-disable react-hooks/exhaustive-deps -- Session verification is intentionally registered once; current callbacks are read when session state changes. */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  broadcastApplicationLogout,
  clearStoredWorkspace,
  readJsonResponse,
} from "../client/runtime";

export function SecurityGate({
  children,
  setToast,
  onAuthenticated,
}: {
  children: ReactNode;
  setToast: (text: string) => void;
  onAuthenticated?: () => void;
}) {
  const [status, setStatus] = useState("LOADING");
  const [loginEmail, setLoginEmail] = useState("");
  const [requiresEmail, setRequiresEmail] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [sessionClock, setSessionClock] = useState(() => Date.now());
  const expiryWarningSent = useRef(false);
  const statusRef = useRef(status);

  const applyStatus = (nextStatus: string) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  };

  useEffect(() => {
    const verifySession = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/auth/status", { cache: "no-store" });
        const result = (await readJsonResponse(response)) as {
          status?: string;
          expiresAt?: string | number;
          requiresEmail?: boolean;
        };
        const nextStatus = result.status ?? "LOGIN_REQUIRED";
        setRequiresEmail(Boolean(result.requiresEmail));
        setSessionExpiresAt(
          nextStatus === "AUTHENTICATED" && result.expiresAt
            ? new Date(result.expiresAt).getTime()
            : null,
        );
        const currentStatus = statusRef.current;
        if (
          currentStatus === "AUTHENTICATED" &&
          nextStatus !== "AUTHENTICATED"
        ) {
          clearStoredWorkspace();
          broadcastApplicationLogout();
          setToast("应用会话已失效，请重新登录");
        } else if (
          currentStatus !== "AUTHENTICATED" &&
          nextStatus === "AUTHENTICATED"
        )
          onAuthenticated?.();
        applyStatus(nextStatus);
      } catch {
        if (statusRef.current === "LOADING") applyStatus("LOGIN_REQUIRED");
      }
    };
    void verifySession();
    const resumeVerification = () => {
      if (document.visibilityState === "visible") void verifySession();
    };
    document.addEventListener("visibilitychange", resumeVerification);
    window.addEventListener("focus", resumeVerification);
    return () => {
      document.removeEventListener("visibilitychange", resumeVerification);
      window.removeEventListener("focus", resumeVerification);
    };
  }, []);

  useEffect(() => {
    if (status !== "AUTHENTICATED" || sessionExpiresAt === null) return;
    const tickSessionClock = () => {
      const now = Date.now();
      setSessionClock(now);
      const remaining = sessionExpiresAt - now;
      if (remaining <= 0) {
        clearStoredWorkspace();
        broadcastApplicationLogout();
        setSessionExpiresAt(null);
        applyStatus("LOGIN_REQUIRED");
        setToast("应用会话已到期，请重新登录");
      } else if (remaining <= 10 * 60_000 && !expiryWarningSent.current) {
        expiryWarningSent.current = true;
        setToast("应用会话将在 10 分钟内到期，请完成当前操作后重新登录");
      } else if (remaining > 10 * 60_000) expiryWarningSent.current = false;
    };
    tickSessionClock();
    const timer = window.setInterval(tickSessionClock, 30_000);
    return () => window.clearInterval(timer);
  }, [status, sessionExpiresAt]);

  async function login() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: requiresEmail ? loginEmail : undefined,
          password: loginPassword,
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        status?: string;
        expiresAt?: string | number;
      };
      if (!response.ok) throw new Error(result.error ?? "登录失败");
      setLoginPassword("");
      setSessionExpiresAt(
        result.expiresAt ? new Date(result.expiresAt).getTime() : null,
      );
      applyStatus(result.status ?? "AUTHENTICATED");
      onAuthenticated?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      setError(message);
      setToast(message);
    } finally {
      setBusy(false);
    }
  }

  async function setInitialPassword() {
    if (
      newPassword.length < 12 ||
      newPassword.length > 128 ||
      confirmNewPassword !== newPassword
    ) {
      setError("请确认新密码为 12 至 128 位且两次输入一致");
      return;
    }
    if (currentPassword && currentPassword === newPassword) {
      setError("新密码不能与当前临时密码相同");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: requiresEmail ? loginEmail : undefined,
          currentPassword,
          newPassword,
        }),
      });
      const result = (await readJsonResponse(response)) as {
        error?: string;
        expiresAt?: string | number;
      };
      if (!response.ok) throw new Error(result.error ?? "密码设置失败");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setSessionExpiresAt(
        result.expiresAt ? new Date(result.expiresAt).getTime() : null,
      );
      applyStatus("AUTHENTICATED");
      onAuthenticated?.();
      setToast("密码已安全设置");
    } catch (error) {
      const message = error instanceof Error ? error.message : "密码设置失败";
      setError(message);
      setToast(message);
    } finally {
      setBusy(false);
    }
  }

  async function restartApplicationSession() {
    await fetch("/api/auth/logout", { method: "POST" });
    clearStoredWorkspace();
    broadcastApplicationLogout();
    setSessionExpiresAt(null);
    applyStatus("LOGIN_REQUIRED");
    setToast("原会话已安全退出，请重新输入应用密码");
  }

  function trackCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLockOn(event.getModifierState("CapsLock"));
  }

  const sessionMinutesRemaining =
    sessionExpiresAt === null
      ? null
      : Math.max(0, Math.ceil((sessionExpiresAt - sessionClock) / 60_000));
  if (status === "AUTHENTICATED")
    return (
      <>
        {children}
        {sessionMinutesRemaining !== null && sessionMinutesRemaining <= 10 && (
          <section
            className="session-expiry-banner"
            role="alert"
            aria-live="assertive"
          >
            <span aria-hidden="true">◷</span>
            <div>
              <b>应用会话即将到期</b>
              <p>
                剩余约 {sessionMinutesRemaining}{" "}
                分钟；不会自动延长，请完成当前操作后重新登录。
              </p>
            </div>
            <button onClick={() => void restartApplicationSession()}>
              现在重新登录
            </button>
          </section>
        )}
      </>
    );

  const needsChange = [
    "CHANGE_REQUIRED",
    "PASSWORD_NOT_SET",
    "BOOTSTRAP_ADMIN",
  ].includes(status);
  const blocked = [
    "ACCOUNT_NOT_PROVISIONED",
    "ACCOUNT_DISABLED",
    "PLATFORM_LOGIN_REQUIRED",
  ].includes(status);
  return (
    <main className="app dark auth-shell">
      <section className="panel auth-gate">
        <span className="auth-mark">NQ</span>
        <h2>
          {blocked
            ? "账号暂不可用"
            : needsChange
              ? status === "BOOTSTRAP_ADMIN" || status === "PASSWORD_NOT_SET"
                ? "设置管理员密码"
                : "首次登录修改密码"
              : status === "LOADING"
                ? "正在验证身份"
                : "应用安全验证"}
        </h2>
        <p>
          {blocked
            ? status === "ACCOUNT_NOT_PROVISIONED"
              ? "该 Workspace 身份尚未由管理员添加到交易系统。"
              : "请联系管理员确认站点访问权限。"
            : needsChange
              ? "密码至少 12 个字符；设置后将启用独立安全会话。"
              : "请输入管理员分配的应用密码。"}
        </p>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        {!blocked &&
          status !== "LOADING" &&
          (needsChange ? (
            <div className="auth-fields">
              {requiresEmail && (
                <label>
                  <span className="sr-only">登录邮箱</span>
                  <input
                    type="email"
                    value={loginEmail}
                    onChange={(event) =>
                      setLoginEmail(event.target.value.trim())
                    }
                    placeholder="登录邮箱"
                    autoComplete="username"
                  />
                </label>
              )}
              {status === "CHANGE_REQUIRED" && (
                <label className="auth-password-field">
                  <span className="sr-only">当前临时密码</span>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    onKeyUp={trackCapsLock}
                    onBlur={() => setCapsLockOn(false)}
                    placeholder="当前临时密码"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? "隐藏" : "显示"}
                  </button>
                </label>
              )}
              <label className="auth-password-field">
                <span className="sr-only">新密码</span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  onKeyUp={trackCapsLock}
                  onBlur={() => setCapsLockOn(false)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      newPassword.length >= 12 &&
                      confirmNewPassword === newPassword
                    )
                      void setInitialPassword();
                  }}
                  placeholder="新密码（至少 12 位）"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? "隐藏" : "显示"}
                </button>
              </label>
              <label className="auth-password-field">
                <span className="sr-only">确认新密码</span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={confirmNewPassword}
                  onChange={(event) =>
                    setConfirmNewPassword(event.target.value)
                  }
                  onKeyUp={trackCapsLock}
                  onBlur={() => setCapsLockOn(false)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      newPassword.length >= 12 &&
                      confirmNewPassword === newPassword
                    )
                      void setInitialPassword();
                  }}
                  placeholder="再次输入新密码"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  aria-label={showPassword ? "隐藏确认密码" : "显示确认密码"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? "隐藏" : "显示"}
                </button>
              </label>
              <div
                className={`password-requirement ${newPassword.length >= 12 ? "met" : ""}`}
                role="status"
              >
                <span>{newPassword.length >= 12 ? "✓" : "○"}</span>至少 12
                个字符 · 当前 {newPassword.length} 个
              </div>
              <div
                className={`password-requirement ${confirmNewPassword.length > 0 && confirmNewPassword === newPassword ? "met" : confirmNewPassword.length > 0 ? "mismatch" : ""}`}
                role="status"
              >
                <span>
                  {confirmNewPassword.length > 0 &&
                  confirmNewPassword === newPassword
                    ? "✓"
                    : "○"}
                </span>
                {confirmNewPassword.length === 0
                  ? "请再次输入新密码"
                  : confirmNewPassword === newPassword
                    ? "两次输入一致"
                    : "两次输入不一致"}
              </div>
              {capsLockOn && (
                <div className="caps-lock-warning" role="alert">
                  大写锁定已开启，请确认密码大小写
                </div>
              )}
              <button
                className="primary-btn"
                disabled={
                  busy ||
                  (requiresEmail && !loginEmail) ||
                  newPassword.length < 12 ||
                  confirmNewPassword !== newPassword
                }
                onClick={() => void setInitialPassword()}
              >
                {busy ? "处理中…" : "设置密码并进入系统"}
              </button>
            </div>
          ) : (
            <div className="auth-fields">
              {requiresEmail && (
                <label>
                  <span className="sr-only">登录邮箱</span>
                  <input
                    type="email"
                    value={loginEmail}
                    onChange={(event) =>
                      setLoginEmail(event.target.value.trim())
                    }
                    placeholder="登录邮箱"
                    autoComplete="username"
                  />
                </label>
              )}
              <label className="auth-password-field">
                <span className="sr-only">应用密码</span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  onKeyUp={trackCapsLock}
                  onBlur={() => setCapsLockOn(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void login();
                  }}
                  placeholder="应用密码"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? "隐藏" : "显示"}
                </button>
              </label>
              {capsLockOn && (
                <div className="caps-lock-warning" role="alert">
                  大写锁定已开启，请确认密码大小写
                </div>
              )}
              <button
                className="primary-btn"
                disabled={
                  busy || (requiresEmail && !loginEmail) || !loginPassword
                }
                onClick={() => void login()}
              >
                {busy ? "验证中…" : "安全登录"}
              </button>
            </div>
          ))}
        <small>平台身份校验 + 应用密码双层保护</small>
      </section>
    </main>
  );
}
