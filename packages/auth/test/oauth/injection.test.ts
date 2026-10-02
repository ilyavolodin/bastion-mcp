import { randomBytes } from 'node:crypto';
import {
  context,
  type Span,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { noopMetrics, withRefreshSpan } from '../../src/oauth/metrics';
import {
  buildInjections,
  DEFAULT_REMOTE_INJECTION,
  decidePackageTokenAction,
  OAuthConfigError,
} from '../../src/oauth/upstream/injection';
import {
  openUpstreamState,
  sealUpstreamState,
  UpstreamStateError,
} from '../../src/oauth/upstream/state';
import { MemoryRedis } from './fakes';

describe('9.5 injection of the credential', () => {
  it('9.5 remote servers default to Authorization: Bearer', () => {
    expect(
      buildInjections({
        inject: undefined,
        kind: 'remote',
        context: { oauth: { accessToken: 'tok' } },
      }),
    ).toEqual([{ ...DEFAULT_REMOTE_INJECTION, value: 'Bearer tok' }]);
    expect(
      buildInjections({ inject: [], kind: 'remote', context: { oauth: { accessToken: 't' } } }),
    ).toHaveLength(1);
  });

  it('9.5 packages have no default: the catalog entry names the env var or argument', () => {
    expect(() => buildInjections({ inject: undefined, kind: 'package', context: {} })).toThrow(
      OAuthConfigError,
    );
    const resolved = buildInjections({
      inject: [
        { to: 'env', name: 'TOKEN', value: '{{oauth.accessToken}}' },
        { to: 'arg', flag: '--token', value: '{{oauth.accessToken}}', position: 1 },
        { to: 'header', name: 'X-User', value: '{{user.email}}' },
      ],
      kind: 'package',
      context: { oauth: { accessToken: 'tok' }, user: { email: 'a@b.example' } },
    });
    expect(resolved).toEqual([
      { to: 'env', name: 'TOKEN', value: 'tok' },
      { to: 'arg', flag: '--token', value: 'tok', position: 1 },
      { to: 'header', name: 'X-User', value: 'a@b.example' },
    ]);
  });

  it('9.5 a template without a value is a configuration error that never names the value', () => {
    expect(() =>
      buildInjections({
        inject: [{ to: 'env', name: 'X', value: '{{secret.MISSING}}' }],
        kind: 'package',
        context: {},
      }),
    ).toThrow(/MISSING/);
  });
});

describe('9.6 package token refresh decision', () => {
  const now = 1_000_000_000;
  it('9.6 restarts with a fresh token when the injected one expires within 5 minutes', () => {
    expect(decidePackageTokenAction({ injectedExpiresAt: now + 299_000, nowMs: now })).toEqual({
      action: 'refresh-and-restart',
    });
    expect(decidePackageTokenAction({ injectedExpiresAt: now + 300_000, nowMs: now })).toEqual({
      action: 'refresh-and-restart',
    });
    expect(decidePackageTokenAction({ injectedExpiresAt: now - 1, nowMs: now })).toEqual({
      action: 'refresh-and-restart',
    });
  });

  it('9.6 keeps the instance when the token has more than 5 minutes left or never expires', () => {
    expect(decidePackageTokenAction({ injectedExpiresAt: now + 300_001, nowMs: now })).toEqual({
      action: 'keep',
    });
    expect(decidePackageTokenAction({ injectedExpiresAt: null, nowMs: now })).toEqual({
      action: 'keep',
    });
  });

  it('9.6 property: the decision is monotonic in the remaining lifetime', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.integer({ min: 0, max: 600 }),
        (remaining, window) => {
          const decision = decidePackageTokenAction({
            injectedExpiresAt: now + remaining,
            nowMs: now,
            windowSeconds: window,
          });
          expect(decision.action === 'refresh-and-restart').toBe(remaining <= window * 1000);
        },
      ),
    );
  });
});

describe('9.6 upstream state (23.3)', () => {
  const ring = { activeKid: 'k1', keys: new Map([['k1', randomBytes(32)]]) };
  const base = {
    principalId: 'u1',
    principalType: 'user' as const,
    installationId: 'i1',
    nonce: 'n-1',
    codeVerifier: 'verifier-secret',
    issuer: 'https://as.example',
    scopes: ['read'],
  };

  it('9.6 round-trips and binds user, installation, nonce, issuer and scopes', async () => {
    const token = sealUpstreamState(base, ring);
    const state = await openUpstreamState(token, ring, {
      principalId: 'u1',
      redis: new MemoryRedis(),
    });
    expect(state).toMatchObject(base);
    expect(token).not.toContain('verifier-secret');
  });

  it('23.3 property: any single-character change to the token is rejected', async () => {
    const token = sealUpstreamState(base, ring);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: token.length - 1 }), async (index) => {
        const replacement = token[index] === 'A' ? 'B' : 'A';
        const mutated = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
        await expect(
          openUpstreamState(mutated, ring, { principalId: 'u1', redis: new MemoryRedis() }),
        ).rejects.toBeInstanceOf(UpstreamStateError);
      }),
      { numRuns: 60 },
    );
  });

  it('23.3 a token sealed with an unknown key is rejected', async () => {
    const other = { activeKid: 'k2', keys: new Map([['k2', randomBytes(32)]]) };
    const token = sealUpstreamState(base, other);
    await expect(
      openUpstreamState(token, ring, { principalId: 'u1', redis: new MemoryRedis() }),
    ).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('22.3 states sealed under the previous key still open (rotation)', async () => {
    const old = sealUpstreamState(base, ring);
    const rotated = { activeKid: 'k2', keys: new Map([...ring.keys, ['k2', randomBytes(32)]]) };
    await expect(
      openUpstreamState(old, rotated, { principalId: 'u1', redis: new MemoryRedis() }),
    ).resolves.toBeTruthy();
  });
});

describe('15.3 refresh instrumentation hooks', () => {
  afterEach(() => trace.disable());

  it('15.3 the default metrics hook is a no-op', () => {
    expect(() => noopMetrics.recordRefresh('success')).not.toThrow();
  });

  it('15.3 withRefreshSpan creates a bastion.oauth.refresh span, ends it, and marks errors', async () => {
    const spans: { name: string; attributes: unknown; status?: unknown; ended: boolean }[] = [];
    const tracer = {
      startActiveSpan: (
        name: string,
        options: { attributes?: unknown },
        fn: (span: Span) => unknown,
      ) => {
        const record: { name: string; attributes: unknown; status?: unknown; ended: boolean } = {
          name,
          attributes: options.attributes,
          ended: false,
        };
        spans.push(record);
        const span = {
          setStatus: (status: unknown) => {
            record.status = status;
          },
          end: () => {
            record.ended = true;
          },
        } as unknown as Span;
        return fn(span);
      },
    } as unknown as Tracer;
    trace.setGlobalTracerProvider({ getTracer: () => tracer } as TracerProvider);
    expect(await withRefreshSpan({ a: 'b' }, async () => 7)).toBe(7);
    await expect(
      withRefreshSpan({}, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(spans).toEqual([
      { name: 'bastion.oauth.refresh', attributes: { a: 'b' }, ended: true },
      {
        name: 'bastion.oauth.refresh',
        attributes: {},
        ended: true,
        status: { code: SpanStatusCode.ERROR },
      },
    ]);
    void context;
  });
});
