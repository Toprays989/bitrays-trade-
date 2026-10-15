import type {
  NexusUnifiedCandle,
  NexusUnifiedMarketSnapshot,
} from "./nexus-unified-market-data";

export const NEXUS_ANALYSIS_SERIES_KEYS = [
  "trade1h",
  "trade4h",
  "trade30m",
  "trade15m",
  "trade5m",
  "trade3m",
  "trade1m",
  "btcTrade1h",
] as const;

export type NexusAnalysisSeriesKey =
  (typeof NEXUS_ANALYSIS_SERIES_KEYS)[number];

export type NexusAnalysisSeriesAvailability = {
  version: "nexus-analysis-series-availability-v1";
  timeoutMs: number;
  degraded: boolean;
  requiredSeries: NexusAnalysisSeriesKey[];
  availableSeries: NexusAnalysisSeriesKey[];
  missingSeries: Array<{
    key: NexusAnalysisSeriesKey;
    reason: string;
  }>;
};

type NexusAnalysisSeriesResult =
  | NexusUnifiedCandle[]
  | NexusUnifiedMarketSnapshot;

export type NexusAnalysisSeriesSource = {
  receivedAt: number | null;
  expiresAt: number | null;
};

export const DEFAULT_NEXUS_ANALYSIS_SERIES_TIMEOUT_MS = 6_000;

async function settleWithin<T>(
  request: Promise<T>,
  key: NexusAnalysisSeriesKey,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${key} 行情等待超过 ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function settleNexusAnalysisCandleSeries(input: {
  requests: Record<
    NexusAnalysisSeriesKey,
    Promise<NexusAnalysisSeriesResult>
  >;
  requiredSeries?: NexusAnalysisSeriesKey[];
  timeoutMs?: number;
}) {
  const requiredSeries = input.requiredSeries ?? ["trade5m"];
  const timeoutMs = Math.max(
    100,
    input.timeoutMs ?? DEFAULT_NEXUS_ANALYSIS_SERIES_TIMEOUT_MS,
  );
  const settled = await Promise.allSettled(
    NEXUS_ANALYSIS_SERIES_KEYS.map((key) =>
      settleWithin(input.requests[key], key, timeoutMs),
    ),
  );
  const rows = NEXUS_ANALYSIS_SERIES_KEYS.reduce(
    (result, key) => {
      result[key] = [];
      return result;
    },
    {} as Record<NexusAnalysisSeriesKey, NexusUnifiedCandle[]>,
  );
  const sources = NEXUS_ANALYSIS_SERIES_KEYS.reduce(
    (result, key) => {
      result[key] = { receivedAt: null, expiresAt: null };
      return result;
    },
    {} as Record<NexusAnalysisSeriesKey, NexusAnalysisSeriesSource>,
  );
  const failures = new Map<NexusAnalysisSeriesKey, unknown>();
  const missingSeries: NexusAnalysisSeriesAvailability["missingSeries"] = [];

  settled.forEach((result, index) => {
    const key = NEXUS_ANALYSIS_SERIES_KEYS[index];
    const value = result.status === "fulfilled" ? result.value : null;
    const candleRows = Array.isArray(value) ? value : value?.rows ?? [];
    if (result.status === "fulfilled" && candleRows.length > 0) {
      rows[key] = candleRows;
      if (value && !Array.isArray(value)) {
        sources[key] = {
          receivedAt: value.receivedAt,
          expiresAt: value.expiresAt,
        };
      }
      return;
    }
    const reason =
      result.status === "rejected"
        ? result.reason
        : new Error(`${key} 没有已收盘K线`);
    failures.set(key, reason);
    missingSeries.push({
      key,
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  return {
    rows,
    sources,
    failures,
    requiredFailure:
      requiredSeries
        .map((key) => failures.get(key))
        .find((failure) => failure !== undefined) ?? null,
    availability: {
      version: "nexus-analysis-series-availability-v1" as const,
      timeoutMs,
      degraded: missingSeries.length > 0,
      requiredSeries: [...requiredSeries],
      availableSeries: NEXUS_ANALYSIS_SERIES_KEYS.filter(
        (key) => !failures.has(key),
      ),
      missingSeries,
    },
  };
}
