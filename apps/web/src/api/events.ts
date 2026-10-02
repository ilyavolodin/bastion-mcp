import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { API_BASE } from './client';
import type { Schemas } from './schema';
import { type NotificationView, toNotification } from './views/session';

/**
 * Payloads of `GET /api/v1/events` (18.1). The stream is Server-Sent Events, which OpenAPI does not describe, so these
 * are the one place the console restates API shapes by hand; each follows what the API publishes
 * (`services/installations.ts`, `services/drift.ts`, `services/registry.ts`, `apps/server/.../version-test.ts`).
 */
export type ServerEvent =
  | { type: 'notification'; data: Schemas['Notification'] }
  | {
      type: 'installation.status';
      data: { installationId: string; status: Schemas['Installation']['status'] };
    }
  | {
      type: 'test.progress';
      data: {
        runId: string;
        entryId: string;
        versionId: string;
        status: Schemas['VersionTestRun']['status'];
      };
    }
  | {
      type: 'drift.review';
      data: { reviewId: string; status: string; itemKind: string; itemKey: string };
    };

export const EVENT_TYPES = [
  'notification',
  'installation.status',
  'test.progress',
  'drift.review',
] as const;

export type EventSourceFactory = (url: string) => EventSource;
const defaultFactory: EventSourceFactory = (url) => new EventSource(url, { withCredentials: true });

/** Opens `GET /api/v1/events` (SSE, 18.1) and calls `onEvent` for every typed server event. */
export function openEventStream(
  onEvent: (event: ServerEvent) => void,
  factory: EventSourceFactory = defaultFactory,
  url = `${API_BASE}/events`,
): () => void {
  const source = factory(url);
  const listeners = EVENT_TYPES.map((type) => {
    const listener = (e: Event) => {
      try {
        onEvent({ type, data: JSON.parse((e as MessageEvent<string>).data) } as ServerEvent);
      } catch {
        // ignore malformed frames; the stream keeps going
      }
    };
    source.addEventListener(type, listener);
    return [type, listener] as const;
  });
  return () => {
    for (const [type, listener] of listeners) source.removeEventListener(type, listener);
    source.close();
  };
}

/** Applies a server event to the query cache. Returns the notification to toast, when there is one. */
export function applyServerEvent(qc: QueryClient, event: ServerEvent): NotificationView | null {
  switch (event.type) {
    case 'notification': {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      if (event.data.type === 'drift') void qc.invalidateQueries({ queryKey: ['drift-reviews'] });
      if (event.data.type === 'install_request') {
        void qc.invalidateQueries({ queryKey: ['install-requests'] });
      }
      return toNotification(event.data);
    }
    case 'installation.status':
      void qc.invalidateQueries({ queryKey: ['installations'] });
      return null;
    case 'test.progress':
      void qc.invalidateQueries({ queryKey: ['catalog'] });
      return null;
    case 'drift.review':
      void qc.invalidateQueries({ queryKey: ['drift-reviews'] });
      return null;
  }
}

export function useServerEvents(
  onNotification: (n: NotificationView) => void,
  enabled = true,
): void {
  const qc = useQueryClient();
  const cb = useRef(onNotification);
  cb.current = onNotification;
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    return openEventStream((event) => {
      const n = applyServerEvent(qc, event);
      if (n) cb.current(n);
    });
  }, [qc, enabled]);
}

/** A raw SSE line stream, used by the installation log tail. */
export function useEventLines(
  url: string | null,
  onLine: (line: string) => void,
  factory: EventSourceFactory = defaultFactory,
): void {
  const cb = useRef(onLine);
  cb.current = onLine;
  useEffect(() => {
    if (!url || (typeof EventSource === 'undefined' && factory === defaultFactory)) return;
    const source = factory(url);
    const listener = (e: Event) => cb.current((e as MessageEvent<string>).data);
    source.addEventListener('log', listener);
    source.addEventListener('message', listener);
    return () => {
      source.removeEventListener('log', listener);
      source.removeEventListener('message', listener);
      source.close();
    };
  }, [url, factory]);
}
