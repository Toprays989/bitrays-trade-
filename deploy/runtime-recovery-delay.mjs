const runtimeUnavailableCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

function nestedErrorCode(error) {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && error.code) return String(error.code);
  return "cause" in error ? nestedErrorCode(error.cause) : null;
}

export function isRuntimeUnavailableError(error) {
  const code = nestedErrorCode(error);
  if (code && runtimeUnavailableCodes.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|connection refused|socket closed|other side closed/i.test(
    message,
  );
}

export function runtimeRecoveryDelayMs(error, input) {
  if (isRuntimeUnavailableError(error)) return 1_000;
  const failures = Math.max(0, Math.trunc(Number(input.failures) || 0));
  let delay = Math.min(
    input.maximumBackoffMs,
    input.normalIntervalMs * 2 ** Math.min(failures, 6),
  );
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /aborted due to timeout|timed?\s*out/i.test(message)
  ) delay = Math.max(delay, input.timeoutCooldownMs);
  return delay;
}

