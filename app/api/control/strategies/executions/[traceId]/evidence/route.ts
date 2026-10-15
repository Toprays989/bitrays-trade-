import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../../../../db";
import {
  strategyExecutionTraces,
  strategyPositionEvidence,
} from "../../../../../../../db/schema";
import { positionObservationCausalLearningEligible } from "../../../../../../../lib/position-observation-timing";
import { isResponse, requirePermission } from "../../../../shared";

export async function GET(
  request: Request,
  context: { params: Promise<{ traceId: string }> },
) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const { traceId } = await context.params;
  if (!/^[A-Za-z0-9:_-]{8,100}$/.test(traceId))
    return Response.json({ error: "执行链路编号无效" }, { status: 400 });
  const [trace] = await getDb()
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.traceId, traceId),
        eq(strategyExecutionTraces.ownerEmail, user.email),
      ),
    )
    .limit(1);
  if (!trace)
    return Response.json({ error: "执行链路不存在或无权查看" }, { status: 404 });
  const rows = await getDb()
    .select()
    .from(strategyPositionEvidence)
    .where(
      and(
        eq(strategyPositionEvidence.traceId, traceId),
        eq(strategyPositionEvidence.strategyId, trace.strategyId),
      ),
    )
    .orderBy(asc(strategyPositionEvidence.minuteOffset));
  return Response.json({
    traceId,
    evidence: rows.map((row) => {
      const detail = safeParse(row.evidenceJson);
      const causalLearningEligible = positionObservationCausalLearningEligible({
        ...row,
        timing: asRecord(detail).observationTiming,
      });
      return {
        ...row,
        detail,
        causalLearningEligible,
        learningUse: causalLearningEligible
          ? "PARAMETER_LEARNING"
          : "HISTORICAL_ONLY",
        evidenceJson: undefined,
      };
    }),
  });
}

function safeParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
