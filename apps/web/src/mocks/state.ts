/**
 * The mock's current db. It lives apart from `db.ts` (which builds it from every domain) so the domain handlers can
 * read it without importing the module that imports them.
 */

import type { MockDb } from './db';
import { buildMe } from './me';

let current: MockDb | undefined;
let factory: (() => MockDb) | undefined;

/** `db.ts` registers how to build the first db; it is built on first use, not when the module is imported. */
export const setDbFactory = (make: () => MockDb): void => {
  factory = make;
};

export const getDb = (): MockDb => {
  if (!current) {
    if (!factory) throw new Error('the mock db is not initialised: import `@/mocks/db`');
    current = factory();
  }
  return current;
};
export const setDb = (db: MockDb): MockDb => {
  current = db;
  return db;
};
export const setRole = (role: MockDb['role']): void => {
  const db = getDb();
  if (db.role !== role) {
    db.role = role;
    db.me = buildMe(role);
  }
};
export const nextId = (prefix: string): string => {
  const db = getDb();
  db.seq += 1;
  return `${prefix}-${db.seq}`;
};

// The typed SSE client only knows the default 'message' event; named events are sent as-is.
export type SseClient = { send: (m: never) => void };
/** The open `/events` streams. Tests clear it after every test (`clearSseClients`). */
const sseClients = new Set<SseClient>();
export const sseStreams = (): Set<SseClient> => sseClients;
export const clearSseClients = (): void => sseClients.clear();
