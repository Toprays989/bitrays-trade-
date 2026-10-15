export type SimpleReboundCycleRunner<T> = (nowMs: number) => Promise<T> | T;

/**
 * Independent scheduler boundary for Simple Rebound. A slow cycle cannot
 * overlap the next tick, which prevents duplicate signals and slot races.
 */
export function createSimpleReboundScheduler<T>(input: Readonly<{
  runCycle: SimpleReboundCycleRunner<T>;
  intervalMs?: number;
  now?: () => number;
}>) {
  const intervalMs = Math.max(250, Math.trunc(input.intervalMs ?? 2_000));
  const now = input.now ?? (() => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastRunAtMs: number | null = null;

  async function tick() {
    if (running) return { skipped: true as const, value: null };
    running = true;
    const startedAtMs = now();
    lastRunAtMs = startedAtMs;
    try {
      return { skipped: false as const, value: await input.runCycle(startedAtMs) };
    } finally {
      running = false;
    }
  }

  return {
    intervalMs,
    tick,
    start() {
      if (timer) return false;
      timer = setInterval(() => void tick(), intervalMs);
      return true;
    },
    stop() {
      if (!timer) return false;
      clearInterval(timer);
      timer = null;
      return true;
    },
    isRunning: () => running,
    lastRunAt: () => lastRunAtMs,
  };
}
