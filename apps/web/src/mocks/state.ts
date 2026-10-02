/**
 * The mock's current db. It lives apart from `db.ts` (which builds it from every domain) so the domain handlers can
 * read it without importing the module that imports them.
 */

import type { MockDb } from './db';
import { buildMe } from './me';

let current: MockDb | undefined;

export const getDb = (): MockDb => {
  if (!current) throw new Error('the mock db is not initialised: call resetDb() first');
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
