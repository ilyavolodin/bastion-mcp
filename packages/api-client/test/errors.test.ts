import { describe, expect, it } from 'vitest';
import { ApiProblemError, problemFromBody } from '../src/errors';

describe('17.1 problemFromBody', () => {
  it('17.1 falls back to a synthetic problem for a non-JSON 5xx body', () => {
    const problem = problemFromBody(502, undefined, '<html>Bad gateway</html>');
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'HTTP 502',
      status: 502,
      detail: '<html>Bad gateway</html>',
      code: 'http_error',
    });
  });

  it('17.1 truncates the fallback detail to 200 characters', () => {
    expect(problemFromBody(500, null, 'x'.repeat(500)).detail).toHaveLength(200);
  });

  it('17.1 ignores JSON that is not a problem document', () => {
    expect(problemFromBody(500, { message: 'boom' }, '{"message":"boom"}').code).toBe('http_error');
  });

  it('17.1 keeps a well-formed problem and drops malformed field errors', () => {
    const problem = problemFromBody(
      400,
      { code: 'invalid', title: 'Invalid', errors: [{ path: 'a', message: 'bad' }, { path: 1 }] },
      '',
    );
    expect(problem.errors).toEqual([{ path: 'a', message: 'bad' }]);
    expect(problem.status).toBe(400);
  });

  it('17.1 distinguishes a stale If-Match from any conflict', () => {
    const make = (status: number) =>
      new ApiProblemError({ type: 't', title: 't', status, detail: '', code: 'c' });
    expect(make(412).isStale).toBe(true);
    expect(make(409).isStale).toBe(false);
    expect(make(409).isConflict).toBe(true);
  });
});
