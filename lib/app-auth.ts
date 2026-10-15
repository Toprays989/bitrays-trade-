import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { appSessions } from "../db/schema";

export const SESSION_COOKIE = "nq_session";
// The Workers Web Crypto runtime currently accepts at most 100,000 PBKDF2 rounds.
// Keep the stored iteration count explicit so future upgrades remain verifiable.
export const PASSWORD_ITERATIONS = 100_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function validatePassword(password: string): string | null {
  if (password.length < 12) return "密码至少需要 12 个字符";
  if (password.length > 128) return "密码不能超过 128 个字符";
  return null;
}

export async function derivePassword(password: string, saltBase64?: string, iterations = PASSWORD_ITERATIONS) {
  const salt = saltBase64 ? fromBase64(saltBase64) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt), iterations };
}

export async function verifyPassword(password: string, expectedHash: string, salt: string, iterations: number) {
  const actual = await derivePassword(password, salt, iterations);
  const left = fromBase64(actual.hash);
  const right = fromBase64(expectedHash);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64(new Uint8Array(digest));
}

function readCookie(request: Request, name: string) {
  const prefix = `${name}=`;
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export async function createSession(email: string) {
  const token = toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await getDb().insert(appSessions).values({ tokenHash, email, expiresAt, createdAt: now, lastSeenAt: now });
  return { token, expiresAt };
}

export function sessionCookie(token: string, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = process.env.NQ_COOKIE_SECURE === "false" ? "" : " Secure;";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${maxAge}`;
}

export async function getSessionByRequest(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const now = new Date();
  const [session] = await getDb().select().from(appSessions).where(and(eq(appSessions.tokenHash, tokenHash), gt(appSessions.expiresAt, now), isNull(appSessions.revokedAt))).limit(1);
  if (!session) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > 5 * 60 * 1000) await getDb().update(appSessions).set({ lastSeenAt: now }).where(eq(appSessions.tokenHash, tokenHash));
  return session;
}

export async function getSession(request: Request, email: string) {
  const session = await getSessionByRequest(request);
  return session?.email === email ? session : null;
}

export async function resolveRequestEmail(request: Request) {
  const platformEmail = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (platformEmail) return platformEmail;
  return (await getSessionByRequest(request))?.email?.trim().toLowerCase() ?? null;
}

export async function revokeSessions(email: string) {
  await getDb().update(appSessions).set({ revokedAt: new Date() }).where(and(eq(appSessions.email, email), isNull(appSessions.revokedAt)));
}
