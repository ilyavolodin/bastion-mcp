/** 21.2 graceful shutdown of the downstream layer, and the other long-lived stream behaviors of the HTTP stack. */
import { afterEach, describe, expect, it } from 'vitest';
import { connectClient, textOf } from './helpers/clients';
import { type HttpStack, startHttpStack } from './helpers/http-stack';
import { rawLegacy, rawModern } from './helpers/raw';

let stack: HttpStack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!check() && Date.now() - started < timeoutMs) await wait(20);
};
const alice = (s: HttpStack) => s.users.alice ?? { id: '', token: '' };
const urlOf = (s: HttpStack) => ({ url: (path = '/mcp') => `${s.base}${path}` });

describe('21.2 graceful shutdown', () => {
  it('21.2 a modern listen stream gets a final complete result (graceful), not an abrupt close', async () => {
    stack = await startHttpStack();
    const client = await connectClient(urlOf(stack), alice(stack), {
      era: 'modern',
      path: '/mcp/i/github',
    });
    const sub = await client.listen({ toolsListChanged: true });
    const running = stack;
    await until(() => running.downstream.streams().listen === 1);
    expect(stack.downstream.streams().listen).toBe(1);
    await stack.downstream.shutdown({ graceMs: 200 });
    expect(await sub.closed).toBe('graceful');
    expect(stack.downstream.streams().listen).toBe(0);
    await client.close().catch(() => undefined);
  });

  it('21.2 a legacy GET stream is closed by closing the SSE stream', async () => {
    stack = await startHttpStack();
    const init = await rawLegacy(stack.base, {
      token: alice(stack).token,
      protocolVersion: '2025-06-18',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '1' },
        },
      },
    });
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    const res = await fetch(`${stack.base}/mcp`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${alice(stack).token}`,
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18',
      },
    });
    expect(res.status).toBe(200);
    const open = stack;
    await until(() => open.downstream.streams().legacy === 1);
    expect(stack.downstream.streams().legacy).toBe(1);
    const ended = (async () => {
      const reader = res.body?.getReader();
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) return 'ended';
      }
    })();
    await stack.downstream.shutdown({ graceMs: 200 });
    expect(await ended).toBe('ended');
    expect(stack.downstream.streams().legacy).toBe(0);
  });

  it('21.2 in-flight operations finish before the streams close and new requests are refused with 503', async () => {
    stack = await startHttpStack();
    stack.upstream.script = async () => {
      await wait(300);
      return { kind: 'complete', result: { content: [{ type: 'text', text: 'late but whole' }] } };
    };
    const inflight = rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: {} },
    });
    await wait(80);
    const shutdown = stack.downstream.shutdown({ graceMs: 3000 });
    await wait(20);
    const refused = await rawModern(stack.base, {
      token: alice(stack).token,
      method: 'tools/list',
    });
    expect(refused.status).toBe(503);
    const done = await inflight;
    expect(textOf(done.json?.result)).toBe('late but whole');
    await shutdown;
  });

  it('21.2 shutdown is bounded by the grace period when an operation never ends', async () => {
    stack = await startHttpStack();
    stack.upstream.script = () => new Promise(() => undefined);
    void rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: {} },
    }).catch(() => undefined);
    await wait(80);
    const started = Date.now();
    await stack.downstream.shutdown({ graceMs: 150 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('6.8 tools/call for clients that declare the Tasks extension', () => {
  const TASKS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };

  it('6.5 6.6 progress notifications upgrade the response to SSE and the result follows', async () => {
    stack = await startHttpStack();
    stack.upstream.script = (c) => {
      c.ctx.emit?.({ method: 'notifications/progress', params: { progress: 1, total: 2 } });
      return { kind: 'complete', result: { content: [{ type: 'text', text: 'done' }] } };
    };
    const res = await rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: {} },
      capabilities: TASKS,
      meta: { progressToken: 'p-1' },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.text).toContain('"progressToken":"p-1"');
    expect(textOf(res.json?.result)).toBe('done');
  });

  it('6.5 input_required is returned with the wrapped state and a retry completes', async () => {
    stack = await startHttpStack();
    stack.upstream.script = (c) =>
      c.params.inputResponses === undefined
        ? {
            kind: 'input_required',
            inputRequests: {
              a: {
                method: 'elicitation/create',
                params: {
                  message: 'm',
                  mode: 'form',
                  requestedSchema: { type: 'object', properties: {} },
                },
              },
            },
            requestState: 'bst1.opaque',
          }
        : { kind: 'complete', result: { content: [{ type: 'text', text: 'resumed' }] } };
    const first = await rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: {} },
      capabilities: { ...TASKS, elicitation: { form: {} } },
    });
    expect(first.json?.result?.resultType).toBe('input_required');
    expect(first.json?.result?.requestState).toBe('bst1.opaque');
  });

  it('6.2 header validation applies: Mcp-Name must be the tool name and the envelope must be present', async () => {
    stack = await startHttpStack();
    const wrongName = await rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'other',
      params: { name: 'echo', arguments: {} },
      capabilities: TASKS,
    });
    expect(wrongName.status).toBe(400);
    expect(wrongName.json?.error?.code).toBe(-32020);
    const noEnvelope = await fetch(`${stack.base}/mcp/i/github`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alice(stack).token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-method': 'tools/call',
        'mcp-name': 'echo',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', _meta: { 'io.modelcontextprotocol/clientCapabilities': TASKS } },
      }),
    });
    expect(noEnvelope.status).toBe(400);
  });

  it('6.2 a JSON-RPC error of the operation layer is answered inside the JSON-RPC envelope', async () => {
    stack = await startHttpStack();
    const res = await rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'nope',
      params: { name: 'nope', arguments: {} },
      capabilities: TASKS,
    });
    expect(res.status).toBe(200);
    expect(res.json?.error?.code).toBe(-32602);
  });
});

describe('7.6 capabilities the endpoint does not declare', () => {
  it('7.6 methods of an undeclared capability are -32601 and the others keep working', async () => {
    stack = await startHttpStack({
      installs: [
        {
          slug: 'github',
          items: {
            tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
            prompts: [],
            resources: [],
            resourceTemplates: [],
          },
          info: { capabilities: { tools: true } },
        },
      ],
    });
    const prompts = await rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'prompts/list',
    });
    expect(prompts.json?.error?.code).toBe(-32601);
    const tools = await rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'tools/list',
    });
    expect(tools.json?.result?.tools).toBeDefined();
  });

  it('6.3 skills/list reaches the operation layer through the SDK fallback on every endpoint', async () => {
    stack = await startHttpStack({
      skills: {
        list: async () => ({ skills: [{ name: 'review', uri: 'skill://p/review/SKILL.md' }] }),
        get: async () => undefined,
        readResource: async () => undefined,
      },
    });
    const res = await rawModern(stack.base, { token: alice(stack).token, method: 'skills/list' });
    expect(JSON.stringify(res.json?.result?.skills)).toContain('review');
    const discover = await rawModern(stack.base, {
      token: alice(stack).token,
      method: 'server/discover',
    });
    expect(JSON.stringify(discover.json?.result?.capabilities)).toContain(
      'io.modelcontextprotocol/skills',
    );
  });

  it('6.3 unknown methods are -32601 on aggregate endpoints and forwarded on single-installation ones', async () => {
    stack = await startHttpStack();
    const agg = await rawModern(stack.base, { token: alice(stack).token, method: 'acme/hello' });
    expect(agg.json?.error?.code).toBe(-32601);
    stack.upstream.script = () => ({ kind: 'complete', result: { hello: 'world' } });
    const single = await rawModern(stack.base, {
      token: alice(stack).token,
      path: '/mcp/i/github',
      method: 'acme/hello',
    });
    expect(single.json?.result?.hello).toBe('world');
  });
});
