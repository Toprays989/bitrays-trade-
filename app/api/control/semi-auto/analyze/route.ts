import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  contractSymbols,
  exchangeCredentials,
  semiAutoAnalyses,
  strategies,
  tradingAccounts,
} from "../../../../../db/schema";
import {
  getBinanceLiveMarkPrices,
  warmNexusBookTicker,
  waitForFreshNexusBookTicker,
} from "../../../../../lib/binance-usdm-live";
import {
  analyzeNexusBtcRelationship,
  nexusBtcRelationshipLabel,
} from "../../../../../lib/nexus-btc-relationship";
import {
  classifyNexusMarketRegimeFromCandles,
  nexusMarketRegimeLabel,
} from "../../../../../lib/nexus-market-regime";
import {
  decideSemiAutoOpportunity,
  semiAutoScenarioEstimate,
  type SemiAutoDirection,
} from "../../../../../lib/nexus-semi-auto-opportunity";
import { nexusUnifiedMarketData } from "../../../../../lib/nexus-unified-market-data-live";
import {
  alignOrderQuantityUp,
  effectiveMinimumOrderQuantity,
} from "../../../../../lib/order-quantity";
import { buildEntryStructureBaseline } from "../../../../../lib/entry-structure-baseline";
import {
  semiAutoConfirmationExpiresAt,
  semiAutoConfirmationStatus,
} from "../../../../../lib/nexus-semi-auto-confirmation";
import type { LiquidationTrendConfig } from "../../../../../lib/liquidation-trend-config";
import { isResponse, requirePermission } from "../../shared";

export const dynamic = "force-dynamic";
const MAX_ANALYSES_PER_OWNER = 1_000;

type RequestBody = {
  strategyId?: number;
  symbol?: string;
  direction?: SemiAutoDirection;
  thesis?: string;
  horizon?: "SCALP" | "INTRADAY" | "SWING";
};

function parseConfig(value: string) {
  try {
    return JSON.parse(value) as LiquidationTrendConfig;
  } catch {
    return null;
  }
}

function roundToTick(value: number, tick: number) {
  if (!Number.isFinite(tick) || tick <= 0) return value;
  return Number((Math.round(value / tick) * tick).toPrecision(15));
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const body = (await request.json()) as RequestBody;
  const symbol = body.symbol?.trim().toUpperCase() ?? "";
  const thesis = body.thesis?.trim() ?? "";
  if (!Number.isInteger(body.strategyId))
    return Response.json({ error: "请选择用于验证机会的 NEXUS 大脑" }, { status: 400 });
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !symbol.endsWith("USDT"))
    return Response.json({ error: "请选择有效的 USDT 永续合约" }, { status: 400 });
  if (body.direction !== "LONG" && body.direction !== "SHORT")
    return Response.json({ error: "请选择做多或做空方向" }, { status: 400 });
  if (thesis.length < 8 || thesis.length > 1000)
    return Response.json(
      { error: "请用 8–1000 个字符描述判断依据、观察到的变化和预期失效条件" },
      { status: 400 },
    );

  const db = getDb();
  const [[strategy], [contract]] = await Promise.all([
    db
      .select()
      .from(strategies)
      .where(
        and(
          eq(strategies.id, body.strategyId!),
          eq(strategies.ownerEmail, user.email),
        ),
      )
      .limit(1),
    db
      .select()
      .from(contractSymbols)
      .where(
        and(
          eq(contractSymbols.symbol, symbol),
          eq(contractSymbols.isActive, true),
        ),
      )
      .limit(1),
  ]);
  if (!strategy)
    return Response.json({ error: "所选 NEXUS 大脑不存在" }, { status: 404 });
  if (!strategy.brainKey)
    return Response.json(
      { error: "所选大脑缺少不可变身份，请先完成大脑迁移" },
      { status: 409 },
    );
  if (!contract)
    return Response.json({ error: "该币种不在已启用系统合约池" }, { status: 409 });
  const config = parseConfig(strategy.configJson);
  if (!config)
    return Response.json({ error: "大脑已发布参数损坏，请先修复配置" }, { status: 409 });
  // 半自动链路由运营明确指定目标合约。自动扫描范围只约束该大脑自主找币，
  // 不应阻止运营使用同一已发布大脑验证系统合约池中的其他合约。

  const [[account], [credential]] = await Promise.all([
    db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.ownerEmail, user.email),
          eq(tradingAccounts.accountId, strategy.accountId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(exchangeCredentials)
      .where(
        and(
          eq(exchangeCredentials.ownerEmail, user.email),
          eq(exchangeCredentials.accountId, strategy.accountId),
        ),
      )
      .limit(1),
  ]);
  if (!account?.isActive)
    return Response.json(
      { error: "策略账户已停用" },
      { status: 409 },
    );
  if (
    !credential?.liveTradingEnabled ||
    credential.connectionStatus !== "VERIFIED"
  )
    return Response.json(
      { error: "策略账户尚未完成实盘密钥校验" },
      { status: 409 },
    );

  try {
    // Start the public order-flow window before the slower operator analysis.
    // It remains observational and cannot delay or authorize an order.
    await warmNexusBookTicker(symbol);
    const [
      markRows,
      book,
      oneMinute,
      fiveMinute,
      fifteenMinute,
      oneHour,
      btcFifteenMinute,
      btcOneHour,
    ] = await Promise.all([
      getBinanceLiveMarkPrices([symbol]),
      // The first request registers the operator-selected symbol with the
      // dynamic book stream. Wait briefly for the first fresh WS update
      // instead of treating the subscription warm-up as an analysis failure.
      waitForFreshNexusBookTicker(symbol, 2_000, 50),
      nexusUnifiedMarketData.closedCandles({
        symbol,
        interval: "1m",
        limit: 60,
      }),
      nexusUnifiedMarketData.closedCandles({
        symbol,
        interval: "5m",
        limit: 80,
      }),
      nexusUnifiedMarketData.closedCandles({
        symbol,
        interval: "15m",
        limit: 80,
      }),
      nexusUnifiedMarketData.closedCandles({
        symbol,
        interval: "1h",
        limit: 80,
      }),
      nexusUnifiedMarketData.closedCandles({
        symbol: "BTCUSDT",
        interval: "15m",
        limit: 80,
      }),
      nexusUnifiedMarketData.closedCandles({
        symbol: "BTCUSDT",
        interval: "1h",
        limit: 80,
      }),
    ]);
    const mark = markRows[0];
    if (!mark)
      throw new Error("系统 WebSocket 标记价格暂不可用");
    const markAgeMs = Number.isFinite(mark.snapshotAgeMs)
      ? Math.max(0, Number(mark.snapshotAgeMs))
      : Math.max(0, Date.now() - Number(mark.receivedAt || mark.time));
    const markTransportLatencyMs = Number.isFinite(mark.transportLatencyMs)
      ? Math.max(0, Number(mark.transportLatencyMs))
      : Math.max(0, Number(mark.receivedAt || mark.time) - Number(mark.time));
    const regimeInput = [
      ["1m", oneMinute.rows],
      ["5m", fiveMinute.rows],
      ["15m", fifteenMinute.rows],
      ["1h", oneHour.rows],
    ] as const;
    const intervals = regimeInput.map(([interval, candles]) => {
      const result = classifyNexusMarketRegimeFromCandles({
        candles,
        atrPeriod: config.trend.atrPeriod5m ?? 14,
      });
      return {
        interval,
        regime: result.regime,
        reason: result.reason,
        fastEma: result.fastEma,
        slowEma: result.slowEma,
        atr: result.atr,
      };
    });
    const btc15m = classifyNexusMarketRegimeFromCandles({
      candles: btcFifteenMinute.rows,
    });
    const btc1h = classifyNexusMarketRegimeFromCandles({
      candles: btcOneHour.rows,
    });
    const relationship = analyzeNexusBtcRelationship({
      altCandles: fifteenMinute.rows,
      btcCandles: btcFifteenMinute.rows,
      relativeVolumeThreshold: config.trend.volumeRatio3m ?? 1.2,
    });
    const decision = decideSemiAutoOpportunity({
      direction: body.direction,
      // Semi-auto direction is an explicit operator hypothesis. The selected
      // brain supplies published evidence/risk parameters, while real-time
      // evidence must independently confirm or reject either direction.
      strategyDirection: "BOTH",
      markAgeMs,
      markTransportLatencyMs,
      intervals,
      btc15m,
      btc1h,
      relationship,
      minimumIndependentRelativeVolume: config.trend.volumeRatio3m ?? 1.2,
    });
    const entryStructureBaseline = buildEntryStructureBaseline({
      eventTimeMs: Number(mark.time),
      capturedAtMs: Date.now(),
      candles: fiveMinute.rows.map((row) => ({
        ...row,
        closeTime: row.openTime + 5 * 60_000 - 1,
      })),
      atrPeriod: config.trend.atrPeriod5m ?? 14,
    });
    const effectiveDecision =
      decision.verdict === "EXECUTABLE" && !entryStructureBaseline
        ? {
            ...decision,
            verdict: "INSUFFICIENT" as const,
            summary: "缺少入场前闭合K线结构，不能建立可追溯的纪律退出边界",
            missingEvidence: [
              ...decision.missingEvidence,
              "入场前5分钟支撑、阻力与ATR结构基准",
            ],
          }
        : decision;
    const leverage = Math.min(
      20,
      Math.max(1, Math.trunc(config.execution.leverage || 1)),
    );
    const configuredMargin = Math.min(
      config.execution.targetOrderNotionalUsdt,
      config.execution.maxOrderNotionalUsdt,
    );
    const configuredNotional = configuredMargin * leverage;
    const minimumQuantity = effectiveMinimumOrderQuantity(
      contract.minOrderQty,
      contract.quantityStep,
      contract.minNotionalUsdt,
      mark.markPrice,
    );
    const quantity = alignOrderQuantityUp(
      Math.max(configuredNotional / mark.markPrice, minimumQuantity),
      contract.minOrderQty,
      contract.quantityStep,
    );
    const notionalUsdt = quantity * mark.markPrice;
    const configuredOrderType = config.execution.orderType;
    const orderType =
      configuredOrderType === "MARKET" ||
      (configuredOrderType === "ADAPTIVE" &&
        book?.fresh &&
        (book.spreadBps ?? Number.POSITIVE_INFINITY) <= 5)
        ? "MARKET"
        : "LIMIT";
    const offset = Math.max(0, config.execution.limitOffsetPercent ?? 0);
    const limitPrice =
      orderType === "LIMIT"
        ? roundToTick(
            mark.markPrice *
              (body.direction === "LONG"
                ? 1 - offset / 100
                : 1 + offset / 100),
            contract.priceTickSize,
          )
        : null;
    const scenario = semiAutoScenarioEstimate({
      notionalUsdt,
      leverage,
      stopLossRoePercent: config.risk.stopLossPercent,
      takeProfitSteps: config.risk.takeProfitSteps,
    });
    const range = Math.max(
      0,
      (contract.highPrice ?? 0) - (contract.lowPrice ?? 0),
    );
    const position24hPercent =
      range > 0
        ? ((mark.markPrice - (contract.lowPrice ?? mark.markPrice)) / range) *
          100
        : null;

    const analyzedAt = new Date();
    const plan =
      effectiveDecision.verdict === "EXECUTABLE" && entryStructureBaseline
        ? {
            accountId: strategy.accountId,
            symbol,
            direction: body.direction,
            orderType,
            limitPrice,
            cancelAfterMinutes:
              orderType === "LIMIT"
                ? Math.max(
                    1,
                    Math.ceil(
                      (config.execution.orderTtlSeconds || 60) / 60,
                    ),
                  )
                : null,
            referencePrice: mark.markPrice,
            leverage,
            quantity,
            minOrderQty: contract.minOrderQty,
            quantityStep: contract.quantityStep,
            notionalUsdt,
            estimatedInitialMarginUsdt: notionalUsdt / leverage,
            takeProfitSteps: config.risk.takeProfitSteps,
            stopLossRoePercent: config.risk.stopLossPercent,
            trailingActivationRoePercent:
              config.risk.trailingActivationPercent,
            trailingGivebackRoePoints:
              config.risk.trailingDrawdownPercent,
            entryStructureBaseline,
            scenario,
          }
        : null;
    const evidence = {
      intervals,
      btc15m: {
        regime: btc15m.regime,
        label: nexusMarketRegimeLabel(btc15m.regime),
        reason: btc15m.reason,
      },
      btc1h: {
        regime: btc1h.regime,
        label: nexusMarketRegimeLabel(btc1h.regime),
        reason: btc1h.reason,
      },
      relationship: {
        ...relationship,
        label: nexusBtcRelationshipLabel(relationship.state),
      },
      market: {
        markPrice: mark.markPrice,
        markAgeMs,
        bidPrice: book?.bidPrice ?? null,
        askPrice: book?.askPrice ?? null,
        spreadBps: book?.spreadBps ?? null,
        position24hPercent,
        change24hPercent: contract.priceChangePercent,
        quoteVolume24h: contract.quoteVolume24h,
      },
      decision: effectiveDecision,
    };
    const [analysisRecord] = await db
      .insert(semiAutoAnalyses)
      .values({
        ownerEmail: user.email,
        accountId: strategy.accountId,
        strategyId: strategy.id,
        brainKey: strategy.brainKey,
        configVersion: strategy.configVersion,
        symbol,
        positionSide: body.direction,
        horizon: body.horizon ?? "INTRADAY",
        thesis,
        verdict: effectiveDecision.verdict,
        summary: effectiveDecision.summary,
        analysisVersion: effectiveDecision.version,
        evidenceJson: JSON.stringify(evidence),
        planJson: plan ? JSON.stringify(plan) : null,
        createdAt: analyzedAt,
        updatedAt: analyzedAt,
      })
      .returning({ id: semiAutoAnalyses.id });
    const overflow = await db
      .select({ id: semiAutoAnalyses.id })
      .from(semiAutoAnalyses)
      .where(eq(semiAutoAnalyses.ownerEmail, user.email))
      .orderBy(desc(semiAutoAnalyses.id))
      .offset(MAX_ANALYSES_PER_OWNER)
      .limit(200);
    if (overflow.length)
      await db
        .delete(semiAutoAnalyses)
        .where(inArray(semiAutoAnalyses.id, overflow.map((row) => row.id)));

    return Response.json(
      {
        analysisRecordId: analysisRecord.id,
        analyzedAt: analyzedAt.toISOString(),
        confirmationExpiresAt: new Date(
          semiAutoConfirmationExpiresAt(analyzedAt),
        ).toISOString(),
        operatorInput: {
          thesis,
          horizon: body.horizon ?? "INTRADAY",
          direction: body.direction,
        },
        brain: {
          id: strategy.id,
          brainKey: strategy.brainKey,
          name: strategy.name,
          configVersion: strategy.configVersion,
          accountId: strategy.accountId,
        },
        market: {
          symbol,
          markPrice: mark.markPrice,
          markAgeMs,
          bidPrice: book?.bidPrice ?? null,
          askPrice: book?.askPrice ?? null,
          spreadBps: book?.spreadBps ?? null,
          position24hPercent,
          change24hPercent: contract.priceChangePercent,
          quoteVolume24h: contract.quoteVolume24h,
        },
        evidence,
        decision: effectiveDecision,
        plan,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "NEXUS 大脑机会分析失败";
    const failedAt = new Date();
    let analysisRecordId: number | null = null;
    try {
      const [failedRecord] = await db
        .insert(semiAutoAnalyses)
        .values({
          ownerEmail: user.email,
          accountId: strategy.accountId,
          strategyId: strategy.id,
          brainKey: strategy.brainKey,
          configVersion: strategy.configVersion,
          symbol,
          positionSide: body.direction,
          horizon: body.horizon ?? "INTRADAY",
          thesis,
          verdict: "INSUFFICIENT",
          summary: `分析未完成：${message}`,
          analysisVersion: "nexus-semi-auto-preflight-v1",
          evidenceJson: JSON.stringify({
            failure: {
              stage: "REALTIME_EVIDENCE",
              message,
              occurredAt: failedAt.toISOString(),
            },
          }),
          planJson: null,
          createdAt: failedAt,
          updatedAt: failedAt,
        })
        .returning({ id: semiAutoAnalyses.id });
      analysisRecordId = failedRecord?.id ?? null;
    } catch {
      // Preserve the original actionable failure even if diagnostic storage
      // is temporarily unavailable.
    }
    return Response.json(
      {
        error: message,
        analysisRecordId,
      },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:manual:create");
  if (isResponse(user)) return user;
  const rows = await getDb()
    .select()
    .from(semiAutoAnalyses)
    .where(eq(semiAutoAnalyses.ownerEmail, user.email))
    .orderBy(desc(semiAutoAnalyses.id))
    .limit(200);
  return Response.json({
    analyses: rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      strategyId: row.strategyId,
      brainKey: row.brainKey,
      configVersion: row.configVersion,
      symbol: row.symbol,
      direction: row.positionSide,
      horizon: row.horizon,
      thesis: row.thesis,
      verdict: row.verdict,
      summary: row.summary,
      analysisVersion: row.analysisVersion,
      evidence: JSON.parse(row.evidenceJson),
      plan: row.planJson ? JSON.parse(row.planJson) : null,
      liveOrderEventId: row.liveOrderEventId,
      createdAt: row.createdAt.toISOString(),
      confirmationExpiresAt: new Date(
        semiAutoConfirmationExpiresAt(row.createdAt),
      ).toISOString(),
      confirmationStatus: semiAutoConfirmationStatus({
        analyzedAt: row.createdAt,
        verdict: row.verdict,
        liveOrderEventId: row.liveOrderEventId,
      }),
    })),
  });
}
