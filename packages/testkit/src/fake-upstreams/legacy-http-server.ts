import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLegacyBrain,
  type JsonObject,
  type JsonRpcId,
  type LegacyConnection,
  type LegacySessionState,
  STREAMING_TOOLS,
} from './legacy-brain';
import type { RecordedRequest } from './modern-server';

/** A legacy (2025-era) Streamable HTTP MCP server with sessions, SSE-delivered server requests and a GET stream. */

type Session = {
  id: string;
  state: LegacySessionState;
  getStream: http.ServerResponse | undefined;
  pending: Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextServerId: number;
};

export type FakeLegacyHttpServer = {
  url: string;
  port: number;
  requests: RecordedRequest[];
  sessions: () => string[];
  /** Number of `initialize` requests seen. */
  initializeCount: () => number;
  /** Methods the server received, in order (JSON-RPC bodies). */
  methods: () => string[];
  toolsChanged: () => void;
  resourceUpdated: (uri: string) => void;
  subscriptions: () => string[];
  /** Whether any session currently has an open GET stream. */
  hasGetStream: () => boolean;
  close: () => Promise<void>;
};

const readJson = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? undefined : JSON.parse(raw);
};

const sse = (res: http.ServerResponse, message: unknown): void => {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
};

export const startFakeLegacyHttpServer = async (
  options: { listTtlMs?: number; requiredToken?: string } = {},
): Promise<FakeLegacyHttpServer> => {
  const sessions = new Map<string, Session>();
  const requests: RecordedRequest[] = [];
  const methods: string[] = [];
  const subscribed = new Set<string>();
  let initializeCount = 0;
  const brain = createLegacyBrain({
    ...(options.listTtlMs === undefined ? {} : { listTtlMs: options.listTtlMs }),
    onSubscribe: (uri, on) => {
      if (on) subscribed.add(uri);
      else subscribed.delete(uri);
    },
  });

  const notifyAll = (message: unknown): void => {
    for (const session of sessions.values()) if (session.getStream) sse(session.getStream, message);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (
        options.requiredToken !== undefined &&
        req.headers.authorization !== `Bearer ${options.requiredToken}`
      ) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      const sid = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (req.method === 'DELETE') {
        if (sessionId) sessions.delete(sessionId);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET') {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': ok\n\n');
        session.getStream?.end();
        session.getStream = res;
        res.on('close', () => {
          if (session.getStream === res) session.getStream = undefined;
        });
        return;
      }
      const message = body as
        | { id?: JsonRpcId; method?: string; params?: JsonObject; result?: unknown; error?: unknown }
        | undefined;
      if (!message || typeof message !== 'object') {
        res.writeHead(400).end();
        return;
      }
      if (message.method !== undefined) methods.push(message.method);
      // A client answering a server-to-client request.
      if (message.method === undefined && message.id !== undefined) {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const waiter = session?.pending.get(message.id);
        if (session && waiter) {
          session.pending.delete(message.id);
          if (message.error) waiter.reject(Object.assign(new Error('client error'), message.error));
          else waiter.resolve(message.result);
        }
        res.writeHead(202).end();
        return;
      }
      if (message.method === 'initialize') {
        initializeCount += 1;
        const session: Session = {
          id: randomUUID(),
          state: { subscriptions: new Set() },
          getStream: undefined,
          pending: new Map(),
          nextServerId: 1,
        };
        sessions.set(session.id, session);
        const reply = await brain.handle(session.state, 'initialize', message.params, {
          sendRequest: () => Promise.reject(new Error('n/a')),
          notifyRelated: () => {},
        });
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session.id });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }));
        return;
      }
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        // Legacy servers without a session reject everything else (this is what a `server/discover` probe sees).
        res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          }),
        );
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const streaming =
        message.method === 'tools/call' &&
        STREAMING_TOOLS.has(String((message.params as JsonObject | undefined)?.name));
      if (!streaming) {
        const reply = await brain.handle(session.state, message.method ?? '', message.params, {
          sendRequest: () => Promise.reject(new Error('no stream')),
          notifyRelated: () => {},
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const connection: LegacyConnection = {
        sendRequest: (method, params) =>
          new Promise((resolve, reject) => {
            const id = `s${session.nextServerId++}`;
            session.pending.set(id, { resolve, reject });
            sse(res, { jsonrpc: '2.0', id, method, params });
          }),
        notifyRelated: (method, params) => sse(res, { jsonrpc: '2.0', method, params }),
      };
      const reply = await brain.handle(session.state, message.method ?? '', message.params, connection);
      sse(res, { jsonrpc: '2.0', id: message.id, ...reply });
      res.end();
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
    sessions: () => [...sessions.keys()],
    initializeCount: () => initializeCount,
    methods: () => methods,
    toolsChanged: () => notifyAll({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
    resourceUpdated: (uri) =>
      notifyAll({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } }),
    subscriptions: () => [...subscribed],
    hasGetStream: () => [...sessions.values()].some((s) => s.getStream !== undefined),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
