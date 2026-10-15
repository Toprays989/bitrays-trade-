import { spawn } from "node:child_process";
import { connect } from "node:net";
import {
  MEMORY_GUARD_STATES,
  memoryGuardDecision,
  readProcessTreeRssBytes,
} from "./process-memory-guard.mjs";

const port = Number(process.env.PORT || 3000);
const graceMs = Math.max(
  30_000,
  Number(process.env.NQ_APP_SUPERVISOR_GRACE_MS || 60_000),
);
const probeIntervalMs = Math.max(
  5_000,
  Number(process.env.NQ_APP_SUPERVISOR_INTERVAL_MS || 10_000),
);
const failureLimit = Math.max(
  6,
  Number(process.env.NQ_APP_SUPERVISOR_FAILURE_LIMIT || 6),
);
const degradedWarningLimit = Math.min(3, failureLimit - 1);
const internalToken = process.env.NQ_INTERNAL_LIQUIDATION_TOKEN || "";
const memoryWarningBytes = Math.max(
  512 * 1024 ** 2,
  Number(process.env.NQ_APP_MEMORY_WARNING_BYTES || 2 * 1024 ** 3),
);
const memoryRecycleBytes = Math.max(
  memoryWarningBytes,
  Number(process.env.NQ_APP_MEMORY_RECYCLE_BYTES || 3 * 1024 ** 3),
);
const memoryHardBytes = Math.max(
  memoryRecycleBytes,
  Number(process.env.NQ_APP_MEMORY_HARD_BYTES || 3.75 * 1024 ** 3),
);
const memoryRecoveryBytes = Math.min(
  memoryWarningBytes,
  Math.max(
    512 * 1024 ** 2,
    Number(
      process.env.NQ_APP_MEMORY_RECOVERY_BYTES ||
        memoryWarningBytes * 0.9,
    ),
  ),
);
const memoryRecycleAfterMs = Math.max(
  30_000,
  Number(process.env.NQ_APP_MEMORY_RECYCLE_AFTER_MS || 30_000),
);
const memoryForceAfterMs = Math.max(
  60_000,
  Number(process.env.NQ_APP_MEMORY_FORCE_AFTER_MS || 90_000),
);
const memoryDrainAfterMs = Math.max(
  60_000,
  Number(process.env.NQ_APP_MEMORY_DRAIN_AFTER_MS || 90_000),
);

const app = spawn(
  "node",
  ["/app/deploy/production-runtime.mjs"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      MINIFLARE_CACHE_DIR: "/var/lib/nexus-quant/wrangler/cache",
      NQ_MINIFLARE_PERSIST_ROOT: "/var/lib/nexus-quant/wrangler/state/v3/v3",
      NQ_RUNTIME_ENV_FILE: "/app/.runtime.env",
      NQ_WRANGLER_CONFIG: "/app/dist/server/wrangler.json",
    },
  },
);

let stopping = false;
let consecutiveConnectionFailures = 0;
let degradedWarningReported = false;
let probeTimer = null;
let memoryPressureStartedAt = 0;
let memoryPressureSignaled = false;
let memoryRecycleBlockedReported = false;
let memoryGuardState = MEMORY_GUARD_STATES.NORMAL;
let lastRssBytes = 0;
let lastProcessCount = 0;

function stop(signal = "SIGTERM", exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (probeTimer) clearTimeout(probeTimer);
  if (!app.killed) app.kill(signal);
  const forceTimer = setTimeout(() => {
    if (!app.killed) app.kill("SIGKILL");
  }, 5_000);
  forceTimer.unref();
  app.once("exit", () => process.exit(exitCode));
}

function tcpProbe() {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function updateRuntimePressure(paused, reason, phase) {
  if (internalToken.length < 32) return null;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/internal/runtime-control`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${internalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          marketAnalysisPaused: paused,
          reason,
          phase,
        }),
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function probe() {
  if (stopping) return;
  const [listening, processMemory] = await Promise.all([
    tcpProbe(),
    readProcessTreeRssBytes(app.pid),
  ]);
  lastRssBytes = processMemory.rssBytes;
  lastProcessCount = processMemory.processCount;
  if (listening) {
    if (degradedWarningReported) {
      console.info(
        JSON.stringify({
          level: "info",
          service: "app-supervisor",
          code: "APP_PORT_RECOVERED",
          action: "KEEP_CONTAINER",
          at: new Date().toISOString(),
        }),
      );
    }
    consecutiveConnectionFailures = 0;
    degradedWarningReported = false;
  } else {
    consecutiveConnectionFailures += 1;
  }
  if (
    !listening &&
    !degradedWarningReported &&
    consecutiveConnectionFailures >= degradedWarningLimit
  ) {
    degradedWarningReported = true;
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "app-supervisor",
        code: "APP_PORT_DEGRADED",
        consecutiveConnectionFailures,
        failureLimit,
        action: "WAIT_FOR_RECOVERY",
        at: new Date().toISOString(),
      }),
    );
  }
  if (consecutiveConnectionFailures >= failureLimit) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "app-supervisor",
        code: "APP_PORT_NOT_LISTENING",
        consecutiveConnectionFailures,
        action: "RESTART_CONTAINER",
        at: new Date().toISOString(),
      }),
    );
    stop("SIGTERM", 1);
    return;
  }
  if (memoryGuardState === MEMORY_GUARD_STATES.RECOVERING) {
    if (lastRssBytes < memoryWarningBytes) {
      const normalState = await updateRuntimePressure(
        false,
        "PROCESS_TREE_RSS_NORMAL",
        MEMORY_GUARD_STATES.NORMAL,
      );
      if (normalState !== null)
        memoryGuardState = MEMORY_GUARD_STATES.NORMAL;
    } else {
      memoryGuardState = MEMORY_GUARD_STATES.NORMAL;
    }
  }

  const pressureActive =
    memoryGuardState === MEMORY_GUARD_STATES.PRESSURE_DRAINING ||
    memoryGuardState === MEMORY_GUARD_STATES.RECYCLE_READY;
  const preliminaryDecision = memoryGuardDecision({
    rssBytes: lastRssBytes,
    warningBytes: memoryWarningBytes,
    recoveryBytes: memoryRecoveryBytes,
    recycleBytes: memoryRecycleBytes,
    hardBytes: memoryHardBytes,
    highDurationMs: memoryPressureStartedAt
      ? Date.now() - memoryPressureStartedAt
      : 0,
    drainAfterMs: memoryDrainAfterMs,
    recycleAfterMs: memoryRecycleAfterMs,
    forceAfterMs: memoryForceAfterMs,
    pressureActive,
    safeToRecycle: false,
  });

  if (preliminaryDecision.state === MEMORY_GUARD_STATES.RECOVERING) {
    const runtimeState = await updateRuntimePressure(
      false,
      "PROCESS_TREE_RSS_RECOVERED",
      MEMORY_GUARD_STATES.RECOVERING,
    );
    if (runtimeState !== null) {
      memoryGuardState = MEMORY_GUARD_STATES.RECOVERING;
      memoryPressureStartedAt = 0;
      memoryPressureSignaled = false;
      memoryRecycleBlockedReported = false;
      console.info(JSON.stringify({
        level: "info",
        service: "app-supervisor",
        code: "APP_MEMORY_RECOVERED",
        state: memoryGuardState,
        rssBytes: lastRssBytes,
        recoveryBytes: memoryRecoveryBytes,
        marketAnalysisPaused: false,
        at: new Date().toISOString(),
      }));
    }
  } else if (
    preliminaryDecision.state === MEMORY_GUARD_STATES.PRESSURE_DRAINING
  ) {
    const enteringPressure = !pressureActive;
    if (!memoryPressureStartedAt) memoryPressureStartedAt = Date.now();
    const runtimeState = await updateRuntimePressure(
      true,
      "PROCESS_TREE_RSS_HIGH",
      MEMORY_GUARD_STATES.PRESSURE_DRAINING,
    );
    if (runtimeState !== null) memoryPressureSignaled = true;
    const decision = memoryGuardDecision({
      rssBytes: lastRssBytes,
      warningBytes: memoryWarningBytes,
      recoveryBytes: memoryRecoveryBytes,
      recycleBytes: memoryRecycleBytes,
      hardBytes: memoryHardBytes,
      highDurationMs: Date.now() - memoryPressureStartedAt,
      drainAfterMs: memoryDrainAfterMs,
      recycleAfterMs: memoryRecycleAfterMs,
      forceAfterMs: memoryForceAfterMs,
      pressureActive: true,
      safeToRecycle: runtimeState?.safeToRecycle === true,
    });
    memoryGuardState = decision.state;
    if (enteringPressure) {
      console.warn(JSON.stringify({
        level: "warn",
        service: "app-supervisor",
        code: "APP_MEMORY_PRESSURE",
        state: memoryGuardState,
        rssBytes: lastRssBytes,
        processCount: lastProcessCount,
        marketAnalysisPaused: memoryPressureSignaled,
        at: new Date().toISOString(),
      }));
    }
    if (decision.blocked && !memoryRecycleBlockedReported) {
      memoryRecycleBlockedReported = true;
      console.error(JSON.stringify({
        level: "error",
        service: "app-supervisor",
        code: "APP_MEMORY_RECYCLE_BLOCKED",
        state: memoryGuardState,
        rssBytes: lastRssBytes,
        activeOrders: runtimeState?.activeOrders ?? null,
        activeAdditions: runtimeState?.activeAdditions ?? null,
        activeExecutionTraces: runtimeState?.activeExecutionTraces ?? null,
        action: "KEEP_CONTAINER_AND_PAUSE_MARKET_ANALYSIS",
        at: new Date().toISOString(),
      }));
    }
    if (decision.recycle) {
      await updateRuntimePressure(
        true,
        "PROCESS_TREE_RSS_RECYCLE_READY",
        MEMORY_GUARD_STATES.RECYCLE_READY,
      );
      console.error(JSON.stringify({
        level: "error",
        service: "app-supervisor",
        code: decision.forced
          ? "APP_MEMORY_FORCED_RECYCLE"
          : "APP_MEMORY_SAFE_RECYCLE",
        state: MEMORY_GUARD_STATES.RECYCLE_READY,
        rssBytes: lastRssBytes,
        activeOrders: runtimeState?.activeOrders ?? null,
        activeAdditions: runtimeState?.activeAdditions ?? null,
        activeExecutionTraces: runtimeState?.activeExecutionTraces ?? null,
        action: "RESTART_CONTAINER",
        at: new Date().toISOString(),
      }));
      stop("SIGTERM", 1);
      return;
    }
  }
  probeTimer = setTimeout(probe, probeIntervalMs);
}

app.once("exit", (code, signal) => {
  if (stopping) return;
  stopping = true;
  if (probeTimer) clearTimeout(probeTimer);
  process.exit(code ?? (signal ? 1 : 0));
});
app.once("error", (error) => {
  console.error(
    JSON.stringify({
      level: "error",
      service: "app-supervisor",
      code: "APP_PROCESS_START_FAILED",
      message: error.message,
      at: new Date().toISOString(),
    }),
  );
  process.exit(1);
});

process.on("SIGTERM", () => stop("SIGTERM", 0));
process.on("SIGINT", () => stop("SIGINT", 0));
probeTimer = setTimeout(probe, graceMs);
