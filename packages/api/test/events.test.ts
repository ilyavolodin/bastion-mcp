import { afterEach, describe, expect, it } from 'vitest';
import type { ApiEvent } from '../src/ports';
import { canReceive } from '../src/services/events';
import { principalFor } from './helpers/fakes/base';
import { buildTestApi, type TestApi } from './helpers/harness';
import { W } from './helpers/world';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

type Frame = { event: string; id?: string; data: unknown };

const parseFrames = (text: string): Frame[] =>
  text
    .split('\n\n')
    .filter((chunk) => chunk.includes('event:'))
    .map((chunk) => {
      const frame: Frame = { event: '', data: null };
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) frame.event = line.slice(7);
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
      }
      return frame;
    });

/** Opens the stream on a real socket, publishes, and collects frames until `count` arrived. */
const collect = async (
  test: TestApi,
  token: string,
  query: string,
  publish: ApiEvent[],
  count: number,
): Promise<{ status: number; type: string | null; frames: Frame[] }> => {
  const address = await test.app.listen({ port: 0, host: '127.0.0.1' });
  const abort = new AbortController();
  const res = await fetch(`${address}/api/v1/events${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: abort.signal,
  });
  const frames: Frame[] = [];
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let published = false;
    const timer = setTimeout(() => abort.abort(), 4000);
    try {
      while (frames.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        frames.splice(0, frames.length, ...parseFrames(buffer));
        if (!published && frames.some((f) => f.event === 'ready')) {
          published = true;
          for (const event of publish) await test.events.publish(event);
        }
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
  return { status: res.status, type: res.headers.get('content-type'), frames };
};

const event = (
  id: string,
  type: ApiEvent['type'],
  audience: ApiEvent['audience'],
  topic?: string,
): ApiEvent => ({
  id,
  type,
  audience,
  data: { id },
  ...(topic ? { topic } : {}),
});

describe('18.1 GET /events', () => {
  it('18.1 requires authentication', async () => {
    api = await buildTestApi();
    const res = await api.call('anonymous', 'GET', '/events');
    expect(res.status).toBe(401);
  });

  it('18.1 streams events addressed to the user, their teams, or the org (admins)', async () => {
    api = await buildTestApi();
    const out = await collect(
      api,
      'tok-member',
      '',
      [
        event('e1', 'notification', { userIds: [W.memberA] }),
        event('e2', 'notification', { userIds: [W.memberB] }),
        event('e3', 'installation.status', { teamIds: [W.teamA] }),
        event('e4', 'drift.review', { org: true }),
        event('e5', 'installation.status', { teamIds: [W.teamB] }),
      ],
      3,
    );
    expect(out.status).toBe(200);
    expect(out.type).toBe('text/event-stream');
    expect(out.frames.map((f) => f.id ?? f.event)).toEqual(['ready', 'e1', 'e3']);
    expect(out.frames[1]).toMatchObject({ event: 'notification', data: { id: 'e1' } });
  });

  it('18.1 sends org events to admins and auditors', async () => {
    api = await buildTestApi();
    const out = await collect(
      api,
      'tok-auditor',
      '',
      [event('o1', 'drift.review', { org: true })],
      2,
    );
    expect(out.frames.map((f) => f.id ?? f.event)).toEqual(['ready', 'o1']);
  });

  it('18.1 filters by ?types= and ?topic=', async () => {
    api = await buildTestApi();
    const out = await collect(
      api,
      'tok-admin',
      '?types=test.progress&topic=version-1',
      [
        event('t1', 'test.progress', { org: true }, 'version-2'),
        event('t2', 'notification', { org: true }),
        event('t3', 'test.progress', { org: true }, 'version-1'),
      ],
      2,
    );
    expect(out.frames.map((f) => f.id ?? f.event)).toEqual(['ready', 't3']);
  });

  it('18.1 rejects unknown event types', async () => {
    api = await buildTestApi();
    const address = await api.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/v1/events?types=bogus`, {
      headers: { authorization: 'Bearer tok-admin' },
    });
    expect(res.status).toBe(400);
  });

  it('18.1 unsubscribes from the bus when the client disconnects', async () => {
    api = await buildTestApi();
    const out = await collect(api, 'tok-admin', '', [], 1);
    expect(out.frames[0]?.event).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const seen: string[] = [];
    api.events.subscribe((e) => seen.push(e.id));
    await api.events.publish(event('late', 'notification', { org: true }));
    expect(seen).toEqual(['late']);
  });

  it('18.1 canReceive applies audiences by user, team and org role', () => {
    const member = principalFor('member');
    const manager = principalFor('managerOwn');
    const admin = principalFor('admin');
    const auditor = principalFor('auditor');
    expect(canReceive(member, event('1', 'notification', { userIds: [W.memberA] }))).toBe(true);
    expect(canReceive(member, event('2', 'notification', { userIds: ['x'] }))).toBe(false);
    expect(canReceive(manager, event('3', 'notification', { teamIds: [W.teamA] }))).toBe(true);
    expect(canReceive(member, event('4', 'notification', { org: true }))).toBe(false);
    expect(canReceive(admin, event('5', 'notification', { org: true }))).toBe(true);
    expect(canReceive(auditor, event('6', 'notification', { org: true }))).toBe(true);
    expect(canReceive(admin, event('7', 'notification', {}))).toBe(false);
  });
});
