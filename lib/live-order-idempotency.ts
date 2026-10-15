const CLIENT_ORDER_ID_MAX_LENGTH = 36;
const CLIENT_ORDER_ID_PREFIX = "nq_";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function legacyLiveEntryClientOrderId(idempotencyKey: string) {
  return `${CLIENT_ORDER_ID_PREFIX}${idempotencyKey}`.slice(
    0,
    CLIENT_ORDER_ID_MAX_LENGTH,
  );
}

export async function liveEntryClientOrderIds(input: {
  ownerEmail: string;
  accountId: string;
  credentialId: number;
  idempotencyKey: string;
}) {
  const scope = JSON.stringify([
    input.ownerEmail.trim().toLowerCase(),
    input.accountId.trim(),
    input.credentialId,
    input.idempotencyKey,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(scope),
  );
  const hash = bytesToHex(new Uint8Array(digest));
  const primary = `${CLIENT_ORDER_ID_PREFIX}${hash.slice(
    0,
    CLIENT_ORDER_ID_MAX_LENGTH - CLIENT_ORDER_ID_PREFIX.length,
  )}`;
  return {
    primary,
    legacy: legacyLiveEntryClientOrderId(input.idempotencyKey),
  };
}
