/**
 * 23.4 proxy overhead: added p50 and p99 latency of `tools/call` through the gateway to a warm modern remote fake
 * upstream with guards off (target: p50 under 5 ms, p99 under 25 ms). The baseline is the same request sent straight to
 * the upstream; "added" is gateway minus baseline at the same concurrency. Everything runs in one process on one machine
 * (load generator, gateway, upstream) next to a Redis container, so the numbers are pessimistic for CPU and include one
 * Docker network hop per Redis round trip.
 */
import type { Rule } from '@bastion-mcp/limits';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { dockerAvailable, startRedis, type TestRedis } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatStats, measure } from './helpers/load';
import { modernEnvelope } from './helpers/raw';
import { startStack, type Stack } from './helpers/stack';

const UPSTREAM = fileURLToPath(new URL('./helpers/raw-upstream.mjs', import.meta.url));

/** A minimal warm modern upstream in its own process, so its CPU does not compete with the gateway's event loop. */
const startRawUpstream = (): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [UPSTREAM], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.once('error', reject);
    child.stdout.once('data', (d: Buffer) => {
      resolve({
        url: d.toString('utf8').trim(),
        close: async () => {
          child.kill();
        },
      });
    });
  });

const GENERATOR = fileURLToPath(new URL('./helpers/loadgen.mjs', import.meta.url));

type Generated = { count: number; errors: number; p50: number; p90: number; p99: number; max: number; mean: number };

/** Runs the open-loop generator in its own process so it does not compete with the gateway's event loop. */
const generate = (url: string, rps: number, seconds: number, token?: string): Promise<Generated> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GENERATOR, url, String(rps), String(seconds), '2', ...(token ? [token] : [])], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).at(-1) ?? '') as Generated);
      } catch (error) {
        reject(error);
      }
    });
  });

const fmt = (label: string, g: Generated): string =>
  `${label}: n=${g.count} err=${g.errors} p50=${g.p50.toFixed(2)}ms p90=${g.p90.toFixed(2)}ms p99=${g.p99.toFixed(2)}ms max=${g.max.toFixed(1)}ms`;

const limitRules = (): Rule[] => [
  { id: 'perf-rate', name: 'rate', subject: 'user', subjectMatch: 'each', scope: {}, kind: 'rate', params: { points: 6_000_000, perSeconds: 60, burst: 0 }, metric: 'calls', action: 'reject', enabled: true },
  { id: 'perf-conc', name: 'conc', subject: 'user', subjectMatch: 'each', scope: {}, kind: 'concurrency', params: { max: 1000, leaseSeconds: 60 }, metric: 'calls', action: 'reject', enabled: true },
];

describe.skipIf(!dockerAvailable())('23.4 proxy overhead against a warm modern remote, guards off', () => {
  let redis: TestRedis;
  let upstream: { url: string; close: () => Promise<void> };
  let stack: Stack;

  beforeAll(async () => {
    redis = await startRedis();
    upstream = await startRawUpstream();
    stack = await startStack({
      redisUrl: redis.url,
      upstreams: [{ slug: 'modern', kind: 'modern', url: upstream.url }],
      flood: { mcpPerMinute: 100_000_000, oauthPerMinute: 60 },
    });
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
    await upstream?.close();
    await redis?.stop();
  });

  /** Per worker: 2,000 calls/s across 3 workers is about 667 calls/s each (23.4). */
  const RPS = 667;
  const SECONDS = 8;

  const runBoth = async (label: string) => {
    const token = stack.users.alice?.token ?? '';
    const direct = await generate(upstream.url, RPS, SECONDS);
    const proxied = await generate(stack.url('/mcp/i/modern'), RPS, SECONDS, token);
    const added = { p50: proxied.p50 - direct.p50, p99: proxied.p99 - direct.p99 };
    console.log(
      `PERF ${label}
PERF   ${fmt('direct ', direct)}
PERF   ${fmt('gateway', proxied)}
PERF   added p50=${added.p50.toFixed(2)}ms p99=${added.p99.toFixed(2)}ms (targets 5ms / 25ms)`,
    );
    return { direct, proxied, added };
  };

  it('profile', async () => {
    const inspector = await import('node:inspector');
    const fs = await import('node:fs');
    const session = new inspector.Session();
    session.connect();
    await new Promise<void>((resolve) => session.post('Profiler.enable', () => session.post('Profiler.start', () => resolve())));
    await generate(stack.url('/mcp/i/modern'), 400, 6, stack.users.alice?.token ?? '');
    await new Promise<void>((resolve) => session.post('Profiler.stop', (_e, { profile }) => { fs.writeFileSync('prof/gateway.cpuprofile', JSON.stringify(profile)); resolve(); }));
  }, 100_000);

  it('23.4 added latency at 667 calls/s per worker with the limiter off (no Redis round trip on the call path)', async () => {
    const r = await runBoth(`limiter off, open loop ${RPS} calls/s for ${SECONDS}s, generator in its own process`);
    expect(r.proxied.errors).toBe(0);
    expect(r.added.p50).toBeLessThan(5);
    expect(r.added.p99).toBeLessThan(25);
  }, 300_000);

  it('23.4 added latency with a rate rule and a concurrency rule evaluated in Redis on every call', async () => {
    stack.rules.push(...limitRules());
    const r = await runBoth(`rate + concurrency rules in Redis, open loop ${RPS} calls/s`);
    expect(r.proxied.errors).toBe(0);
    expect(r.added.p50).toBeLessThan(5);
    expect(r.added.p99).toBeLessThan(25);
    stack.rules.length = 0;
  }, 300_000);

  it('23.4 capacity of one worker (closed loop, 20 workers, generator in this process): recorded, not gated', async () => {
    const token = stack.users.alice?.token ?? '';
    const call = async (i: number): Promise<void> => {
      const res = await fetch(stack.url('/mcp/i/modern'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'echo',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' }, _meta: modernEnvelope() } }),
      });
      const body = (await res.json()) as { error?: unknown };
      if (body.error) throw new Error('error');
    };
    const stats = await measure({ concurrency: 20, total: 3000, warmup: 300, fn: call });
    console.log(`PERF ${formatStats('capacity c=20 (same process as generator and upstream)', stats)}`);
    expect(stats.errors).toBe(0);
  }, 300_000);
});
