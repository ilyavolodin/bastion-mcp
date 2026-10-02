import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bastionClientInfo,
  buildRequestMeta,
  declaredCapabilities,
  intersectCapabilities,
  onBehalfOf,
  timeoutFor,
  traceHeaders,
} from '../src/connectors/identity';

describe('6.4 upstream identity and capabilities', () => {
  it('6.4 identifies Bastion upstream as bastion with the gateway title', () => {
    expect(bastionClientInfo('1.2.3')).toEqual({
      name: 'bastion',
      version: '1.2.3',
      title: 'Bastion MCP Gateway',
    });
  });

  it('6.4 always declares elicitation form and url', () => {
    expect(declaredCapabilities({ enableSampling: false, enableRoots: false })).toEqual({
      elicitation: { form: {}, url: {} },
    });
  });

  it('6.4 declares sampling and roots only when the catalog entry enables them', () => {
    expect(declaredCapabilities({ enableSampling: true, enableRoots: false })).toMatchObject({
      sampling: {},
    });
    const both = declaredCapabilities({ enableSampling: true, enableRoots: true });
    expect(both.sampling).toEqual({});
    expect(both.roots).toEqual({});
    expect(
      declaredCapabilities({ enableSampling: false, enableRoots: true }).sampling,
    ).toBeUndefined();
  });

  it('6.4 per request capabilities are the declaration intersected with the downstream request', () => {
    const declared = declaredCapabilities({ enableSampling: true, enableRoots: true });
    expect(intersectCapabilities(declared, {})).toEqual({});
    expect(intersectCapabilities(declared, { elicitation: { url: {} } })).toEqual({
      elicitation: { url: {} },
    });
    expect(intersectCapabilities(declared, { elicitation: {}, sampling: {} })).toEqual({
      elicitation: { form: {} },
      sampling: {},
    });
  });

  it('6.4 property: the intersection never grants more than either side declares', () => {
    const flag = fc.option(fc.constant({}), { nil: undefined });
    const caps = fc.record({
      elicitation: fc.option(fc.record({ form: flag, url: flag }), { nil: undefined }),
      sampling: flag,
      roots: flag,
    });
    fc.assert(
      fc.property(caps, caps, (a, b) => {
        const out = intersectCapabilities(a as never, b as never);
        if (out.sampling) expect(a.sampling && b.sampling).toBeTruthy();
        if (out.roots) expect(a.roots && b.roots).toBeTruthy();
        if (out.elicitation?.url) expect(a.elicitation?.url && b.elicitation?.url).toBeTruthy();
        if (out.elicitation?.form) expect(a.elicitation?.form).toBeTruthy();
      }),
    );
  });

  it('6.4 adds onBehalfOf, trace context and the log level to _meta', () => {
    const meta = buildRequestMeta(
      {
        principal: { userId: 'u1', clientName: 'cursor' },
        trace: { traceparent: '00-a-b-01', baggage: 'k=v' },
        logLevel: 'debug',
      },
      { keep: 1 },
    );
    expect(meta['io.github.bastion-mcp/onBehalfOf']).toEqual({
      userId: 'u1',
      clientName: 'cursor',
    });
    expect(meta.traceparent).toBe('00-a-b-01');
    expect(meta.baggage).toBe('k=v');
    expect(meta.keep).toBe(1);
    expect(meta['io.modelcontextprotocol/logLevel']).toBe('debug');
  });

  it('6.6 the log level is sent upstream only when the downstream request carried one', () => {
    const meta = buildRequestMeta({ principal: { userId: 'u1' }, trace: {} }, undefined);
    expect(meta['io.modelcontextprotocol/logLevel']).toBeUndefined();
    expect(onBehalfOf({ userId: 'u1' }).clientName).toBe('unknown');
  });

  it('6.4 trace headers carry only present fields', () => {
    expect(traceHeaders({ traceparent: 'x' })).toEqual({ traceparent: 'x' });
  });

  it('6.4 timeouts: 60 s for tools/call, 15 s for lists, reads and prompts, overridable up to 30 minutes', () => {
    expect(timeoutFor('tools/call', undefined)).toBe(60_000);
    expect(timeoutFor('tools/list', undefined)).toBe(15_000);
    expect(timeoutFor('resources/read', undefined)).toBe(15_000);
    expect(timeoutFor('prompts/get', undefined)).toBe(15_000);
    expect(timeoutFor('tools/call', { toolCallMs: 120_000 })).toBe(120_000);
    expect(timeoutFor('resources/read', { listMs: 40_000 })).toBe(40_000);
    expect(timeoutFor('tools/call', { toolCallMs: 99 * 60_000 })).toBe(30 * 60_000);
  });
});
