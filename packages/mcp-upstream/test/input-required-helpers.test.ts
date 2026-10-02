import { ProtocolError } from '@modelcontextprotocol/client';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  answerExpired,
  answerMissingCapability,
  asErrorResponse,
  clientSupports,
  inputRequestKey,
  toInputRequests,
} from '../src/input-required/helpers';

describe('6.5 input-required helpers', () => {
  it('6.5 keys a batch b0, b1, ...', () => {
    expect(inputRequestKey(0)).toBe('b0');
    const map = toInputRequests([
      { kind: 'elicitation', params: { message: 'a' } },
      { kind: 'sampling', params: { messages: [] } },
      { kind: 'roots', params: undefined },
    ]);
    expect(Object.keys(map)).toEqual(['b0', 'b1', 'b2']);
    expect(map.b0).toEqual({ method: 'elicitation/create', params: { message: 'a' } });
    expect(map.b1?.method).toBe('sampling/createMessage');
    expect(map.b2?.method).toBe('roots/list');
  });

  it('6.5 property: n requests are keyed b0..b(n-1) in order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (n) => {
        const map = toInputRequests(
          Array.from({ length: n }, () => ({ kind: 'roots' as const, params: {} })),
        );
        expect(Object.keys(map)).toEqual(Array.from({ length: n }, (_, i) => `b${i}`));
      }),
    );
  });

  it('6.5 checks elicitation.form, elicitation.url, sampling and roots against the client capabilities', () => {
    expect(clientSupports({}, 'elicitation', {})).toBe(false);
    expect(clientSupports({ elicitation: {} }, 'elicitation', { mode: 'form' })).toBe(true);
    expect(clientSupports({ elicitation: {} }, 'elicitation', { mode: 'url' })).toBe(false);
    expect(clientSupports({ elicitation: { url: {} } }, 'elicitation', { mode: 'url' })).toBe(true);
    expect(clientSupports({ elicitation: { url: {} } }, 'elicitation', {})).toBe(false);
    expect(clientSupports({ elicitation: { form: {}, url: {} } }, 'elicitation', {})).toBe(true);
    expect(clientSupports({ sampling: {} }, 'sampling', {})).toBe(true);
    expect(clientSupports({}, 'sampling', {})).toBe(false);
    expect(clientSupports({ roots: {} }, 'roots', undefined)).toBe(true);
    expect(clientSupports({}, 'roots', undefined)).toBe(false);
  });

  it('6.5 without the capability: elicitation is declined, sampling gets -32601, roots the configured roots', () => {
    expect(answerMissingCapability('elicitation', [])).toEqual({ action: 'decline' });
    expect(() => answerMissingCapability('sampling', [])).toThrow(ProtocolError);
    try {
      answerMissingCapability('sampling', []);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(-32601);
    }
    expect(answerMissingCapability('roots', [])).toEqual({ roots: [] });
    expect(answerMissingCapability('roots', ['file:///workspace'])).toEqual({
      roots: [{ uri: 'file:///workspace' }],
    });
  });

  it('6.5 on TTL expiry elicitations are cancelled and sampling and roots get -32603', () => {
    expect(answerExpired('elicitation')).toEqual({ action: 'cancel' });
    for (const kind of ['sampling', 'roots'] as const) {
      try {
        answerExpired(kind);
        expect.unreachable();
      } catch (error) {
        expect((error as ProtocolError).code).toBe(-32603);
      }
    }
  });

  it('6.5 recognizes an error response in inputResponses but not a result that has an error field', () => {
    expect(asErrorResponse({ error: { code: -32000, message: 'no' } })).toEqual({
      code: -32000,
      message: 'no',
    });
    expect(asErrorResponse({ action: 'accept', error: { code: 1, message: 'x' } })).toBeUndefined();
    expect(asErrorResponse({ action: 'accept' })).toBeUndefined();
    expect(asErrorResponse('x')).toBeUndefined();
    expect(asErrorResponse({ error: {} })).toEqual({ code: -32603, message: 'client error' });
  });
});
