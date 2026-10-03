import { expect, onTestFinished, vi } from 'vitest';
import { server } from '@/mocks/server';
import { findOperation, type HttpMethod, validateRequest } from './contract';

export type Captured = { method: HttpMethod; path: string; search: string; body: unknown };

/**
 * Records the requests the app sends to the MSW mock, with their JSON bodies, so a test can submit a real form and
 * then check what went over the wire against the OpenAPI request schema (`expectSent`).
 */
export function captureRequests() {
  const calls: Captured[] = [];
  const reads: Promise<void>[] = [];
  const onStart = ({ request }: { request: Request }) => {
    const copy = request.clone();
    reads.push(
      copy.text().then((text) => {
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = text;
        }
        calls.push({
          method: request.method.toLowerCase() as HttpMethod,
          path: new URL(request.url).pathname,
          search: new URL(request.url).search,
          body,
        });
      }),
    );
  };
  server.events.on('request:start', onStart);
  const stop = () => server.events.removeListener('request:start', onStart);
  // A failing test must not leave the listener behind for the next one.
  onTestFinished(stop);
  return {
    calls,
    stop,
    /** Waits for a request of this method whose path matches, and returns the last one. */
    async next(method: HttpMethod, path: RegExp | string): Promise<Captured> {
      const match = (c: Captured) =>
        c.method === method &&
        (typeof path === 'string' ? c.path.endsWith(path) : path.test(c.path));
      // As patient as Testing Library's `findBy` (see `setup.ts`): a loaded machine must not fail the test.
      await vi.waitFor(
        async () => {
          await Promise.all(reads);
          expect(calls.some(match)).toBe(true);
        },
        { timeout: 8000 },
      );
      return calls.filter(match).at(-1) as Captured;
    },
  };
}

/** Asserts that a captured request body is valid for the operation it addressed in the OpenAPI document. */
export const expectValidBody = (sent: Captured): void => {
  const op = findOperation(sent.method, sent.path);
  expect(op, `${sent.method.toUpperCase()} ${sent.path} is not an API operation`).not.toBeNull();
  if (!op) return;
  const verdict = validateRequest(op, sent.body);
  expect(
    verdict.errors,
    `${sent.method.toUpperCase()} ${op.template} body ${JSON.stringify(sent.body)}`,
  ).toEqual([]);
};

/**
 * Submits through the app, then checks the body that reached the API: `await expectSent(capture, 'post', '/teams')`
 * returns the validated body for further assertions on the values the user typed.
 */
export async function expectSent(
  capture: ReturnType<typeof captureRequests>,
  method: HttpMethod,
  path: RegExp | string,
): Promise<unknown> {
  const sent = await capture.next(method, path);
  expectValidBody(sent);
  return sent.body;
}
