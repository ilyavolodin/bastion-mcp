import { UpstreamUnavailableError } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import type { EraCache } from '../src/connectors/era-cache';
import type { OpOptions, UpstreamSession } from '../src/connectors/types';
import type { InstanceManager } from '../src/instances/manager';
import { LeaseManager } from '../src/ownership/lease';
import { WorkerRegistry } from '../src/ownership/registry';
import type { InternalRpcClient } from '../src/rpc/client';
import type { RemotePool } from '../src/service/pool';
import { UpstreamService } from '../src/service/service';
import type { JsonObject, SessionOutcome } from '../src/types';
import { FakeRedis } from './helpers/fake-redis';
import { ctxOf, installationOf, remoteSpec } from './helpers/fixtures';
import { connectUrls, FakeCredentials, MemoryInstallations } from './helpers/memory-ports';
import { keyring } from './helpers/runtime';

type Call = { method: string; params: JsonObject; options: OpOptions };

const fakeSession = (
  script: (call: Call) => SessionOutcome,
): UpstreamSession & { calls: Call[] } => {
  const calls: Call[] = [];
  const session = {
    calls,
    era: 'modern' as const,
    protocolVersion: '2026-07-28',
    sessionId: undefined,
    serverCapabilities: {},
    serverInfo: { name: 'fake', version: '1' },
    instructions: 'be nice',
    closed: false,
    request: async (method: string, params: JsonObject, options: OpOptions) => {
      const call = { method, params, options };
      calls.push(call);
      return script(call);
    },
    onNotification: () => () => undefined,
    onClose: () => undefined,
    close: async () => undefined,
    hasContinuation: () => false,
  };
  return session as unknown as UpstreamSession & { calls: Call[] };
};

const build = (session: UpstreamSession) => {
  const redis = new FakeRedis();
  const registry = new WorkerRegistry({
    redis,
    workerId: 'w1',
    address: '127.0.0.1:1',
    role: 'worker',
    version: '1',
  });
  const installations = new MemoryInstallations();
  const credentials = new FakeCredentials();
  const service = new UpstreamService({
    redis,
    registry,
    leases: new LeaseManager({ redis, registry }),
    instances: {} as InstanceManager,
    pool: {
      get: async () => ({ era: 'modern' as const, session }),
      closeAll: async () => undefined,
    } as unknown as RemotePool,
    eraCache: {} as EraCache,
    rpc: {} as InternalRpcClient,
    installations,
    credentials,
    connectUrls,
    stateKeyring: keyring,
  });
  const a = installations.add(
    installationOf(remoteSpec('https://a.example/mcp'), { installationId: 'inst-a', slug: 'a' }),
  );
  const b = installations.add(
    installationOf(remoteSpec('https://b.example/mcp'), { installationId: 'inst-b', slug: 'b' }),
  );
  return { service, a, b, credentials };
};

describe('6.8 Tasks routing through the service', () => {
  const task = {
    resultType: 'task',
    task: { taskId: 'up-task-1', status: 'working', ttl: 600_000 },
  };

  it('6.8 wraps a CreateTaskResult taskId as btk1. and routes tasks/get by the wrapped id', async () => {
    const session = fakeSession(({ method }) =>
      method === 'tools/call'
        ? { kind: 'task', task }
        : {
            kind: 'complete',
            result: { taskId: 'up-task-1', status: 'completed', result: { content: [] } },
          },
    );
    const { service, a } = build(session);
    const created = await service.execute({
      installationId: a.installationId,
      method: 'tools/call',
      params: { name: 'long', arguments: {} },
      ctx: ctxOf({ installationId: a.installationId }),
    });
    expect(created.kind).toBe('task');
    if (created.kind !== 'task') return;
    const wrapped = (created.task as typeof task).task.taskId;
    expect(wrapped.startsWith('btk1.')).toBe(true);
    expect(wrapped).not.toContain('up-task-1');
    const got = await service.executeTask({
      method: 'tasks/get',
      params: { taskId: wrapped },
      ctx: ctxOf(),
    });
    expect(got.kind).toBe('complete');
    // The upstream saw ITS task id; the client keeps seeing the wrapped one.
    expect(session.calls.at(-1)?.params.taskId).toBe('up-task-1');
    expect((got as { result: { taskId: string } }).result.taskId).toBe(wrapped);
  });

  it('6.8 tasks/update and tasks/cancel route the same way', async () => {
    const session = fakeSession(({ method }) =>
      method === 'tools/call' ? { kind: 'task', task } : { kind: 'complete', result: { ok: true } },
    );
    const { service, a } = build(session);
    const created = await service.execute({
      installationId: a.installationId,
      method: 'tools/call',
      params: { name: 'long', arguments: {} },
      ctx: ctxOf(),
    });
    const wrapped = ((created as { task: typeof task }).task as typeof task).task.taskId;
    for (const method of ['tasks/update', 'tasks/cancel'] as const) {
      await service.executeTask({ method, params: { taskId: wrapped, extra: 1 }, ctx: ctxOf() });
      expect(session.calls.at(-1)).toMatchObject({
        method,
        params: { taskId: 'up-task-1', extra: 1 },
      });
    }
  });

  it('6.8 a task id of another user or a forged one is rejected with -32602 before anything is sent upstream', async () => {
    const session = fakeSession(() => ({ kind: 'task', task }));
    const { service, a } = build(session);
    const created = await service.execute({
      installationId: a.installationId,
      method: 'tools/call',
      params: { name: 'long', arguments: {} },
      ctx: ctxOf(),
    });
    const wrapped = ((created as { task: typeof task }).task as typeof task).task.taskId;
    const before = session.calls.length;
    const other = ctxOf({ principal: { userId: 'someone-else' } });
    await expect(
      service.executeTask({ method: 'tasks/get', params: { taskId: wrapped }, ctx: other }),
    ).rejects.toMatchObject({ mcpCode: -32602 });
    await expect(
      service.executeTask({ method: 'tasks/get', params: { taskId: 'btk1.bogus' }, ctx: ctxOf() }),
    ).rejects.toMatchObject({ mcpCode: -32602 });
    await expect(
      service.executeTask({ method: 'tools/call', params: {}, ctx: ctxOf() }),
    ).rejects.toThrow();
    expect(session.calls.length).toBe(before);
  });

  it('6.8 the task is routed to the installation it was created on', async () => {
    const seen: string[] = [];
    const session = fakeSession(({ options, method }) => {
      seen.push(options.ctx.installationId);
      return method === 'tools/call' ? { kind: 'task', task } : { kind: 'complete', result: {} };
    });
    const { service, b } = build(session);
    const created = await service.execute({
      installationId: b.installationId,
      method: 'tools/call',
      params: { name: 'long', arguments: {} },
      ctx: ctxOf({ installationId: b.installationId }),
    });
    const wrapped = ((created as { task: typeof task }).task as typeof task).task.taskId;
    await service.executeTask({
      method: 'tasks/get',
      params: { taskId: wrapped },
      ctx: ctxOf({ installationId: 'ignored' }),
    });
    expect(seen.at(-1)).toBe('inst-b');
  });
});

describe('6.4 upstream context sent with every operation', () => {
  it('6.4 the upstream request context carries the downstream principal and trace carrier', async () => {
    const session = fakeSession(() => ({ kind: 'complete', result: { content: [] } }));
    const { service, a } = build(session);
    await service.execute({
      installationId: a.installationId,
      method: 'tools/call',
      params: { name: 'x', arguments: {} },
      ctx: ctxOf({
        trace: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
        downstreamName: 'a__x',
      }),
    });
    const sent = session.calls[0]?.options.ctx;
    expect(sent?.principal.userId).toBe('user-1');
    expect(sent?.trace.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  });

  it('6.7 instructions and serverInfo seen at the handshake are available to the list layer', async () => {
    const session = fakeSession(() => ({ kind: 'complete', result: {} }));
    const { service, a } = build(session);
    await service.execute({
      installationId: a.installationId,
      method: 'ping',
      params: {},
      ctx: ctxOf(),
    });
    expect(service.upstreamMeta(a, { injections: [], credentialHash: 'cred-1' })).toMatchObject({
      instructions: 'be nice',
      serverInfo: { name: 'fake' },
    });
  });

  it('6.9 upstream failures are mapped to typed errors with the installation slug', async () => {
    const session = fakeSession(() => {
      throw new Error('socket hang up');
    });
    const { service, a } = build(session);
    const error = await service
      .execute({
        installationId: a.installationId,
        method: 'tools/call',
        params: { name: 'x' },
        ctx: ctxOf(),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect((error as UpstreamUnavailableError).data.installation).toBe('a');
  });

  it('6.9 an unknown method on a modern single-installation endpoint is forwarded verbatim', async () => {
    const session = fakeSession(() => ({ kind: 'complete', result: { skills: [] } }));
    const { service, a } = build(session);
    const out = await service.execute({
      installationId: a.installationId,
      method: 'skills/list',
      params: { cursor: 'c' },
      ctx: ctxOf({ singleInstallationEndpoint: true }),
    });
    expect(out).toEqual({ kind: 'complete', result: { skills: [] } });
    expect(session.calls[0]).toMatchObject({ method: 'skills/list', params: { cursor: 'c' } });
  });
});

describe('6.5 upstream auth required', () => {
  const echo = () =>
    fakeSession(() => ({ kind: 'complete', result: { content: [{ type: 'text', text: 'ok' }] } }));

  it('6.5 returns input_required with a URL-mode elicitation when the client declared elicitation.url', async () => {
    const session = echo();
    const { service, a, credentials } = build(session);
    credentials.authRequired = true;
    const out = await service.execute({
      installationId: a.installationId,
      method: 'tools/call',
      params: { name: 'x', arguments: {} },
      ctx: ctxOf({ endpointId: 'ep-1', clientCapabilities: { elicitation: { url: {} } } }),
    });
    expect(out.kind).toBe('input_required');
    if (out.kind !== 'input_required') return;
    const request = out.inputRequests?.auth;
    expect(request?.method).toBe('elicitation/create');
    expect(request?.params).toMatchObject({
      mode: 'url',
      url: 'https://bastion.test/connect/inst-a?state=abc',
    });
    expect(out.requestState.startsWith('bst1.')).toBe(true);
    expect(session.calls).toHaveLength(0);
    // After the user connected, the retry runs the call.
    credentials.authRequired = false;
    const done = await service.retry({
      installationId: a.installationId,
      method: 'tools/call',
      params: { name: 'x', arguments: {} },
      inputResponses: { auth: { action: 'accept' } },
      requestState: out.requestState,
      ctx: ctxOf({ endpointId: 'ep-1', clientCapabilities: { elicitation: { url: {} } } }),
    });
    expect(done.kind).toBe('complete');
    expect(session.calls[0]?.params.requestState).toBeUndefined();
  });

  it('6.5 otherwise the call fails with -32015 and data.connectUrl', async () => {
    const { service, a, credentials } = build(echo());
    credentials.authRequired = true;
    for (const clientCapabilities of [{}, { elicitation: { form: {} } }]) {
      const error = await service
        .execute({
          installationId: a.installationId,
          method: 'tools/call',
          params: { name: 'x' },
          ctx: ctxOf({ clientCapabilities }),
        })
        .catch((e: unknown) => e);
      expect((error as { mcpCode?: number }).mcpCode).toBe(-32015);
      expect((error as { data: { connectUrl: string } }).data.connectUrl).toBe(
        'https://bastion.test/connect/inst-a?state=abc',
      );
    }
  });

  it('6.5 methods that cannot elicit (completion, lists) always fail with -32015', async () => {
    const { service, a, credentials } = build(echo());
    credentials.authRequired = true;
    const error = await service
      .execute({
        installationId: a.installationId,
        method: 'completion/complete',
        params: {},
        ctx: ctxOf({ clientCapabilities: { elicitation: { url: {} } } }),
      })
      .catch((e: unknown) => e);
    expect((error as { mcpCode?: number }).mcpCode).toBe(-32015);
  });
});
