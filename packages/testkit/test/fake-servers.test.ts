import { afterEach, describe, expect, it } from 'vitest';
import {
  startConformanceEverythingServer,
  startFakeLegacyHttpServer,
  startFakeLegacySseServer,
  startFakeTasksServer,
} from '../src/fake-upstreams';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('fake upstream servers (characterization)', () => {
  it('legacy http: invalid JSON answers 500, a valid initialize opens a session', async () => {
    const server = await startFakeLegacyHttpServer();
    closers.push(server.close);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
    expect((await post(server.url, '{not json')).status).toBe(500);
    const init = await post(
      server.url,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();
    expect(server.sessions()).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });

  it('legacy http: an empty POST is a 400 and requests are recorded', async () => {
    const server = await startFakeLegacyHttpServer({ requiredToken: 't' });
    closers.push(server.close);
    expect((await post(server.url, '')).status).toBe(401);
    const ok = await post(server.url, '', { authorization: 'Bearer t' });
    expect(ok.status).toBe(400);
  });

  it('legacy sse: invalid JSON on /messages answers 500, unknown sessions 404', async () => {
    const server = await startFakeLegacySseServer();
    closers.push(server.close);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/sse`);
    const controller = new AbortController();
    const stream = await fetch(server.url, { signal: controller.signal });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const endpoint = /data: (\S+)/.exec(first)?.[1] ?? '';
    expect(endpoint).toMatch(/^\/messages\?sessionId=/);
    expect(server.sessions()).toBe(1);
    const base = `http://127.0.0.1:${server.port}`;
    expect((await post(`${base}${endpoint}`, '{bad')).status).toBe(500);
    expect((await post(`${base}/messages?sessionId=nope`, '{}')).status).toBe(404);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    controller.abort();
  });

  it('tasks: invalid JSON and non-POST are 405, a notification is 202, a request is 200', async () => {
    const server = await startFakeTasksServer();
    closers.push(server.close);
    expect((await post(server.url, '{bad')).status).toBe(405);
    expect((await fetch(server.url)).status).toBe(405);
    expect((await post(server.url, JSON.stringify({ jsonrpc: '2.0', method: 'x' }))).status).toBe(
      202,
    );
    const reply = await post(
      server.url,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope', params: {} }),
    );
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  it('everything server: answers invalid JSON with a parse error and an old protocol version with -32022', async () => {
    const server = await startConformanceEverythingServer();
    closers.push(server.close);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
    const bad = await post(server.url, '{bad', { accept: 'application/json, text/event-stream' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    const init = await post(
      server.url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
      { accept: 'application/json, text/event-stream' },
    );
    expect(init.status).toBe(400);
    expect(await init.json()).toMatchObject({ id: 1, error: { code: -32022 } });
  });
});
