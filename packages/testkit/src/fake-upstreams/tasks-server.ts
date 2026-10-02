import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A raw JSON-RPC (2026-07-28 shape) server that implements the Tasks extension `io.modelcontextprotocol/tasks`
 * (6.8): `tools/call` of `long_task` answers a `CreateTaskResult`; `tasks/get` reports `working` until `completeAfter`
 * polls, then `completed` with the tool result; `tasks/update` records `inputResponses`; `tasks/cancel` cancels.
 * Written by hand because the SDK's 2026-07-28 registry does not carry `tasks/get` and `tasks/cancel`.
 */

export type FakeTasksServer = {
  url: string;
  port: number;
  /** `{ method, params }` of every request received, in order. */
  requests: { method: string; params: Record<string, unknown> }[];
  close: () => Promise<void>;
};

type TaskState = { polls: number; cancelled: boolean; inputResponses?: unknown };

const SERVER_INFO = { name: 'fake-tasks', version: '1.0.0' };

export const startFakeTasksServer = async (
  options: { completeAfter?: number } = {},
): Promise<FakeTasksServer> => {
  const completeAfter = options.completeAfter ?? 2;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const tasks = new Map<string, TaskState>();
  let next = 0;

  const result = (id: unknown, body: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      ...body,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    },
  });
  const error = (id: unknown, code: number, message: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  const handle = (body: { id?: unknown; method?: string; params?: Record<string, unknown> }) => {
    const params = body.params ?? {};
    requests.push({ method: String(body.method), params });
    switch (body.method) {
      case 'server/discover':
        return result(body.id, {
          supportedVersions: ['2026-07-28'],
          capabilities: {
            tools: {},
            extensions: { 'io.modelcontextprotocol/tasks': {} },
          },
          serverInfo: SERVER_INFO,
          ttlMs: 0,
          cacheScope: 'private',
        });
      case 'tools/list':
        return result(body.id, {
          tools: [
            {
              name: 'long_task',
              description: 'Starts a long running task',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
          ttlMs: 0,
          cacheScope: 'private',
        });
      case 'tools/call': {
        if (params.name !== 'long_task') return error(body.id, -32602, 'unknown tool');
        next += 1;
        const taskId = `task-${next}`;
        tasks.set(taskId, { polls: 0, cancelled: false });
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            resultType: 'task',
            task: { taskId, status: 'working', ttl: 600_000, pollIntervalMs: 10 },
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          },
        };
      }
      case 'tasks/get': {
        const taskId = String(params.taskId);
        const state = tasks.get(taskId);
        if (!state) return error(body.id, -32602, 'unknown task');
        state.polls += 1;
        if (state.cancelled) return result(body.id, { taskId, status: 'cancelled' });
        if (state.polls >= completeAfter) {
          return result(body.id, {
            taskId,
            status: 'completed',
            result: { content: [{ type: 'text', text: `task ${taskId} done` }] },
          });
        }
        return result(body.id, { taskId, status: 'working' });
      }
      case 'tasks/update': {
        const state = tasks.get(String(params.taskId));
        if (!state) return error(body.id, -32602, 'unknown task');
        state.inputResponses = params.inputResponses;
        return result(body.id, { taskId: params.taskId, status: 'working' });
      }
      case 'tasks/cancel': {
        const state = tasks.get(String(params.taskId));
        if (!state) return error(body.id, -32602, 'unknown task');
        state.cancelled = true;
        return result(body.id, { taskId: params.taskId, status: 'cancelled' });
      }
      default:
        return error(body.id, -32601, `Method not found: ${String(body.method)}`);
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let parsed: { id?: unknown; method?: string; params?: Record<string, unknown> } | undefined;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed;
      } catch {
        parsed = undefined;
      }
      if (req.method !== 'POST' || !parsed) {
        res.writeHead(405).end();
        return;
      }
      if (parsed.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handle(parsed)));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
