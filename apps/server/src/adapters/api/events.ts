/**
 * `EventBus` for the SSE stream `GET /api/v1/events` (18.1). Events published on one ui replica reach the streams of
 * every replica: they go to Redis (`bastion:events`) and each replica delivers them to its own subscribers. The
 * publishing replica delivers locally at once and ignores its own echo.
 */
import { randomUUID } from 'node:crypto';
import type { ApiEvent, EventBus } from '@bastion-mcp/api';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const EVENTS_CHANNEL = 'bastion:events';

const envelope = z.object({
  origin: z.string(),
  event: z.object({
    id: z.string(),
    type: z.enum([
      'notification',
      'installation.status',
      'test.progress',
      'drift.review',
      'installation.log',
    ]),
    audience: z.object({
      userIds: z.array(z.string()).optional(),
      teamIds: z.array(z.string()).optional(),
      org: z.boolean().optional(),
    }),
    data: z.unknown(),
    topic: z.string().optional(),
  }),
});

export type RedisEventBus = EventBus & { start(): Promise<void>; close(): Promise<void> };

export const createEventBus = (deps: {
  redis: Redis;
  duplicate: () => Redis;
  onError?: (message: string) => void;
}): RedisEventBus => {
  const origin = randomUUID();
  const handlers = new Set<(event: ApiEvent) => void>();
  let sub: Redis | undefined;

  const deliver = (event: ApiEvent): void => {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        deps.onError?.(error instanceof Error ? error.message : String(error));
      }
    }
  };

  return {
    async publish(event) {
      deliver(event);
      try {
        await deps.redis.publish(EVENTS_CHANNEL, JSON.stringify({ origin, event }));
      } catch (error) {
        deps.onError?.(error instanceof Error ? error.message : String(error));
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async start() {
      if (sub) return;
      sub = deps.duplicate();
      sub.on('message', (_channel: string, message: string) => {
        try {
          const parsed = envelope.safeParse(JSON.parse(message));
          if (!parsed.success || parsed.data.origin === origin) return;
          deliver(parsed.data.event as ApiEvent);
        } catch {
          // a malformed message from another replica is dropped
        }
      });
      await sub.subscribe(EVENTS_CHANNEL);
    },
    async close() {
      handlers.clear();
      if (sub) await sub.quit().catch(() => undefined);
      sub = undefined;
    },
  };
};
