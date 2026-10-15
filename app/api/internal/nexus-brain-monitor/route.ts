import {
  NEXUS_BRAIN_BRANCHES,
} from "../../../../lib/nexus-brain-branch-scheduler";

export const dynamic = "force-dynamic";

/**
 * Compatibility manifest only. Production dispatch is owned by the external
 * runner, which gives every branch an independent HTTP request context. Never
 * import or call another route handler here: Workers I/O objects are scoped to
 * the request that created them and cannot safely be shared through cloned
 * request objects, response bodies, or module-global promises.
 */
export async function POST() {
  return Response.json(
    {
      ok: true,
      runtime: "NEXUS_MARKET_BRAIN",
      dispatchOwner: "LIQUIDATION_MONITOR_RUNNER",
      dispatchMode: "SEQUENTIAL_INDEPENDENT_REQUESTS",
      branches: NEXUS_BRAIN_BRANCHES,
      branchCadenceTicks: NEXUS_BRAIN_BRANCHES.length,
      message: "生产大脑由独立监听进程轮转调度；该兼容端点不执行策略分支。",
      checkedAt: new Date().toISOString(),
    },
    { status: 200 },
  );
}
