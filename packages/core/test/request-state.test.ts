import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Keyring } from '../src/aead';
import {
  REQUEST_STATE_PREFIX,
  REQUEST_STATE_TTL_SECONDS,
  RequestStateError,
  unwrapRequestState,
  wrapRequestState,
} from '../src/request-state';

const ring: Keyring = { activeKid: 'k1', keys: new Map([['k1', randomBytes(32)]]) };
const now = 1_790_000_000;

const binding = {
  principalId: 'p1',
  endpointId: 'e1',
  installationId: 'i1',
  method: 'tools/call',
  name: 'github__create_issue',
  args: { repo: 'web', n: 1 },
};

describe('6.5 wrapped request state', () => {
  it('wraps with the bst1. prefix and unwraps to the upstream state', () => {
    const state = wrapRequestState(ring, binding, { upstreamState: 'up', now });
    expect(state.startsWith(REQUEST_STATE_PREFIX)).toBe(true);
    const out = unwrapRequestState(ring, state, binding, { now: now + 5 });
    expect(out.upstreamState).toBe('up');
  });

  it('expires 10 minutes after issue', () => {
    const state = wrapRequestState(ring, binding, { now });
    expect(REQUEST_STATE_TTL_SECONDS).toBe(600);
    expect(() => unwrapRequestState(ring, state, binding, { now: now + 601 })).toThrow(
      /invalid requestState/,
    );
    expect(() => unwrapRequestState(ring, state, binding, { now: now + 599 })).not.toThrow();
  });

  it.each([
    ['principal', { principalId: 'p2' }],
    ['endpoint', { endpointId: 'e2' }],
    ['installation', { installationId: 'i2' }],
    ['method', { method: 'prompts/get' }],
    ['name digest', { name: 'other__tool' }],
    ['argument digest', { args: { repo: 'api', n: 1 } }],
  ])('rejects a retry whose %s differs', (_label, change) => {
    const state = wrapRequestState(ring, binding, { now });
    expect(() => unwrapRequestState(ring, state, { ...binding, ...change }, { now })).toThrow(
      RequestStateError,
    );
  });

  it('argument digest ignores key order (JCS)', () => {
    const state = wrapRequestState(ring, binding, { now });
    expect(() =>
      unwrapRequestState(ring, state, { ...binding, args: { n: 1, repo: 'web' } }, { now }),
    ).not.toThrow();
  });

  it('rejects states without the bst1. prefix', () => {
    expect(() => unwrapRequestState(ring, 'raw-upstream-state', binding, { now })).toThrow(
      RequestStateError,
    );
  });

  it('carries continuation and owner worker for legacy upstreams', () => {
    const state = wrapRequestState(ring, binding, {
      now,
      continuationId: 'c1',
      ownerWorkerId: 'w1',
    });
    const out = unwrapRequestState(ring, state, binding, { now });
    expect(out).toMatchObject({ continuationId: 'c1', ownerWorkerId: 'w1' });
  });

  it('property: tampering with any character fails closed', () => {
    const state = wrapRequestState(ring, binding, { now });
    fc.assert(
      fc.property(fc.integer({ min: REQUEST_STATE_PREFIX.length, max: state.length - 1 }), (i) => {
        const ch = state[i] === 'A' ? 'B' : 'A';
        const bad = state.slice(0, i) + ch + state.slice(i + 1);
        try {
          unwrapRequestState(ring, bad, binding, { now });
          return false;
        } catch (e) {
          return e instanceof RequestStateError;
        }
      }),
    );
  });
});
