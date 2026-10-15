import { env } from "cloudflare:workers";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  liveOrderEvents,
  livePositionAdditions,
  strategyExecutionTraces,
} from "../../../../db/schema";
import {
  runtimeMemoryPressureState,
  setRuntimeMemoryPressure,
} from "../../../../lib/runtime-memory-pressure";
import { LIVE_ORDER_WORKING_STATUSES } from "../../../../lib/live-order-status";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const configured = (
    env as unknown as { NQ_INTERNAL_LIQUIDATION_TOKEN?: string }
  ).NQ_INTERNAL_LIQUIDATION_TOKEN ?? "";
  return configured.length >= 32 &&
    request.headers.get("authorization") === `Bearer ${configured}`;
}

export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "内部运行控制凭据无效" }, { status: 401 });
  const payload = await request.json().catch(() => ({})) as {
    marketAnalysisPaused?: unknown;
    reason?: unknown;
    phase?: unknown;
  };
  if (typeof payload.marketAnalysisPaused === "boolean")
    setRuntimeMemoryPressure({
      marketAnalysisPaused: payload.marketAnalysisPaused,
      phase: payload.phase,
      reason: payload.marketAnalysisPaused
        ? String(payload.reason ?? "PROCESS_RSS_HIGH").slice(0, 120)
        : null,
    });

  const db = getDb();
  const [orderRows, additionRows, traceRows] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)` })
      .from(liveOrderEvents)
      .where(inArray(
        liveOrderEvents.status,
        [...LIVE_ORDER_WORKING_STATUSES],
      )),
    db
      .select({ value: sql<number>`count(*)` })
      .from(livePositionAdditions)
      .where(and(
        inArray(livePositionAdditions.status, [
          "PENDING",
          "SUBMITTED",
          "EXECUTION_UNKNOWN",
        ]),
        isNull(livePositionAdditions.appliedPositionVersion),
      )),
    db
      .select({ value: sql<number>`count(*)` })
      .from(strategyExecutionTraces)
      .where(inArray(strategyExecutionTraces.state, [
        "ORDER_PENDING",
        "EXECUTION_UNKNOWN",
        "EXIT_PENDING",
      ])),
  ]);
  const activeOrders = normalizedCount(orderRows[0]?.value);
  const activeAdditions = normalizedCount(additionRows[0]?.value);
  const activeExecutionTraces = normalizedCount(traceRows[0]?.value);
  return Response.json({
    ok: true,
    pressure: runtimeMemoryPressureState(),
    activeOrders,
    activeAdditions,
    activeExecutionTraces,
    safeToRecycle:
      activeOrders === 0 &&
      activeAdditions === 0 &&
      activeExecutionTraces === 0,
    checkedAt: new Date().toISOString(),
  });
}

function normalizedCount(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
