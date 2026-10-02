/**
 * The per-worker notification hub (6.6): ONE Redis subscription to `bastion:notify` and `bastion:listen`; streams
 * register their principal, teams and endpoint and receive only the events that target them.
 */
import { REDIS_CHANNELS } from '@bastion-mcp/core';
import { z } from 'zod';
import type { NotifyEvent, NotifyHubPort, StreamTarget } from './adapters/contracts';
import { type DownstreamRedis, type Logger, noopLogger, type RedisSubscriber } from './ports';

export const notifyEventSchema = z.object({
  targets: z.object({
    principalIds: z.array(z.string()).optional(),
    teamIds: z.array(z.string()).optional(),
    all: z.boolean().optional(),
  }),
  endpointIds: z.array(z.string()).optional(),
  kind: z.enum([
    'tools_list_changed',
    'prompts_list_changed',
    'resources_list_changed',
    'resource_updated',
  ]),
  uri: z.string().optional(),
});

/** Whether an event is addressed to a stream: target match AND endpoint match (6.6). */
export const eventTargets = (event: NotifyEvent, target: StreamTarget): boolean => {
  const t = event.targets;
  const who =
    t.all === true ||
    (t.principalIds?.includes(target.principalId) ?? false) ||
    (t.teamIds?.some((id) => target.teamIds.includes(id)) ?? false);
  if (!who) return false;
  const endpoints = event.endpointIds;
  return endpoints === undefined || endpoints.length === 0 || endpoints.includes(target.endpointId);
};

export const notificationFor = (
  event: NotifyEvent,
): { method: string; params?: { uri: string } } => {
  switch (event.kind) {
    case 'tools_list_changed':
      return { method: 'notifications/tools/list_changed' };
    case 'prompts_list_changed':
      return { method: 'notifications/prompts/list_changed' };
    case 'resources_list_changed':
      return { method: 'notifications/resources/list_changed' };
    case 'resource_updated':
      return { method: 'notifications/resources/updated', params: { uri: event.uri ?? '' } };
  }
};

type Entry = { target: StreamTarget; handler: (event: NotifyEvent) => void };

export class NotifyHub implements NotifyHubPort {
  private readonly entries = new Set<Entry>();
  private readonly redis: DownstreamRedis;
  private readonly logger: Logger;
  private subscriber: RedisSubscriber | undefined;

  constructor(options: { redis: DownstreamRedis; logger?: Logger }) {
    this.redis = options.redis;
    this.logger = options.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    if (this.subscriber) return;
    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('message', (_channel, message) => this.onMessage(message));
    await subscriber.subscribe(REDIS_CHANNELS.notify, REDIS_CHANNELS.listen);
  }

  async stop(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    this.entries.clear();
    if (subscriber) await subscriber.quit().catch(() => undefined);
  }

  register(target: StreamTarget, handler: (event: NotifyEvent) => void): () => void {
    const entry: Entry = { target, handler };
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
    };
  }

  private onMessage(message: string): void {
    let event: NotifyEvent;
    try {
      const parsed = notifyEventSchema.safeParse(JSON.parse(message));
      if (!parsed.success) {
        this.logger.warn('dropped a malformed notification event');
        return;
      }
      event = parsed.data;
    } catch {
      this.logger.warn('dropped an unparseable notification event');
      return;
    }
    for (const entry of [...this.entries]) {
      if (!eventTargets(event, entry.target)) continue;
      try {
        entry.handler(event);
      } catch (error) {
        this.logger.warn('a notification handler threw', { error: String(error) });
      }
    }
  }
}
