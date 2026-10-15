import { and, count, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { userAccess } from "../../../../../db/schema";
import { derivePassword, revokeSessions, validatePassword, verifyPassword } from "../../../../../lib/app-auth";
import { isResponse, requirePermission, ROLE_PERMISSIONS, writeAudit } from "../../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "sys:access:manage");
  if (isResponse(user)) return user;
  const rows = await getDb().select({ id: userAccess.id, email: userAccess.email, displayName: userAccess.displayName, role: userAccess.role, dataScope: userAccess.dataScope, isActive: userAccess.isActive, mustChangePassword: userAccess.mustChangePassword, hasPassword: userAccess.passwordHash, lockedUntil: userAccess.lockedUntil, lastLoginAt: userAccess.lastLoginAt, updatedAt: userAccess.updatedAt }).from(userAccess).orderBy(userAccess.email).limit(100);
  return Response.json({ users: rows.map((row) => ({ ...row, hasPassword: Boolean(row.hasPassword) })) });
}

export async function POST(request: Request) {
  const admin = await requirePermission(request, "sys:access:manage");
  if (isResponse(admin)) return admin;
  const body = await request.json() as { email?: string; displayName?: string; role?: "ADMIN" | "OPERATOR" | "VIEWER"; dataScope?: "ALL" | "OWN"; temporaryPassword?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || !body.role || !body.dataScope || !body.temporaryPassword) return Response.json({ error: "用户信息不完整" }, { status: 400 });
  const policyError = validatePassword(body.temporaryPassword);
  if (policyError) return Response.json({ error: policyError }, { status: 400 });
  const db = getDb();
  const [existing] = await db.select({ id: userAccess.id }).from(userAccess).where(eq(userAccess.email, email)).limit(1);
  if (existing) return Response.json({ error: "该邮箱已存在" }, { status: 409 });
  const password = await derivePassword(body.temporaryPassword);
  const role = body.role;
  const dataScope = role === "ADMIN" ? "ALL" : body.dataScope;
  const now = new Date();
  await db.insert(userAccess).values({ email, displayName: body.displayName?.trim() || null, role, dataScope, permissionsJson: JSON.stringify(ROLE_PERMISSIONS[role]), passwordHash: password.hash, passwordSalt: password.salt, passwordIterations: password.iterations, mustChangePassword: true, createdAt: now, updatedAt: now });
  await writeAudit(admin, "CREATE_USER", "user_access", email, { role, dataScope });
  return Response.json({ user: { email, role, dataScope, mustChangePassword: true } }, { status: 201 });
}

export async function PUT(request: Request) {
  const admin = await requirePermission(request, "sys:access:manage");
  if (isResponse(admin)) return admin;
  const body = await request.json() as { email?: string; temporaryPassword?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !body.temporaryPassword) return Response.json({ error: "重置密码参数不完整" }, { status: 400 });
  const policyError = validatePassword(body.temporaryPassword);
  if (policyError) return Response.json({ error: policyError }, { status: 400 });
  const db = getDb();
  const [target] = await db.select({ id: userAccess.id, passwordHash: userAccess.passwordHash, passwordSalt: userAccess.passwordSalt, passwordIterations: userAccess.passwordIterations }).from(userAccess).where(eq(userAccess.email, email)).limit(1);
  if (!target) return Response.json({ error: "目标成员不存在" }, { status: 404 });
  if (target.passwordHash && target.passwordSalt && target.passwordIterations && await verifyPassword(body.temporaryPassword, target.passwordHash, target.passwordSalt, target.passwordIterations)) {
    return Response.json({ error: "新临时密码不能与该成员当前密码相同" }, { status: 409 });
  }
  const password = await derivePassword(body.temporaryPassword);
  const now = new Date();
  await revokeSessions(email);
  await db.update(userAccess).set({ passwordHash: password.hash, passwordSalt: password.salt, passwordIterations: password.iterations, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null, updatedAt: now }).where(eq(userAccess.id, target.id));
  await writeAudit(admin, "RESET_USER_PASSWORD", "user_access", email, {});
  return Response.json({ status: "PASSWORD_RESET" });
}

export async function PATCH(request: Request) {
  const user = await requirePermission(request, "sys:access:manage");
  if (isResponse(user)) return user;
  const body = await request.json() as { email?: string; role?: "ADMIN" | "OPERATOR" | "VIEWER"; dataScope?: "ALL" | "OWN"; isActive?: boolean };
  const email = body.email?.trim().toLowerCase();
  if (!email || !body.role || !["ADMIN", "OPERATOR", "VIEWER"].includes(body.role) || !body.dataScope || !["ALL", "OWN"].includes(body.dataScope)) {
    return Response.json({ error: "角色更新参数不完整" }, { status: 400 });
  }
  const db = getDb();
  const [target] = await db.select().from(userAccess).where(eq(userAccess.email, email)).limit(1);
  if (!target) return Response.json({ error: "目标成员不存在" }, { status: 404 });
  const isActive = body.isActive ?? target.isActive;
  if (email === user.email && !isActive) return Response.json({ error: "不能停用当前登录账号" }, { status: 409 });
  if (target.role === "ADMIN" && (body.role !== "ADMIN" || !isActive)) {
    const [adminCount] = await db.select({ value: count() }).from(userAccess).where(and(eq(userAccess.role, "ADMIN"), eq(userAccess.dataScope, "ALL"), eq(userAccess.isActive, true)));
    if ((adminCount?.value ?? 0) <= 1) return Response.json({ error: "必须保留至少一名全局管理员" }, { status: 409 });
  }
  const dataScope = body.role === "ADMIN" ? "ALL" : body.dataScope;
  const now = new Date();
  if (!isActive) await revokeSessions(email);
  await db.update(userAccess).set({ role: body.role, dataScope, isActive, permissionsJson: JSON.stringify(ROLE_PERMISSIONS[body.role]), updatedAt: now }).where(eq(userAccess.email, email));
  await writeAudit(user, "UPDATE_USER_ACCESS", "user_access", email, { previousRole: target.role, role: body.role, previousDataScope: target.dataScope, dataScope, previousActive: target.isActive, isActive });
  return Response.json({ user: { email, role: body.role, dataScope, isActive, updatedAt: now } });
}
