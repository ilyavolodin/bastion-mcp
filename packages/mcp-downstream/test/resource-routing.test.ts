/** 7.4 the one rule that routes a resource URI to an installation: read, subscribe and the listen filter agree. */
import { type EndpointPolicy, RedisSeenUriStore } from '@bastion-mcp/router';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowAllPolicy,
  buildEndpoint,
  installation,
  items,
  opContext,
  principal,
} from './helpers/fixtures';
import { type HttpStack, startHttpStack } from './helpers/http-stack';
import { makeOps } from './helpers/ops';
import { modernEnvelope } from './helpers/raw';

const NOT_SERVED = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99';

const opsSetup = async () => {
  const inst = installation('github');
  const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
  const ops = makeOps();
  return { ops, inst, ctx: () => opContext(resolved) };
};

describe('7.4 resource URI routing in the operations', () => {
  it('7.4 a seen URI of an installation the endpoint does not serve is -32602 for read, subscribe and unsubscribe', async () => {
    const { ops, ctx } = await opsSetup();
    await ops.seen.record(principal().id, 'default', [
      { uri: 'file:///gone.txt', installationId: NOT_SERVED },
    ]);
    for (const method of ['resources/read', 'resources/subscribe', 'resources/unsubscribe']) {
      await expect(ops.run(method, { uri: 'file:///gone.txt' }, ctx())).rejects.toMatchObject({
        mcpCode: -32602,
      });
    }
    expect(ops.upstream.calls).toHaveLength(0);
    expect(ops.upstream.subscriptions).toHaveLength(0);
  });

  it('7.4 a seen URI of a served installation routes read and subscribe to it', async () => {
    const { ops, ctx, inst } = await opsSetup();
    await ops.seen.record(principal().id, 'default', [
      { uri: 'file:///seen.txt', installationId: inst.id },
    ]);
    await ops.run('resources/read', { uri: 'file:///seen.txt' }, ctx());
    expect(ops.upstream.calls[0]?.params.uri).toBe('file:///seen.txt');
    await ops.run('resources/subscribe', { uri: 'file:///seen.txt' }, ctx());
    expect(ops.upstream.subscriptions[0]).toMatchObject({
      action: 'add',
      args: { installationId: inst.id, downstreamUri: 'file:///seen.txt' },
    });
  });

  it('7.4 an unknown URI is -32602 for unsubscribe too', async () => {
    const { ops, ctx } = await opsSetup();
    await expect(
      ops.run('resources/unsubscribe', { uri: 'nope://x' }, ctx()),
    ).rejects.toMatchObject({ mcpCode: -32602 });
  });
});

describe('7.4 10.3 the listen adapter honors only the URIs resources/read would serve', () => {
  const stacks: HttpStack[] = [];
  afterAll(async () => {
    for (const s of stacks) await s.stop();
  });

  const honored = async (stack: HttpStack, uris: string[]): Promise<unknown> => {
    const abort = new AbortController();
    const res = await fetch(`${stack.base}/mcp/i/github`, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'subscriptions/listen',
        authorization: `Bearer ${stack.users.alice?.token ?? ''}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: { notifications: { resourceSubscriptions: uris }, _meta: modernEnvelope() },
      }),
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (reader && !text.includes('\n\n')) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value);
    }
    abort.abort();
    const data = text
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5);
    return (JSON.parse(data ?? '{}') as { params?: { notifications?: unknown } }).params
      ?.notifications;
  };

  const start = async (policy?: EndpointPolicy): Promise<HttpStack> => {
    const stack = await startHttpStack(policy ? { policy } : {});
    stacks.push(stack);
    return stack;
  };

  it('7.4 an indexed URI is honored, an unknown one and a seen-but-unserved one are dropped', async () => {
    const stack = await start();
    const endpointId = `i:${stack.installs[0]?.id}`;
    await new RedisSeenUriStore(stack.redis as never).record(
      stack.users.alice?.id ?? '',
      endpointId,
      [
        { uri: 'file:///gone.txt', installationId: NOT_SERVED },
        { uri: 'file:///seen.txt', installationId: stack.installs[0]?.id ?? '' },
      ],
    );
    expect(
      await honored(stack, ['test://static', 'nope://x', 'file:///gone.txt', 'file:///seen.txt']),
    ).toEqual({ resourceSubscriptions: ['test://static', 'file:///seen.txt'] });
  });

  it('10.3 a URI the policy denies for readResource is dropped', async () => {
    const stack = await start({
      ...allowAllPolicy,
      authorize: (req) => ({
        decision: req.action === 'readResource' ? 'deny' : 'allow',
        reasons: ['p1'],
        errors: [],
      }),
    });
    expect(await honored(stack, ['test://static'])).toEqual({});
  });
});
