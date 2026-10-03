import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { clearEtags } from '@/api/client';
import { resetDb } from '@/mocks/db';
import { changeAnswered, versionWaived } from '@/mocks/http';
import { server } from '@/mocks/server';
import { clearSseClients } from '@/mocks/state';
import { findOperation, type HttpMethod, requiresIfMatch } from './contract';
import { ifMatchPolicy } from './if-match';

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
// The real API answers 428 to a change of a stored row that names no version (17.1). A screen that forgets the header
// must fail its test: for exactly the operations the OpenAPI document marks `x-requires-if-match`, a change sent
// without `If-Match` is recorded, and counted as a mistake when the mock answers 428 (the screen may swallow it in a
// toast) or accepts it. A handler that creates its row (a new team member) waives the precondition itself.
const missingIfMatch: string[] = [];
const pending = new Map<string, string>();
const onStart = ({ request, requestId }: { request: Request; requestId: string }) => {
  const method = request.method.toLowerCase() as HttpMethod;
  if (!['put', 'patch', 'delete'].includes(method) || request.headers.get('if-match')) return;
  const pathname = new URL(request.url).pathname;
  const op = findOperation(method, pathname);
  if (op && requiresIfMatch(op)) pending.set(requestId, `${request.method} ${pathname}`);
};
const onResponse = ({ response, requestId }: { response: Response; requestId: string }) => {
  const label = pending.get(requestId);
  if (label === undefined) return;
  pending.delete(requestId);
  // Only what a handler of the mock answered counts: a test may answer the call itself.
  if (!changeAnswered(requestId)) return;
  if ((response.status < 400 && !versionWaived(requestId)) || response.status === 428) {
    missingIfMatch.push(label);
  }
};
beforeAll(() => {
  server.events.on('request:start', onStart);
  server.events.on('response:mocked', onResponse);
});
beforeEach(() => {
  ifMatchPolicy.tolerate = false;
  missingIfMatch.length = 0;
  pending.clear();
});
afterEach(() => {
  if (missingIfMatch.length > 0 && !ifMatchPolicy.tolerate) {
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
  clearSseClients();
  clearEtags();
  sessionStorage.clear();
  localStorage.clear();
  document.documentElement.dataset.theme = 'light';
  document.cookie = 'bastion_csrf=test-csrf; path=/';
});
afterAll(() => {
  server.events.removeListener('request:start', onStart);
  server.events.removeListener('response:mocked', onResponse);
  server.close();
});
document.cookie = 'bastion_csrf=test-csrf; path=/';
