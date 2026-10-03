/**
 * Who may do what in the mock. Role checks live in one table (`can`) so a handler names what it needs (`{ allow:
 * 'admin' }` on the route, see `http.ts`), not which roles have it.
 */
import type { UiRole } from '@/api/views/session';
import { getDb } from './state';

export const isRole = (...roles: UiRole[]): boolean => roles.includes(getDb().role);

/** What a role may do, by name. */
const ROLES_FOR = {
  /** Org settings, people, secrets, IdP: Admins only. */
  admin: ['admin'],
  /** Publish, decide and manage: Admins and Managers. */
  manage: ['admin', 'manager'],
  /** Read everything in the org: Admins and Auditors. */
  seeAll: ['admin', 'auditor'],
  /** Read the org's configuration screens: everybody but Members. */
  readConfig: ['admin', 'manager', 'auditor'],
  /** The registry is hidden from Auditors (`capabilities.registry`). */
  registry: ['admin', 'manager', 'member'],
} as const satisfies Record<string, readonly UiRole[]>;
export type Action = keyof typeof ROLES_FOR;

export const can = (action: Action): boolean =>
  (ROLES_FOR[action] as readonly UiRole[]).includes(getDb().role);

export const isAdmin = (): boolean => can('admin');

/** A Manager manages the teams where the signed-in person is a manager; an Admin manages every team. */
export const managesTeam = (teamId: string): boolean =>
  isAdmin() ||
  (isRole('manager') && getDb().me.teams.some((t) => t.id === teamId && t.role === 'manager'));
