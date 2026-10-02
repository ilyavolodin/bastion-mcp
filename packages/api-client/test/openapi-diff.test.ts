import { describe, expect, it } from 'vitest';
import { diffOpenApi } from '../src';

const doc = (
  version: string,
  paths: Record<string, Record<string, unknown>>,
  schemes: string[] = ['bearer'],
) => ({
  openapi: '3.1.0',
  info: { title: 't', version },
  paths,
  components: { securitySchemes: Object.fromEntries(schemes.map((s) => [s, { type: 'http' }])) },
});

const op = (response: unknown, extra: Record<string, unknown> = {}) => ({
  responses: { '200': { content: { 'application/json': { schema: response } } } },
  ...extra,
});

const obj = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
) => ({
  type: 'object',
  properties,
  required,
});

const base = doc('1.0.0', {
  '/users': {
    get: op(obj({ id: { type: 'string' }, role: { enum: ['a', 'b'] } })),
    post: op(obj({ id: { type: 'string' } }), {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: obj({ email: { type: 'string' } }) } },
      },
    }),
  },
  '/teams': { get: op(obj({ id: { type: 'string' } })) },
});

describe('17 openapi diff: breaking changes (CI check)', () => {
  it('17 reports no changes for identical documents', () => {
    const r = diffOpenApi(base, structuredClone(base));
    expect(r.breaking).toEqual([]);
    expect(r.compatible).toEqual([]);
    expect(r.needsVersionBump).toBe(false);
  });

  it('17 flags a removed operation and requires a major bump', () => {
    const next = structuredClone(base);
    delete (next.paths as Record<string, unknown>)['/teams'];
    const r = diffOpenApi(base, next);
    expect(r.breaking.map((c) => c.message)).toContain('operation was removed');
    expect(r.needsVersionBump).toBe(true);
    const bumped = { ...next, info: { title: 't', version: '2.0.0' } };
    expect(diffOpenApi(base, bumped).needsVersionBump).toBe(false);
  });

  it('17 flags a removed or retyped response property', () => {
    const removed = doc('1.0.0', {
      ...base.paths,
      '/users': { ...base.paths['/users'], get: op(obj({ role: { enum: ['a', 'b'] } })) },
    });
    expect(diffOpenApi(base, removed).breaking.map((c) => c.message)).toContain(
      'response property id was removed',
    );
    const retyped = doc('1.0.0', {
      ...base.paths,
      '/users': {
        ...base.paths['/users'],
        get: op(obj({ id: { type: ['string', 'null'] }, role: { enum: ['a', 'b'] } })),
      },
    });
    expect(
      diffOpenApi(base, retyped).breaking.some((c) => c.message.includes('may now be null')),
    ).toBe(true);
  });

  it('17 flags new response enum values but not removed ones', () => {
    const widened = doc('1.0.0', {
      ...base.paths,
      '/users': {
        ...base.paths['/users'],
        get: op(obj({ id: { type: 'string' }, role: { enum: ['a', 'b', 'c'] } })),
      },
    });
    expect(diffOpenApi(base, widened).breaking.length).toBe(1);
    const narrowed = doc('1.0.0', {
      ...base.paths,
      '/users': {
        ...base.paths['/users'],
        get: op(obj({ id: { type: 'string' }, role: { enum: ['a'] } })),
      },
    });
    expect(diffOpenApi(base, narrowed).breaking).toEqual([]);
  });

  it('17 flags a new required request property but accepts a new optional one', () => {
    const body = (props: Record<string, unknown>, required: string[]) => ({
      required: true,
      content: { 'application/json': { schema: obj(props, required) } },
    });
    const required = doc('1.0.0', {
      ...base.paths,
      '/users': {
        ...base.paths['/users'],
        post: op(obj({ id: { type: 'string' } }), {
          requestBody: body({ email: { type: 'string' }, name: { type: 'string' } }, [
            'email',
            'name',
          ]),
        }),
      },
    });
    expect(diffOpenApi(base, required).breaking.map((c) => c.message)).toContain(
      'request property name is new and required',
    );
    const optional = doc('1.0.0', {
      ...base.paths,
      '/users': {
        ...base.paths['/users'],
        post: op(obj({ id: { type: 'string' } }), {
          requestBody: body({ email: { type: 'string' }, name: { type: 'string' } }, ['email']),
        }),
      },
    });
    const r = diffOpenApi(base, optional);
    expect(r.breaking).toEqual([]);
    expect(r.compatible.map((c) => c.message)).toContain('property name was added');
  });

  it('17 flags new required parameters and removed success responses', () => {
    const withParam = doc('1.0.0', {
      ...base.paths,
      '/teams': {
        get: op(obj({ id: { type: 'string' } }), {
          parameters: [{ in: 'query', name: 'x', required: true, schema: { type: 'string' } }],
        }),
      },
    });
    expect(diffOpenApi(base, withParam).breaking.map((c) => c.message)).toContain(
      'new required parameter query:x',
    );
    const noOk = doc('1.0.0', {
      ...base.paths,
      '/teams': { get: { responses: { '404': {} } } },
    });
    expect(diffOpenApi(base, noOk).breaking.map((c) => c.message)).toContain(
      'response 200 was removed',
    );
  });

  it('17 treats added operations as compatible and removed security schemes as breaking', () => {
    const added = doc('1.0.0', { ...base.paths, '/new': { get: op(obj({})) } });
    const r = diffOpenApi(base, added);
    expect(r.breaking).toEqual([]);
    expect(r.compatible.map((c) => c.message)).toContain('operation was added');
    const noScheme = doc('1.0.0', base.paths, []);
    expect(diffOpenApi(base, noScheme).breaking.map((c) => c.message)).toContain(
      'security scheme bearer was removed',
    );
  });

  it('17 resolves $ref schemas in components', () => {
    const withRef = (props: Record<string, unknown>) => ({
      ...doc('1.0.0', { '/a': { get: op({ $ref: '#/components/schemas/A' }) } }),
      components: { schemas: { A: obj(props) }, securitySchemes: { bearer: {} } },
    });
    const r = diffOpenApi(
      withRef({ id: { type: 'string' }, n: { type: 'number' } }),
      withRef({ id: { type: 'string' } }),
    );
    expect(r.breaking.map((c) => c.message)).toContain('response property n was removed');
  });
});

describe('17 openapi diff: more request and response rules', () => {
  const withBody = (body: unknown, required = true) =>
    doc('1.0.0', {
      '/x': {
        post: op(obj({}), {
          requestBody: { required, content: { 'application/json': { schema: body } } },
        }),
      },
    });
  const noBody = doc('1.0.0', { '/x': { post: op(obj({})) } });

  it('17 flags added required, removed and newly required request bodies', () => {
    expect(diffOpenApi(noBody, withBody(obj({}))).breaking.map((c) => c.message)).toContain(
      'a request body was added',
    );
    expect(diffOpenApi(noBody, withBody(obj({}), false)).breaking).toEqual([]);
    expect(diffOpenApi(withBody(obj({})), noBody).breaking.map((c) => c.message)).toContain(
      'the request body was removed',
    );
    expect(
      diffOpenApi(withBody(obj({}), false), withBody(obj({}), true)).breaking.map((c) => c.message),
    ).toContain('the request body became required');
  });

  it('17 flags narrowed request types and enums, and optional properties becoming required', () => {
    const narrowed = diffOpenApi(
      withBody({ type: ['string', 'null'] }),
      withBody({ type: 'string' }),
    );
    expect(narrowed.breaking.map((c) => c.message)).toContain(
      'request type no longer accepts null',
    );
    const enumNow = diffOpenApi(
      withBody({ type: 'string' }),
      withBody({ type: 'string', enum: ['a'] }),
    );
    expect(enumNow.breaking.map((c) => c.message)).toContain(
      'request values are now restricted to an enum',
    );
    const enumRemoved = diffOpenApi(withBody({ enum: ['a', 'b'] }), withBody({ enum: ['a'] }));
    expect(enumRemoved.breaking.length).toBe(1);
    const req = diffOpenApi(
      withBody(obj({ a: { type: 'string' } }, [])),
      withBody(obj({ a: { type: 'string' } }, ['a'])),
    );
    expect(req.breaking.map((c) => c.message)).toContain('request property a became required');
  });

  it('17 flags response properties that are no longer always present and array item changes', () => {
    const resp = (schema: unknown) => doc('1.0.0', { '/x': { get: op(schema) } });
    const optional = diffOpenApi(
      resp(obj({ a: { type: 'string' } })),
      resp(obj({ a: { type: 'string' } }, [])),
    );
    expect(optional.breaking.map((c) => c.message)).toContain(
      'response property a is no longer always present',
    );
    const items = diffOpenApi(
      resp({ type: 'array', items: obj({ a: { type: 'string' } }) }),
      resp({ type: 'array', items: obj({}) }),
    );
    expect(items.breaking.map((c) => c.message)).toContain('response property a was removed');
  });

  it('17 handles anyOf alternatives and parameter changes', () => {
    const resp = (schema: unknown) => doc('1.0.0', { '/x': { get: op(schema) } });
    const grown = diffOpenApi(
      resp({ anyOf: [{ type: 'string' }] }),
      resp({ anyOf: [{ type: 'string' }, { type: 'null' }] }),
    );
    expect(grown.breaking.map((c) => c.message)).toContain('response has new alternatives');
    const shrunk = diffOpenApi(
      withBody({ anyOf: [{ type: 'string' }, { type: 'null' }] }),
      withBody({ anyOf: [{ type: 'string' }] }),
    );
    expect(shrunk.breaking.map((c) => c.message)).toContain(
      'request no longer accepts every previous alternative',
    );
    const p = (extra: Record<string, unknown>) =>
      doc('1.0.0', {
        '/x': {
          get: op(obj({}), {
            parameters: [{ in: 'query', name: 'q', schema: { type: 'string' }, ...extra }],
          }),
        },
      });
    expect(diffOpenApi(p({}), p({ required: true })).breaking.map((c) => c.message)).toContain(
      'parameter query:q became required',
    );
    expect(
      diffOpenApi(p({}), doc('1.0.0', { '/x': { get: op(obj({})) } })).breaking.map(
        (c) => c.message,
      ),
    ).toContain('parameter query:q was removed');
  });
});
