/**
 * Validates bodies against the OpenAPI document of the real API (`packages/api-client/openapi.json`) with ajv.
 * `validateResponse` checks what the MSW mock (fixtures and handlers) answers, `validateRequest` checks what a form
 * sends, so a screen that drifts from the API fails a test instead of failing in production.
 */
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import openapi from '../../../../packages/api-client/openapi.json';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

type JsonSchema = Record<string, unknown>;
type Operation = {
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
};
const doc = openapi as unknown as {
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components: { schemas: Record<string, JsonSchema> };
};

export type OperationRef = { method: HttpMethod; template: string };

/** The operation (`/teams/{id}`) that a concrete request path (`/teams/abc`) addresses. */
export const findOperation = (method: HttpMethod, rawPath: string): OperationRef | null => {
  const path = rawPath.split('?')[0]?.replace(/^.*\/api\/v1/, '') ?? '';
  const segs = path.split('/').filter(Boolean);
  let best: { template: string; literals: number } | null = null;
  for (const [template, item] of Object.entries(doc.paths)) {
    if (!item[method]) continue;
    const parts = template.split('/').filter(Boolean);
    const wild = parts.at(-1) === '{path}';
    if (wild ? segs.length < parts.length : segs.length !== parts.length) continue;
    if (!parts.every((p, i) => p.startsWith('{') || p === segs[i])) continue;
    const literals = parts.filter((p) => !p.startsWith('{')).length;
    if (!best || literals > best.literals) best = { template, literals };
  }
  return best ? { method, template: best.template } : null;
};

/** Whether the API answers 428 to this operation without an `If-Match` (the route loads a row version, 17.1). */
export const requiresIfMatch = (op: OperationRef): boolean =>
  (doc.paths[op.template]?.[op.method] as { 'x-requires-if-match'?: boolean } | undefined)?.[
    'x-requires-if-match'
  ] === true;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

const compileSchema = (key: string, schema: JsonSchema) => {
  let validate = compiled.get(key);
  if (!validate) {
    // `#/components/schemas/X` references resolve inside the same root document.
    validate = ajv.compile({ ...schema, components: doc.components });
    compiled.set(key, validate);
  }
  return validate;
};

export type Verdict = { ok: boolean; errors: string[] };

const verdict = (validate: ReturnType<typeof ajv.compile>, body: unknown): Verdict => {
  const ok = validate(body) as boolean;
  return {
    ok,
    errors: ok
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`),
  };
};

const jsonSchemaOf = (content: Record<string, { schema?: JsonSchema }> | undefined) =>
  content?.['application/json']?.schema ?? content?.['application/problem+json']?.schema;

/** Validates a response body (`status` defaults to the success status of the operation). */
export const validateResponse = (op: OperationRef, body: unknown, status?: number): Verdict => {
  const responses = doc.paths[op.template]?.[op.method]?.responses ?? {};
  const code =
    status !== undefined ? String(status) : Object.keys(responses).find((c) => c.startsWith('2'));
  const schema = code ? jsonSchemaOf(responses[code]?.content) : undefined;
  if (!schema)
    return { ok: false, errors: [`no response schema for ${op.method} ${op.template} ${code}`] };
  return verdict(compileSchema(`res:${op.method} ${op.template} ${code}`, schema), body);
};

/** Validates a request body against the operation's JSON request schema. */
export const validateRequest = (op: OperationRef, body: unknown): Verdict => {
  const schema = jsonSchemaOf(doc.paths[op.template]?.[op.method]?.requestBody?.content);
  if (!schema)
    return { ok: false, errors: [`no request body schema for ${op.method} ${op.template}`] };
  return verdict(compileSchema(`req:${op.method} ${op.template}`, schema), body);
};

/** Every operation of the document, for tests that walk them. */
export const allOperations = (): OperationRef[] =>
  Object.entries(doc.paths).flatMap(([template, item]) =>
    METHODS.filter((method) => item[method] !== undefined).map((method) => ({ method, template })),
  );

/** Whether the operation answers a JSON body on success. */
export const hasJsonResponse = (op: OperationRef): boolean => {
  const responses = doc.paths[op.template]?.[op.method]?.responses ?? {};
  const code = Object.keys(responses).find((c) => c.startsWith('2'));
  return code !== undefined && jsonSchemaOf(responses[code]?.content) !== undefined;
};
