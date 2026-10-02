/**
 * 23.3 security suites for the downstream layer: token attacks with the real `TokenVerifier`, session id reuse,
 * requestState and task id attacks, hidden items, and the shape of guard, policy and limit denials.
 */
import { wrapRequestState } from '@bastion-mcp/core';
import { afterEach, describe, expect, it } from 'vitest';
import { principal as fixturePrincipal, uuidFor } from './helpers/fixtures';
import { freePort, type HttpStack, startHttpStack } from './helpers/http-stack';
import { realAuth } from './helpers/real-auth';
import { rawLegacy, rawModern } from './helpers/raw';
import { keyring } from './helpers/ops';

let stack: HttpStack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

const ALICE = uuidFor('user-alice');
const BOB = uuidFor('user-bob');
const record = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'user' as const,
  orgRole: 'member' as const,
  teams: [],
  active: true,
  ...over,
});

const withRealAuth = async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const auth = realAuth(base, [record(ALICE), record(BOB)]);
  stack = await startHttpStack({ port, verifier: auth.verifier });
  return { base, auth };
};

const list = (base: string, token: string, path = '/mcp') => rawModern(base, { token, path, method: 'tools/list' });

describe('23.3 token attacks (real verifier)', () => {
  it('9.3 a valid token reaches the endpoint', async () => {
    const { base, auth } = await withRealAuth();
    const res = await list(base, await auth.sign({}, { sub: ALICE }));
    expect(res.status).toBe(200);
  });

  it('23.3 an expired token is 401 with the Bearer challenge naming the resource metadata', async () => {
    const { base, auth } = await withRealAuth();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const res = await list(base, await auth.sign({}, { sub: ALICE, iat: past - 900, exp: past }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    );
  });

  it('23.3 a token for another audience, another issuer or another type is 401', async () => {
    const { base, auth } = await withRealAuth();
    for (const options of [
      { aud: 'https://evil.example/mcp' },
      { aud: `${base}/api` },
      { iss: 'https://evil.example/oauth' },
      { typ: 'JWT' },
    ]) {
      const res = await list(base, await auth.sign({}, { sub: ALICE, ...options }));
      expect(res.status).toBe(401);
    }
  });

  it('23.3 a revoked principal (watermark at or after iat) is 401', async () => {
    const { base, auth } = await withRealAuth();
    const token = await auth.sign({}, { sub: ALICE });
    await auth.revocations.setWatermark(ALICE, Math.floor(Date.now() / 1000) + 1);
    expect((await list(base, token)).status).toBe(401);
  });

  it('23.3 an alg: none token is 401', async () => {
    const { base, auth } = await withRealAuth();
    expect((await list(base, auth.unsigned(ALICE))).status).toBe(401);
  });

  it('23.3 a token with a tampered payload or signature is 401', async () => {
    const { base, auth } = await withRealAuth();
    const token = await auth.sign({}, { sub: ALICE });
    const [h, p, s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p ?? '', 'base64url').toString()), sub: BOB })).toString('base64url');
    expect((await list(base, `${h}.${forgedPayload}.${s}`)).status).toBe(401);
    expect((await list(base, `${h}.${p}.${(s ?? '').slice(0, -2)}AA`)).status).toBe(401);
  });

  it('9.3 a token without the mcp scope is 403 insufficient_scope', async () => {
    const { base, auth } = await withRealAuth();
    const res = await list(base, await auth.sign({ scope: 'api:read' }, { sub: ALICE }));
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
  });

  it('7.1 a token whose audience is a path prefix of the request URL is accepted, and only there', async () => {
    const { base, auth } = await withRealAuth();
    const token = await auth.sign({}, { sub: ALICE, aud: `${base}/mcp/i/github` });
    expect((await list(base, token, '/mcp/i/github')).status).toBe(200);
    expect((await list(base, token, '/mcp')).status).toBe(401);
  });

  it('9.3 an inactive principal is 401', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const auth = realAuth(base, [record(ALICE, { active: false })]);
    stack = await startHttpStack({ port, verifier: auth.verifier });
    expect((await list(base, await auth.sign({}, { sub: ALICE }))).status).toBe(401);
  });
});

describe('23.3 legacy session id reuse', () => {
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
  };

  it('6.2 a session id presented with another user token is 404, indistinguishable from an unknown id', async () => {
    stack = await startHttpStack();
    const created = await rawLegacy(stack.base, { token: stack.users.alice?.token ?? '', protocolVersion: '2025-06-18', body: init });
    const sessionId = created.headers.get('mcp-session-id') ?? '';
    expect(sessionId).toHaveLength(43); // 32 random bytes, base64url
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    const other = await rawLegacy(stack.base, { token: stack.users.bob?.token ?? '', protocolVersion: '2025-06-18', sessionId, body: call });
    const unknown = await rawLegacy(stack.base, { token: stack.users.bob?.token ?? '', protocolVersion: '2025-06-18', sessionId: 'x'.repeat(43), body: call });
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(other.text).toBe(unknown.text);
    const owner = await rawLegacy(stack.base, { token: stack.users.alice?.token ?? '', protocolVersion: '2025-06-18', sessionId, body: call });
    expect(owner.status).toBe(200);
  });

  it('6.2 another user cannot end the session with DELETE or read its GET stream', async () => {
    stack = await startHttpStack();
    const created = await rawLegacy(stack.base, { token: stack.users.alice?.token ?? '', protocolVersion: '2025-06-18', body: init });
    const sessionId = created.headers.get('mcp-session-id') ?? '';
    const del = await rawLegacy(stack.base, { token: stack.users.bob?.token ?? '', method: 'DELETE', body: undefined, sessionId, protocolVersion: '2025-06-18' });
    expect(del.status).toBe(404);
    const get = await rawLegacy(stack.base, { token: stack.users.bob?.token ?? '', method: 'GET', body: undefined, sessionId, protocolVersion: '2025-06-18', headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(404);
    expect((await stack.redis.keys()).some((k) => k === `sess:${sessionId}`)).toBe(true);
  });
});

describe('23.3 requestState attacks over HTTP (modern)', () => {
  const callTool = (token: string, args: Record<string, unknown>, extra: Record<string, unknown>) =>
    rawModern(stack?.base ?? '', {
      token,
      path: '/mcp/i/github',
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: args, ...extra },
      capabilities: { elicitation: { form: {} } },
    });

  const stateFor = (userToken: 'alice' | 'bob', over: Record<string, unknown> = {}, now = Math.floor(Date.now() / 1000)) =>
    wrapRequestState(
      keyring,
      {
        principalId: stack?.users[userToken]?.id ?? '',
        endpointId: `i:${stack?.installs[0]?.id}`,
        installationId: stack?.installs[0]?.id ?? '',
        method: 'tools/call',
        name: 'echo',
        args: { text: 'x' },
        ...over,
      },
      { now },
    );

  it('6.5 22.1 a valid state works; tampered, other-user, other-args, expired and unprefixed states are -32602 invalid requestState', async () => {
    stack = await startHttpStack();
    const alice = stack.users.alice?.token ?? '';
    const bob = stack.users.bob?.token ?? '';
    const good = stateFor('alice');
    const ok = await callTool(alice, { text: 'x' }, { requestState: good, inputResponses: {} });
    expect(ok.json?.result).toBeDefined();
    stack.upstream.calls.length = 0;
    const attacks: [string, Promise<Awaited<ReturnType<typeof rawModern>>>][] = [
      ['tampered', callTool(alice, { text: 'x' }, { requestState: `${good.slice(0, -2)}AA`, inputResponses: {} })],
      ['other user', callTool(bob, { text: 'x' }, { requestState: good, inputResponses: {} })],
      ['other args', callTool(alice, { text: 'DIFFERENT' }, { requestState: good, inputResponses: {} })],
      ['expired', callTool(alice, { text: 'x' }, { requestState: stateFor('alice', {}, Math.floor(Date.now() / 1000) - 7200), inputResponses: {} })],
      ['unprefixed', callTool(alice, { text: 'x' }, { requestState: 'upstream-state-1', inputResponses: {} })],
      ['other endpoint', callTool(alice, { text: 'x' }, { requestState: stateFor('alice', { endpointId: 'default' }), inputResponses: {} })],
    ];
    for (const [name, pending] of attacks) {
      const res = await pending;
      expect(res.json?.error, name).toMatchObject({ code: -32602, message: 'invalid requestState' });
    }
    expect(stack.upstream.calls).toHaveLength(0);
  });
});

describe('6.9 hidden items and denial shapes over HTTP', () => {
  it('6.9 a tool hidden by policy and a nonexistent tool are the same JSON-RPC error', async () => {
    stack = await startHttpStack({
      policy: {
        authorize: () => ({ decision: 'allow', reasons: [], errors: [] }),
        filterVisible: (request, list) =>
          request.action === 'seeTool'
            ? {
                visible: list.filter((i) => !('name' in i && i.name === 'echo')),
                hidden: list.filter((i) => 'name' in i && i.name === 'echo').map((item) => ({ item, reasons: ['h'] })),
              }
            : { visible: [...list], hidden: [] },
      },
    });
    const call = (name: string) =>
      rawModern(stack?.base ?? '', { token: stack?.users.alice?.token ?? '', path: '/mcp/i/github', method: 'tools/call', name, params: { name, arguments: {} } });
    const hidden = await call('echo');
    const missing = await call('nonexistent');
    expect(hidden.json?.error?.code).toBe(-32602);
    expect(missing.json?.error?.code).toBe(-32602);
    expect(hidden.status).toBe(missing.status);
    expect(hidden.json?.error?.message?.replace('echo', 'X')).toBe(missing.json?.error?.message?.replace('nonexistent', 'X'));
  });

  it('6.9 policy, limit and guard denials of tools/call are tool results with isError and the Bastion error _meta', async () => {
    stack = await startHttpStack({
      policy: {
        authorize: (req) => ({ decision: req.action === 'callTool' || req.action === 'getPrompt' ? 'deny' : 'allow', reasons: ['p1'], errors: [] }),
        filterVisible: (_r, list) => ({ visible: [...list], hidden: [] }),
      },
    });
    const denied = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: '/mcp/i/github', method: 'tools/call', name: 'echo', params: { name: 'echo', arguments: {} } });
    expect(denied.status).toBe(200);
    expect(denied.json?.result?.isError).toBe(true);
    expect(JSON.stringify(denied.json?.result?._meta)).toContain('POLICY_DENIED');
    const other = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: '/mcp/i/github', method: 'prompts/get', name: 'greet', params: { name: 'greet', arguments: { who: 'a' } } });
    // Only tools/call turns a denial into a result; other methods answer a JSON-RPC error (6.9).
    expect(other.json?.error?.code).toBe(-32010);
  });

  it('13.2 a response guard that blocks never lets the content through and the call log says blocked', async () => {
    stack = await startHttpStack({
      guardLayers: { org: { guards: [{ instanceId: 'g', type: 'regex', config: { rules: [{ id: 'r', pattern: 'TOPSECRET', phases: ['response'], action: 'block', verdict: 'malicious' }] } }] } },
    });
    stack.upstream.script = () => ({ kind: 'complete', result: { content: [{ type: 'text', text: 'the TOPSECRET payload' }] } });
    const res = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: '/mcp/i/github', method: 'tools/call', name: 'echo', params: { name: 'echo', arguments: {} } });
    expect(res.text).not.toContain('TOPSECRET payload');
    expect(res.json?.result?.isError).toBe(true);
    expect(stack.rows.at(-1)?.outcome).toBe('blocked');
  });

  it('14.2 a rate limit is a tool result with retryAfterMs', async () => {
    stack = await startHttpStack({
      rules: [
        { id: 'r1', name: 'r', subject: 'user', subjectMatch: 'each', scope: {}, kind: 'rate', params: { points: 1, perSeconds: 60, burst: 0 }, metric: 'calls', action: 'reject', enabled: true },
      ],
    });
    const call = () =>
      rawModern(stack?.base ?? '', { token: stack?.users.alice?.token ?? '', path: '/mcp/i/github', method: 'tools/call', name: 'echo', params: { name: 'echo', arguments: {} } });
    await call();
    const limited = await call();
    expect(limited.json?.result?.isError).toBe(true);
    expect(JSON.stringify(limited.json?.result?._meta)).toContain('retryAfterMs');
  });
});

describe('22.1 principals are isolated', () => {
  it('7.1 two users calling the same endpoint get their own installations and call-log principals', async () => {
    stack = await startHttpStack();
    for (const who of ['alice', 'bob'] as const) {
      await rawModern(stack.base, { token: stack.users[who]?.token ?? '', path: '/mcp/i/github', method: 'tools/call', name: 'echo', params: { name: 'echo', arguments: {} } });
    }
    const principals = stack.rows.map((r) => r.principalId);
    expect(new Set(principals).size).toBe(2);
    const installs = stack.rows.map((r) => r.installationId);
    expect(new Set(installs).size).toBe(2);
    expect(fixturePrincipal().id).toBeTypeOf('string');
  });
});
