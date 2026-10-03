import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { clearEtags } from '@/api/client';
import { resetDb } from '@/mocks/db';
import { problem } from '@/mocks/http';
import { server } from '@/mocks/server';
import { getDb } from '@/mocks/state';
import { findOperation, type HttpMethod, requiresIfMatch } from './contract';

expect.extend(toHaveNoViolations);
configure({ asyncUtilTimeout: 8000 });

// Monaco cannot run in jsdom: the lazy editor implementation becomes the plain textarea.
vi.mock('@/components/monaco-impl', async () => {
  const { PlainEditor } = await import('@/components/code-editor');
  return { default: PlainEditor };
});

// jsdom has no layout engine and a few browser APIs that Radix, cmdk and Recharts touch.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}));
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
window.scrollTo = () => {};

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  // Node's fetch needs absolute URLs; the SPA always uses relative ones. Wrap MSW's patched fetch.
  const patched = globalThis.fetch.bind(globalThis);
  // jsdom's AbortSignal is not undici's: strip it and race the abort instead.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const { signal, ...rest } = init ?? {};
    const url =
      typeof input === 'string' && input.startsWith('/')
        ? new URL(input, window.location.origin).toString()
        : input;
    const call = patched(url, rest);
    if (!signal) return call;
    return Promise.race([
      call,
      new Promise<Response>((_, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
      ),
    ]);
  }) as typeof fetch;
});
// The real API answers 428 to a change of a stored row that names no version (17.1). The mock does too, for exactly
// the operations the OpenAPI document marks `x-requires-if-match`, so a screen that forgets the header fails a test.
const missingIfMatch: string[] = [];
beforeEach(() => {
  missingIfMatch.length = 0;
  server.use(
    http.all('*/api/v1/*', ({ request }) => {
      const method = request.method.toLowerCase() as HttpMethod;
      if (!['put', 'patch', 'delete'].includes(method) || request.headers.get('if-match')) return;
      const pathname = new URL(request.url).pathname;
      const op = findOperation(method, pathname);
      // Adding a person to a team creates the membership: there is no version to name yet (17.1).
      const member = /\/teams\/([^/]+)\/members\/([^/]+)$/.exec(pathname);
      const newMember =
        method === 'put' &&
        member !== null &&
        !getDb()
          .data.access.teams.find((t) => t.id === member[1])
          ?.members.some((m) => m.userId === member[2]);
      if (op && requiresIfMatch(op) && !newMember) {
        // The screen may swallow the 428 (a toast, a form error): the test fails on it anyway, in afterEach.
        missingIfMatch.push(`${request.method} ${new URL(request.url).pathname}`);
        return problem(
          428,
          'precondition_required',
          'An If-Match header with the resource ETag is required',
        );
      }
    }),
  );
});
afterEach(() => {
  if (missingIfMatch.length > 0) {
    throw new Error(
      `these changes were sent without If-Match (17.1): ${missingIfMatch.join(', ')}`,
    );
  }
  cleanup();
  // Radix dialogs mark siblings aria-hidden and lock body pointer events; do not leak that between tests.
  document.body.removeAttribute('style');
  document.body.removeAttribute('data-scroll-locked');
  for (const el of document.querySelectorAll('[aria-hidden="true"][data-aria-hidden]'))
    el.removeAttribute('aria-hidden');
  server.resetHandlers();
  resetDb();
  clearEtags();
  sessionStorage.clear();
  localStorage.clear();
  document.documentElement.dataset.theme = 'light';
  document.cookie = 'bastion_csrf=test-csrf; path=/';
});
afterAll(() => server.close());
document.cookie = 'bastion_csrf=test-csrf; path=/';
