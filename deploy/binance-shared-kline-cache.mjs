const SHARED_KLINE_PATHS = new Set([
  "/fapi/v1/klines",
  "/fapi/v1/markPriceKlines",
]);

export function sharedKlineRequestPlan({
  environment,
  method,
  pathname,
  searchParams,
  canonicalLimit = 99,
}) {
  if (
    environment !== "live" ||
    method !== "GET" ||
    !SHARED_KLINE_PATHS.has(pathname) ||
    searchParams.has("startTime")
  ) return null;
  const requestedLimit = Number(searchParams.get("limit") || canonicalLimit);
  if (
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > canonicalLimit
  ) return null;
  const upstreamSearchParams = new URLSearchParams(searchParams);
  upstreamSearchParams.set("limit", String(canonicalLimit));
  upstreamSearchParams.sort();
  const canonicalPath = `${pathname}?${upstreamSearchParams.toString()}`;
  return {
    requestedLimit,
    canonicalLimit,
    canonicalPath,
    cacheKey: `${environment}:${canonicalPath}`,
    upstreamSearchParams,
  };
}

export function projectSharedKlinePayload(payload, requestedLimit) {
  if (
    !payload ||
    payload.status < 200 ||
    payload.status >= 300 ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1
  ) return payload;
  try {
    const rows = JSON.parse(payload.body.toString("utf8"));
    if (!Array.isArray(rows)) return payload;
    return {
      ...payload,
      headers: {
        ...payload.headers,
        "x-nq-kline-source": "shared-canonical-cache",
      },
      body: Buffer.from(JSON.stringify(rows.slice(-requestedLimit))),
    };
  } catch {
    return payload;
  }
}

export class BoundedResponseCache {
  #entries = new Map();
  #bytes = 0;
  #evictions = 0;
  #expired = 0;

  constructor({ maximumEntries, maximumBytes }) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1)
      throw new Error("响应缓存条数上限无效");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new Error("响应缓存字节上限无效");
    this.maximumEntries = maximumEntries;
    this.maximumBytes = maximumBytes;
  }

  get(key, now = Date.now()) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.#delete(key, entry);
      this.#expired += 1;
      return null;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value, expiresAt, now = Date.now()) {
    const prior = this.#entries.get(key);
    if (prior) this.#delete(key, prior);
    this.pruneExpired(now);
    const bytes = responsePayloadBytes(value, key);
    this.#entries.set(key, { value, expiresAt, bytes });
    this.#bytes += bytes;
    while (
      this.#entries.size > this.maximumEntries ||
      this.#bytes > this.maximumBytes
    ) {
      const oldestKey = this.#entries.keys().next().value;
      if (typeof oldestKey !== "string") break;
      const oldest = this.#entries.get(oldestKey);
      if (!oldest) break;
      this.#delete(oldestKey, oldest);
      this.#evictions += 1;
    }
  }

  delete(key) {
    const entry = this.#entries.get(key);
    if (entry) this.#delete(key, entry);
  }

  pruneExpired(now = Date.now()) {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt > now) continue;
      this.#delete(key, entry);
      this.#expired += 1;
    }
  }

  metrics() {
    return {
      entries: this.#entries.size,
      estimatedBytes: this.#bytes,
      maximumEntries: this.maximumEntries,
      maximumBytes: this.maximumBytes,
      capacityEvictions: this.#evictions,
      expiredEntriesPruned: this.#expired,
    };
  }

  #delete(key, entry) {
    this.#entries.delete(key);
    this.#bytes = Math.max(0, this.#bytes - entry.bytes);
  }
}

function responsePayloadBytes(payload, key) {
  const bodyBytes = Buffer.isBuffer(payload?.body)
    ? payload.body.byteLength
    : Buffer.byteLength(String(payload?.body ?? ""));
  const headerBytes = Buffer.byteLength(JSON.stringify(payload?.headers ?? {}));
  return bodyBytes + headerBytes + Buffer.byteLength(key) + 128;
}
