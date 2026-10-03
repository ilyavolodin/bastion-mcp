import { describe, expect, it } from 'vitest';
import {
  expandTemplate,
  fieldsOf,
  hasParameters,
  initialArguments,
  type JsonSchema,
  listToText,
  missingRequired,
  parseNumber,
  templateVariables,
  textToList,
  unknownArguments,
} from './json-schema-form';

const search: JsonSchema = {
  type: 'object',
  required: ['query'],
  properties: {
    limit: { type: 'integer', description: 'How many', default: 10 },
    query: { type: 'string', description: 'What to look for' },
    mode: { type: 'string', enum: ['fast', 'deep'] },
    tags: { type: 'array', items: { type: 'string' } },
    ids: { type: 'array', items: { type: 'integer' } },
    exact: { type: 'boolean' },
    filter: { type: 'object', properties: { owner: { type: 'string' } } },
    either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
};

describe('fields of a tool’s input schema (12.5)', () => {
  it('lists required parameters first, then the rest in the schema’s order, with their kinds', () => {
    const fields = fieldsOf(search);
    expect(fields.map((f) => f.name)).toEqual([
      'query',
      'limit',
      'mode',
      'tags',
      'ids',
      'exact',
      'filter',
      'either',
    ]);
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(by.query).toMatchObject({
      kind: 'string',
      required: true,
      description: 'What to look for',
    });
    expect(by.limit).toMatchObject({ kind: 'integer', required: false, initial: 10 });
    expect(by.mode).toMatchObject({ kind: 'enum', enumValues: ['fast', 'deep'] });
    expect(by.tags).toMatchObject({ kind: 'list', itemKind: 'string' });
    expect(by.ids).toMatchObject({ kind: 'list', itemKind: 'integer' });
    expect(by.exact?.kind).toBe('boolean');
    // What a form cannot express is edited as JSON.
    expect(by.filter?.kind).toBe('json');
    expect(by.either?.kind).toBe('json');
  });

  it('treats a nullable type as its concrete type and a tool without parameters as having none', () => {
    expect(
      fieldsOf({ type: 'object', properties: { note: { type: ['string', 'null'] } } })[0]?.kind,
    ).toBe('string');
    expect(fieldsOf({ type: 'object', properties: {} })).toEqual([]);
    expect(hasParameters({ type: 'object' })).toBe(false);
    expect(hasParameters(undefined)).toBe(false);
    expect(hasParameters(search)).toBe(true);
  });
});

describe('what a form starts with', () => {
  it('uses only what the schema offers: defaults, const, examples, the first choice of a required enum', () => {
    expect(initialArguments(search)).toEqual({ limit: 10 });
    expect(
      initialArguments({
        type: 'object',
        required: ['kind', 'region', 'id'],
        properties: {
          kind: { type: 'string', enum: ['a', 'b'] },
          region: { type: 'string', const: 'eu' },
          id: { type: 'string', examples: ['abc'] },
          other: { type: 'string' },
        },
      }),
    ).toEqual({ kind: 'a', region: 'eu', id: 'abc' });
  });

  it('never makes a value up for a required string without any hint (no "query": "orders")', () => {
    expect(
      initialArguments({ type: 'object', required: ['q'], properties: { q: { type: 'string' } } }),
    ).toEqual({});
  });
});

describe('typed values', () => {
  it('lists are one item per line, numbers stay numbers, empties are undefined', () => {
    expect(listToText(['a', 'b'])).toBe('a\nb');
    expect(textToList('a\n\n b \n', 'string')).toEqual(['a', 'b']);
    expect(textToList('1\n2', 'integer')).toEqual([1, 2]);
    expect(textToList('1\nx', 'integer')).toEqual(['1', 'x']);
    expect(textToList('  \n', 'string')).toBeUndefined();
    expect(parseNumber('12', true)).toBe(12);
    expect(parseNumber('1.9', true)).toBe(1);
    expect(parseNumber('1.5', false)).toBe(1.5);
    expect(parseNumber('', false)).toBeUndefined();
    expect(parseNumber('abc', false)).toBeUndefined();
  });

  it('reports required parameters without a value, and names the schema does not know', () => {
    expect(missingRequired(search, {})).toEqual([{ name: 'query', message: 'query is required' }]);
    expect(missingRequired(search, { query: '' })).toHaveLength(1);
    expect(missingRequired(search, { query: 'x' })).toEqual([]);
    expect(unknownArguments(search, { query: 'x', typo: 1 })).toEqual(['typo']);
    expect(unknownArguments({ ...search, additionalProperties: true }, { typo: 1 })).toEqual([]);
  });
});

describe('resource templates (RFC 6570)', () => {
  it('names the variables of simple, reserved and query expansions once each', () => {
    expect(templateVariables('file:///{path}')).toEqual(['path']);
    expect(templateVariables('repo://{owner}/{repo}/contents{+path}{?ref,page}')).toEqual([
      'owner',
      'repo',
      'path',
      'ref',
      'page',
    ]);
    expect(templateVariables('x://{id}/{id}')).toEqual(['id']);
    expect(templateVariables('plain://uri')).toEqual([]);
  });

  it('fills them in, escaping what needs it', () => {
    expect(expandTemplate('file:///{path}', { path: 'a b' })).toBe('file:///a%20b');
    expect(
      expandTemplate('repo://{owner}/{repo}{+path}', { owner: 'o', repo: 'r', path: '/a b/c' }),
    ).toBe('repo://o/r/a%20b/c');
    expect(expandTemplate('x://q{?a,b}', { a: '1', b: '' })).toBe('x://q?a=1');
    expect(expandTemplate('x://q{?a,b}', {})).toBe('x://q');
  });
});
