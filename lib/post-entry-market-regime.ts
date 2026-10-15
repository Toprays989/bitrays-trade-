export type MarketContractSnapshot = {
  symbol: string;
  change: number;
  quoteVolume: number;
};

export type PostEntryMarketRegime = {
  status: "FAVORABLE" | "NEUTRAL" | "ADVERSE" | "UNAVAILABLE";
  label: string;
  positionSide: "LONG" | "SHORT";
  sampleSize: number;
  btcChangePercent24h: number | null;
  ethChangePercent24h: number | null;
  benchmarkChangePercent24h: number | null;
  positiveBreadthPercent: number | null;
  medianChangePercent24h: number | null;
  reason: string;
};

export function analyzePostEntryMarketRegime(input: {
  rows: MarketContractSnapshot[];
  positionSide: "LONG" | "SHORT";
  maxSymbols?: number;
}): PostEntryMarketRegime {
  const maxSymbols = Math.max(20, Math.min(200, input.maxSymbols ?? 100));
  const valid = input.rows
    .filter((row) =>
      /^[A-Z0-9]{1,20}USDT$/.test(row.symbol) &&
      Number.isFinite(row.change) &&
      Number.isFinite(row.quoteVolume) &&
      row.quoteVolume > 0,
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, maxSymbols);
  const btc = finiteChange(input.rows, "BTCUSDT");
  const eth = finiteChange(input.rows, "ETHUSDT");
  const benchmarks = [btc, eth].filter((value): value is number => value !== null);
  const benchmark = benchmarks.length
    ? benchmarks.reduce((sum, value) => sum + value, 0) / benchmarks.length
    : null;

  if (valid.length < 20 || benchmark === null) {
    return {
      status: "UNAVAILABLE",
      label: "大盘数据不足",
      positionSide: input.positionSide,
      sampleSize: valid.length,
      btcChangePercent24h: btc,
      ethChangePercent24h: eth,
      benchmarkChangePercent24h: benchmark,
      positiveBreadthPercent: null,
      medianChangePercent24h: null,
      reason: "统一行情快照样本不足，本分钟不据此评价入场质量。",
    };
  }

  const changes = valid.map((row) => row.change).sort((a, b) => a - b);
  const positiveBreadth = valid.filter((row) => row.change > 0).length / valid.length * 100;
  const middle = Math.floor(changes.length / 2);
  const median = changes.length % 2
    ? changes[middle]
    : (changes[middle - 1] + changes[middle]) / 2;
  const bullish = benchmark >= 0.3 && positiveBreadth >= 55;
  const bearish = benchmark <= -0.3 && positiveBreadth <= 45;
  const favorable = input.positionSide === "LONG" ? bullish : bearish;
  const adverse = input.positionSide === "LONG" ? bearish : bullish;
  const status = favorable ? "FAVORABLE" : adverse ? "ADVERSE" : "NEUTRAL";
  const label = status === "FAVORABLE"
    ? "大盘顺风"
    : status === "ADVERSE"
      ? "大盘逆风"
      : "大盘中性";
  return {
    status,
    label,
    positionSide: input.positionSide,
    sampleSize: valid.length,
    btcChangePercent24h: round(btc),
    ethChangePercent24h: round(eth),
    benchmarkChangePercent24h: round(benchmark),
    positiveBreadthPercent: round(positiveBreadth),
    medianChangePercent24h: round(median),
    reason: `${input.positionSide === "LONG" ? "多仓" : "空仓"} · BTC/ETH均值 ${formatPercent(benchmark)} · 上涨广度 ${positiveBreadth.toFixed(1)}% · 活跃合约中位数 ${formatPercent(median)}`,
  };
}

export function unavailablePostEntryMarketRegime(
  positionSide: "LONG" | "SHORT",
  reason = "统一行情快照暂不可用，本分钟不据此评价入场质量。",
): PostEntryMarketRegime {
  return {
    status: "UNAVAILABLE",
    label: "大盘数据不足",
    positionSide,
    sampleSize: 0,
    btcChangePercent24h: null,
    ethChangePercent24h: null,
    benchmarkChangePercent24h: null,
    positiveBreadthPercent: null,
    medianChangePercent24h: null,
    reason,
  };
}

function finiteChange(rows: MarketContractSnapshot[], symbol: string) {
  const value = rows.find((row) => row.symbol === symbol)?.change;
  return Number.isFinite(value) ? Number(value) : null;
}

function round(value: number | null) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
