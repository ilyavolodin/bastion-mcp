import { REDIS_CHANNELS } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import type { NotifyEvent, StreamTarget } from '../src/adapters/contracts';
import { eventTargets, NotifyHub, notificationFor, notifyEventSchema } from '../src/notify-hub';
import { FakeRedis } from './helpers/fake-redis';

const target = (over: Partial<StreamTarget> = {}): StreamTarget => ({
  principalId: 'u1',
  teamIds: ['t1'],
  endpointId: 'default',
  ...over,
});
const event = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  targets: { principalIds: ['u1'] },
  kind: 'tools_list_changed',
  ...over,
});

describe('6.6 event targeting', () => {
  it('6.6 targets by principal, team or all', () => {
    expect(eventTargets(event(), target())).toBe(true);
    expect(eventTargets(event(), target({ principalId: 'u2' }))).toBe(false);
    expect(eventTargets(event({ targets: { teamIds: ['t1'] } }), target())).toBe(true);
    expect(eventTargets(event({ targets: { teamIds: ['t9'] } }), target())).toBe(false);
    expect(eventTargets(event({ targets: { all: true } }), target({ principalId: 'zz' }))).toBe(
      true,
    );
    expect(eventTargets(event({ targets: { all: false } }), target())).toBe(false);
    expect(eventTargets(event({ targets: {} }), target())).toBe(false);
  });

  it('6.6 endpointIds restrict delivery when present', () => {
    expect(eventTargets(event({ endpointIds: ['other'] }), target())).toBe(false);
    expect(eventTargets(event({ endpointIds: ['default'] }), target())).toBe(true);
    expect(eventTargets(event({ endpointIds: [] }), target())).toBe(true);
  });

  it('6.6 maps kinds to notification methods', () => {
    expect(notificationFor({ ...event(), kind: 'tools_list_changed' })).toEqual({
      method: 'notifications/tools/list_changed',
    });
    expect(notificationFor({ ...event(), kind: 'prompts_list_changed' }).method).toBe(
      'notifications/prompts/list_changed',
    );
    expect(notificationFor({ ...event(), kind: 'resources_list_changed' }).method).toBe(
      'notifications/resources/list_changed',
    );
    expect(notificationFor({ ...event(), kind: 'resource_updated', uri: 'x://y' })).toEqual({
      method: 'notifications/resources/updated',
      params: { uri: 'x://y' },
    });
  });

  it('6.6 the event schema rejects unknown kinds', () => {
    expect(notifyEventSchema.safeParse({ targets: {}, kind: 'nope' }).success).toBe(false);
  });
});

describe('6.6 NotifyHub', () => {
  const started = async () => {
    const redis = new FakeRedis();
    const hub = new NotifyHub({ redis });
    await hub.start();
    return { redis, hub };
  };

  it('6.6 subscribes ONCE per worker to bastion:notify and bastion:listen', async () => {
    const { redis, hub } = await started();
    const a: NotifyEvent[] = [];
    const b: NotifyEvent[] = [];
    hub.register(target(), (e) => a.push(e));
    hub.register(target({ principalId: 'u2' }), (e) => b.push(e));
    expect(redis.subscriberCount()).toBe(1);
    expect(redis.channelSubscriptions(REDIS_CHANNELS.notify)).toBe(1);
    expect(redis.channelSubscriptions(REDIS_CHANNELS.listen)).toBe(1);
  });

  it('6.6 filters events by principal, team, all and endpoint before writing', async () => {
    const { redis, hub } = await started();
    const got: Record<string, string[]> = { u1: [], u2: [], t: [], e2: [] };
    hub.register(target(), (e) => got.u1?.push(e.kind));
    hub.register(target({ principalId: 'u2', teamIds: [] }), (e) => got.u2?.push(e.kind));
    hub.register(target({ principalId: 'u3', teamIds: ['t7'] }), (e) => got.t?.push(e.kind));
    hub.register(target({ principalId: 'u1', endpointId: 'e2' }), (e) => got.e2?.push(e.kind));
    const pub = (channel: string, e: NotifyEvent) => redis.publish(channel, JSON.stringify(e));
    await pub(REDIS_CHANNELS.notify, event({ targets: { principalIds: ['u2'] } }));
    await pub(
      REDIS_CHANNELS.listen,
      event({ targets: { teamIds: ['t7'] }, kind: 'prompts_list_changed' }),
    );
    await pub(
      REDIS_CHANNELS.notify,
      event({ targets: { all: true }, endpointIds: ['e2'], kind: 'resources_list_changed' }),
    );
    expect(got.u1).toEqual([]);
    expect(got.u2).toEqual(['tools_list_changed']);
    expect(got.t).toEqual(['prompts_list_changed']);
    expect(got.e2).toEqual(['resources_list_changed']);
  });

  it('6.6 drops malformed messages without throwing and keeps delivering', async () => {
    const { redis, hub } = await started();
    const got: string[] = [];
    hub.register(target(), (e) => got.push(e.kind));
    await redis.publish(REDIS_CHANNELS.notify, 'not json');
    await redis.publish(REDIS_CHANNELS.notify, JSON.stringify({ kind: 'bogus' }));
    await redis.publish(REDIS_CHANNELS.notify, JSON.stringify(event()));
    expect(got).toEqual(['tools_list_changed']);
  });

  it('6.6 a throwing handler does not stop delivery to others', async () => {
    const { redis, hub } = await started();
    const got: string[] = [];
    hub.register(target(), () => {
      throw new Error('boom');
    });
    hub.register(target(), (e) => got.push(e.kind));
    await redis.publish(REDIS_CHANNELS.notify, JSON.stringify(event()));
    expect(got).toEqual(['tools_list_changed']);
  });

  it('6.6 unregister stops delivery and stop() quits the subscriber connection', async () => {
    const { redis, hub } = await started();
    const got: string[] = [];
    const off = hub.register(target(), (e) => got.push(e.kind));
    off();
    off();
    await redis.publish(REDIS_CHANNELS.notify, JSON.stringify(event()));
    expect(got).toEqual([]);
    await hub.stop();
    expect(redis.subscriberCount()).toBe(0);
  });

  it('6.6 start is idempotent', async () => {
    const { redis, hub } = await started();
    await hub.start();
    expect(redis.subscriberCount()).toBe(1);
  });
});
