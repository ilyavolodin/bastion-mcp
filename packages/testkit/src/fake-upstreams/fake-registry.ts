import type { IncomingMessage } from 'node:http';
import { startHttp } from '../http';

export type RegistryRecordedRequest = { url: string; headers: IncomingMessage['headers'] };

export type FakeRegistry = {
  baseUrl: string;
  requests: RegistryRecordedRequest[];
  /** Entries (list elements) served by `/v0.1/servers`, paged by `limit`. */
  setEntries(entries: unknown[]): void;
  /** Next response overrides, consumed in order: HTTP status and optional raw body. */
  failNext(status: number, body?: string): void;
  /** Delay every response by this long (timeout tests). */
  setDelay(ms: number): void;
  /** Raw body for the next list call. */
  rawNext(body: string): void;
  close(): Promise<void>;
};

/** A registry implementing the MCP Registry REST API v0.1 (11.6): list, versions, failure and delay injection. */
export const startFakeRegistry = async (): Promise<FakeRegistry> => {
  let entries: unknown[] = [];
  const requests: RegistryRecordedRequest[] = [];
  const failures: { status: number; body: string }[] = [];
  const raw: string[] = [];
  let delay = 0;

  const nameOf = (entry: unknown): string => (entry as { server: { name: string } }).server.name;
  const versionOf = (entry: unknown): string =>
    (entry as { server: { version: string } }).server.version;

  const running = await startHttp((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    const respond = (): void => {
      const failure = failures.shift();
      if (failure) {
        res.writeHead(failure.status, { 'content-type': 'application/json' });
        res.end(failure.body);
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const rawBody = raw.shift();
      if (rawBody !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rawBody);
        return;
      }
      if (url.pathname === '/v0.1/servers') {
        const limit = Number(url.searchParams.get('limit') ?? '30');
        const offset = Number(url.searchParams.get('cursor') ?? '0');
        const slice = entries.slice(offset, offset + limit);
        const next = offset + limit < entries.length ? String(offset + limit) : undefined;
        send(200, {
          servers: slice,
          metadata: { count: slice.length, ...(next ? { nextCursor: next } : {}) },
        });
        return;
      }
      const versions = /^\/v0\.1\/servers\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(url.pathname);
      if (versions) {
        const name = decodeURIComponent(versions[1] as string);
        const version = versions[2] ? decodeURIComponent(versions[2]) : undefined;
        const matching = entries.filter(
          (e) => nameOf(e) === name && (!version || versionOf(e) === version),
        );
        if (matching.length === 0) {
          send(404, { error: 'not found' });
          return;
        }
        send(
          200,
          version ? matching[0] : { servers: matching, metadata: { count: matching.length } },
        );
        return;
      }
      send(404, { error: 'not found' });
    };
    if (delay > 0) setTimeout(respond, delay);
    else respond();
  });

  return {
    baseUrl: running.url,
    requests,
    setEntries: (e) => {
      entries = e;
    },
    failNext: (status, body = '{"error":"boom"}') => {
      failures.push({ status, body });
    },
    setDelay: (ms) => {
      delay = ms;
    },
    rawNext: (body) => {
      raw.push(body);
    },
    close: running.close,
  };
};
