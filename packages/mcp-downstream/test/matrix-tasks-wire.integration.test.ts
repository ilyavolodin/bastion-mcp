/**
 * 23.2 Tasks row, wire level. The Tasks fake speaks `io.modelcontextprotocol/tasks` on the wire; Bastion's upstream
 * client is the SDK 2.2.0 `Client`, which decodes only `complete` and `input_required` results. A `resultType: "task"`
 * answer therefore surfaces as `-32014 upstream unavailable`: the task round trip is covered at the `UpstreamPort`
 * boundary in `tasks.test.ts` and cannot run end to end until the SDK client decodes task results.
 */
import { dockerAvailable, type FakeTasksServer, startFakeTasksServer, startRedis, type TestRedis } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawModern } from './helpers/raw';
import { startStack, type Stack } from './helpers/stack';

describe.skipIf(!dockerAvailable())('23.2 Tasks fake over the wire (known SDK 2.2.0 limitation)', () => {
  let redis: TestRedis;
  let tasks: FakeTasksServer;
  let stack: Stack;
  beforeAll(async () => {
    redis = await startRedis();
    tasks = await startFakeTasksServer();
    stack = await startStack({ redisUrl: redis.url, upstreams: [{ slug: 'tasks', kind: 'modern', url: tasks.url }] });
  }, 180_000);
  afterAll(async () => {
    await stack?.stop();
    await tasks?.close();
    await redis?.stop();
  });

  it('6.8 a CreateTaskResult from a wire-level Tasks upstream is reported as -32014 by the SDK client', async () => {
    const res = await rawModern(stack.base, {
      token: stack.users.alice?.token ?? '',
      path: '/mcp/i/tasks',
      method: 'tools/call',
      name: 'long_task',
      params: { name: 'long_task', arguments: {} },
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    });
    expect(res.json?.error?.code).toBe(-32014);
    expect(res.json?.error?.message).toMatch(/Unsupported result type 'task'/);
  });

  it('6.8 plain tool calls of the same upstream keep working', async () => {
    const res = await rawModern(stack.base, { token: stack.users.alice?.token ?? '', path: '/mcp/i/tasks', method: 'tools/list' });
    expect(JSON.stringify(res.json?.result?.tools)).toContain('long_task');
  });
});
