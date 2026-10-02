import { z } from 'zod';
import { ERROR_BASE_URL } from './errors';

export const API_VERSION = '1.0.0';

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: z.string(),
  instance: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

const ERROR_STATUSES: Record<string, string> = {
  '400': 'Validation failed',
  '401': 'Authentication required',
  '403': 'Not allowed',
  '404': 'Not found',
  '409': 'Conflict',
  '412': 'If-Match does not match the current ETag',
  '428': 'If-Match is required',
};

export const SECURITY_SCHEMES = {
  bearer: {
    type: 'http' as const,
    scheme: 'bearer',
    description:
      'PAT or OAuth access token for resource https://<host>/api with scope api:read or api:write',
  },
  session: {
    type: 'apiKey' as const,
    in: 'cookie' as const,
    name: 'bastion_sid',
    description: 'Browser session; state-changing calls also send x-bastion-csrf (9.2)',
  },
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** The parts of an OpenAPI document this module touches. */
export type OpenApiDoc = {
  paths?: Record<string, Record<string, unknown> | undefined>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
};

type Operation = { responses?: Record<string, unknown> };

const REF = /#\/components\/schemas\/([A-Za-z0-9_.-]+)/g;

/**
 * Drops component schemas no operation reaches (zod registers every named schema for input and output; only the
 * variants that a route uses belong in the document).
 */
export const pruneUnusedSchemas = (doc: OpenApiDoc): void => {
  const schemas = (doc.components?.schemas ?? {}) as Record<string, unknown>;
  const used = new Set<string>(['Problem']);
  const visit = (value: unknown): void => {
    for (const match of JSON.stringify(value).matchAll(REF)) {
      const name = match[1];
      if (name === undefined || used.has(name)) continue;
      used.add(name);
      visit(schemas[name]);
    }
  };
  visit(doc.paths);
  visit(schemas.Problem);
  for (const name of Object.keys(schemas)) if (!used.has(name)) delete schemas[name];
};

/**
 * Adds the RFC 9457 problem schema, the security schemes and the shared error responses to the generated
 * document (17.1). Pure so that it can be tested and reused by the export script.
 */
export const decorateOpenApi = <T extends OpenApiDoc>(doc: T): T => {
  const problem: Record<string, unknown> = { ...z.toJSONSchema(problemSchema) };
  delete problem.$schema;
  const components = doc.components ?? {};
  const schemas = (components.schemas ?? {}) as Record<string, unknown>;
  components.schemas = { ...schemas, Problem: problem };
  components.securitySchemes = SECURITY_SCHEMES;
  doc.components = components;
  pruneUnusedSchemas(doc);
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item) continue;
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      const responses: Record<string, unknown> = { ...(op.responses ?? {}) };
      for (const [status, description] of Object.entries(ERROR_STATUSES)) {
        if (status in responses) continue;
        if ((status === '412' || status === '428') && !['put', 'patch', 'delete'].includes(method))
          continue;
        responses[status] = {
          description,
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        };
      }
      op.responses = responses;
    }
  }
  return doc;
};

export const openApiInfo = {
  title: 'Bastion control-plane API',
  version: API_VERSION,
  description: `REST API of the ui role (17). Errors are RFC 9457 problems; types live under ${ERROR_BASE_URL}.`,
} as const;
