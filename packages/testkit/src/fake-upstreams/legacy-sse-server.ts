import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLegacyBrain,
  type JsonObject,
  type JsonRpcId,
  type LegacySessionState,
} from './legacy-brain';

/** A deprecated HTTP+SSE (2024-11-05) MCP server: `GET /sse` opens the stream, `POST /messages` sends requests. */

type SseSession = {
  stream: http.ServerResponse;
  state: LegacySessionState;
  pending: Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextServerId: number;
};

export type FakeLegacySseServer = {
  url: string;
  port: number;
  sessions: () => number;
  toolsChanged: () => void;
  close: () => Promise<void>;
};

export const startFakeLegacySseServer = async (): Promise<FakeLegacySseServer> => {
  const sessions = new Map<string, SseSession>();
  const brain = createLegacyBrain();
  const send = (session: SseSession, message: unknown): void => {
    session.stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/sse') {
        const id = randomUUID();
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
        sessions.set(id, {
          stream: res,
          state: { subscriptions: new Set() },
          pending: new Map(),
          nextServerId: 1,
        });
        res.on('close', () => sessions.delete(id));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const session = sessions.get(url.searchParams.get('sessionId') ?? '');
        if (!session) {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: JsonRpcId;
          method?: string;
          params?: JsonObject;
          result?: unknown;
          error?: unknown;
        };
        res.writeHead(202).end('Accepted');
        if (message.method === undefined && message.id !== undefined) {
          const waiter = session.pending.get(message.id);
          session.pending.delete(message.id);
          if (waiter) {
            if (message.error) waiter.reject(new Error('client error'));
            else waiter.resolve(message.result);
          }
          return;
        }
        if (message.id === undefined || message.method === undefined) return;
        const reply = await brain.handle(session.state, message.method, message.params, {
          sendRequest: (method, params) =>
            new Promise((resolve, reject) => {
              const id = `s${session.nextServerId++}`;
              session.pending.set(id, { resolve, reject });
              send(session, { jsonrpc: '2.0', id, method, params });
            }),
          notifyRelated: (method, params) => send(session, { jsonrpc: '2.0', method, params }),
        });
        send(session, { jsonrpc: '2.0', id: message.id, ...reply });
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    port,
    sessions: () => sessions.size,
    toolsChanged: () => {
      for (const s of sessions.values()) {
        send(s, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
