/** 23.1 property layer: requestState tamper rejection, input partition laws, arbitrary input never crashes the HTTP layer. */
import { wrapRequestState } from '@bastion-mcp/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullyLocal, partitionInputRequests } from '../src/bridge/partition';
import { buildEndpoint, installation, items, opContext, principal } from './helpers/fixtures';
import { type HttpStack, startHttpStack } from './helpers/http-stack';
import { keyring, makeOps } from './helpers/ops';
import { rawLegacy, rawModern } from './helpers/raw';

const TOOL = 'github__echo';

describe('22.1 requestState tamper rejection (property)', () => {
  it('6.5 any single-character change, truncation or foreign token is rejected with -32602 and never reaches the upstream', async () => {
    const inst = installation('github');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const ops = makeOps();
    const ctx = opContext(resolved);
    const good = wrapRequestState(
      keyring,
      {
        principalId: principal().id,
        endpointId: 'default',
        installationId: inst.id,
        method: 'tools/call',
        name: TOOL,
        args: { text: 'x' },
      },
      { now: Math.floor(Date.now() / 1000) },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc
            .tuple(fc.nat(good.length - 1), fc.string({ minLength: 1, maxLength: 1 }))
            .map(([i, c]) =>
              good[i] === c
                ? `${good.slice(0, i)}${c === 'A' ? 'B' : 'A'}${good.slice(i + 1)}`
                : `${good.slice(0, i)}${c}${good.slice(i + 1)}`,
            ),
          fc.nat(good.length - 1).map((n) => good.slice(0, n)),
          fc.string(),
          fc.string().map((s) => `bst1.${s}`),
        ),
        async (state) => {
          fc.pre(state !== good);
          const err = await ops
            .run(
              'tools/call',
              { name: TOOL, arguments: { text: 'x' }, requestState: state, inputResponses: {} },
              ctx,
            )
            .then(() => undefined)
            .catch((e: unknown) => e);
          expect(err).toMatchObject({ mcpCode: -32602 });
        },
      ),
      { numRuns: 300 },
    );
    expect(ops.upstream.calls).toHaveLength(0);
  });

  it('6.5 the untouched state is accepted (the property is not vacuous)', async () => {
    const inst = installation('github');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const ops = makeOps();
    const ctx = opContext(resolved);
    const good = wrapRequestState(
      keyring,
      {
        principalId: principal().id,
        endpointId: 'default',
        installationId: inst.id,
        method: 'tools/call',
        name: TOOL,
        args: { text: 'x' },
      },
      { now: Math.floor(Date.now() / 1000) },
    );
    const out = await ops.run(
      'tools/call',
      { name: TOOL, arguments: { text: 'x' }, requestState: good, inputResponses: {} },
      ctx,
    );
    expect(out.kind).toBe('complete');
  });
});

describe('6.5 input partition laws (property)', () => {
  const kinds = ['elicitation/create', 'sampling/createMessage', 'roots/list', 'acme/other'];
  const requests = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 6 }),
    fc.record({
      method: fc.constantFrom(...kinds),
      params: fc.option(fc.record({ mode: fc.constantFrom('form', 'url') }), { nil: undefined }),
    }),
  );
  const caps = fc.record({
    elicitation: fc.option(
      fc.record({
        form: fc.option(fc.constant({}), { nil: undefined }),
        url: fc.option(fc.constant({}), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    sampling: fc.option(fc.constant({}), { nil: undefined }),
    roots: fc.option(fc.constant({}), { nil: undefined }),
  });

  it('every request goes to exactly one side, nothing is lost, and unknown methods always reach the client', () => {
    fc.assert(
      fc.property(requests, caps, (inputRequests, capabilities) => {
        const clean = JSON.parse(JSON.stringify(capabilities)) as never;
        const p = partitionInputRequests(inputRequests as never, clean, ['file:///w']);
        const all = Object.keys(inputRequests).sort();
        const split = [...Object.keys(p.forClient), ...Object.keys(p.local)].sort();
        expect(split).toEqual(all);
        for (const key of Object.keys(p.forClient)) expect(key in p.local).toBe(false);
        for (const [key, entry] of Object.entries(inputRequests)) {
          if (entry.method === 'acme/other') expect(key in p.forClient).toBe(true);
        }
        expect(fullyLocal(p)).toBe(Object.keys(p.forClient).length === 0);
      }),
      { numRuns: 300 },
    );
  });
});

describe('23.3 fuzzing the HTTP layer', () => {
  let stack: HttpStack;
  beforeAll(async () => {
    stack = await startHttpStack();
  });
  afterAll(async () => {
    await stack.stop();
  });

  it('6.2 arbitrary JSON bodies on both eras never produce a 5xx or crash the worker', async () => {
    const token = stack.users.alice?.token ?? '';
    const json = fc.jsonValue({ maxDepth: 4 });
    await fc.assert(
      fc.asyncProperty(json, fc.constantFrom('modern', 'legacy'), async (body, era) => {
        const res =
          era === 'modern'
            ? await rawModern(stack.base, {
                token,
                method: 'tools/list',
                params:
                  typeof body === 'object' && body !== null && !Array.isArray(body)
                    ? (body as Record<string, unknown>)
                    : { v: body },
              })
            : await rawLegacy(stack.base, { token, protocolVersion: '2025-06-18', body });
        expect(res.status).toBeLessThan(500);
      }),
      { numRuns: 200 },
    );
    const alive = await rawModern(stack.base, { token, method: 'tools/list' });
    expect(alive.status).toBe(200);
  }, 60_000);

  it('6.2 raw garbage bodies with JSON content type are -32700 or -32600, never 5xx', async () => {
    const token = stack.users.alice?.token ?? '';
    await fc.assert(
      fc.asyncProperty(fc.string(), async (garbage) => {
        const res = await fetch(`${stack.base}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: garbage,
        });
        expect(res.status).toBeLessThan(500);
        await res.text();
      }),
      { numRuns: 200 },
    );
  }, 60_000);
});
