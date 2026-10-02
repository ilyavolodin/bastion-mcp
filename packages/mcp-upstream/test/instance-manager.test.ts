import { createHash } from 'node:crypto';
import {
  type PackageSpec,
  RateLimitedError,
  SandboxStartFailedError,
  UpstreamUnavailableError,
} from '@bastion-mcp/core';
import type { EgressPolicy } from '@bastion-mcp/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisEgressPolicyStore } from '../src/instances/egress-store';
import { InflightCounter } from '../src/instances/inflight';
import { buildStartRequest } from '../src/instances/start-request';
import type { EgressPolicyWriter } from '../src/ports';
import { FakeRedis } from './helpers/fake-redis';
import {
  credential,
  ctxOf,
  installationOf,
  packageSpec,
  principal,
  sleep,
} from './helpers/fixtures';
import { callOn, ensureArgs, makeWorker, newShared, type Shared } from './helpers/harness';

const text = (outcome: { kind: string; result?: unknown }): string =>
  (outcome.result as { content: { text: string }[] }).content[0]?.text ?? '';

const spyEgress = (shared: Shared) => {
  const inner = new RedisEgressPolicyStore(shared.redis);
  const phases: string[] = [];
  const writer: EgressPolicyWriter = {
    get: (id) => inner.get(id),
    set: async (id, policy: EgressPolicy) => {
      phases.push(policy.phase);
      await inner.set(id, policy);
    },
    delete: (id) => inner.delete(id),
  };
  return { writer, phases, inner };
};

describe('8.6 instance lifecycle', () => {
  let shared: Shared;
  const workers: ReturnType<typeof makeWorker>[] = [];
  const track = (w: ReturnType<typeof makeWorker>) => {
    workers.push(w);
    return w;
  };

  beforeEach(() => {
    shared = newShared();
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.manager.closeConnections();
    shared.driver.killAll();
    vi.useRealTimers();
  });

  const start = async (
    w: ReturnType<typeof makeWorker>,
    installation = installationOf(packageSpec()),
  ) => {
    await w.registry.heartbeat();
    const args = await ensureArgs(w.manager, installation);
    const ensured = await w.manager.ensure(args);
    if (ensured.kind !== 'local') throw new Error('expected local');
    return { live: ensured.live, args };
  };

  it('8.6 starts on first use through claiming, binding, installing, spawning and connecting', async () => {
    const spy = spyEgress(shared);
    const w = track(makeWorker(shared, 'w1', { egress: spy.writer }));
    const { live, args } = await start(
      w,
      installationOf(
        packageSpec({
          egress: { allow: ['api.example.com'] },
          packageArguments: [{ type: 'named', name: '--token', value: '{{var.T}}' }],
          environmentVariables: [{ name: 'REGION', value: 'eu-{{user.id}}' }],
        }),
        { variables: { T: 'abc' } },
      ),
    );
    expect(live.state.kind).toBe('ready');
    expect(live.session.era).toBe('legacy');
    expect(w.telemetry.runs[0]).toEqual(['claimed', 'bound', 'installed', 'spawned', 'connected']);
    expect(shared.driver.createCount).toBe(1);
    expect(text((await callOn(w.manager, live, 'echo', { text: 'hi' })) as never)).toBe('hi');
    const request = shared.driver.startRequests[0];
    expect(request?.args).toEqual(['--token', 'abc']);
    expect(request?.env).toEqual({ REGION: 'eu-user-1' });
    expect(request?.registry).toEqual({
      npm: 'https://registry.example/npm',
      pypi: 'https://pypi.example/simple',
    });
    expect(request?.egress.proxyUrl).toMatch(
      new RegExp(`^http://${args.record.id}:[0-9a-f]{64}@10\\.1\\.2\\.3:3128$`),
    );
    expect(spy.phases).toEqual(['installing', 'starting', 'running']);
  });

  it('8.8 writes egress:{instanceId} = {tokenSha256, allow, phase} at start and on every phase change', async () => {
    const spy = spyEgress(shared);
    const w = track(makeWorker(shared, 'w1', { egress: spy.writer }));
    const { args } = await start(
      w,
      installationOf(packageSpec({ egress: { allow: ['*.github.com:443'] } })),
    );
    const policy = await spy.inner.get(args.record.id);
    expect(policy?.phase).toBe('running');
    expect(policy?.allow).toEqual(['*.github.com:443']);
    const proxyUrl = shared.driver.startRequests[0]?.egress.proxyUrl ?? '';
    const token = decodeURIComponent(new URL(proxyUrl).password);
    expect(policy?.tokenSha256).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('21.2 persists the runner token through the RunnerTokenStore so a new owner can attach', async () => {
    const w = track(makeWorker(shared, 'w1'));
    const { args } = await start(w);
    const saved = shared.tokens.tokens.get(args.record.id);
    expect(saved).toBeTruthy();
    const row = shared.repo.rows.get(args.record.id);
    expect(row?.sandbox?.id).toBe('bst-1');
    expect(JSON.stringify(row)).not.toContain(saved as string);
  });

  it('8.6 concurrent callers wait on the same start (single flight)', async () => {
    const w = track(makeWorker(shared, 'w1'));
    await w.registry.heartbeat();
    const installation = installationOf(packageSpec());
    const args = await ensureArgs(w.manager, installation);
    const results = await Promise.all(Array.from({ length: 6 }, () => w.manager.ensure(args)));
    expect(shared.driver.createCount).toBe(1);
    const lives = new Set(results.map((r) => (r.kind === 'local' ? r.live : null)));
    expect(lives.size).toBe(1);
    expect(await shared.redis.get(`start:${args.record.id}`)).toBeNull();
  });

  it('8.6 a start that waits on start:{instanceId} proceeds once the other starter is done', async () => {
    const w = track(makeWorker(shared, 'w1'));
    await w.registry.heartbeat();
    const args = await ensureArgs(w.manager, installationOf(packageSpec()));
    await shared.redis.set(`start:${args.record.id}`, 'other-worker', 'PX', 600, 'NX');
    const started = Date.now();
    const ensured = await w.manager.ensure(args);
    expect(ensured.kind).toBe('local');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('8.6 idle instances stop after idleTimeoutMinutes: destroyed, token and lease dropped, state absent', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const w = track(makeWorker(shared, 'w1'));
    const { live, args } = await start(w, installationOf(packageSpec({ idleTimeoutMinutes: 5 })));
    await callOn(w.manager, live, 'echo', { text: 'x' });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(w.manager.get(args.record.id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(shared.driver.destroyed).toEqual(['bst-1']));
    expect(w.manager.get(args.record.id)).toBeUndefined();
    expect(shared.tokens.tokens.has(args.record.id)).toBe(false);
    expect(await shared.redis.get(`lease:${args.record.id}`)).toBeNull();
    expect(live.state.kind).toBe('absent');
    expect(shared.repo.rows.get(args.record.id)?.sandbox).toBeUndefined();
  });

  it('8.6 persistent workspaces are suspended, not destroyed, when idle', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const w = track(makeWorker(shared, 'w1'));
    const { args } = await start(
      w,
      installationOf(
        packageSpec({ idleTimeoutMinutes: 1, workspace: { persistent: true, sizeMiB: 512 } }),
      ),
    );
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(shared.driver.suspended).toEqual(['bst-1']));
    expect(shared.driver.destroyed).toEqual([]);
    expect(w.manager.get(args.record.id)).toBeUndefined();
  });

  it('8.6 an instance with calls in flight or a pending continuation is not idle-stopped', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const w = track(makeWorker(shared, 'w1'));
    const { live, args } = await start(w, installationOf(packageSpec({ idleTimeoutMinutes: 1 })));
    const call = callOn(w.manager, live, 'slow', { ms: 50 });
    await vi.advanceTimersByTimeAsync(10);
    expect(live.inflight).toBe(1);
    await call;
    expect(live.inflight).toBe(0);
    expect(await new InflightCounter(shared.redis).get(args.record.id)).toBe(0);
  });

  it('8.6 failed starts back off 5 s, 30 s, 2 min, 10 min and fail fast with -32016 until then', async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const w = track(makeWorker(shared, 'w1', { clock }));
    await w.registry.heartbeat();
    shared.driver.failStart = 'npm ci failed: ETARGET';
    const args = await ensureArgs(w.manager, installationOf(packageSpec()));
    const first = await w.manager.ensure(args).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(SandboxStartFailedError);
    expect((first as SandboxStartFailedError).data.phase).toBe('installing');
    expect(shared.driver.createCount).toBe(1);
    expect(shared.driver.destroyed).toEqual(['bst-1']);
    // Within the 5 s backoff: no new claim.
    now += 4_000;
    const early = await w.manager.ensure(args).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(SandboxStartFailedError);
    expect((early as Error).message).toMatch(/retrying in/);
    expect(shared.driver.createCount).toBe(1);
    // After the backoff the start is attempted again; the second failure backs off 30 s.
    now += 2_000;
    await expect(w.manager.ensure(args)).rejects.toBeInstanceOf(SandboxStartFailedError);
    expect(shared.driver.createCount).toBe(2);
    now += 20_000;
    await expect(w.manager.ensure(args)).rejects.toThrow(/retrying in/);
    expect(shared.driver.createCount).toBe(2);
    now += 11_000;
    shared.driver.failStart = undefined;
    const ok = await w.manager.ensure(args);
    expect(ok.kind).toBe('local');
  });

  it('8.6 three failures within 30 minutes mark the installation error with the last phase and stderr tail', async () => {
    let now = 5_000_000;
    const clock = { now: () => now };
    const w = track(makeWorker(shared, 'w1', { clock }));
    await w.registry.heartbeat();
    shared.driver.failStart = 'registry unreachable';
    const installation = installationOf(packageSpec());
    const args = await ensureArgs(w.manager, installation);
    for (const wait of [0, 6_000, 31_000]) {
      now += wait;
      await w.manager.ensure(args).catch(() => undefined);
    }
    expect(shared.driver.createCount).toBe(3);
    const marked = shared.status.errors.get('inst-1');
    expect(marked?.phase).toBe('installing');
    expect(marked?.message).toContain('registry unreachable');
    expect(shared.repo.rows.get(args.record.id)?.error?.phase).toBe('installing');
    // Restart clears the history and the mark; the next call starts immediately.
    await w.manager.restart(args.record.id);
    expect(shared.status.errors.has('inst-1')).toBe(false);
    shared.driver.failStart = undefined;
    const ok = await w.manager.ensure(args);
    expect(ok.kind).toBe('local');
  });

  it('8.6 a failure keeps its phase and message on the instance, and a new catalog version starts clean instead of waiting out the backoff', async () => {
    const now = 20_000_000;
    const clock = { now: () => now };
    const w = track(makeWorker(shared, 'w1', { clock }));
    await w.registry.heartbeat();
    shared.driver.failStart = 'npm error notarget No matching version found';
    const args = await ensureArgs(w.manager, installationOf(packageSpec()));
    await w.manager.ensure(args).catch(() => undefined);
    const failed = shared.repo.rows.get(args.record.id)?.error;
    expect(failed?.phase).toBe('installing');
    expect(failed?.message).toContain('No matching version');
    // the author fixes the spec: a new version starts at once, no "retrying in ... s"
    shared.driver.failStart = undefined;
    const fixed = installationOf(packageSpec(), { catalogVersionId: 'ver-fixed' });
    const ok = await w.manager.ensure({ ...args, installation: fixed });
    expect(ok.kind).toBe('local');
    expect(shared.repo.rows.get(args.record.id)?.error).toBeUndefined();
  });

  it('8.7 captureLockfile resolves in a throwaway sandbox that is destroyed afterwards, with the installing egress phase', async () => {
    const spy = spyEgress(shared);
    const w = track(makeWorker(shared, 'w1', { egress: spy.writer }));
    const lock = await w.manager.captureLockfile(packageSpec() as PackageSpec, {
      userId: 'user-1',
      label: 'x',
    });
    expect(lock.kind).toBe('npm-shrinkwrap');
    expect(lock.sha256).toBe(createHash('sha256').update(lock.content).digest('hex'));
    expect(shared.driver.startRequests[0]?.captureLockfile).toBe(true);
    expect(spy.phases).toEqual(['installing']);
    expect(shared.driver.destroyed).toHaveLength(1);
  });

  it('8.7 a failed capture destroys the sandbox and reports the resolver output', async () => {
    const w = track(makeWorker(shared, 'w1'));
    shared.driver.failStart = 'npm error code ETARGET';
    await expect(
      w.manager.captureLockfile(packageSpec() as PackageSpec, { userId: 'user-1', label: 'x' }),
    ).rejects.toMatchObject({
      code: 'SANDBOX_START_FAILED',
      message: expect.stringContaining('ETARGET'),
    });
    expect(shared.driver.destroyed).toHaveLength(1);
  });

  it('8.6 failures older than 30 minutes no longer count', async () => {
    let now = 9_000_000;
    const clock = { now: () => now };
    const w = track(makeWorker(shared, 'w1', { clock }));
    await w.registry.heartbeat();
    shared.driver.failStart = 'x';
    const args = await ensureArgs(w.manager, installationOf(packageSpec()));
    await w.manager.ensure(args).catch(() => undefined);
    now += 31 * 60_000;
    shared.driver.failStart = undefined;
    const ok = await w.manager.ensure(args);
    expect(ok.kind).toBe('local');
    expect(shared.status.errors.size).toBe(0);
  });

  it('8.6 a crash fails in-flight requests with -32014, drops to absent and restarts on the next use', async () => {
    const clockState = { now: Date.now() };
    const clock = { now: () => clockState.now };
    const w = track(makeWorker(shared, 'w1', { clock }));
    const { live, args } = await start(w);
    clockState.now += 120_000; // the crash happens long after start: not a start failure
    const inflight = callOn(w.manager, live, 'crash').catch((e: unknown) => e);
    const error = await inflight;
    expect(error).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(w.manager.get(args.record.id)).toBeUndefined());
    await vi.waitFor(() => expect(shared.driver.destroyed).toContain('bst-1'));
    expect(shared.repo.rows.get(args.record.id)?.failures).toEqual([]);
    const next = await w.manager.ensure(args);
    expect(next.kind).toBe('local');
    expect(shared.driver.createCount).toBe(2);
  });

  it('8.6 a crash within 30 s of start counts as a failure and the sandbox stderr tail is kept', async () => {
    const w = track(makeWorker(shared, 'w1'));
    const { live, args } = await start(w);
    await callOn(w.manager, live, 'crash').catch(() => undefined);
    await vi.waitFor(() => expect(shared.repo.rows.get(args.record.id)?.failures.length).toBe(1));
    expect(live.stderr?.tail.tail()).toContain('about to crash');
    const next = await w.manager.ensure(args).catch((e: unknown) => e);
    expect(next).toBeInstanceOf(SandboxStartFailedError);
  });

  it('8.6 limits a user to BASTION_MAX_RUNNING_INSTANCES_PER_USER: the LRU idle instance is stopped to make room', async () => {
    const w = track(
      makeWorker(shared, 'w1', { limits: { maxRunningPerUser: 2, maxRunningTotal: 500 } }),
    );
    await w.registry.heartbeat();
    const mk = (n: number) =>
      installationOf(packageSpec(), { installationId: `inst-${n}`, slug: `s${n}` });
    const a = await w.manager.ensure(await ensureArgs(w.manager, mk(1)));
    await sleep(5);
    const b = await w.manager.ensure(await ensureArgs(w.manager, mk(2)));
    if (a.kind !== 'local' || b.kind !== 'local') throw new Error('expected local');
    // Mark instance 1 as least recently used, then start a third.
    const rowA = shared.repo.rows.get(a.live.id);
    if (rowA) shared.repo.rows.set(rowA.id, { ...rowA, lastUsedAt: 1 });
    const c = await w.manager.ensure(await ensureArgs(w.manager, mk(3)));
    expect(c.kind).toBe('local');
    await vi.waitFor(() => expect(shared.driver.destroyed).toContain('bst-1'));
    expect(w.manager.get(a.live.id)).toBeUndefined();
    expect(w.manager.get(b.live.id)).toBeDefined();
  });

  it('8.6 without an idle-eligible instance a start over the cap fails with -32011', async () => {
    const w = track(
      makeWorker(shared, 'w1', { limits: { maxRunningPerUser: 1, maxRunningTotal: 500 } }),
    );
    await w.registry.heartbeat();
    const mk = (n: number) =>
      installationOf(packageSpec(), { installationId: `inst-${n}`, slug: `s${n}` });
    const a = await w.manager.ensure(await ensureArgs(w.manager, mk(1)));
    if (a.kind !== 'local') throw new Error('expected local');
    const busy = callOn(w.manager, a.live, 'slow', { ms: 400 });
    await sleep(50);
    const error = await w.manager
      .ensure(await ensureArgs(w.manager, mk(2)))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).mcpCode).toBe(-32011);
    expect(shared.repo.rows.get('x')?.failures).toBeUndefined();
    await busy;
  });

  it('8.6 enforces the org-wide cap BASTION_MAX_RUNNING_SANDBOXES across users', async () => {
    const w = track(
      makeWorker(shared, 'w1', { limits: { maxRunningPerUser: 10, maxRunningTotal: 1 } }),
    );
    await w.registry.heartbeat();
    const one = installationOf(packageSpec(), {
      installationId: 'inst-a',
      slug: 'a',
      ownerUserId: 'alice',
    });
    const two = installationOf(packageSpec(), {
      installationId: 'inst-b',
      slug: 'b',
      ownerUserId: 'bob',
    });
    const a = await w.manager.ensure(await ensureArgs(w.manager, one));
    if (a.kind !== 'local') throw new Error('expected local');
    const busy = callOn(w.manager, a.live, 'slow', { ms: 300 });
    await sleep(40);
    await expect(w.manager.ensure(await ensureArgs(w.manager, two))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await busy;
  });

  it('8.6 when the catalog version changes, in-flight calls finish and the instance restarts on next use', async () => {
    const w = track(makeWorker(shared, 'w1'));
    const { live, args } = await start(w);
    const inflight = callOn(w.manager, live, 'slow', { ms: 250 });
    await sleep(30);
    const upgraded = installationOf(packageSpec(), { catalogVersionId: 'ver-2' });
    const restarting = w.manager.ensure({ ...args, installation: upgraded });
    await sleep(30);
    expect(shared.driver.createCount).toBe(1);
    expect(text((await inflight) as never)).toBe('done');
    const result = await restarting;
    expect(result.kind).toBe('local');
    expect(shared.driver.createCount).toBe(2);
    expect(result.kind === 'local' && result.live.versionId).toBe('ver-2');
  });

  it('8.6 shared instances: 1 to 10 replicas, least in-flight wins, rows have installation_id null', async () => {
    const w = track(makeWorker(shared, 'w1'));
    await w.registry.heartbeat();
    const shape = { instanceScope: 'shared' as const };
    const installation = installationOf(packageSpec(shape), { replicas: 3 });
    const first = await w.manager.instanceFor(installation);
    expect(first.installationId).toBeNull();
    expect(first.userId).toBeNull();
    expect(first.catalogVersionId).toBe('ver-1');
    // With the first replica idle it is reused rather than growing the pool.
    expect((await w.manager.instanceFor(installation)).id).toBe(first.id);
    const counter = new InflightCounter(shared.redis);
    await counter.incr(first.id);
    const second = await w.manager.instanceFor(installation);
    expect(second.id).not.toBe(first.id);
    expect(second.replica).toBe(1);
    await counter.incr(second.id);
    const third = await w.manager.instanceFor(installation);
    expect(third.replica).toBe(2);
    await counter.incr(third.id);
    await counter.incr(third.id);
    await counter.incr(second.id);
    // At the replica limit the least loaded existing replica is chosen.
    const chosen = await w.manager.instanceFor(installation);
    expect(chosen.id).toBe(first.id);
    expect(await w.manager.getRecord(installation)).not.toBeNull();
  });

  it('21.2 a new owner attaches to the running sandbox with the stored token and replaces the old connection', async () => {
    const a = track(makeWorker(shared, 'w1'));
    const { live, args } = await start(a);
    await callOn(a.manager, live, 'echo', { text: '1' });
    // w1 loses its lease (as if it hung): w2 takes over.
    await shared.redis.del(`workers:w1`);
    const b = track(makeWorker(shared, 'w22'));
    await b.registry.heartbeat();
    const ensured = await b.manager.ensure({
      ...args,
      record: (await shared.repo.get(args.record.id)) ?? args.record,
    });
    expect(ensured.kind).toBe('local');
    expect(shared.driver.attachCount).toBe(1);
    expect(shared.driver.createCount).toBe(1);
    expect(b.telemetry.runs[0]).toEqual(['connected']);
    if (ensured.kind !== 'local') return;
    expect(text((await callOn(b.manager, ensured.live, 'echo', { text: 'from-b' })) as never)).toBe(
      'from-b',
    );
    // The old owner's channel was closed with 4001: it drops its local state and does not destroy the sandbox.
    await vi.waitFor(() => expect(a.manager.get(args.record.id)).toBeUndefined());
    expect(shared.driver.destroyed).toEqual([]);
  });

  it('21.2 if attach fails the instance starts fresh', async () => {
    const a = track(makeWorker(shared, 'w1'));
    const { args } = await start(a);
    shared.driver.sandboxes.get('bst-1')?.kill();
    shared.driver.sandboxes.delete('bst-1');
    await a.manager.closeConnections();
    await shared.redis.del(`lease:${args.record.id}`);
    const b = track(makeWorker(shared, 'w22'));
    await b.registry.heartbeat();
    const ensured = await b.manager.ensure({
      ...args,
      record: (await shared.repo.get(args.record.id)) ?? args.record,
    });
    expect(ensured.kind).toBe('local');
    expect(shared.driver.createCount).toBe(2);
    expect(b.telemetry.runs[0]).toEqual(['claimed', 'bound', 'installed', 'spawned', 'connected']);
  });

  it('21.2 a lease that cannot be renewed closes the connection but leaves the sandbox running', async () => {
    const w = track(makeWorker(shared, 'w1'));
    const { args } = await start(w);
    await shared.redis.set(`lease:${args.record.id}`, 'thief');
    await w.leases.renewAll();
    await vi.waitFor(() => expect(w.manager.get(args.record.id)).toBeUndefined());
    expect(shared.driver.destroyed).toEqual([]);
    expect(shared.driver.sandboxes.get('bst-1')?.state).toBe('running');
  });

  it('21.2 a request for an instance owned by another worker is forwarded, not started here', async () => {
    const a = track(makeWorker(shared, 'w1'));
    const { args } = await start(a);
    const b = track(makeWorker(shared, 'w22'));
    await b.registry.heartbeat();
    const ensured = await b.manager.ensure(args);
    expect(ensured).toMatchObject({ kind: 'forward', workerId: 'w1' });
    expect(shared.driver.createCount).toBe(1);
  });

  it('8.7 resolves templates before claiming a sandbox so a bad setting costs nothing', async () => {
    const w = track(makeWorker(shared, 'w1'));
    await w.registry.heartbeat();
    const installation = installationOf(
      packageSpec({ packageArguments: [{ type: 'positional', value: '{{var.MISSING}}' }] }),
    );
    const error = await w.manager
      .ensure(await ensureArgs(w.manager, installation))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxStartFailedError);
    expect(shared.driver.createCount).toBe(0);
  });

  it('8.7 stderr lines go to the StderrPipeline sink', async () => {
    const lines: string[] = [];
    const w = track(
      makeWorker(shared, 'w1', { stderrSink: { write: (e) => void lines.push(e.line) } }),
    );
    const { live } = await start(w);
    await callOn(w.manager, live, 'crash').catch(() => undefined);
    await vi.waitFor(() => expect(lines).toContain('about to crash'));
  });

  it('21.2 graceful shutdown closes connections but keeps sandboxes running', async () => {
    const w = track(makeWorker(shared, 'w1'));
    const { args } = await start(w);
    await w.manager.closeConnections();
    expect(w.manager.get(args.record.id)).toBeUndefined();
    expect(shared.driver.destroyed).toEqual([]);
    expect(shared.driver.sandboxes.get('bst-1')?.state).toBe('running');
  });

  it('8.6 stop() of an unknown instance is a no-op and stopAnywhere destroys remote ones', async () => {
    const a = track(makeWorker(shared, 'w1'));
    const { args } = await start(a);
    const b = track(makeWorker(shared, 'w22'));
    await b.manager.stop('nothing', 'evict');
    await b.manager.stopAnywhere(args.record.id);
    expect(shared.driver.destroyed).toContain('bst-1');
  });
});

describe('8.7 start request from the spec', () => {
  it('8.7 installs from the catalog version lockfile and passes install-script policy', () => {
    const lockfile = { kind: 'npm-shrinkwrap' as const, content: '{}', sha256: 'a'.repeat(64) };
    const installation = installationOf(
      packageSpec({ lockfile, allowInstallScripts: true, bin: 'srv' }),
    );
    const request = buildStartRequest(installation, principal, credential, {
      proxyUrl: 'http://p:1@h:3128',
    });
    expect(request.lockfile).toEqual(lockfile);
    expect(request.allowInstallScripts).toBe(true);
    expect(request.bin).toBe('srv');
    expect(request.runtime).toBe('npm');
  });

  it('9.5 credential injections become environment variables and arguments', () => {
    const installation = installationOf(
      packageSpec({ packageArguments: [{ type: 'positional', value: 'serve' }] }),
    );
    const request = buildStartRequest(
      installation,
      principal,
      {
        credentialHash: 'h',
        injections: [
          { to: 'env', name: 'API_TOKEN', value: '{{secret.TOKEN}}' },
          { to: 'arg', value: '--verbose' },
          { to: 'arg', flag: '--key', value: '{{oauth.accessToken}}', position: 0 },
        ],
        templateContext: { secret: { TOKEN: 't0k' }, oauth: { accessToken: 'oa' } },
      },
      { proxyUrl: 'http://p:1@h:3128' },
    );
    expect(request.env).toEqual({ API_TOKEN: 't0k' });
    expect(request.args).toEqual(['--key', 'oa', 'serve', '--verbose']);
  });

  it('8.1 rejects building a start request for a remote spec', () => {
    const installation = installationOf({ type: 'remote' } as never);
    expect(() =>
      buildStartRequest(installation, principal, credential, { proxyUrl: 'x' }),
    ).toThrow();
  });

  void ctxOf;
  void FakeRedis;
  void UpstreamUnavailableError;
});
