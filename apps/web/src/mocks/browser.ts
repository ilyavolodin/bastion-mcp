import { setupWorker } from 'msw/browser';
import type { UiRole } from '@/api/types';
import { resetDb } from './db';
import { emitMockEvent, handlers } from './handlers';

declare global {
  interface Window {
    __bastionMock?: {
      emit: typeof emitMockEvent;
      reset: (role?: UiRole) => void;
    };
  }
}

const ROLES: readonly UiRole[] = ['admin', 'manager', 'member', 'auditor'];

/** Starts the in-browser API (VITE_MOCK_API=true). `?as=member` picks the signed-in role. */
export async function startMocking(): Promise<void> {
  const requested = new URLSearchParams(window.location.search).get('as');
  if (requested && (ROLES as readonly string[]).includes(requested)) {
    sessionStorage.setItem('bastion.mockRole', requested);
  }
  const role = (sessionStorage.getItem('bastion.mockRole') as UiRole | null) ?? 'admin';
  resetDb(role);
  // The real server sets this cookie at login (9.2); the mock does the same so CSRF is exercised.
  document.cookie = 'bastion_csrf=mock-csrf-token; path=/; SameSite=Lax';
  await setupWorker(...handlers).start({ onUnhandledRequest: 'bypass', quiet: true });
  window.__bastionMock = { emit: emitMockEvent, reset: (r) => resetDb(r ?? role) };
}
