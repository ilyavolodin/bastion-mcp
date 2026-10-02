import { RateLimitedError, UpstreamUnavailableError } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { degradedFrom } from '../src/lists/source';

describe('6.9 / 11.3 why a listing degraded', () => {
  it('carries the message of an error Bastion raised on purpose, so the author can fix it', () => {
    const out = degradedFrom(
      new UpstreamUnavailableError(
        'remote host x resolves to 10.0.0.2, a private network address',
        {
          installation: 'x',
        },
      ),
    );
    expect(out).toMatchObject({
      status: 'degraded',
      code: 'upstream_unavailable',
      detail: 'remote host x resolves to 10.0.0.2, a private network address',
    });
  });

  it('keeps unexpected errors out of responses: only the code', () => {
    const out = degradedFrom(new Error('ECONNRESET at /srv/secret/path.js:12'));
    expect(out).toEqual({ status: 'degraded', code: 'list_failed' });
  });

  it('truncates long messages', () => {
    const out = degradedFrom(
      new RateLimitedError('x'.repeat(2000), { retryAfterMs: 1, limit: 'a' }),
    );
    expect(out.detail).toHaveLength(500);
  });
});
