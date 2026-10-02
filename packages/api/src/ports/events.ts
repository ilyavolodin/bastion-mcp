/** SSE fan-out (18.1): `GET /api/v1/events`. */
export type ApiEventType =
  | 'notification'
  | 'installation.status'
  | 'test.progress'
  | 'drift.review'
  | 'installation.log';

export type ApiEvent = {
  id: string;
  type: ApiEventType;
  /** Who may receive it. `org` events go to admins and auditors only. */
  audience: { userIds?: string[]; teamIds?: string[]; org?: boolean };
  data: unknown;
  /** Narrower stream key, for example the installation id for logs or the version id for tests. */
  topic?: string;
};

export interface EventBus {
  publish(event: ApiEvent): Promise<void> | void;
  /** Returns the unsubscribe function. */
  subscribe(handler: (event: ApiEvent) => void): () => void;
}
