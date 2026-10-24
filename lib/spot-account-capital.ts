export type SpotAccountBalance = {
  asset?: string;
  free?: string | number;
  locked?: string | number;
};

export type SpotAccountSnapshot = {
  accountType?: string | null;
  permissions?: string[] | null;
  balances?: SpotAccountBalance[] | null;
};

/**
 * Binance has returned Spot accounts with either accountType="SPOT" or a
 * permissions array containing SPOT. Treat both forms as authoritative and
 * use free USDT only for a new challenge's available capital. Locked USDT is
 * already reserved by Binance and cannot fund a new challenge.
 */
export function readSpotAvailableUsdt(account: SpotAccountSnapshot) {
  const accountType = String(account.accountType || "").toUpperCase();
  const permissions = new Set((account.permissions || []).map((permission) => String(permission).toUpperCase()));
  const isSpot = accountType === "SPOT" || permissions.has("SPOT");
  const usdt = (account.balances || []).find((balance) => String(balance.asset || "").toUpperCase() === "USDT");
  const free = Number(usdt?.free);
  return {
    isSpot,
    availableUsdt: Number.isFinite(free) && free > 0 ? free : 0,
  };
}
