import { readFile } from "node:fs/promises";

export const MEMORY_GUARD_STATES = Object.freeze({
  NORMAL: "NORMAL",
  PRESSURE_DRAINING: "PRESSURE_DRAINING",
  RECYCLE_READY: "RECYCLE_READY",
  RECOVERING: "RECOVERING",
});

export function parseProcStatusRssBytes(source) {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(String(source || ""));
  return match ? Number(match[1]) * 1024 : 0;
}

export function parseProcChildren(source) {
  return String(source || "")
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

export async function readProcessTreeRssBytes(rootPid) {
  const visited = new Set();
  const queue = [Number(rootPid)];
  let rssBytes = 0;
  while (queue.length) {
    const pid = queue.shift();
    if (!Number.isSafeInteger(pid) || pid <= 0 || visited.has(pid)) continue;
    visited.add(pid);
    try {
      rssBytes += parseProcStatusRssBytes(
        await readFile(`/proc/${pid}/status`, "utf8"),
      );
    } catch {
      continue;
    }
    try {
      queue.push(...parseProcChildren(
        await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"),
      ));
    } catch {
      // A process may exit between status and child enumeration.
    }
  }
  return { rssBytes, processCount: visited.size };
}

export function memoryGuardDecision(input) {
  const rssBytes = Math.max(0, Number(input.rssBytes) || 0);
  const warningBytes = Math.max(1, Number(input.warningBytes) || 1);
  const recoveryBytes = Math.min(
    warningBytes,
    Math.max(0, Number(input.recoveryBytes) || 0),
  );
  const recycleBytes = Math.max(warningBytes, Number(input.recycleBytes) || warningBytes);
  const hardBytes = Math.max(recycleBytes, Number(input.hardBytes) || recycleBytes);
  const highDurationMs = Math.max(0, Number(input.highDurationMs) || 0);
  const safeToRecycle = input.safeToRecycle === true;
  const pressureActive = input.pressureActive === true;
  const drainAfterMs = Math.max(0, Number(input.drainAfterMs) || 0);
  const recycleAfterMs = Math.max(0, Number(input.recycleAfterMs) || 0);
  const forceAfterMs = Math.max(0, Number(input.forceAfterMs) || 0);

  if (pressureActive && rssBytes <= recoveryBytes)
    return {
      state: MEMORY_GUARD_STATES.RECOVERING,
      pressure: false,
      recycle: false,
      forced: false,
      blocked: false,
    };
  if (!pressureActive && rssBytes < warningBytes)
    return {
      state: MEMORY_GUARD_STATES.NORMAL,
      pressure: false,
      recycle: false,
      forced: false,
      blocked: false,
    };

  const hardThresholdReady =
    rssBytes >= hardBytes &&
    highDurationMs >= forceAfterMs;
  const recycleThresholdReady =
    rssBytes >= recycleBytes &&
    highDurationMs >= recycleAfterMs;
  const drainTimeoutReady =
    pressureActive &&
    highDurationMs >= drainAfterMs;
  const recycleReady =
    hardThresholdReady || recycleThresholdReady || drainTimeoutReady;

  if (recycleReady && safeToRecycle)
    return {
      state: MEMORY_GUARD_STATES.RECYCLE_READY,
      pressure: true,
      recycle: true,
      forced: hardThresholdReady,
      blocked: false,
    };
  return {
    state: MEMORY_GUARD_STATES.PRESSURE_DRAINING,
    pressure: true,
    recycle: false,
    forced: false,
    blocked: recycleReady && !safeToRecycle,
  };
}

export function retryAfterDelayMs(value, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.now();
  const fallbackMs = Math.max(0, Number(options.fallbackMs) || 15_000);
  const minimumMs = Math.max(0, Number(options.minimumMs) || 1_000);
  const maximumMs = Math.max(
    minimumMs,
    Number(options.maximumMs) || 300_000,
  );
  const raw = String(value ?? "").trim();
  let delayMs = Number.NaN;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
      delayMs = seconds * 1_000;
    else {
      const retryAtMs = Date.parse(raw);
      if (Number.isFinite(retryAtMs)) delayMs = retryAtMs - nowMs;
    }
  }
  if (!Number.isFinite(delayMs) || delayMs <= 0) delayMs = fallbackMs;
  return Math.min(maximumMs, Math.max(minimumMs, Math.ceil(delayMs)));
}
