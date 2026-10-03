import { isRecord } from '@bastion-mcp/core';
/**
 * JSON Schema helpers: 2020-12 compilation with ajv (12.3), argument validation (12.3), and the
 * `x-mcp-header` rules of the 2026-07-28 Streamable HTTP transport.
 */

import type { ValidateFunction } from 'ajv/dist/2020.js';
import Ajv2020 from 'ajv/dist/2020.js';
import type { JsonObject, JsonValue } from './schema';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export const isObject = (value: unknown): value is JsonObject => isRecord(value);

/**
 * Compiles `schema` as JSON Schema 2020-12 and returns the validator; throws with ajv's message when
 * the schema is invalid. A foreign `$schema` (servers often emit draft-07) is ignored for the
 * compile so common schemas are checked as 2020-12 rather than rejected as unknown metaschemas.
 */
export const compileSchema = (schema: JsonObject): ValidateFunction => {
  const copy: JsonObject = { ...schema };
  if (copy.$schema !== undefined && copy.$schema !== DRAFT_2020_12) delete copy.$schema;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  return ajv.compile(copy);
};

const validators = new WeakMap<object, ValidateFunction>();

const describeError = (error: { instancePath: string; message?: string | undefined }): string =>
  `${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? 'is invalid'}`;

/** Validates `args` against `schema`; returns violation messages (empty when valid). */
export const validateAgainstSchema = (schema: JsonObject, args: unknown): string[] => {
  let validate = validators.get(schema);
  if (!validate) {
    validate = compileSchema(schema);
    validators.set(schema, validate);
  }
  if (validate(args)) return [];
  return (validate.errors ?? []).map(describeError);
};

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

const isPrimitiveSchema = (prop: JsonObject): boolean => {
  const type = prop.type;
  if (typeof type === 'string') return PRIMITIVE_TYPES.has(type);
  if (Array.isArray(type))
    return type.length > 0 && type.every((t) => typeof t === 'string' && PRIMITIVE_TYPES.has(t));
  const values = Array.isArray(prop.enum)
    ? prop.enum
    : prop.const !== undefined
      ? [prop.const]
      : [];
  return (
    values.length > 0 &&
    values.every((v: JsonValue) => ['string', 'number', 'boolean'].includes(typeof v))
  );
};

/**
 * `x-mcp-header` rules: only on top-level properties of primitive type (string, number, boolean),
 * a non-empty name of RFC 9110 token characters, unique case-insensitively within the tool.
 * Returns the problems found (empty when valid).
 */
export const validateXMcpHeaders = (schema: JsonObject): string[] => {
  const errors: string[] = [];
  const properties = isObject(schema.properties) ? schema.properties : {};
  const seen = new Map<string, string>();
  for (const [name, prop] of Object.entries(properties)) {
    if (!isObject(prop) || prop['x-mcp-header'] === undefined) continue;
    const header = prop['x-mcp-header'];
    if (typeof header !== 'string' || header === '' || !HEADER_NAME.test(header)) {
      errors.push(
        `property "${name}": x-mcp-header must be a non-empty token without spaces or ":"`,
      );
      continue;
    }
    if (!isPrimitiveSchema(prop)) {
      errors.push(
        `property "${name}": x-mcp-header requires a primitive type (string, number, boolean)`,
      );
    }
    const key = header.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push(`property "${name}": x-mcp-header "${header}" duplicates the one on "${first}"`);
    } else seen.set(key, name);
  }
  return errors;
};
