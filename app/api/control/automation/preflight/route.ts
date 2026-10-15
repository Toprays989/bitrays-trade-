import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  contractSymbols,
  exchangeCredentials,
  liveOrderEvents,
  livePositions,
  strategies,
  tradingAccounts,
} from "../../../../../db/schema";
import { binanceAnalysisCapacity } from "../../../../../lib/binance-analysis-capacity";
import { getBinanceLiveSystemMetrics } from "../../../../../lib/binance-usdm-live";
import { liveTradingAllowedByServer } from "../../../../../lib/credential-vault";
import { getTradeReadiness } from "../../../../../lib/trade-readiness";
import {
  ensureAccountState,
  ensureSeedData,
  isResponse,
  readTradingStrategyDailyPnl,
  requirePermission,
  writeAudit,
} from "../../shared";

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:automation:run");
  if (isResponse(user)) return user;
  await Promise.all([ensureSeedData(), ensureAccountState(user)]);
  const db = getDb();
  const [runningStrategies, activeSymbols, systemMetrics] =
    await Promise.all([
      db
        .select()
        .from(strategies)
        .where(
          and(
            eq(strategies.ownerEmail, user.email),
            eq(strategies.status, "RUNNING"),
          ),
        )
        .limit(10),
      db
        .select()
        .from(contractSymbols)
        .where(eq(contractSymbols.isActive, true)),
      getBinanceLiveSystemMetrics().catch(() => null),
    ]);
  const serverLiveTradingAllowed = await liveTradingAllowedByServer();
  const activeNames = new Set(activeSymbols.map((symbol) => symbol.symbol));
  const strategyContexts = await Promise.all(
    runningStrategies.map(async (strategy) => {
      const config = parseConfig(strategy.configJson);
      const [account] = await db
        .select()
        .from(tradingAccounts)
        .where(
          and(
            eq(tradingAccounts.ownerEmail, user.email),
            eq(tradingAccounts.accountId, strategy.accountId),
          ),
        )
        .limit(1);
      const [liveCredential] =
        account?.executionMode === "LIVE"
          ? await db
              .select()
              .from(exchangeCredentials)
              .where(
                and(
                  eq(exchangeCredentials.ownerEmail, user.email),
                  eq(exchangeCredentials.accountId, account.accountId),
                ),
              )
              .limit(1)
          : [];
      const [strategyDailyPnl, openPositions, pendingOrders] = account
        ? await Promise.all([
            readTradingStrategyDailyPnl(user, account, strategy.id),
            db
              .select()
              .from(livePositions)
              .where(
                and(
                  eq(livePositions.ownerEmail, user.email),
                  eq(livePositions.accountId, account.accountId),
                  eq(livePositions.status, "OPEN"),
                ),
              ),
            db
              .select()
              .from(liveOrderEvents)
              .where(
                and(
                  eq(liveOrderEvents.ownerEmail, user.email),
                  eq(liveOrderEvents.accountId, account.accountId),
                  eq(liveOrderEvents.testOnly, false),
                  inArray(liveOrderEvents.status, [
                    "PENDING",
                    "NEW",
                    "PARTIALLY_FILLED",
                    "CANCEL_PENDING",
                    "EXECUTION_UNKNOWN",
                  ]),
                ),
              ),
          ])
        : [null, [], []];
      const tradeReadiness = account
        ? getTradeReadiness(
            account,
            liveCredential,
            serverLiveTradingAllowed,
          )
        : null;
      // Binance availableBalance 已经扣除了当前仓位/挂单占用保证金，
      // 是自动订单提交前的权威资金边界。当日累计开仓保证金只展示，
      // 不再参与拒单、缩量或加仓授权。
      const availableMargin =
        account && liveCredential
          ? Math.max(liveCredential.availableBalance ?? 0, 0)
          : 0;
      const committedMargin =
        openPositions.reduce(
          (sum, position) =>
            sum +
            (position.quantity * position.markPrice) /
              Math.max(position.leverage, 1),
          0,
        ) +
        pendingOrders.reduce(
          (sum, order) =>
            sum +
            order.estimatedNotional / Math.max(config.leverage, 1),
          0,
        );
      const missingSymbols = config.selectedSymbols.filter(
        (symbol) => !activeNames.has(symbol),
      );
      const executableUniverse = config.selectedSymbols.length
        ? config.selectedSymbols.filter((symbol) => activeNames.has(symbol))
        : activeSymbols.map((symbol) => symbol.symbol);
      const executableSymbols =
        config.maxSymbols === 0
          ? executableUniverse
          : executableUniverse.slice(0, config.maxSymbols);
      return {
        strategy,
        config,
        account,
        liveCredential,
        strategyDailyPnl,
        tradeReadiness,
        openPositions,
        pendingOrders,
        availableMargin,
        committedMargin,
        missingSymbols,
        executableSymbols,
      };
    }),
  );
  const dedicatedLiquidationMonitor =
    strategyContexts.length > 0 &&
    strategyContexts.every(
      ({ strategy }) =>
        strategy.strategyType === "LIQ_CHASE" &&
        strategy.brainTemplate === "NEXUS_MARKET_BRAIN" &&
        strategy.runtimeMode === "LIVE",
    );
  const analysisCapacity = binanceAnalysisCapacity({
    rest: systemMetrics?.rest,
    weightPerSymbol: 6,
    configuredMaxSymbols: 100,
  });
  const checks = [
    {
      key: "strategy",
      label: "运行策略",
      passed: runningStrategies.length > 0,
      detail: `${runningStrategies.length} 个已运行`,
    },
    {
      key: "account",
      label: "策略实盘账户",
      passed:
        strategyContexts.length > 0 &&
        strategyContexts.every(
          ({ account, availableMargin }) =>
            Boolean(
              account?.isActive &&
                availableMargin > 0,
            ),
        ),
      detail:
        strategyContexts.length > 0
          ? strategyContexts
              .map(({ strategy, account, strategyDailyPnl, availableMargin, config }) =>
                account
                  ? `${strategy.name}：${account.name} · ${
                      account.isActive
                          ? `策略当日综合盈亏 ${strategyDailyPnl?.dailyPnl.toFixed(2) ?? "--"} / 亏损线 -${config.dailyLossLimitUsdt.toFixed(2)} USDT；Binance 可再开仓保证金 ${availableMargin.toFixed(2)} USDT / 组合占用建议 ${config.maxMarginUsagePercent}%（不拒单） / ${config.leverage}×`
                          : "已停用"
                    }`
                  : `${strategy.name}：账户不存在`,
              )
              .join("；")
          : "没有运行策略",
    },
    {
      key: "capacity",
      label: "保证金容量",
      passed:
        strategyContexts.length > 0 &&
        strategyContexts.every(
          ({ account, availableMargin }) =>
            Boolean(account && availableMargin > 0),
        ),
      detail:
        strategyContexts.length > 0
          ? strategyContexts
              .map(
                ({
                  strategy,
                  account,
                  openPositions,
                  pendingOrders,
                  committedMargin,
                  availableMargin,
                  config,
                }) =>
                  account
                    ? `${strategy.name}：当前持仓 ${openPositions.length} 个 · 等待订单 ${pendingOrders.length} 笔 · 组合占用参考 ${committedMargin.toFixed(2)} USDT · Binance 可再开仓保证金 ${availableMargin.toFixed(2)} USDT`
                    : `${strategy.name}：账户不存在`,
              )
              .join("；") +
            "；实际下单按各策略风险参数再次核对，不按笔数限制"
          : "没有运行策略",
    },
    {
      key: "symbols",
      label: "策略合约范围",
      passed:
        strategyContexts.length > 0 &&
        strategyContexts.every(
          ({ executableSymbols, missingSymbols }) =>
            executableSymbols.length > 0 && missingSymbols.length === 0,
        ),
      detail:
        strategyContexts.length > 0
          ? strategyContexts
              .map(({ strategy, executableSymbols, missingSymbols }) =>
                missingSymbols.length
                  ? `${strategy.name} 已失效：${missingSymbols.join("、")}`
                  : `${strategy.name}：${executableSymbols.length} 个激活合约`,
              )
              .join("；")
          : "没有运行策略",
    },
    {
      key: "weight",
      label: "API 权重预算",
      passed:
        dedicatedLiquidationMonitor ||
        (analysisCapacity.available && analysisCapacity.maxSymbols > 0),
      detail: dedicatedLiquidationMonitor
        ? "全部运行大脑使用统一 WebSocket 爆仓监控；不执行重复全市场K线扫描"
        : analysisCapacity.available
          ? `${analysisCapacity.usedWeight}/${analysisCapacity.admissionLimit}，本轮最多分析 ${analysisCapacity.maxSymbols} 个合约`
          : "系统统一 API 权重指标不可用",
    },
    {
      key: "mode",
      label: "实盘执行环境",
      passed:
        strategyContexts.length > 0 &&
        strategyContexts.every(
          ({ account, tradeReadiness, liveCredential }) =>
            Boolean(
              account?.executionMode === "LIVE" &&
                tradeReadiness?.liveReady &&
                liveCredential,
            ),
        ),
      detail:
        strategyContexts.length > 0
          ? strategyContexts
              .map(({ strategy, account, tradeReadiness, config }) =>
                account?.executionMode === "LIVE"
                  ? `${strategy.name}：LIVE · ${
                      tradeReadiness?.liveReady
                        ? "账户已就绪"
                        : tradeReadiness?.blockers.join("；") || "账户未就绪"
                    } · ${config.leverage}×`
                  : `${strategy.name}：账户尚未启用实盘`,
              )
              .join("；")
          : "没有运行策略",
    },
  ];
  const ready = checks.every((check) => check.passed);
  await writeAudit(user, "AUTOMATION_PREFLIGHT", "automation", user.accountId, {
    ready,
    checks,
  });
  return Response.json({
    ready,
    checkedAt: new Date(),
    checks,
    nextAction: ready ? "READY_FOR_SIGNAL_SCAN" : "BLOCKED_BY_PREFLIGHT",
  });
}

function parseConfig(value: string) {
  const defaults = {
    maxSymbols: 0,
    leverage: 10,
    maxMarginUsagePercent: 50,
    maxDailyNotionalUsdt: 60,
    dailyLossLimitUsdt: 15,
    selectedSymbols: [] as string[],
  };
  try {
    const parsed = JSON.parse(value) as {
      maxSymbols?: unknown;
      leverage?: unknown;
      selectedSymbols?: unknown;
      execution?: {
        leverage?: unknown;
        maxDailyNotionalUsdt?: unknown;
      };
      risk?: {
        maxMarginUsagePercent?: unknown;
        dailyLossLimitUsdt?: unknown;
      };
    };
    return {
      maxSymbols: Number.isFinite(Number(parsed.maxSymbols))
        ? Math.max(0, Math.trunc(Number(parsed.maxSymbols)))
        : defaults.maxSymbols,
      leverage: Number.isFinite(
          Number(parsed.execution?.leverage ?? parsed.leverage),
        )
        ? Math.min(
            125,
            Math.max(
              1,
              Math.trunc(
                Number(parsed.execution?.leverage ?? parsed.leverage),
              ),
            ),
          )
        : defaults.leverage,
      maxMarginUsagePercent: Number.isFinite(
          Number(parsed.risk?.maxMarginUsagePercent),
        )
        ? Math.min(
            100,
            Math.max(1, Number(parsed.risk?.maxMarginUsagePercent)),
          )
        : defaults.maxMarginUsagePercent,
      maxDailyNotionalUsdt: Number.isFinite(
          Number(parsed.execution?.maxDailyNotionalUsdt),
        )
        ? Math.max(0, Number(parsed.execution?.maxDailyNotionalUsdt))
        : defaults.maxDailyNotionalUsdt,
      dailyLossLimitUsdt: Number.isFinite(
          Number(parsed.risk?.dailyLossLimitUsdt),
        )
        ? Math.max(0, Number(parsed.risk?.dailyLossLimitUsdt))
        : defaults.dailyLossLimitUsdt,
      selectedSymbols: Array.isArray(parsed.selectedSymbols)
        ? parsed.selectedSymbols.filter(
            (symbol): symbol is string => typeof symbol === "string",
          )
        : defaults.selectedSymbols,
    } satisfies {
      maxSymbols: number;
      leverage: number;
      maxMarginUsagePercent: number;
      maxDailyNotionalUsdt: number;
      dailyLossLimitUsdt: number;
      selectedSymbols: string[];
    };
  } catch {
    return defaults;
  }
}
