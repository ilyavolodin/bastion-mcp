import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildPrincipal } from '@bastion-mcp/auth';
import type {
  LegacyAdapter,
  NotifyEvent,
  NotifyHubPort,
  OpRunner,
  StreamTarget,
} from '../src/adapters/contracts';
import { createLegacyAdapter, type LegacyAdapterDeps } from '../src/adapters/legacy';
import type { BastionRequestContext } from '../src/context';
import type { JsonObject } from '../src/types';
import { FakeRedis } from './helpers/fake-redis';
import {
  buildEndpoint,
  installation,
  items,
  OTHER_USER_ID,
  requestContext,
  TEAM_ID,
  uuidFor,
} from './helpers/fixtures';

const INST_A = uuidFor('inst-a');

export class FakeHub implements NotifyHubPort {
  readonly targets: { target: StreamTarget; handler: (e: NotifyEvent) => void }[] = [];
  register(target: StreamTarget, handler: (event: NotifyEvent) => void): () => void {
    const entry = { target, handler };
    this.targets.push(entry);
    return () => {
      const i = this.targets.indexOf(entry);
      if (i >= 0) this.targets.splice(i, 1);
    };
  }
  emit(event: NotifyEvent): void {
    for (const t of [...this.targets]) t.handler(event);
  }
}

export const defaultRun: OpRunner = async (method, params) => {
  switch (method) {
    case 'initialize':
      return {
        kind: 'complete',
        result: {
          protocolVersion: params.protocolVersion === '2025-06-18' ? '2025-06-18' : '2025-11-25',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'bastion', version: '1' },
        },
      };
    case 'ping':
    case 'logging/setLevel':
    case 'resources/subscribe':
    case 'resources/unsubscribe':
    case 'notifications/initialized':
      return { kind: 'complete', result: {} };
    case 'tools/list':
      return { kind: 'complete', result: { tools: [] } };
    default:
      return { kind: 'complete', result: { content: [{ type: 'text', text: `ran ${method}` }] } };
  }
};

export type Harness = {
  url: string;
  adapter: LegacyAdapter;
  redis: FakeRedis;
  hub: FakeHub;
  forwarded: { address: string; sessionId: string; message: unknown }[];
  close: () => Promise<void>;
  rcOf: { current: (req: http.IncomingMessage) => BastionRequestContext };
};

export const startHarness = async (
  options: {
    run?: OpRunner;
    redis?: FakeRedis;
    deps?: Partial<LegacyAdapterDeps>;
    workerId?: string;
    peers?: Record<string, string>;
  } = {},
): Promise<Harness> => {
  const resolved = await buildEndpoint({
    installations: [installation('a')],
    items: { [INST_A]: items() },
  });
  const redis = options.redis ?? new FakeRedis();
  const hub = new FakeHub();
  const forwarded: Harness['forwarded'] = [];
  const adapter = createLegacyAdapter({
    redis,
    hub,
    run: options.run ?? defaultRun,
    workers: {
      workerId: options.workerId ?? 'w1',
      lookup: async (id) => (options.peers?.[id] ? { address: options.peers[id] } : null),
    },
    forwarder: {
      forwardSessionResponse: async (address, sessionId, message) => {
        forwarded.push({ address, sessionId, message });
      },
    },
    maxSessionsPerPrincipal: 20,
    roots: async () => [],
    keepAliveMs: 40,
    ...options.deps,
  });
  const rcOf = {
    current: (req: http.IncomingMessage): BastionRequestContext => {
      const who = req.headers['x-test-user'];
      return requestContext(resolved, {
        headers: req.headers,
        ...(typeof who === 'string'
          ? {
              principal: buildPrincipal(
                {
                  id: who === 'other' ? OTHER_USER_ID : who,
                  type: 'user',
                  orgRole: 'member',
                  teams: [{ teamId: TEAM_ID, role: 'member' }],
                  active: true,
                },
                { authMethod: 'oauth', clientId: 'c', scopes: ['mcp'] },
              ),
            }
          : {}),
      });
    },
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      await adapter.handle({ req, res, body, rc: { ...rcOf.current(req), body } });
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    adapter,
    redis,
    hub,
    forwarded,
    rcOf,
    close: async () => {
      await adapter.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
};

export const rpc = (id: number | string, method: string, params: JsonObject = {}): JsonObject => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

export const post = (
  h: Harness,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(h.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });

export const initialize = async (
  h: Harness,
  headers: Record<string, string> = {},
): Promise<string> => {
  const res = await post(
    h,
    rpc(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'c', version: '1' },
    }),
    headers,
  );
  const id = res.headers.get('mcp-session-id');
  if (!id) throw new Error(`no session id: ${res.status} ${await res.text()}`);
  await res.text();
  return id;
};

/** Parses SSE `data:` payloads of a text/event-stream body. */
export const sseMessages = (text: string): JsonObject[] =>
  text
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as JsonObject);
