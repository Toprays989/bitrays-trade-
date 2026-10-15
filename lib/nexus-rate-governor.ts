export type NexusRateDomain = "REST_IP" | "WS_IP" | "ORDER_UID";

export type NexusRateLimitConfig = {
  limit: number;
  windowMs: number;
  emergencyReserve: number;
};

type WindowState = {
  startedAt: number;
  used: number;
};

type CircuitState = {
  until: number;
  status: 418 | 429;
};

export class NexusRateGovernor {
  private readonly windows = new Map<string, WindowState>();
  private readonly circuits = new Map<string, CircuitState>();
  private readonly limits: Record<NexusRateDomain, NexusRateLimitConfig>;

  constructor(limits: Record<NexusRateDomain, NexusRateLimitConfig>) {
    this.limits = limits;
  }

  reserve(input: {
    domain: NexusRateDomain;
    scope: string;
    cost: number;
    emergency?: boolean;
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    const config = this.limits[input.domain];
    const key = `${input.domain}:${input.scope}`;
    const circuit = this.circuits.get(key);
    if (circuit && circuit.until > now)
      return {
        allowed: false,
        reason: circuit.status === 418 ? "HARD_CIRCUIT" : "BACKOFF",
        retryAfterMs: circuit.until - now,
        used: this.windows.get(key)?.used ?? 0,
        limit: config.limit,
      } as const;
    if (circuit) this.circuits.delete(key);
    let window = this.windows.get(key);
    if (!window || window.startedAt + config.windowMs <= now) {
      window = { startedAt: now, used: 0 };
      this.windows.set(key, window);
    }
    const cost = Math.max(0, input.cost);
    const usableLimit = input.emergency
      ? config.limit
      : Math.max(0, config.limit - config.emergencyReserve);
    if (window.used + cost > usableLimit)
      return {
        allowed: false,
        reason: input.emergency ? "LIMIT_EXHAUSTED" : "EMERGENCY_RESERVED",
        retryAfterMs: window.startedAt + config.windowMs - now,
        used: window.used,
        limit: usableLimit,
      } as const;
    window.used += cost;
    return {
      allowed: true,
      reason: "RESERVED",
      retryAfterMs: 0,
      used: window.used,
      limit: usableLimit,
    } as const;
  }

  openCircuit(input: {
    domain: NexusRateDomain;
    scope: string;
    status: 418 | 429;
    retryAfterMs: number;
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    this.circuits.set(`${input.domain}:${input.scope}`, {
      status: input.status,
      until: now + Math.max(1, input.retryAfterMs),
    });
  }

  snapshot(now = Date.now()) {
    return {
      windows: [...this.windows.entries()].map(([key, value]) => ({
        key,
        ...value,
      })),
      circuits: [...this.circuits.entries()]
        .filter(([, value]) => value.until > now)
        .map(([key, value]) => ({ key, ...value })),
    };
  }
}
