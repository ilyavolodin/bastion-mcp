import type {
  Clock,
  FetchInit,
  FetchLike,
  GuardCache,
  GuardInput,
  GuardPhase,
  RiskState,
  RiskStore,
  SecretResolver,
  TextSegment,
} from '../src';

export const input = (
  phase: GuardPhase,
  segments: TextSegment[],
  extra: Partial<GuardInput> = {},
): GuardInput => ({
  phase,
  segments,
  principal: { principalId: 'p1', clientId: 'c1' },
  installation: { installationId: 'inst-1', slug: 'github' },
  item: { kind: 'tool', name: 'get_file_contents' },
  method: 'tools/call',
  ...extra,
});

export const seg = (
  text: string,
  path = 'content[0].text',
  extra: Partial<TextSegment> = {},
): TextSegment => ({
  path,
  text,
  ...extra,
});

export const signal = (): AbortSignal => new AbortController().signal;

export class FakeClock implements Clock {
  constructor(public t = 1_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class MemoryCache implements GuardCache {
  readonly store = new Map<string, { value: string; ttl: number }>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, ttl: ttlSeconds });
  }
}

export class MemoryRiskStore implements RiskStore {
  readonly states = new Map<string, RiskState>();
  async get(principalId: string, clientId: string): Promise<RiskState | null> {
    return this.states.get(`${principalId}:${clientId}`) ?? null;
  }
  async set(principalId: string, clientId: string, state: RiskState): Promise<void> {
    this.states.set(`${principalId}:${clientId}`, state);
  }
}

export const secrets = (map: Record<string, string>): SecretResolver => ({
  async resolve(name) {
    const v = map[name];
    if (v === undefined) throw new Error(`no secret ${name}`);
    return v;
  },
});

export type Call = { url: string; init: FetchInit; body: unknown };

/** A fetch that replays recorded bodies in order and records each request. */
export const recordedFetch = (
  responses: (unknown | ((call: Call) => unknown))[],
): { fetch: FetchLike; calls: Call[] } => {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    const r = responses[Math.min(i++, responses.length - 1)];
    const body = typeof r === 'function' ? (r as (c: Call) => unknown)(call) : r;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
};

/** A fetch that never answers until its signal aborts. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new Error('aborted'));
    init.signal.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });

export const statusFetch =
  (status: number): FetchLike =>
  async () => ({ ok: false, status, json: async () => ({}) });

/** The parsed JSON body of a recorded call, typed by the caller. */
export const bodyOf = <T>(call: Call | undefined): T => {
  if (call === undefined) throw new Error('no call was recorded');
  return call.body as T;
};
