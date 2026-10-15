import {
  liveReductionAccounting,
  type ExchangeCredential,
  type LivePosition,
  type LivePositionReduction,
  type TradingAccount,
} from "./workspace-model.ts";
import { accountFundingSnapshot } from "../../lib/account-funding-snapshot.ts";

export type PositionLedgerStatusRow = {
  id: string;
  accountId: string;
  symbol: string | null;
  category: "BALANCE" | "EXECUTION" | "ACCOUNTING";
  severity: "ERROR" | "WARNING";
  message: string;
  updatedAt: string | number | null;
};

export function buildPositionLedgerStatusRows(
  accounts: TradingAccount[],
  credentials: ExchangeCredential[],
  positions: LivePosition[],
  reductions: LivePositionReduction[],
  nowMs = Date.now(),
): PositionLedgerStatusRow[] {
  const rows: PositionLedgerStatusRow[] = [];
  const latestCredentialByAccount = new Map<string, ExchangeCredential>();

  for (const credential of credentials) {
    const current = latestCredentialByAccount.get(credential.accountId);
    if (
      !current ||
      timestamp(credential.balanceSyncedAt) >=
        timestamp(current.balanceSyncedAt)
    ) {
      latestCredentialByAccount.set(credential.accountId, credential);
    }
  }

  for (const account of accounts) {
    const credential = latestCredentialByAccount.get(account.accountId);
    const funding = credential ? accountFundingSnapshot(credential, nowMs) : null;
    if (!funding?.fresh) {
      rows.push({
        id: `balance:${account.accountId}`,
        accountId: account.accountId,
        symbol: null,
        category: "BALANCE",
        severity:
          credential?.connectionStatus === "FAILED" ? "ERROR" : "WARNING",
        message:
          credential?.lastError ||
          funding?.status === "STALE"
            ? "Binance 账户资金快照已过期，当前数值不参与实时资金汇总"
            : "Binance 账户资金尚未完整同步，汇总数据仅包含已核对账户",
        updatedAt: credential?.updatedAt ?? account.updatedAt,
      });
    }
  }

  for (const position of positions) {
    if (
      position.status !== "ERROR" &&
      position.status !== "EXECUTION_UNKNOWN" &&
      !position.lastError
    ) {
      continue;
    }
    rows.push({
      id: `position:${position.id}`,
      accountId: position.accountId,
      symbol: position.symbol,
      category: "EXECUTION",
      severity:
        position.status === "ERROR" ||
        position.status === "EXECUTION_UNKNOWN"
          ? "ERROR"
          : "WARNING",
      message: position.lastError ?? "仓位执行状态等待交易所核对",
      updatedAt: position.updatedAt,
    });
  }

  const pendingAccountingByPosition = new Map<
    number,
    LivePositionReduction
  >();
  for (const reduction of reductions) {
    if (!liveReductionAccounting(reduction).exactNetAvailable) {
      const current = pendingAccountingByPosition.get(reduction.positionId);
      if (
        !current ||
        timestamp(reduction.createdAt) >= timestamp(current.createdAt)
      ) {
        pendingAccountingByPosition.set(reduction.positionId, reduction);
      }
    }
  }
  for (const reduction of pendingAccountingByPosition.values()) {
    rows.push({
      id: `accounting:${reduction.positionId}`,
      accountId: reduction.accountId,
      symbol: reduction.symbol,
      category: "ACCOUNTING",
      severity: "WARNING",
      message: "成交费用尚未完整核对，当前收益暂按毛盈亏展示",
      updatedAt: reduction.createdAt,
    });
  }

  return rows.sort(
    (left, right) =>
      Number(right.severity === "ERROR") -
        Number(left.severity === "ERROR") ||
      timestamp(right.updatedAt) - timestamp(left.updatedAt),
  );
}

function timestamp(value: string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const parsed =
    typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
