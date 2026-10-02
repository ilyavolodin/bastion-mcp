import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import { clearEtags } from '@/api/client';
import { resetDb } from '@/mocks/db';
import { server } from '@/mocks/server';

expect.extend(toHaveNoViolations);

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
vi.stubGlobal(
  'matchMedia',
  (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
);
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
window.scrollTo = () => {};

// Node's fetch needs absolute URLs; the SPA always uses relative ones.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  realFetch(
    typeof input === 'string' && input.startsWith('/')
      ? new URL(input, window.location.origin).toString()
      : input,
    init,
  )) as typeof fetch;

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
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
