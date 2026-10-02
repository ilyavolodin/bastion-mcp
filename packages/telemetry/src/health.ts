/** Health framework (15.7): per-check timeouts, per-check JSON. */

export interface HealthCheckResult {
  ok: boolean;
  detail?: unknown;
}
export type HealthCheck = (signal: AbortSignal) => Promise<HealthCheckResult | boolean | undefined>;

export interface CheckReport {
  ok: boolean;
  detail: unknown;
}
export interface HealthReport {
  ok: boolean;
  checks: Record<string, CheckReport>;
}

export interface HealthRegistryOptions {
  /** Default per-check timeout (ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

const normalize = (value: HealthCheckResult | boolean | undefined): CheckReport => {
  if (typeof value === 'boolean') return { ok: value, detail: null };
  if (value === undefined) return { ok: true, detail: null };
  return { ok: value.ok, detail: value.detail ?? null };
};

const runOne = async (check: HealthCheck, timeoutMs: number): Promise<CheckReport> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckReport>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, detail: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([check(controller.signal).then(normalize), timeout]);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export class HealthRegistry {
  private readonly checks = new Map<string, { check: HealthCheck; timeoutMs: number }>();
  private readonly defaultTimeoutMs: number;

  constructor(options: HealthRegistryOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  register(name: string, check: HealthCheck, options: { timeoutMs?: number } = {}): void {
    this.checks.set(name, { check, timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs });
  }

  names(): string[] {
    return [...this.checks.keys()];
  }

  /** Run every check concurrently, each with its own timeout and `AbortSignal`. Never rejects. */
  async run(): Promise<HealthReport> {
    const entries = [...this.checks.entries()];
    const reports = await Promise.all(
      entries.map(
        async ([name, { check, timeoutMs }]) => [name, await runOne(check, timeoutMs)] as const,
      ),
    );
    const checks: Record<string, CheckReport> = {};
    for (const [name, report] of reports) checks[name] = report;
    return { ok: reports.every(([, r]) => r.ok), checks };
  }

  /** `GET /healthz`: the process is alive; no dependency is consulted. */
  liveness(): { ok: true } {
    return { ok: true };
  }
}
