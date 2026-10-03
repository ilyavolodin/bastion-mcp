import { sse } from 'msw';
import type { Schemas } from '@/api/schema';
import { accessHandlers } from './domains/access';
import { catalogHandlers } from './domains/catalog';
import { observabilityHandlers } from './domains/observability';
import { pluginsHandlers } from './domains/plugins';
import { registryHandlers } from './domains/registry';
import { serversHandlers } from './domains/servers';
import { sessionHandlers } from './domains/session';
import { settingsHandlers } from './domains/settings';
import { csrfMiddleware, P } from './http';
import { getDb, type SseClient, sseStreams } from './state';

const SSE_CLIENTS = sseStreams();
const sendNamed = (c: SseClient, event: string, data: string) =>
  (c.send as (m: { event: string; data: string }) => void)({ event, data });

/** Pushes a server event to every open `/events` stream (demo and tests). */
export const emitMockEvent = (event: string, data: unknown): void => {
  if (event === 'notification')
    getDb().data.session.notifications.unshift(data as Schemas['Notification']);
  for (const c of [...SSE_CLIENTS]) {
    try {
      sendNamed(c, event, JSON.stringify(data));
    } catch {
      SSE_CLIENTS.delete(c);
    }
  }
};

/** Every route is answered by a domain handler typed by the generated OpenAPI types (`./domains/*`). */
export const handlers = [
  csrfMiddleware,
  ...sessionHandlers,
  ...accessHandlers,
  ...settingsHandlers,
  ...catalogHandlers,
  ...serversHandlers,
  ...observabilityHandlers,
  ...registryHandlers,
  ...pluginsHandlers,

  // --- Live updates (18.1) ---------------------------------------------------------------------------------
  sse(P('/events'), ({ client, request }) => {
    SSE_CLIENTS.add(client);
    request.signal.addEventListener('abort', () => SSE_CLIENTS.delete(client));
  }),
];
