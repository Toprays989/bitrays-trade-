import { liveOrderIsWorking } from "./live-order-status.ts";

type ExposureRow = {
  ownerEmail: string;
  accountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
};

type OrderExposureRow = ExposureRow & { status: string };

export function sentinelDuplicateExposure(input: {
  ownerEmail: string;
  sentinelAccountId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  positions: ExposureRow[];
  orders: OrderExposureRow[];
}) {
  const owner = input.ownerEmail.trim().toLowerCase();
  const symbol = input.symbol.trim().toUpperCase();
  const matches = (row: ExposureRow) =>
    row.ownerEmail.trim().toLowerCase() === owner &&
    row.accountId !== input.sentinelAccountId &&
    row.symbol.trim().toUpperCase() === symbol &&
    row.positionSide === input.positionSide;
  const positionAccounts = input.positions.filter(matches).map((row) => row.accountId);
  const workingOrderAccounts = input.orders
    .filter((row) => matches(row) && liveOrderIsWorking(row.status))
    .map((row) => row.accountId);
  const duplicateAccountIds = [
    ...new Set([...positionAccounts, ...workingOrderAccounts]),
  ].sort();
  return {
    version: 1,
    advisoryOnly: true,
    duplicate: duplicateAccountIds.length > 0,
    symbol,
    positionSide: input.positionSide,
    sentinelAccountId: input.sentinelAccountId,
    duplicateAccountIds,
    positionAccountCount: new Set(positionAccounts).size,
    workingOrderAccountCount: new Set(workingOrderAccounts).size,
    message: duplicateAccountIds.length
      ? `${duplicateAccountIds.join("、")} 已有同合约同方向仓位或挂单；哨兵仅提示，不自动干预`
      : "其他子账户暂无同合约同方向仓位或挂单",
  };
}
