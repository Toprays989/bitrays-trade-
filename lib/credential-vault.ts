import { env } from "cloudflare:workers";
export {
  liveTradingAllowedByServer,
  readServerLiveTradingControl,
  setServerLiveTradingControl,
} from "./live-trading-control";

type RuntimeEnvironment = { NQ_CREDENTIAL_MASTER_KEY?: string; NQ_ALLOW_INSECURE_HTTP_LIVE?: string };

function runtimeEnvironment() { return env as unknown as RuntimeEnvironment; }
function decodeBase64(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encodeBase64(value: Uint8Array) { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary); }

async function vaultKey() {
  const encoded = runtimeEnvironment().NQ_CREDENTIAL_MASTER_KEY;
  if (!encoded) throw new Error("服务器尚未配置密钥加密主密钥");
  const raw = decodeBase64(encoded);
  if (raw.byteLength !== 32) throw new Error("服务器密钥加密主密钥格式无效");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCredential(value: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, await vaultKey(), new TextEncoder().encode(value));
  return { ciphertext: encodeBase64(new Uint8Array(ciphertext)), iv: encodeBase64(iv) };
}

export async function decryptCredential(ciphertext: string, iv: string, context: string) {
  const cleartext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(iv), additionalData: new TextEncoder().encode(context) }, await vaultKey(), decodeBase64(ciphertext));
  return new TextDecoder().decode(cleartext);
}

export function insecureHttpLiveAllowed() { return runtimeEnvironment().NQ_ALLOW_INSECURE_HTTP_LIVE === "true"; }

export function isSecureCredentialRequest(request: Request) {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  if (request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https") return true;
  if (insecureHttpLiveAllowed()) return true;
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

export function credentialContext(ownerEmail: string, accountId: string, field: "api-key" | "secret-key") { return `nexusquant:${ownerEmail}:${accountId}:${field}:v1`; }
