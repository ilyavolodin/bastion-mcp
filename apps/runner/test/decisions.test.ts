import { STDIO_SUBPROTOCOL } from '@bastion-mcp/sandbox/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTEN_HOST, DEFAULT_LISTEN_PORT, parseArgs } from '../src/args';
import { DEFAULT_EGRESS_HOST, DEFAULT_EGRESS_PORT } from '../src/egress-forward';
import { pickEnv } from '../src/env';
import { instancePackageJson } from '../src/install';
import { decideUpgrade } from '../src/state';

const offered = { 'sec-websocket-protocol': STDIO_SUBPROTOCOL };

describe('8.3 decideUpgrade', () => {
  it('8.3 allows a token-bearing upgrade to /v1/stdio while running with the subprotocol', () => {
    expect(decideUpgrade('running', '/v1/stdio', offered, true)).toEqual({ allow: true });
    expect(
      decideUpgrade(
        'running',
        '/v1/stdio?x=1',
        { 'sec-websocket-protocol': `a, ${STDIO_SUBPROTOCOL}` },
        true,
      ),
    ).toEqual({ allow: true });
  });

  it('8.3 rejects a missing token with 401 and a wrong state with 409', () => {
    expect(decideUpgrade('running', '/v1/stdio', offered, false)).toMatchObject({
      allow: false,
      status: 401,
    });
    expect(decideUpgrade('bound', '/v1/stdio', offered, true)).toMatchObject({
      allow: false,
      status: 409,
    });
    expect(decideUpgrade('unbound', '/v1/stdio', offered, false)).toMatchObject({
      allow: false,
      status: 409,
    });
  });

  it('8.3 rejects other paths with 404 and a missing subprotocol with 400', () => {
    expect(decideUpgrade('running', '/healthz', offered, true)).toEqual({
      allow: false,
      status: 404,
      reason: 'Not Found',
    });
    expect(decideUpgrade('running', '/nope', offered, true)).toMatchObject({ status: 404 });
    expect(decideUpgrade('running', '/v1/stdio', {}, true)).toEqual({
      allow: false,
      status: 400,
      reason: 'Bad Request',
    });
  });

  it('8.3 reasons are safe for an HTTP status line', () => {
    const decision = decideUpgrade('running', '/v1/stdio', offered, false);
    expect(decision.allow ? '' : decision.reason).toMatch(/^[\x20-\x7e]*$/);
  });
});

describe('8.3 pickEnv', () => {
  it('8.3 copies only the named variables that are set and non-empty', () => {
    expect(pickEnv(['A', 'B', 'C', 'D'], { A: '1', B: '', C: undefined, E: '5' })).toEqual({
      A: '1',
    });
    expect(pickEnv([], { A: '1' })).toEqual({});
  });
});

describe('8.3 shared constants and helpers', () => {
  it('8.3 the default listen and egress addresses are the documented ones', () => {
    expect(parseArgs([]).listen).toEqual({ kind: 'tcp', host: '0.0.0.0', port: 8080 });
    expect([DEFAULT_LISTEN_HOST, DEFAULT_LISTEN_PORT]).toEqual(['0.0.0.0', 8080]);
    expect([DEFAULT_EGRESS_HOST, DEFAULT_EGRESS_PORT]).toEqual(['127.0.0.1', 3128]);
  });

  it('8.3 instancePackageJson pins exactly the requested package', () => {
    expect(JSON.parse(instancePackageJson({ identifier: '@a/b', version: '1.2.3' }))).toEqual({
      name: 'bastion-mcp-instance',
      version: '0.0.0',
      private: true,
      dependencies: { '@a/b': '1.2.3' },
    });
  });
});
