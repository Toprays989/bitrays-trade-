export type ControlRole = "ADMIN" | "OPERATOR" | "VIEWER";
export type ControlDataScope = "ALL" | "OWN";
export type PermissionTag =
  | "trade:dashboard:view"
  | "trade:manual:create"
  | "trade:live_order:create"
  | "trade:order:cancel"
  | "trade:symbol_pool:view"
  | "trade:symbol_pool:edit"
  | "trade:strategy:edit"
  | "trade:automation:run"
  | "trade:reconcile:run"
  | "trade:position:close"
  | "trade:position:risk_edit"
  | "trade:position:risk_run"
  | "trade:position:close_all"
  | "trade:risk:rearm"
  | "trade:test_order:validate"
  | "sys:account:view"
  | "sys:account:validate"
  | "sys:account:manage"
  | "sys:exchange:manage"
  | "sys:access:view"
  | "sys:access:manage"
  | "sys:audit:view";

export const ROLE_PERMISSIONS: Record<ControlRole, PermissionTag[]> = {
  ADMIN: ["trade:dashboard:view", "trade:manual:create", "trade:live_order:create", "trade:order:cancel", "trade:symbol_pool:view", "trade:symbol_pool:edit", "trade:strategy:edit", "trade:automation:run", "trade:reconcile:run", "trade:position:close", "trade:position:risk_edit", "trade:position:risk_run", "trade:position:close_all", "trade:risk:rearm", "trade:test_order:validate", "sys:account:view", "sys:account:validate", "sys:account:manage", "sys:exchange:manage", "sys:access:view", "sys:access:manage", "sys:audit:view"],
  OPERATOR: ["trade:dashboard:view", "trade:manual:create", "trade:order:cancel", "trade:symbol_pool:view", "trade:symbol_pool:edit", "trade:strategy:edit", "trade:automation:run", "trade:reconcile:run", "trade:position:close", "trade:position:risk_edit", "trade:position:risk_run", "trade:test_order:validate", "sys:account:view", "sys:account:validate", "sys:access:view", "sys:audit:view"],
  VIEWER: ["trade:dashboard:view", "trade:symbol_pool:view", "sys:account:view", "sys:access:view", "sys:audit:view"],
};

export function resolveStoredAccess(input: {
  role: string;
  dataScope: string;
  permissionsJson: string | null;
}): {
  role: ControlRole;
  dataScope: ControlDataScope;
  permissions: PermissionTag[];
} {
  const roleIsKnown = input.role === "ADMIN" ||
    input.role === "OPERATOR" || input.role === "VIEWER";
  const role: ControlRole = roleIsKnown
    ? input.role
    : "VIEWER";
  const dataScope: ControlDataScope = role === "ADMIN"
    ? "ALL"
    : roleIsKnown && input.dataScope === "ALL"
    ? "ALL"
    : "OWN";
  let configured: unknown = null;
  try {
    configured = JSON.parse(input.permissionsJson || "null");
  } catch {
    configured = null;
  }
  const allowed = new Set<PermissionTag>(ROLE_PERMISSIONS[role]);
  const permissions = Array.isArray(configured)
    ? configured.filter((tag): tag is PermissionTag =>
      typeof tag === "string" && allowed.has(tag as PermissionTag))
    : [];
  return { role, dataScope, permissions };
}
