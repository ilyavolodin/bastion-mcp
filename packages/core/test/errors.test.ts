import { describe, expect, it } from 'vitest';
import {
  type BastionError,
  GuardBlockedError,
  isBastionError,
  PolicyDeniedError,
  QuotaExceededError,
  RateLimitedError,
  SandboxStartFailedError,
  sanitizeUpstreamErrorMessage,
  toToolErrorResult,
  UpstreamAuthRequiredError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '../src/errors';

describe('6.9 error mapping', () => {
  const cases: [BastionError, string, number, number][] = [
    [new PolicyDeniedError('no', { policyIds: ['rule-1'] }), 'POLICY_DENIED', 403, -32010],
    [
      new RateLimitedError('slow', { retryAfterMs: 1000, limit: 'rl' }),
      'RATE_LIMITED',
      429,
      -32011,
    ],
    [
      new QuotaExceededError('out', { resetsAt: '2026-11-01T00:00:00Z', quota: 'q' }),
      'QUOTA_EXCEEDED',
      429,
      -32012,
    ],
    [
      new GuardBlockedError('blocked', { guard: 'regex', ruleId: 'r' }),
      'GUARD_BLOCKED',
      403,
      -32013,
    ],
    [
      new UpstreamUnavailableError('down', { installation: 'gh' }),
      'UPSTREAM_UNAVAILABLE',
      502,
      -32014,
    ],
    [
      new UpstreamAuthRequiredError('auth', {
        installation: 'gh',
        connectUrl: 'https://x/connect/1',
      }),
      'UPSTREAM_AUTH_REQUIRED',
      401,
      -32015,
    ],
    [
      new SandboxStartFailedError('fail', { installation: 'gh', phase: 'installing' }),
      'SANDBOX_START_FAILED',
      502,
      -32016,
    ],
    [
      new UpstreamTimeoutError('slow', { installation: 'gh', timeoutMs: 60000 }),
      'UPSTREAM_TIMEOUT',
      504,
      -32017,
    ],
  ];

  it.each(cases)('%s carries code, http status and mcp code', (err, code, http, mcp) => {
    expect(err.code).toBe(code);
    expect(err.httpStatus).toBe(http);
    expect(err.mcpCode).toBe(mcp);
    expect(isBastionError(err)).toBe(true);
  });

  it('isBastionError rejects foreign errors', () => {
    expect(isBastionError(new Error('x'))).toBe(false);
    expect(isBastionError('x')).toBe(false);
  });

  it('6.9 tools/call denials become tool results the model can read', () => {
    const result = toToolErrorResult(
      new RateLimitedError('Too many calls', { retryAfterMs: 2000, limit: 'rl-1' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Too many calls' }]);
    expect(result._meta['io.github.bastion-mcp/error']).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 2000,
    });
  });

  it('6.9 only policy, rate, quota and guard errors convert to tool results', () => {
    expect(new PolicyDeniedError('x', {}).isToolResult).toBe(true);
    expect(new RateLimitedError('x', { retryAfterMs: 1, limit: 'a' }).isToolResult).toBe(true);
    expect(new QuotaExceededError('x', { resetsAt: 'a', quota: 'b' }).isToolResult).toBe(true);
    expect(new GuardBlockedError('x', { guard: 'a', ruleId: 'b' }).isToolResult).toBe(true);
    expect(new UpstreamUnavailableError('x', { installation: 'a' }).isToolResult).toBe(false);
  });

  it('6.9 upstream error messages are truncated to 2,000 characters and lose stack traces', () => {
    const long = 'a'.repeat(5000);
    expect(sanitizeUpstreamErrorMessage(long)).toHaveLength(2000);
    const withStack = 'boom\n    at fn (/srv/app.js:1:1)\n    at other (/srv/app.js:2:2)';
    expect(sanitizeUpstreamErrorMessage(withStack)).toBe('boom');
  });
});
