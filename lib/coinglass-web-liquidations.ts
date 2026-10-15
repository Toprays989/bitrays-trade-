export type LiquidationWindowHours = 1 | 4 | 12 | 24;

export type LiquidationWindowSnapshot = {
  hours: LiquidationWindowHours;
  totalUsd: number;
  longLiquidatedUsd: number;
  shortLiquidatedUsd: number;
  dominantSide: "LONG_LIQUIDATIONS" | "SHORT_LIQUIDATIONS" | "MIXED";
  dominantShare: number;
};

export type GlobalLiquidationContext = {
  status: "AVAILABLE" | "STALE" | "UNAVAILABLE";
  source: "COINGLASS_WEB_VIA_READER";
  sourcePageUrl: string;
  fetchedAt: string | null;
  staleAgeMs: number | null;
  windows: LiquidationWindowSnapshot[];
  marketTrend:
    | "UPTREND_SHORT_SQUEEZE"
    | "DOWNTREND_LONG_FLUSH"
    | "TRANSITION_OR_RANGE"
    | "UNAVAILABLE";
  swingTrend:
    | "UPSIDE_WAVE"
    | "DOWNSIDE_WAVE"
    | "REVERSAL_OR_DIVERGENCE"
    | "UNAVAILABLE";
  longEntryContext:
    | "SUPPORTIVE"
    | "WAIT_FOR_CONTRACT_RECLAIM"
    | "ADVERSE"
    | "NEUTRAL"
    | "UNAVAILABLE";
  summary: string;
  error: string | null;
};

const SOURCE_PAGE_URL = "https://www.coinglass.com/zh/liquidations";
const CACHE_TTL_MS = 60_000;
const STALE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const DOMINANCE_SHARE = 0.6;

let cache:
  | {
    fetchedAtMs: number;
    value: GlobalLiquidationContext;
  }
  | undefined;

export function parseCoinGlassLiquidationMarkdown(
  markdown: string,
): LiquidationWindowSnapshot[] {
  const start = markdown.indexOf("## 总爆仓");
  const end = markdown.indexOf("## 交易所爆仓", start + 1);
  if (start < 0 || end <= start) return [];
  const section = markdown.slice(start, end);
  const rows = new Map<LiquidationWindowHours, LiquidationWindowSnapshot>();
  const pattern =
    /(1|4|12|24)小时爆仓\s*\n+\s*\$([^\s]+)\s*\n+\s*多单\s*\n+\s*\$([^\s]+)\s*\n+\s*空单\s*\n+\s*\$([^\s]+)/g;
  for (const match of section.matchAll(pattern)) {
    const hours = Number(match[1]) as LiquidationWindowHours;
    const totalUsd = parseCompactUsd(match[2]);
    const longLiquidatedUsd = parseCompactUsd(match[3]);
    const shortLiquidatedUsd = parseCompactUsd(match[4]);
    if (
      !Number.isFinite(totalUsd) ||
      !Number.isFinite(longLiquidatedUsd) ||
      !Number.isFinite(shortLiquidatedUsd) ||
      totalUsd <= 0
    ) continue;
    const denominator = longLiquidatedUsd + shortLiquidatedUsd;
    const longShare = denominator > 0 ? longLiquidatedUsd / denominator : 0.5;
    const shortShare = denominator > 0 ? shortLiquidatedUsd / denominator : 0.5;
    const dominantSide =
      longShare >= DOMINANCE_SHARE
        ? "LONG_LIQUIDATIONS"
        : shortShare >= DOMINANCE_SHARE
          ? "SHORT_LIQUIDATIONS"
          : "MIXED";
    rows.set(hours, {
      hours,
      totalUsd,
      longLiquidatedUsd,
      shortLiquidatedUsd,
      dominantSide,
      dominantShare: Math.max(longShare, shortShare),
    });
  }
  return ([1, 4, 12, 24] as const)
    .map((hours) => rows.get(hours))
    .filter((row): row is LiquidationWindowSnapshot => Boolean(row));
}

export function analyzeGlobalLiquidationContext(
  windows: LiquidationWindowSnapshot[],
): Pick<
  GlobalLiquidationContext,
  "marketTrend" | "swingTrend" | "longEntryContext" | "summary"
> {
  const byHours = new Map(windows.map((row) => [row.hours, row]));
  const longTerm = [byHours.get(12), byHours.get(24)];
  const shortTerm = [byHours.get(1), byHours.get(4)];
  const marketTrend =
    longTerm.every((row) => row?.dominantSide === "SHORT_LIQUIDATIONS")
      ? "UPTREND_SHORT_SQUEEZE"
      : longTerm.every((row) => row?.dominantSide === "LONG_LIQUIDATIONS")
        ? "DOWNTREND_LONG_FLUSH"
        : longTerm.every(Boolean)
          ? "TRANSITION_OR_RANGE"
          : "UNAVAILABLE";
  const swingTrend =
    shortTerm.every((row) => row?.dominantSide === "SHORT_LIQUIDATIONS")
      ? "UPSIDE_WAVE"
      : shortTerm.every((row) => row?.dominantSide === "LONG_LIQUIDATIONS")
        ? "DOWNSIDE_WAVE"
        : shortTerm.every(Boolean)
          ? "REVERSAL_OR_DIVERGENCE"
          : "UNAVAILABLE";
  const longEntryContext =
    marketTrend === "UPTREND_SHORT_SQUEEZE" && swingTrend === "UPSIDE_WAVE"
      ? "SUPPORTIVE"
      : marketTrend === "UPTREND_SHORT_SQUEEZE" &&
          swingTrend === "DOWNSIDE_WAVE"
        ? "WAIT_FOR_CONTRACT_RECLAIM"
        : marketTrend === "DOWNTREND_LONG_FLUSH" &&
            swingTrend === "DOWNSIDE_WAVE"
          ? "ADVERSE"
          : marketTrend === "UNAVAILABLE" || swingTrend === "UNAVAILABLE"
            ? "UNAVAILABLE"
            : "NEUTRAL";
  const marketLabel = {
    UPTREND_SHORT_SQUEEZE: "12/24小时空头爆仓占优，大盘处于上行挤空背景",
    DOWNTREND_LONG_FLUSH: "12/24小时多头爆仓占优，大盘处于下行杀多背景",
    TRANSITION_OR_RANGE: "12/24小时爆仓方向分歧，大盘处于转换或震荡背景",
    UNAVAILABLE: "中长周期爆仓数据不足",
  }[marketTrend];
  const swingLabel = {
    UPSIDE_WAVE: "1/4小时偏上行波段",
    DOWNSIDE_WAVE: "1/4小时偏下行波段",
    REVERSAL_OR_DIVERGENCE: "1/4小时方向分歧",
    UNAVAILABLE: "短周期爆仓数据不足",
  }[swingTrend];
  return {
    marketTrend,
    swingTrend,
    longEntryContext,
    summary: `${marketLabel}；${swingLabel}。该背景仅用于成交后的持仓观察，不参与入场放行或拒绝。`,
  };
}

export async function getCoinGlassWebLiquidationContext(): Promise<GlobalLiquidationContext> {
  const now = Date.now();
  if (cache && now - cache.fetchedAtMs < CACHE_TTL_MS)
    return cache.value;
  // A Worker request must own and await every upstream I/O operation it
  // starts. Never keep an in-flight fetch Promise in module-global state.
  return refreshContext(now);
}

function refreshContext(now: number): Promise<GlobalLiquidationContext> {
  return fetchFreshContext()
    .then((value) => {
      cache = { fetchedAtMs: Date.now(), value };
      return value;
    })
    .catch((error) => {
      if (cache && now - cache.fetchedAtMs <= STALE_TTL_MS) {
        const staleAgeMs = now - cache.fetchedAtMs;
        return {
          ...cache.value,
          status: "STALE" as const,
          staleAgeMs,
          summary: `${cache.value.summary} 当前网页刷新失败，使用 ${Math.ceil(staleAgeMs / 1_000)} 秒前缓存。`,
          error: error instanceof Error ? error.message : "网页读取失败",
        };
      }
      return unavailableContext(
        error instanceof Error ? error.message : "网页读取失败",
      );
    });
}

async function fetchFreshContext(): Promise<GlobalLiquidationContext> {
  const { env } = await import("cloudflare:workers");
  const proxyBaseUrl = (
    env as unknown as { NQ_BINANCE_PROXY_URL?: string }
  ).NQ_BINANCE_PROXY_URL?.replace(/\/$/, "");
  if (!proxyBaseUrl)
    throw new Error("系统统一市场代理未配置");
  const response = await fetch(`${proxyBaseUrl}/market/global-liquidations`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`CoinGlass 网页读取返回 ${response.status}`);
  const payload = (await readJsonBody(response)) as {
    markdown?: string;
    error?: string;
  };
  if (!payload.markdown)
    throw new Error(payload.error || "CoinGlass 网页内容不可用");
  const markdown = payload.markdown;
  const windows = parseCoinGlassLiquidationMarkdown(markdown);
  if (windows.length !== 4)
    throw new Error(`CoinGlass 网页周期不完整：${windows.length}/4`);
  const analysis = analyzeGlobalLiquidationContext(windows);
  return {
    status: "AVAILABLE",
    source: "COINGLASS_WEB_VIA_READER",
    sourcePageUrl: SOURCE_PAGE_URL,
    fetchedAt: new Date().toISOString(),
    staleAgeMs: 0,
    windows,
    ...analysis,
    error: null,
  };
}

async function readJsonBody(response: Response) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    response.text(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void response.body?.cancel().catch(() => undefined);
        reject(new Error("CoinGlass 网页响应读取超时"));
      }, REQUEST_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return JSON.parse(text) as unknown;
}

function parseCompactUsd(value: string) {
  const normalized = value.replace(/[$,\s]/g, "").toUpperCase();
  const match = normalized.match(
    /^([0-9]+(?:\.[0-9]+)?)(万|亿|K|M|B)?$/,
  );
  if (!match) return Number.NaN;
  const numeric = Number(match[1]);
  const multiplier = {
    万: 10_000,
    亿: 100_000_000,
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
  }[match[2] ?? ""] ?? 1;
  return numeric * multiplier;
}

function unavailableContext(error: string): GlobalLiquidationContext {
  return {
    status: "UNAVAILABLE",
    source: "COINGLASS_WEB_VIA_READER",
    sourcePageUrl: SOURCE_PAGE_URL,
    fetchedAt: null,
    staleAgeMs: null,
    windows: [],
    marketTrend: "UNAVAILABLE",
    swingTrend: "UNAVAILABLE",
    longEntryContext: "UNAVAILABLE",
    summary: "CoinGlass 网页爆仓背景暂不可用，不据此阻塞下单或持仓保护。",
    error,
  };
}
