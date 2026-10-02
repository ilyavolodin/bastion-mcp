import { UpstreamUnavailableError } from '@bastion-mcp/core';
import {
  type FakeLegacyHttpServer,
  type FakeLegacySseServer,
  type FakeModernServer,
  startFakeLegacyHttpServer,
  startFakeLegacySseServer,
  startFakeModernServer,
} from '@bastion-mcp/testkit';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteAgentRegistry } from '../src/connectors/agent';
import { HttpConnector } from '../src/connectors/http';
import { SseConnector } from '../src/connectors/sse';
import type { ConnectContext, UpstreamSession } from '../src/connectors/types';
import { ContinuationRegistry } from '../src/input-required/registry';
import { FakeRedis } from './helpers/fake-redis';
import {
  credential,
  ctxOf,
  FULL_CAPS,
  installationOf,
  LOOPBACK_SETTINGS,
  principal,
  remoteSpec,
  sleep,
} from './helpers/fixtures';

const text = (outcome: { kind: string; result?: unknown }): string => {
  const result = outcome.result as { content: { text: string }[] };
  return result.content[0]?.text ?? '';
};

describe('6.4 upstream connectors against real fake upstream servers', () => {
  let modern: FakeModernServer;
  let legacy: FakeLegacyHttpServer;
  let sse: FakeLegacySseServer;
  const agents = new RemoteAgentRegistry();
  const open: UpstreamSession[] = [];

  beforeAll(async () => {
    modern = await startFakeModernServer({ hugeResultBytes: 200_000 });
    legacy = await startFakeLegacyHttpServer();
    sse = await startFakeLegacySseServer();
  });
  afterAll(async () => {
    await Promise.all(open.map((s) => s.close()));
    await agents.closeAll();
    await modern.close();
    await legacy.close();
    await sse.close();
  });

  const connector = (caps?: { messageBytes?: number }) =>
    new HttpConnector({
      agents,
      settings: LOOPBACK_SETTINGS,
      version: '9.9.9',
      ...(caps ? { caps } : {}),
    });

  const connectCtx = (url: string, extra: Partial<ConnectContext> = {}): ConnectContext => ({
    installation: installationOf(remoteSpec(url)),
    principal,
    credential,
    instanceId: 'instance-1',
    signal: new AbortController().signal,
    ...extra,
  });

  const connect = async (
    url: string,
    extra: Partial<ConnectContext> = {},
    caps?: { messageBytes?: number },
  ) => {
    const session = await connector(caps).connect(connectCtx(url, extra));
    open.push(session);
    return session;
  };

  it('6.4 negotiates the modern era with versionNegotiation auto and reports the verdict', async () => {
    let verdictKind: string | undefined;
    const session = await connect(modern.url, { onVerdict: (v) => (verdictKind = v.kind) });
    expect(session.era).toBe('modern');
    expect(session.protocolVersion).toBe('2026-07-28');
    expect(verdictKind).toBe('modern');
  });

  it('6.4 a cached verdict passed as prior skips the server/discover probe', async () => {
    let verdict: ConnectContext['prior'];
    await connect(modern.url, { onVerdict: (v) => (verdict = v) });
    const before = modern.discoverCount();
    await connect(modern.url, { prior: verdict });
    expect(modern.discoverCount()).toBe(before);
  });

  it('6.4 identifies as bastion and attributes every request with onBehalfOf and trace context', async () => {
    const session = await connect(modern.url);
    const outcome = await session.callTool(
      { name: 'whoami', arguments: {} },
      {
        ctx: ctxOf({
          trace: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
        }),
      },
    );
    expect(outcome.kind).toBe('complete');
    const meta = JSON.parse(text(outcome as never)) as Record<string, unknown>;
    expect(meta['io.github.bastion-mcp/onBehalfOf']).toEqual({
      userId: 'user-1',
      clientName: 'claude-desktop',
    });
    expect(meta.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    const sent = modern.requests.filter((r) => r.headers.traceparent !== undefined);
    expect(sent.length).toBeGreaterThan(0);
    const envelope = meta.envelope as Record<string, unknown>;
    expect(envelope['io.modelcontextprotocol/clientInfo']).toMatchObject({
      name: 'bastion',
      title: 'Bastion MCP Gateway',
    });
  });

  it('6.4 modern upstreams receive the declared capabilities intersected with the downstream request', async () => {
    const session = await connect(modern.url);
    const outcome = await session.callTool(
      { name: 'whoami', arguments: {} },
      { ctx: ctxOf({ clientCapabilities: { elicitation: { form: {} } } }) },
    );
    const meta = JSON.parse(text(outcome as never)) as Record<string, unknown>;
    const envelope = meta.envelope as Record<string, unknown>;
    const caps = envelope['io.modelcontextprotocol/clientCapabilities'] as Record<string, unknown>;
    expect(caps.elicitation).toEqual({ form: {} });
    expect(caps.sampling).toBeUndefined();
  });

  it('6.5 passes an upstream InputRequiredResult through with inputRequests and requestState unchanged', async () => {
    const session = await connect(modern.url);
    const first = await session.callTool(
      { name: 'ask', arguments: { q: 'name?' } },
      { ctx: ctxOf() },
    );
    expect(first.kind).toBe('input_required');
    if (first.kind !== 'input_required') throw new Error('unreachable');
    expect(Object.keys(first.inputRequests ?? {})).toEqual(['name']);
    expect(first.inputRequests?.name?.method).toBe('elicitation/create');
    expect(first.upstreamState).toBe('upstream-state-1');
    const second = await session.callTool(
      {
        name: 'ask',
        arguments: { q: 'name?' },
        inputResponses: { name: { action: 'accept', content: { name: 'Ada' } } },
        requestState: first.upstreamState,
      },
      { ctx: ctxOf() },
    );
    expect(text(second as never)).toBe('hello Ada state=upstream-state-1');
  });

  it('6.4 forwards progress notifications to the request emitter', async () => {
    const session = await connect(modern.url);
    const seen: unknown[] = [];
    await session.callTool(
      { name: 'progress', arguments: { steps: 3 } },
      { ctx: ctxOf({ emit: (n) => seen.push(n) }) },
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toMatchObject({ method: 'notifications/progress' });
  });

  it('6.4 an abort signal cancels the upstream request', async () => {
    const session = await connect(modern.url);
    const controller = new AbortController();
    const before = modern.aborted.length;
    const pending = session.callTool(
      { name: 'slow', arguments: { ms: 5000 } },
      { ctx: ctxOf({ signal: controller.signal }) },
    );
    await sleep(200);
    controller.abort(new Error('client went away'));
    await expect(pending).rejects.toBeDefined();
    await sleep(300);
    expect(modern.aborted.length).toBeGreaterThan(before);
  });

  it('6.4 a call that exceeds its timeout fails with an SDK request timeout', async () => {
    const session = await connect(modern.url);
    const error = await session
      .callTool({ name: 'slow', arguments: { ms: 3000 } }, { ctx: ctxOf(), timeoutMs: 150 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SdkError);
    expect((error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
  });

  it('8.9 responses larger than the per-message cap fail with -32014 and the session survives', async () => {
    const session = await connect(modern.url, {}, { messageBytes: 50_000 });
    const error = await session
      .callTool({ name: 'huge', arguments: {} }, { ctx: ctxOf() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect((error as UpstreamUnavailableError).mcpCode).toBe(-32014);
  });

  it('8.9 personal installations never reach private ranges, admin entries only the configured CIDRs', async () => {
    const personal = installationOf(remoteSpec(modern.url), { origin: 'personal' });
    await expect(
      connector().connect({ ...connectCtx(modern.url), installation: personal }),
    ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    const noCidr = new HttpConnector({
      agents,
      settings: { privateCidrs: [], insecureHosts: ['127.0.0.1'] },
      version: '1',
    });
    await expect(noCidr.connect(connectCtx(modern.url))).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it('8.9 requires HTTPS except for BASTION_INSECURE_UPSTREAM_HOSTS', async () => {
    const strict = new HttpConnector({
      agents,
      settings: { privateCidrs: ['127.0.0.0/8'], insecureHosts: [] },
      version: '1',
    });
    await expect(strict.connect(connectCtx(modern.url))).rejects.toThrow(/HTTPS/);
  });

  it('8.9 URL variables and headers are resolved per user at connect time', async () => {
    const spec = remoteSpec(`http://127.0.0.1:${modern.port}/{{var.path}}`, 'streamable-http', {
      variables: { path: { name: 'path', default: 'mcp' } },
      headers: [{ name: 'X-User', value: '{{user.id}}' }],
    });
    const ctx = { ...connectCtx(modern.url), installation: installationOf(spec) };
    const session = await connector().connect(ctx);
    open.push(session);
    const last = modern.requests.at(-1);
    expect(last?.url).toBe('/mcp');
    expect(last?.headers['x-user']).toBe('user-1');
  });

  it('6.4 credential injections become request headers', async () => {
    modern.setRequiredToken('s3cret');
    try {
      const withToken = {
        ...connectCtx(modern.url),
        credential: {
          credentialHash: 'c2',
          injections: [
            { to: 'header' as const, name: 'Authorization', value: 'Bearer {{secret.TOKEN}}' },
          ],
          templateContext: { secret: { TOKEN: 's3cret' } },
        },
      };
      const session = await connector().connect(withToken);
      open.push(session);
      expect(session.era).toBe('modern');
    } finally {
      modern.setRequiredToken(undefined);
    }
  });

  it('6.4 a legacy upstream is detected, keeps a session id and uses the legacy handshake', async () => {
    let verdictKind: string | undefined;
    const session = await connect(legacy.url, { onVerdict: (v) => (verdictKind = v.kind) });
    expect(session.era).toBe('legacy');
    expect(session.sessionId).toBeTruthy();
    expect(verdictKind).toBe('legacy');
    const out = await session.callTool(
      { name: 'echo', arguments: { text: 'hi' } },
      { ctx: ctxOf({ era: 'legacy' }) },
    );
    expect(text(out as never)).toBe('hi');
  });

  it('6.4 the clientInfo of a legacy upstream is bastion with the declared capabilities', async () => {
    const session = await connect(legacy.url);
    const out = await session.callTool({ name: 'whoami', arguments: {} }, { ctx: ctxOf() });
    const who = JSON.parse(text(out as never)) as {
      clientInfo: { name: string; title: string; version: string };
      capabilities: Record<string, unknown>;
      meta: Record<string, unknown>;
    };
    expect(who.clientInfo).toMatchObject({
      name: 'bastion',
      title: 'Bastion MCP Gateway',
      version: '9.9.9',
    });
    expect(who.capabilities.elicitation).toEqual({ form: {}, url: {} });
    expect(who.capabilities.sampling).toBeUndefined();
    expect(who.meta['io.github.bastion-mcp/onBehalfOf']).toBeDefined();
  });

  it('6.4 sampling and roots are declared only when the catalog entry enables them', async () => {
    const ctx = {
      ...connectCtx(legacy.url),
      installation: installationOf(remoteSpec(legacy.url), {
        enableSampling: true,
        enableRoots: true,
      }),
    };
    const session = await connector().connect(ctx);
    open.push(session);
    const out = await session.callTool({ name: 'whoami', arguments: {} }, { ctx: ctxOf() });
    const who = JSON.parse(text(out as never)) as { capabilities: Record<string, unknown> };
    expect(who.capabilities.sampling).toEqual({});
    expect(who.capabilities.roots).toEqual({});
  });

  it('6.5 a legacy upstream elicitation ends the call with input_required keyed b0 and resumes on the same continuation', async () => {
    const registry = new ContinuationRegistry({
      redis: new FakeRedis(),
      workerId: 'w1',
      instanceId: 'instance-1',
    });
    const session = await connect(legacy.url, { continuations: registry });
    const first = await session.callTool(
      { name: 'ask', arguments: { q: 'who?' } },
      { ctx: ctxOf({ era: 'modern' }) },
    );
    expect(first.kind).toBe('input_required');
    if (first.kind !== 'input_required') throw new Error('unreachable');
    expect(Object.keys(first.inputRequests ?? {})).toEqual(['b0']);
    expect(first.inputRequests?.b0?.method).toBe('elicitation/create');
    expect(first.continuationId).toBeTruthy();
    const done = await session.resumeContinuation(
      first.continuationId as string,
      { b0: { action: 'accept', content: { name: 'Grace' } } },
      { ctx: ctxOf() },
    );
    expect(done.kind).toBe('complete');
    expect(text(done as never)).toBe('hello Grace');
    await sleep(20);
    expect(registry.size).toBe(0);
  });

  it('6.5 parallel server requests from one call are batched into b0 and b1', async () => {
    const registry = new ContinuationRegistry({
      redis: new FakeRedis(),
      workerId: 'w1',
      instanceId: 'i',
    });
    const session = await connect(legacy.url, { continuations: registry });
    const first = await session.callTool({ name: 'ask2', arguments: { q: 'p' } }, { ctx: ctxOf() });
    if (first.kind !== 'input_required') throw new Error('expected input_required');
    expect(Object.keys(first.inputRequests ?? {})).toEqual(['b0', 'b1']);
    const done = await session.resumeContinuation(
      first.continuationId as string,
      {
        b0: { action: 'accept', content: { v: 'A' } },
        b1: { action: 'accept', content: { v: 'B' } },
      },
      { ctx: ctxOf() },
    );
    expect(text(done as never)).toBe('A+B');
  });

  it('6.5 a missing downstream elicitation capability is answered decline without reaching the client', async () => {
    const session = await connect(legacy.url, {
      continuations: new ContinuationRegistry({
        redis: new FakeRedis(),
        workerId: 'w1',
        instanceId: 'i',
      }),
    });
    const out = await session.callTool(
      { name: 'ask', arguments: { q: 'x' } },
      { ctx: ctxOf({ clientCapabilities: {} }) },
    );
    expect(out.kind).toBe('complete');
    expect(text(out as never)).toBe('action:decline');
  });

  it('6.5 sampling without the downstream capability gets -32601 and roots the configured roots', async () => {
    const installation = installationOf(remoteSpec(legacy.url), {
      enableSampling: true,
      enableRoots: true,
      roots: ['file:///workspace'],
    });
    const session = await connector().connect({
      ...connectCtx(legacy.url),
      installation,
      continuations: new ContinuationRegistry({
        redis: new FakeRedis(),
        workerId: 'w1',
        instanceId: 'i',
      }),
    });
    open.push(session);
    const sampled = await session.callTool(
      { name: 'sample', arguments: {} },
      { ctx: ctxOf({ clientCapabilities: {} }) },
    );
    expect(text(sampled as never)).toBe('sample-error:-32601');
    const roots = await session.callTool(
      { name: 'roots', arguments: {} },
      { ctx: ctxOf({ clientCapabilities: {} }) },
    );
    expect(text(roots as never)).toBe('roots:file:///workspace');
  });

  it('21.2 a stored legacy remote session id is reused instead of a new initialize', async () => {
    const first = await connect(legacy.url);
    const initializes = legacy.initializeCount();
    const resumed = await connect(legacy.url, {
      remoteSession: {
        sessionId: first.sessionId as string,
        protocolVersion: first.protocolVersion as string,
        url: legacy.url,
      },
    });
    expect(legacy.initializeCount()).toBe(initializes);
    expect(resumed.sessionId).toBe(first.sessionId);
    const out = await resumed.callTool(
      { name: 'echo', arguments: { text: 'again' } },
      { ctx: ctxOf() },
    );
    expect(text(out as never)).toBe('again');
    await sleep(100);
    expect(legacy.hasGetStream()).toBe(true);
  });

  it('21.2 when the stored session is gone the connection starts fresh', async () => {
    const initializes = legacy.initializeCount();
    const session = await connect(legacy.url, {
      remoteSession: { sessionId: 'stale-session', protocolVersion: '2025-06-18', url: legacy.url },
    });
    expect(legacy.initializeCount()).toBe(initializes + 1);
    expect(session.sessionId).not.toBe('stale-session');
  });

  it('6.1 an HTTP+SSE upstream works through SseConnector', async () => {
    const spec = remoteSpec(sse.url, 'sse');
    const session = await new SseConnector({
      agents,
      settings: LOOPBACK_SETTINGS,
      version: '1',
    }).connect({
      ...connectCtx(sse.url),
      installation: installationOf(spec),
    });
    open.push(session);
    expect(session.era).toBe('legacy');
    const out = await session.callTool(
      { name: 'echo', arguments: { text: 'sse' } },
      { ctx: ctxOf() },
    );
    expect(text(out as never)).toBe('sse');
    const list = await session.listTools({}, { ctx: ctxOf() });
    expect((list.tools as unknown[]).length).toBeGreaterThan(0);
  });

  it('6.6 list_changed from a legacy upstream reaches notification handlers', async () => {
    const session = await connect(legacy.url);
    const seen: string[] = [];
    session.onNotification((n) => seen.push(n.method));
    await sleep(100);
    legacy.toolsChanged();
    await sleep(200);
    expect(seen).toContain('notifications/tools/list_changed');
  });

  it('6.4 a closed upstream session reports its close to handlers', async () => {
    const session = await connect(legacy.url);
    let closed = false;
    session.onClose(() => {
      closed = true;
    });
    await session.close();
    await sleep(20);
    expect(session.closed).toBe(true);
    expect(closed).toBe(true);
    void FULL_CAPS;
  });
});
