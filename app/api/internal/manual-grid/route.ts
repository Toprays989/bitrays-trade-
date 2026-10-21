import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { contractSymbols, exchangeCredentials, livePositions, manualEntryGridLevels, manualEntryGridPlans } from "../../../../db/schema";
import { getBinanceLiveMarkPrices } from "../../../../lib/binance-usdm-live";
import { evaluateManualGridTick, type ManualGridLevelState } from "../../../../lib/manual-entry-grid";
import { buildManualGridExecutionPlan } from "../../../../lib/manual-grid-execution-plan";
import { executeManualGridAddition, executeManualGridFirstEntry } from "../../../../lib/execution/manual-grid-live-executor";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const configured = (env as unknown as { NQ_INTERNAL_RISK_TOKEN?: string }).NQ_INTERNAL_RISK_TOKEN ?? "";
  return configured.length >= 32 && request.headers.get("authorization") === `Bearer ${configured}`;
}

function liveExecutionEnabled() {
  return (env as unknown as { NQ_MANUAL_GRID_LIVE_EXECUTION_ENABLED?: string })
    .NQ_MANUAL_GRID_LIVE_EXECUTION_ENABLED === "true";
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "内部网格触发凭据无效" }, { status: 401 });
  const db = getDb();
  const now = new Date();
  if (!liveExecutionEnabled()) {
    const blocked = await db.update(manualEntryGridPlans).set({
      status: "ERROR",
      lastBlockReason: "MANUAL_GRID_EXECUTOR_NOT_READY",
      updatedAt: now,
      leaseUntil: null,
    }).where(eq(manualEntryGridPlans.status, "ARMED")).returning({ id: manualEntryGridPlans.id });
    return Response.json({
      ok: false,
      blocked: true,
      code: "MANUAL_GRID_EXECUTOR_NOT_READY",
      blockedPlanCount: blocked.length,
      checkedAt: now.toISOString(),
    }, { status: 503 });
  }
  const plans = await db.select().from(manualEntryGridPlans).where(and(
    inArray(manualEntryGridPlans.status, ["ARMED"]),
    or(isNull(manualEntryGridPlans.leaseUntil), lte(manualEntryGridPlans.leaseUntil, now)),
    // Expired plans are marked before any trigger is evaluated.
  )).limit(100);
  let expired = 0;
  let checked = 0;
  let triggered = 0;
  const results: Array<Record<string, unknown>> = [];
  for (const plan of plans) {
    const leaseUntil = new Date(now.getTime() + 5_000);
    const [leasedPlan] = await db.update(manualEntryGridPlans).set({ leaseUntil, updatedAt: now }).where(and(
      eq(manualEntryGridPlans.id, plan.id),
      eq(manualEntryGridPlans.status, "ARMED"),
      or(isNull(manualEntryGridPlans.leaseUntil), lte(manualEntryGridPlans.leaseUntil, now)),
    )).returning({ id: manualEntryGridPlans.id });
    if (!leasedPlan) continue;
    try {
    if (plan.expiresAt && plan.expiresAt.getTime() <= now.getTime()) {
      await db.update(manualEntryGridPlans).set({ status: "EXPIRED", leaseUntil: null, updatedAt: now }).where(eq(manualEntryGridPlans.id, plan.id));
      expired += 1;
      continue;
    }
    const [mark] = await getBinanceLiveMarkPrices([plan.symbol]);
    const currentPrice = Number(mark?.markPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      results.push({ planId: plan.id, status: "NO_FRESH_MARK" });
      continue;
    }
    const rows = await db.select().from(manualEntryGridLevels).where(eq(manualEntryGridLevels.planId, plan.id));
    const states: ManualGridLevelState[] = rows.map((row) => ({ index: row.levelIndex, price: row.levelPrice, triggerCount: row.triggerCount, state: row.state === "WAIT_REARM" ? "WAIT_REARM" : "ARMED" }));
    const evaluated = evaluateManualGridTick({ direction: plan.positionSide, previousPrice: plan.lastPrice, currentPrice, levels: states, hysteresisBps: plan.hysteresisBps });
    await db.update(manualEntryGridPlans).set({ lastPrice: currentPrice, lastPriceAt: now, updatedAt: now }).where(and(eq(manualEntryGridPlans.id, plan.id), eq(manualEntryGridPlans.status, "ARMED"), eq(manualEntryGridPlans.leaseUntil, leaseUntil)));
    const [credential, symbol] = await Promise.all([
      db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, plan.credentialId), eq(exchangeCredentials.ownerEmail, plan.ownerEmail), eq(exchangeCredentials.accountId, plan.accountId))).limit(1).then((rows) => rows[0]),
      db.select().from(contractSymbols).where(eq(contractSymbols.symbol, plan.symbol)).limit(1).then((rows) => rows[0]),
    ]);
    if (!credential || !symbol) throw new Error("网格执行缺少账户密钥或合约规则");
    const [unknownPosition] = await db.select({ id: livePositions.id }).from(livePositions).where(and(eq(livePositions.ownerEmail, plan.ownerEmail), eq(livePositions.accountId, plan.accountId), eq(livePositions.symbol, plan.symbol), eq(livePositions.positionSide, plan.positionSide), eq(livePositions.status, "EXECUTION_UNKNOWN"))).limit(1);
    const executionUnknownCount = unknownPosition ? 1 : 0;
    let activePlan = plan;
    for (const level of evaluated.levels) {
      const row = rows.find((candidate) => candidate.levelIndex === level.index);
      const trigger = evaluated.triggers.find((candidate) => candidate.index === level.index);
      if (!row || trigger) continue;
      await db.update(manualEntryGridLevels).set({ state: level.state, triggerCount: level.triggerCount, updatedAt: now }).where(eq(manualEntryGridLevels.id, row.id));
    }
    // Execute only the actual crossings, in the evaluator's nearest-first
    // order. A failed or unknown fill stops the batch so later levels cannot
    // accidentally open a second independent position.
    for (const trigger of evaluated.triggers) {
      const level = evaluated.levels.find((candidate) => candidate.index === trigger.index);
      const row = rows.find((candidate) => candidate.levelIndex === trigger.index);
      if (!row || !level) continue;
      const executionPlan = buildManualGridExecutionPlan({ planId: activePlan.id, symbol: activePlan.symbol, direction: activePlan.positionSide, quantity: row.quantity, trigger, positionId: activePlan.positionId, positionVersion: activePlan.positionVersion, executionUnknownCount });
      if (executionPlan.kind === "BLOCK_RECONCILIATION") {
        await db.update(manualEntryGridPlans).set({ status: "ERROR", lastBlockReason: executionPlan.reason, updatedAt: now }).where(eq(manualEntryGridPlans.id, plan.id));
        await db.update(manualEntryGridLevels).set({ state: "EXECUTION_UNKNOWN", triggerCount: level.triggerCount, lastTriggerPrice: currentPrice, lastTriggeredAt: now, lastError: executionPlan.reason, updatedAt: now }).where(eq(manualEntryGridLevels.id, row.id));
        break;
      }
      const existingPosition = executionPlan.kind === "ADD_TO_EXISTING_POSITION"
        ? (await db.select().from(livePositions).where(eq(livePositions.id, executionPlan.addition.positionId)).limit(1))[0]
        : null;
      if (executionPlan.kind === "ADD_TO_EXISTING_POSITION" && (!existingPosition || existingPosition.status !== "OPEN")) {
        await db.update(manualEntryGridPlans).set({ status: "ERROR", lastBlockReason: "MANUAL_GRID_POSITION_NOT_OPEN", updatedAt: now }).where(eq(manualEntryGridPlans.id, plan.id));
        await db.update(manualEntryGridLevels).set({ state: "ERROR", triggerCount: level.triggerCount, lastTriggerPrice: currentPrice, lastTriggeredAt: now, lastError: "绑定持仓不存在或已非 OPEN", updatedAt: now }).where(eq(manualEntryGridLevels.id, row.id));
        break;
      }
      let execution;
      try {
        execution = executionPlan.kind === "OPEN_NEW_POSITION"
          ? await executeManualGridFirstEntry({ db, plan: activePlan, order: executionPlan.order, referencePrice: currentPrice, credential, symbol })
          : await executeManualGridAddition({ db, plan: activePlan, position: existingPosition!, order: executionPlan.order, referencePrice: currentPrice, credential, symbol });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.update(manualEntryGridPlans).set({ status: "ERROR", lastError: message, lastBlockReason: "MANUAL_GRID_EXECUTION_ERROR", updatedAt: now }).where(eq(manualEntryGridPlans.id, plan.id));
        await db.update(manualEntryGridLevels).set({ state: "ERROR", triggerCount: level.triggerCount, clientOrderId: executionPlan.order.clientOrderId, lastTriggerPrice: currentPrice, lastTriggeredAt: now, lastError: message, updatedAt: now }).where(eq(manualEntryGridLevels.id, row.id));
        break;
      }
      const nextState = execution.status === "FILLED" ? "FILLED" : execution.status === "EXECUTION_UNKNOWN" ? "EXECUTION_UNKNOWN" : "ERROR";
      await db.update(manualEntryGridLevels).set({ state: nextState, triggerCount: level.triggerCount, clientOrderId: executionPlan.order.clientOrderId, lastTriggerPrice: currentPrice, lastTriggeredAt: now, lastError: execution.status === "ERROR" ? "网格订单执行失败" : null, updatedAt: now }).where(eq(manualEntryGridLevels.id, row.id));
      if (execution.status === "FILLED" && executionPlan.kind === "OPEN_NEW_POSITION" && execution.positionId) {
        await db.update(manualEntryGridPlans).set({ positionId: execution.positionId, positionVersion: 1, updatedAt: now }).where(and(eq(manualEntryGridPlans.id, plan.id), eq(manualEntryGridPlans.status, "ARMED")));
        activePlan = { ...activePlan, positionId: execution.positionId, positionVersion: 1 };
      }
      if (execution.status === "EXECUTION_UNKNOWN") {
        await db.update(manualEntryGridPlans).set({ status: "ERROR", lastBlockReason: "MANUAL_GRID_EXECUTION_UNKNOWN", updatedAt: now }).where(eq(manualEntryGridPlans.id, plan.id));
        break;
      }
      if (execution.status === "ERROR") {
        await db.update(manualEntryGridPlans).set({ status: "ERROR", lastBlockReason: "MANUAL_GRID_EXECUTION_ERROR", updatedAt: now }).where(eq(manualEntryGridPlans.id, plan.id));
        break;
      }
    }
    checked += 1;
    triggered += evaluated.triggers.length;
    results.push({ planId: plan.id, symbol: plan.symbol, currentPrice, previousPrice: plan.lastPrice, triggers: evaluated.triggers });
    } finally {
      await db.update(manualEntryGridPlans).set({ leaseUntil: null, updatedAt: new Date() }).where(and(eq(manualEntryGridPlans.id, plan.id), eq(manualEntryGridPlans.leaseUntil, leaseUntil)));
    }
  }
  return Response.json({ ok: true, plane: "MANUAL_GRID", checked, triggered, expired, results, checkedAt: now.toISOString() });
}
