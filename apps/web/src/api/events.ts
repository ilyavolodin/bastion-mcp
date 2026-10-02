import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { API_BASE } from './client';
import type { Notification, ServerEvent } from './types';

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
export function applyServerEvent(qc: QueryClient, event: ServerEvent): Notification | null {
  switch (event.type) {
    case 'notification': {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      if (event.data.kind === 'drift') void qc.invalidateQueries({ queryKey: ['drift-reviews'] });
      if (event.data.kind === 'install_request') {
        void qc.invalidateQueries({ queryKey: ['install-requests'] });
      }
      return event.data;
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

export function useServerEvents(onNotification: (n: Notification) => void, enabled = true): void {
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
