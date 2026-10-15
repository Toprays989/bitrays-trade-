export const PRIVATE_POSITION_RISK_TTL_MS = 750;
export const PRIVATE_ACCOUNT_TTL_MS = 2_000;
export const PRIVATE_ORDER_QUERY_TTL_MS = 2_000;

export function privateStateCacheTtl(method, pathname, hasApiKey) {
  if (method !== "GET" || !hasApiKey) return 0;
  if (pathname === "/fapi/v3/positionRisk")
    return PRIVATE_POSITION_RISK_TTL_MS;
  if (pathname === "/fapi/v3/account") return PRIVATE_ACCOUNT_TTL_MS;
  if (pathname === "/fapi/v1/order") return PRIVATE_ORDER_QUERY_TTL_MS;
  return 0;
}

export function privateStateCacheKey(input) {
  const symbol = String(input.searchParams.get("symbol") || "")
    .trim()
    .toUpperCase();
  const orderIdentity = input.pathname === "/fapi/v1/order"
    ? String(
        input.searchParams.get("origClientOrderId") ||
          input.searchParams.get("orderId") ||
          "",
      ).trim()
    : "";
  return [
    "private",
    input.environment,
    input.apiKeyScope,
    String(input.epoch || 0),
    input.pathname,
    symbol,
    orderIdentity,
  ].join(":");
}

export function mutatesPrivateAccountState(method, pathname) {
  if (!["POST", "DELETE"].includes(method)) return false;
  return [
    "/fapi/v1/order",
    "/fapi/v1/leverage",
    "/fapi/v1/positionSide/dual",
  ].includes(pathname);
}
