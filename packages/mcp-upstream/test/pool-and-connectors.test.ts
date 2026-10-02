import { type FakeModernServer, startFakeModernServer } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteAgentRegistry } from '../src/connectors/agent';
import { EraCache } from '../src/connectors/era-cache';
import { HttpConnector } from '../src/connectors/http';
import { SandboxConnector } from '../src/connectors/sandbox';
import type { ConnectContext, UpstreamConnector, UpstreamSession } from '../src/connectors/types';
import { poolKey, RemotePool } from '../src/service/pool';
import { TASKS_EXTENSION } from '../src/tasks/extensions';
import { FakeRedis } from './helpers/fake-redis';
import { FakeSandboxDriver } from './helpers/fake-sandbox';
import {
  credential,
  ctxOf,
  installationOf,
  LOOPBACK_SETTINGS,
  packageSpec,
  principal,
  remoteSpec,
  sleep,
} from './helpers/fixtures';

const fakeSession = (
  era: 'modern' | 'legacy',
): UpstreamSession & { closeCount: number; closeHandlers: (() => void)[] } => {
  const state = {
    era,
    closed: false,
    closeCount: 0,
    closeHandlers: [] as (() => void)[],
    onClose(handler: () => void) {
      this.closeHandlers.push(handler);
    },
    async close() {
      this.closed = true;
      this.closeCount += 1;
    },
  };
  return state as unknown as UpstreamSession & {
    closeCount: number;
    closeHandlers: (() => void)[];
  };
};

const connectorOf = (era: 'modern' | 'legacy', verdict: 'modern' | 'legacy' = era) => {
  const calls: ConnectContext[] = [];
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const connector: UpstreamConnector = {
    connect: async (ctx) => {
      calls.push(ctx);
      await sleep(20);
      ctx.onVerdict?.(
        verdict === 'legacy'
          ? { kind: 'legacy' }
          : { kind: 'modern', discover: { supportedVersions: ['2026-07-28'] } as never },
      );
      const session = fakeSession(era);
      sessions.push(session);
      return session;
    },
  };
  return { connector, calls, sessions };
};

describe('6.4 pool of stateless modern remote sessions', () => {
  const installation = installationOf(remoteSpec('https://a.example/mcp'));
  const signal = new AbortController().signal;

  it('6.4 keeps one SDK client per (installationId, credentialHash) and concurrent callers share the connect', async () => {
    const { connector, calls } = connectorOf('modern');
    const pool = new RemotePool({ connector, eraCache: new EraCache(new FakeRedis()) });
    const results = await Promise.all(
      [1, 2, 3].map(() => pool.get(installation, principal, credential, signal)),
    );
    expect(calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.session)).size).toBe(1);
    expect(pool.size).toBe(1);
    await pool.get(installation, principal, credential, signal);
    expect(calls).toHaveLength(1);
    await pool.get(installation, principal, { ...credential, credentialHash: 'other' }, signal);
    expect(calls).toHaveLength(2);
    expect(pool.size).toBe(2);
    await pool.closeAll();
  });

  it('6.4 a closed session or a new catalog version reconnects; the closed one leaves the pool', async () => {
    const { connector, calls, sessions } = connectorOf('modern');
    const pool = new RemotePool({ connector, eraCache: new EraCache(new FakeRedis()) });
    await pool.get(installation, principal, credential, signal);
    sessions[0]?.closeHandlers[0]?.();
    expect(pool.size).toBe(0);
    await pool.get(installation, principal, credential, signal);
    expect(calls).toHaveLength(2);
    await pool.get({ ...installation, catalogVersionId: 'ver-2' }, principal, credential, signal);
    expect(calls).toHaveLength(3);
    expect(sessions[1]?.closeCount).toBe(1);
    await pool.closeAll();
  });

  it('6.4 invalidate drops the sessions of an installation and idle ones are swept', async () => {
    let now = 1_000_000;
    const { connector, sessions } = connectorOf('modern');
    const pool = new RemotePool({
      connector,
      eraCache: new EraCache(new FakeRedis()),
      clock: { now: () => now },
      idleMs: 60_000,
    });
    await pool.get(installation, principal, credential, signal);
    await pool.get(
      installationOf(remoteSpec('https://b.example'), { installationId: 'inst-2' }),
      principal,
      credential,
      signal,
    );
    pool.invalidate('inst-1');
    expect(pool.size).toBe(1);
    expect(sessions[0]?.closeCount).toBe(1);
    now += 61_000;
    pool.sweep();
    expect(pool.size).toBe(0);
    await pool.closeAll();
  });

  it('6.4 a spec that references {{user.*}} is pooled per user even with one shared credential', () => {
    const shared = installationOf(remoteSpec('https://a.example/{{user.id}}/mcp'));
    expect(poolKey(shared, principal, credential)).toBe('inst-1:cred-1:user-1');
    expect(poolKey(shared, { userId: 'u2' }, credential)).toBe('inst-1:cred-1:u2');
    expect(poolKey(installation, principal, credential)).toBe('inst-1:cred-1');
    expect(poolKey(installationOf(packageSpec()), principal, credential)).toBe('inst-1:cred-1');
  });

  it('6.4 a cached legacy verdict means no pooled session: the caller uses an owned instance', async () => {
    const { connector, calls } = connectorOf('modern');
    const eraCache = new EraCache(new FakeRedis());
    await eraCache.put('inst-1', 'cred-1', { kind: 'legacy' });
    const pool = new RemotePool({ connector, eraCache });
    expect(await pool.get(installation, principal, credential, signal)).toEqual({ era: 'legacy' });
    expect(calls).toHaveLength(0);
  });

  it('6.4 21.2 a probe that finds a legacy upstream caches the verdict, drops the probe session and hands over', async () => {
    const { connector, sessions } = connectorOf('legacy');
    const redis = new FakeRedis();
    const eraCache = new EraCache(redis);
    const pool = new RemotePool({ connector, eraCache });
    expect(await pool.get(installation, principal, credential, signal)).toEqual({ era: 'legacy' });
    expect(sessions[0]?.closeCount).toBe(1);
    expect(pool.size).toBe(0);
    expect(await eraCache.get('inst-1', 'cred-1')).toEqual({ kind: 'legacy' });
  });

  it('6.4 a modern probe caches its DiscoverResult verdict and passes it back as prior', async () => {
    const { connector, calls } = connectorOf('modern');
    const eraCache = new EraCache(new FakeRedis());
    const pool = new RemotePool({ connector, eraCache });
    await pool.get(installation, principal, credential, signal);
    expect((await eraCache.get('inst-1', 'cred-1'))?.kind).toBe('modern');
    pool.invalidate('inst-1');
    await pool.get(installation, principal, credential, signal);
    expect(calls[1]?.prior?.kind).toBe('modern');
    await pool.closeAll();
  });
});

describe('6.4 sandbox connector era selection', () => {
  const driver = new FakeSandboxDriver();

  const open = async (protocol: 'legacy' | 'modern' | 'auto') => {
    const installation = installationOf(packageSpec({ protocol }));
    const handle = await driver.create({
      instanceId: 'i',
      installationId: 'inst-1',
      userId: 'u',
      size: 'small',
      workspace: { persistent: false, sizeMiB: 512 },
    });
    for await (const event of handle.runner.start({} as never)) void event;
    const channel = await handle.runner.openStdio();
    return new SandboxConnector({ version: '1' }).connect({
      installation,
      principal,
      credential,
      instanceId: 'i',
      signal: new AbortController().signal,
      sandbox: { channel },
    });
  };

  afterAll(() => driver.killAll());

  it('6.4 legacy is the default for stdio: initialize handshake', async () => {
    const session = await open('legacy');
    expect(session.era).toBe('legacy');
    expect(session.serverInfo?.name).toBe('fake-stdio');
    await session.close();
  });

  it('6.4 protocol auto probes and falls back to legacy for a server that only speaks the old protocol', async () => {
    const session = await open('auto');
    expect(session.era).toBe('legacy');
    await session.close();
  });

  it('6.4 protocol modern fails against a legacy-only stdio server instead of guessing', async () => {
    await expect(open('modern')).rejects.toBeDefined();
  });

  it('6.4 a spec that is not a package, or a missing runner channel, is refused', async () => {
    const connector = new SandboxConnector({ version: '1' });
    const base = { principal, credential, instanceId: 'i', signal: new AbortController().signal };
    await expect(
      connector.connect({ ...base, installation: installationOf(remoteSpec('https://a.example')) }),
    ).rejects.toThrow('package spec');
    await expect(
      connector.connect({ ...base, installation: installationOf(packageSpec()) }),
    ).rejects.toThrow('runner channel');
  });
});

describe('6.8 extension allow and block lists per catalog entry', () => {
  let modern: FakeModernServer;
  const agents = new RemoteAgentRegistry();
  beforeAll(async () => {
    modern = await startFakeModernServer();
  });
  afterAll(async () => {
    await agents.closeAll();
    await modern.close();
  });

  const caps = {
    elicitation: { form: {} },
    extensions: { [TASKS_EXTENSION]: {}, 'com.acme/x': { v: 1 } },
  };
  const upstreamExtensions = async (
    extensions: { allow?: string[]; block?: string[] },
    single: boolean,
  ): Promise<Record<string, unknown>> => {
    const installation = installationOf(remoteSpec(modern.url), { extensions });
    const session = await new HttpConnector({
      agents,
      settings: LOOPBACK_SETTINGS,
      version: '1',
    }).connect({
      installation,
      principal,
      credential,
      instanceId: 'i',
      signal: new AbortController().signal,
    });
    try {
      const out = await session.callTool(
        { name: 'whoami', arguments: {} },
        { ctx: ctxOf({ clientCapabilities: caps as never, singleInstallationEndpoint: single }) },
      );
      const text =
        (out as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '{}';
      const envelope = (
        JSON.parse(text) as { envelope: Record<string, { extensions?: Record<string, unknown> }> }
      ).envelope;
      return envelope['io.modelcontextprotocol/clientCapabilities']?.extensions ?? {};
    } finally {
      await session.close();
    }
  };

  it('6.8 on aggregate endpoints only known extensions are declared upstream', async () => {
    expect(Object.keys(await upstreamExtensions({}, false))).toEqual([TASKS_EXTENSION]);
  });

  it('6.8 on single-installation endpoints unknown extensions are declared and forwarded verbatim', async () => {
    expect(await upstreamExtensions({}, true)).toEqual({
      [TASKS_EXTENSION]: {},
      'com.acme/x': { v: 1 },
    });
  });

  it('6.8 an admin block list removes an extension for that entry, an allow list restricts to its members', async () => {
    expect(await upstreamExtensions({ block: [TASKS_EXTENSION] }, true)).toEqual({
      'com.acme/x': { v: 1 },
    });
    expect(await upstreamExtensions({ allow: ['com.acme/x'] }, true)).toEqual({
      'com.acme/x': { v: 1 },
    });
  });

  it('6.8 tasks/* requests are refused with -32601 when the entry blocks the Tasks extension', async () => {
    const installation = installationOf(remoteSpec(modern.url), {
      extensions: { block: [TASKS_EXTENSION] },
    });
    const session = await new HttpConnector({
      agents,
      settings: LOOPBACK_SETTINGS,
      version: '1',
    }).connect({
      installation,
      principal,
      credential,
      instanceId: 'i',
      signal: new AbortController().signal,
    });
    try {
      await expect(
        session.request('tasks/get', { taskId: 'x' }, { ctx: ctxOf() }),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await session.close();
    }
  });
});
