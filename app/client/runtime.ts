export function clearStoredWorkspace() {
  try {
    window.localStorage.removeItem("nexus-quant-active-page");
    window.localStorage.removeItem("nexus-quant-open-tabs");
  } catch {
    // Local storage may be unavailable; logout must still continue.
  }
}

export function broadcastApplicationLogout() {
  try {
    window.localStorage.setItem("nexus-quant-logout-at", String(Date.now()));
  } catch {
    // The current tab can still log out when cross-tab broadcast is unavailable.
  }
}

export function createClientRequestId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function")
    return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("当前浏览器不支持安全随机数，请升级浏览器后再下单");
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.text();
  if (!payload.trim()) {
    throw new Error(
      response.ok
        ? "服务器返回空响应，请检查数据库与运行环境绑定"
        : `服务器请求失败（HTTP ${response.status}），但未返回错误详情`,
    );
  }
  try {
    return JSON.parse(payload) as T;
  } catch {
    throw new Error(`服务器返回了无法识别的数据（HTTP ${response.status}）`);
  }
}

export async function fetchWithTransientRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retryDelaysMs = [0, 350, 1_000],
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const delay = retryDelaysMs[attempt] ?? 0;
    if (delay > 0)
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    try {
      const response = await fetch(input, init);
      if (
        ![502, 503, 504].includes(response.status) ||
        attempt === retryDelaysMs.length - 1
      )
        return response;
      lastError = new Error(`服务器暂时不可用（HTTP ${response.status}）`);
    } catch (error) {
      lastError = error;
      if (
        attempt === retryDelaysMs.length - 1 ||
        (typeof navigator !== "undefined" && !navigator.onLine)
      )
        throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("服务器暂时不可用");
}

export function clientRequestErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (
    error instanceof TypeError ||
    (error instanceof Error && error.message === "Failed to fetch")
  )
    return "服务连接短暂波动，已保留当前数据并自动恢复";
  return error instanceof Error ? error.message : fallback;
}
