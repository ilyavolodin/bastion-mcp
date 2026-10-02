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
