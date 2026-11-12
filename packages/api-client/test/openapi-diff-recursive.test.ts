import { describe, expect, it } from 'vitest';
import { diffOpenApi } from '../src';

const withNode = (idType: string) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1.0.0' },
  paths: {
    '/n': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Node' } },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http' } },
    schemas: {
      Node: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: idType }, child: { $ref: '#/components/schemas/Node' } },
      },
    },
  },
});

describe('17 openapi diff: recursive schemas', () => {
  it('17 a self-referential $ref schema terminates and still reports a change inside it', () => {
    expect(() => diffOpenApi(withNode('string'), withNode('string'))).not.toThrow();
    const r = diffOpenApi(withNode('string'), withNode('number'));
    expect(r.breaking.length + r.compatible.length).toBeGreaterThan(0);
  });
});
