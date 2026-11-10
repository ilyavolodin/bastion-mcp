import { describe, expect, it } from 'vitest';
import { diffOpenApi } from '../src';

const doc = (
  version: string,
  paths: Record<string, Record<string, unknown>>,
  schemas: Record<string, unknown> = {},
) => ({
  openapi: '3.1.0',
  info: { title: 't', version },
  paths,
  components: { securitySchemes: { bearer: { type: 'http' } }, schemas },
});

const shape = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
});

const BEFORE = shape(
  {
    a: { type: 'string', enum: ['x', 'y'] },
    b: { type: ['string', 'null'] },
    c: shape({ d: { type: 'string' }, e: { type: 'string' } }, ['d']),
    f: { type: 'array', items: { type: 'string' } },
    g: {
      anyOf: [{ type: 'string' }, shape({ h: { type: 'string' } }, ['h'])],
    },
    gone: { type: 'string' },
    plain: { type: 'string' },
  },
  ['a', 'b', 'c', 'f', 'g', 'gone'],
);

const AFTER = shape(
  {
    a: { type: 'number', enum: ['x', 'z'] },
    b: { type: 'string' },
    c: shape({ d: { type: 'number' }, e: { type: 'string' }, n: { type: 'string' } }, [
      'd',
      'e',
      'n',
    ]),
    f: { type: 'array', items: { type: 'number' } },
    g: {
      oneOf: [
        { type: 'number' },
        shape({ h: { type: 'number' }, i: { type: 'string' } }, ['h']),
        { type: 'null' },
      ],
    },
    plain: { type: 'string', enum: ['q'] },
    extra: { type: 'string' },
  },
  ['a', 'c', 'f', 'g', 'extra'],
);

const asResponse = (schema: unknown) =>
  doc('1.0.0', {
    '/x': { get: { responses: { '200': { content: { 'application/json': { schema } } } } } },
  });
const asRequest = (schema: unknown) =>
  doc('1.0.0', {
    '/x': {
      post: {
        requestBody: { required: true, content: { 'application/json': { schema } } },
        responses: {},
      },
    },
  });

const lines = (changes: { kind: string; where: string; message: string }[]) =>
  changes.map((c) => `${c.where} :: ${c.message}`);

describe('17 openapi diff: order of the reported changes', () => {
  it('17 reports response-side changes in rule order within each schema, depth first', () => {
    const out = diffOpenApi(asResponse(BEFORE), asResponse(AFTER));
    expect(lines(out.breaking)).toMatchInlineSnapshot(`
      [
        "GET /x 200.a :: response may now be number",
        "GET /x 200.a :: response may now contain z",
        "GET /x 200.c.d :: response may now be number",
        "GET /x 200.f[] :: response may now be number",
        "GET /x 200.g :: response has new alternatives",
        "GET /x 200.g|0 :: response may now be number",
        "GET /x 200.g|1.h :: response may now be number",
        "GET /x 200 :: response property gone was removed",
        "GET /x 200 :: response property b is no longer always present",
      ]
    `);
    expect(lines(out.compatible)).toMatchInlineSnapshot(`
      [
        "GET /x 200.c :: property n was added",
        "GET /x 200.g|1 :: property i was added",
        "GET /x 200 :: property extra was added",
      ]
    `);
  });

  it('17 reports request-side changes in rule order within each schema, depth first', () => {
    const out = diffOpenApi(asRequest(BEFORE), asRequest(AFTER));
    expect(lines(out.breaking)).toMatchInlineSnapshot(`
      [
        "POST /x body.a :: request type no longer accepts string",
        "POST /x body.a :: request no longer accepts y",
        "POST /x body.b :: request type no longer accepts null",
        "POST /x body.c.d :: request type no longer accepts string",
        "POST /x body.c :: request property n is new and required",
        "POST /x body.c :: request property e became required",
        "POST /x body.f[] :: request type no longer accepts string",
        "POST /x body.g|0 :: request type no longer accepts string",
        "POST /x body.g|1.h :: request type no longer accepts string",
        "POST /x body.plain :: request values are now restricted to an enum",
        "POST /x body :: request property extra is new and required",
      ]
    `);
    expect(lines(out.compatible)).toMatchInlineSnapshot(`
      [
        "POST /x body.g|1 :: property i was added",
      ]
    `);
  });
});
