/**
 * Helpers shared by every mock domain: time constants, the mock clock and the 422 problem.
 */
import { problem } from './http';
import { getDb } from './state';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The mock clock: the db's `now` plus the real time elapsed since the db was built, so rows created in a session get
 * a fresh time and a test that fakes `Date` (or moves `db.now`) moves it too. Every call is later than the previous
 * one, so a row's `updatedAt` (its ETag) changes with every change.
 */
export const nowMs = (): number => {
  const db = getDb();
  const t = Math.max(db.now + (Date.now() - db.epoch), db.lastStamp + 1);
  db.lastStamp = t;
  return t;
};
/** Moves the mock clock forward (a test of something that takes time, like a catalog test run). */
export const advanceClock = (ms: number): void => {
  getDb().now += ms;
};
export const nowIso = (): string => iso(nowMs());

export type FieldError = { path: string; message: string };

/** The 422 of an invalid body, with the fields that need attention (RFC 9457 `errors`). */
export const validationFailed = (errors: FieldError[], detail?: string) =>
  problem(422, 'validation_failed', 'Some fields need attention', detail, errors);
