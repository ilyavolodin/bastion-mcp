import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import { clearEtags } from '@/api/client';
import { resetDb } from '@/mocks/db';
import { server } from '@/mocks/server';

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
afterEach(() => {
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
