import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  auditEvents,
  notificationReadStates,
  strategies,
  strategyLearningCycles,
  strategyLearningReviews,
  strategyParameterSuggestions,
} from "../../../../db/schema";
import { isResponse, requirePermission } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const db = getDb();
  const positionNotificationActions = [
    "LIVE_POSITION_OPERATOR_ACTION_REQUIRED",
    "FULL_ACCOUNT_POSITION_MISMATCH",
    "FULL_ACCOUNT_POSITION_RECONCILE_FAILED",
  ];
  const [strategyRows, suggestionRows, positionAlertRows, readStateRows] = await Promise.all([
    user.dataScope === "ALL" ? db.select().from(strategies).orderBy(desc(strategies.updatedAt)).limit(100) : db.select().from(strategies).where(eq(strategies.ownerEmail, user.email)).orderBy(desc(strategies.updatedAt)).limit(100),
    db
      .select()
      .from(strategyParameterSuggestions)
      .where(eq(strategyParameterSuggestions.status, "PENDING"))
      .orderBy(desc(strategyParameterSuggestions.createdAt))
      .limit(100),
    user.dataScope === "ALL"
      ? db.select().from(auditEvents)
          .where(inArray(auditEvents.action, positionNotificationActions))
          .orderBy(desc(auditEvents.createdAt))
          .limit(100)
      : db.select().from(auditEvents)
          .where(and(
            eq(auditEvents.ownerEmail, user.email),
            inArray(auditEvents.action, positionNotificationActions),
          ))
          .orderBy(desc(auditEvents.createdAt))
          .limit(100),
    db.select().from(notificationReadStates).where(eq(notificationReadStates.ownerEmail, user.email)).limit(1),
  ]);

  const visibleStrategies = new Map(
    strategyRows.map((strategy) => [strategy.id, strategy]),
  );
  const visibleStrategyIds = [...visibleStrategies.keys()];
  const learningRows = visibleStrategyIds.length
    ? await db
        .select({
          id: strategyLearningCycles.id,
          learningKey: strategyLearningCycles.learningKey,
          strategyId: strategyLearningCycles.strategyId,
          configVersion: strategyLearningCycles.configVersion,
          exactNetAvailable: strategyLearningCycles.exactNetAvailable,
          detailJson: strategyLearningCycles.detailJson,
          updatedAt: strategyLearningCycles.updatedAt,
        })
        .from(strategyLearningCycles)
        .leftJoin(
          strategyLearningReviews,
          eq(
            strategyLearningCycles.learningKey,
            strategyLearningReviews.learningKey,
          ),
        )
        .where(and(
          inArray(strategyLearningCycles.strategyId, visibleStrategyIds),
          eq(strategyLearningCycles.terminalStatus, "CLOSED"),
          sql`json_extract(${strategyLearningCycles.detailJson}, '$.fastLearning.status') IN ('LEARNED', 'PARTIAL')`,
          sql`${strategyLearningReviews.id} IS NULL`,
        ))
        .orderBy(desc(strategyLearningCycles.updatedAt))
        .limit(30)
    : [];
  const suggestionNotifications = suggestionRows.flatMap((suggestion) => {
    const strategy = visibleStrategies.get(suggestion.strategyId);
    if (!strategy) return [];
    const evidence = safeParse(suggestion.evidenceJson);
    const action = String(evidence.action ?? "OBSERVE");
    // Observation diagnostics remain available in the strategy evidence
    // panel, but they are not parameter changes and must not interrupt the
    // operator. Historical-version suggestions are equally non-actionable.
    if (
      suggestion.configVersion !== strategy.configVersion ||
      !["TIGHTEN", "LOOSEN"].includes(action)
    )
      return [];
    const label = String(evidence.label ?? suggestion.parameterName);
    const confidence = Number(evidence.confidence);
    return [{
      // Suggestion ids are stored in a separate table. Negative ids keep the
      // notification list key stable without colliding with audit-event ids.
      id: -suggestion.id,
      action: "STRATEGY_PARAMETER_SUGGESTION_PENDING",
      resourceId: String(strategy.id),
      strategyId: strategy.id,
      createdAt: suggestion.createdAt,
      severity: "INFO" as const,
      title: "策略参数建议待人工确认",
      message:
        `${strategy.name} · V${suggestion.configVersion} · ${label}` +
        (Number.isFinite(confidence)
          ? ` · 可信度 ${(confidence * 100).toFixed(0)}%`
          : ""),
      destination: "strategies",
    }];
  });
  const reasonLabels: Record<string, string> = {
    CONFIGURED_STOP: "配置止损已触发",
    TAKE_PROFIT: "止盈条件已触发",
    TRAILING_PROTECTION: "移动保护已触发",
    STRUCTURE_INVALIDATION: "持仓结构已失效",
  };
  const learningNotifications = learningRows.flatMap((cycle) => {
    const strategy = visibleStrategies.get(cycle.strategyId);
    if (!strategy) return [];
    const detail = safeParse(cycle.detailJson);
    const memoryCase = asRecord(detail.memoryCase);
    const fastLearning = asRecord(detail.fastLearning);
    const symbol = String(memoryCase.symbol ?? "未知合约");
    const outcome = String(fastLearning.outcome ?? "UNAVAILABLE");
    const outcomeLabel = outcome === "WIN"
      ? "盈利终局"
      : outcome === "LOSS"
        ? "亏损终局"
        : "终局结果";
    return [{
      id: -(1_000_000_000 + cycle.id),
      action: "STRATEGY_LEARNING_SAMPLE_READY",
      resourceId: cycle.learningKey,
      strategyId: cycle.strategyId,
      createdAt: cycle.updatedAt,
      severity: "INFO" as const,
      title: "策略学习样本待运营复核",
      message:
        `${strategy.name} · ${symbol} · V${cycle.configVersion} · ${outcomeLabel}` +
        (cycle.exactNetAvailable ? " · 精确净结算已就绪" : " · 费用待补"),
      destination: "strategies",
    }];
  });
  const positionNotifications = positionAlertRows.map((event) => {
    const detail = safeParse(event.detailJson);
    const symbol = String(detail.symbol ?? "未知合约");
    const side = detail.positionSide === "SHORT" ? "空仓" : "多仓";
    const roe = Number(detail.currentRoePercent);
    const roeText = Number.isFinite(roe) ? ` · ROE ${roe.toFixed(2)}%` : "";
    const accountMismatch =
      event.action === "FULL_ACCOUNT_POSITION_MISMATCH";
    const accountReconcileFailed =
      event.action === "FULL_ACCOUNT_POSITION_RECONCILE_FAILED";
    return {
      id: event.id,
      action: event.action,
      resourceId: event.resourceId,
      createdAt: event.createdAt,
      severity: accountMismatch || accountReconcileFailed
        ? "CRITICAL" as const
        : "WARNING" as const,
      title: accountReconcileFailed
        ? "Binance 仓位定时核对失败"
        : accountMismatch
        ? "Binance 与本地仓位不一致"
        : "仓位等待人工处理",
      message: accountReconcileFailed
        ? `账户仓位核对未完成：${String(detail.message ?? "未知错误")}；系统将在退避后自动重试`
        : accountMismatch
        ? `${symbol} ${side}：本地 ${Number(detail.localQuantity) || 0}，Binance ${Number(detail.exchangeQuantity) || 0}；系统未猜测改账，请核对`
        : `${symbol} ${side}：${reasonLabels[String(detail.reason)] ?? "保护条件已触发"}${roeText}，系统未平仓`,
      destination: "positions",
    };
  });
  const notifications = [
    ...learningNotifications,
    ...suggestionNotifications,
    ...positionNotifications,
  ]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 30);

  return Response.json({ notifications, readThrough: readStateRows[0]?.readThrough ?? null });
}

export async function POST(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  let body: { readThrough?: string | number } = {};
  try { body = await request.json() as typeof body; } catch { /* 空请求表示全部标为已读 */ }
  const now = new Date();
  const requestedMs = body.readThrough === undefined ? now.getTime() : new Date(body.readThrough).getTime();
  if (!Number.isFinite(requestedMs) || requestedMs < 0) return Response.json({ error: "通知已读时间无效" }, { status: 400 });
  const requestedReadThrough = new Date(Math.min(requestedMs, now.getTime()));
  const db = getDb();
  await db.insert(notificationReadStates).values({ ownerEmail: user.email, readThrough: requestedReadThrough, updatedAt: now }).onConflictDoUpdate({
    target: notificationReadStates.ownerEmail,
    set: {
      // The read cursor is monotonic. Referencing the excluded row keeps the
      // comparison inside SQLite and avoids serialising a Date into raw SQL.
      readThrough: sql`MAX(${notificationReadStates.readThrough}, excluded.read_through)`,
      updatedAt: now,
    },
  });
  const [savedState] = await db.select().from(notificationReadStates).where(eq(notificationReadStates.ownerEmail, user.email)).limit(1);
  return Response.json({ readThrough: savedState.readThrough, syncedAcrossDevices: true });
}

function safeParse(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
