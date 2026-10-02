/**
 * 23.2 / 6.8 Tasks through the real downstream HTTP stack with the upstream scripted at the `UpstreamPort`: create, get,
 * update and cancel through wrapped `btk1.` ids, header validation and cross-user replay. (A wire-level Tasks upstream
 * cannot be exercised end to end: the SDK 2.2.0 client does not decode `resultType: "task"`, see the integration test.)
 */
import { wrapTaskId } from '@bastion-mcp/mcp-upstream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawModern } from './helpers/raw';
import { type HttpStack, startHttpStack } from './helpers/http-stack';
import { keyring } from './helpers/ops';

const TASKS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const PATH = '/mcp/i/github';

describe('6.8 Tasks extension through the downstream HTTP layer', () => {
  let stack: HttpStack;
  beforeAll(async () => {
    stack = await startHttpStack();
  });
  afterAll(async () => {
    await stack.stop();
  });

  const wrapFor = (who: 'alice' | 'bob', upstreamTaskId = 'up-1') =>
    wrapTaskId(keyring, {
      principalId: stack.users[who]?.id ?? '',
      installationId: stack.installs[0]?.id ?? '',
      upstreamTaskId,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
  const call = (who: 'alice' | 'bob', method: string, taskId: string, extra: Record<string, unknown> = {}, name: string | undefined = taskId, caps: Record<string, unknown> = TASKS) =>
    rawModern(stack.base, {
      token: stack.users[who]?.token ?? '',
      path: PATH,
      method,
      name,
      params: { taskId, ...extra },
      capabilities: caps,
    });

  it('6.8 declares the Tasks extension when the request declares it and an installation can serve it', async () => {
    const withExt = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: PATH, method: 'server/discover', capabilities: TASKS });
    expect(JSON.stringify(withExt.json?.result?.capabilities)).toContain('io.modelcontextprotocol/tasks');
    const without = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: PATH, method: 'server/discover' });
    expect(JSON.stringify(without.json?.result?.capabilities)).not.toContain('io.modelcontextprotocol/tasks');
  });

  it('6.8 a task outcome of tools/call reaches the client as a CreateTaskResult with the wrapped id', async () => {
    const id = wrapFor('alice');
    stack.upstream.script = () => ({ kind: 'task', task: { resultType: 'task', task: { taskId: id, status: 'working' } } });
    const res = await rawModern(stack.base, {
      token: stack.users.alice?.token ?? '',
      path: PATH,
      method: 'tools/call',
      name: 'echo',
      params: { name: 'echo', arguments: {} },
      capabilities: TASKS,
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).toContain(id);
  });

  it('6.8 tasks/get routes by the wrapped id and answers with the same id', async () => {
    const id = wrapFor('alice');
    stack.upstream.taskScript = () => ({ kind: 'complete', result: { taskId: id, status: 'working' } });
    const res = await call('alice', 'tasks/get', id);
    expect(res.status).toBe(200);
    expect(res.json?.result).toMatchObject({ taskId: id, status: 'working', resultType: 'complete' });
    expect(stack.upstream.taskCalls.at(-1)).toMatchObject({ method: 'tasks/get', params: { taskId: id } });
  });

  it('6.8 response guards run on the terminal result of tasks/get', async () => {
    const id = wrapFor('alice');
    stack.guardLayers.current = {
      org: { guards: [{ instanceId: 'g', type: 'regex', config: { rules: [{ id: 'r', label: 'k', pattern: 'sk-[0-9]+', phases: ['response'], action: 'redact' }] } }] },
    };
    stack.upstream.taskScript = () => ({ kind: 'complete', result: { taskId: id, status: 'completed', result: { content: [{ type: 'text', text: 'key sk-123' }] } } });
    const res = await call('alice', 'tasks/get', id);
    expect(JSON.stringify(res.json?.result)).toContain('[REDACTED:k]');
    stack.guardLayers.current = {};
  });

  it('6.8 tasks/update and tasks/cancel route the same way', async () => {
    const id = wrapFor('alice');
    stack.upstream.taskScript = () => ({ kind: 'complete', result: { taskId: id, status: 'cancelled' } });
    await call('alice', 'tasks/update', id, { inputResponses: { a: { action: 'accept', content: {} } } });
    const cancel = await call('alice', 'tasks/cancel', id);
    expect(cancel.json?.result?.status).toBe('cancelled');
    expect(stack.upstream.taskCalls.map((c) => c.method)).toEqual(expect.arrayContaining(['tasks/update', 'tasks/cancel']));
  });

  it('22.1 a task id of another user, a tampered id and a forged id are rejected before the upstream is called', async () => {
    const before = stack.upstream.taskCalls.length;
    const aliceId = wrapFor('alice');
    for (const [who, id] of [['bob', aliceId], ['alice', `${aliceId.slice(0, -3)}AAA`], ['alice', 'btk1.forged'], ['alice', 'plain']] as const) {
      const res = await call(who, 'tasks/get', id);
      expect(res.json?.error?.code).toBe(-32602);
    }
    expect(stack.upstream.taskCalls.length).toBe(before);
  });

  it('6.2 task methods get the SDK header validation: Mcp-Method, Mcp-Name and the protocol version', async () => {
    const id = wrapFor('alice');
    const wrongName = await call('alice', 'tasks/get', id, {}, 'other');
    expect(wrongName.status).toBe(400);
    expect(wrongName.json?.error?.code).toBe(-32020);
    const wrongMethod = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: PATH, method: 'tasks/get', name: id, params: { taskId: id }, capabilities: TASKS, headers: { 'mcp-method': 'tasks/cancel' } });
    expect(wrongMethod.status).toBe(400);
    const wrongVersion = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: PATH, method: 'tasks/get', name: id, params: { taskId: id }, capabilities: TASKS, headers: { 'mcp-protocol-version': '2026-01-01' } });
    expect(wrongVersion.status).toBe(400);
  });

  it('6.8 a client that did not declare the extension cannot use tasks/*', async () => {
    const res = await call('alice', 'tasks/get', wrapFor('alice'), {}, undefined, {});
    expect(res.json?.error?.code).toBe(-32601);
  });
});
