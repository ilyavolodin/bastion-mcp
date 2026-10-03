/**
 * Turns the JSON Schema of a tool (`inputSchema`) into form fields and back (the Try-it panel, 12.5). Nothing here
 * invents values: a field starts empty, or with what the schema itself says (`default`, `const`, the first `enum`
 * value, the first `examples` entry). Whatever the form cannot express (objects, unions, tuples) is edited as JSON.
 */
import { isRecord } from './json';

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  title?: string;
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  examples?: unknown[];
  items?: JsonSchema;
  format?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  [key: string]: unknown;
};

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'list' | 'json';

export type FormField = {
  name: string;
  kind: FieldKind;
  required: boolean;
  label: string;
  description: string | undefined;
  /** What the schema suggests for an empty field. */
  initial: unknown;
  enumValues: unknown[];
  /** For a `list`: the kind of each item (`string`, `number`, `integer`). */
  itemKind: 'string' | 'number' | 'integer';
  /** The schema of this one property, for the JSON editor of a `json` field. */
  schema: JsonSchema;
};

/** The one concrete type of a schema (`["string","null"]` is a string), or `undefined` when it is open. */
const typeOf = (schema: JsonSchema): string | undefined => {
  const t = schema.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.find((x) => x !== 'null');
  return undefined;
};

const suggestion = (schema: JsonSchema): unknown => {
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  return undefined;
};

const kindOf = (schema: JsonSchema): { kind: FieldKind; itemKind: FormField['itemKind'] } => {
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return { kind: 'enum', itemKind: 'string' };
  const t = typeOf(schema);
  if (t === 'string') return { kind: 'string', itemKind: 'string' };
  if (t === 'number' || t === 'integer') return { kind: t, itemKind: 'string' };
  if (t === 'boolean') return { kind: 'boolean', itemKind: 'string' };
  if (t === 'array') {
    const item = schema.items ? typeOf(schema.items) : 'string';
    if (item === 'string' || item === 'number' || item === 'integer') {
      return { kind: 'list', itemKind: item };
    }
  }
  return { kind: 'json', itemKind: 'string' };
};

/** The properties of an object schema as form fields: required ones first, then the schema's own order. */
export const fieldsOf = (schema: JsonSchema | undefined): FormField[] => {
  if (!schema || typeOf(schema) !== 'object' || !isRecord(schema.properties)) return [];
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).map(([name, prop]): FormField => {
    const p = isRecord(prop) ? (prop as JsonSchema) : {};
    const { kind, itemKind } = kindOf(p);
    return {
      name,
      kind,
      required: required.has(name),
      label: typeof p.title === 'string' && p.title ? p.title : name,
      description: typeof p.description === 'string' ? p.description : undefined,
      initial: suggestion(p),
      enumValues: Array.isArray(p.enum) ? p.enum : [],
      itemKind,
      schema: p,
    };
  });
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
};

/** Whether the schema describes named arguments at all (a tool without parameters has none to ask for). */
export const hasParameters = (schema: JsonSchema | undefined): boolean =>
  fieldsOf(schema).length > 0;

/**
 * The arguments a form starts with: only what the schema itself offers for its required parameters (and any default
 * of an optional one). Nothing is made up.
 */
export const initialArguments = (schema: JsonSchema | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fieldsOf(schema)) {
    if (f.initial !== undefined) out[f.name] = f.initial;
    else if (f.required && f.kind === 'enum' && f.enumValues[0] !== undefined) {
      out[f.name] = f.enumValues[0];
    }
  }
  return out;
};

/** A list field is typed as one item per line. */
export const listToText = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join('\n') : '';

export const textToList = (
  text: string,
  itemKind: FormField['itemKind'],
): unknown[] | undefined => {
  const parts = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return undefined;
  if (itemKind === 'string') return parts;
  const nums = parts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : parts;
};

/** The value of a number field from what was typed; `undefined` when empty, `NaN`-free. */
export const parseNumber = (text: string, integer: boolean): number | undefined => {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  return integer ? Math.trunc(n) : n;
};

export type ArgumentIssue = { name: string; message: string };

/** Required parameters that have no value yet (an empty string counts as no value for a required one). */
export const missingRequired = (
  schema: JsonSchema | undefined,
  args: Record<string, unknown>,
): ArgumentIssue[] =>
  fieldsOf(schema)
    .filter((f) => f.required)
    .filter((f) => {
      const v = args[f.name];
      return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    })
    .map((f) => ({ name: f.name, message: `${f.label} is required` }));

/**
 * Names in the arguments that the schema does not know. Tools may accept extras (`additionalProperties`), so this is a
 * hint for the person, never a blocker.
 */
export const unknownArguments = (
  schema: JsonSchema | undefined,
  args: Record<string, unknown>,
): string[] => {
  if (!schema || !isRecord(schema.properties) || schema.additionalProperties === true) return [];
  const known = new Set(Object.keys(schema.properties));
  return Object.keys(args).filter((k) => !known.has(k));
};

/** The variables of an RFC 6570 URI template as the Try-it panel asks for them: `{id}`, `{+path}`, `{?q,page}`. */
export const templateVariables = (uriTemplate: string): string[] => {
  const names: string[] = [];
  for (const [, expression] of uriTemplate.matchAll(/\{([^}]+)\}/g)) {
    const inner = (expression ?? '').replace(/^[+#./;?&]/, '');
    for (const part of inner.split(',')) {
      const name = part.replace(/[*:]\d*$/, '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
};

/** Fills the simple expansions of a URI template (`{id}`, `{+path}`, `{?q,page}`); unfilled ones stay empty. */
export const expandTemplate = (uriTemplate: string, values: Record<string, string>): string =>
  uriTemplate.replace(/\{([^}]+)\}/g, (_all, expression: string) => {
    const operator = /^[+#./;?&]/.exec(expression)?.[0] ?? '';
    const names = expression
      .replace(/^[+#./;?&]/, '')
      .split(',')
      .map((p) => p.replace(/[*:]\d*$/, '').trim())
      .filter(Boolean);
    const encode = (v: string) =>
      operator === '+' || operator === '#' ? encodeURI(v) : encodeURIComponent(v);
    if (operator === '?' || operator === '&') {
      const pairs = names
        .filter((n) => (values[n] ?? '') !== '')
        .map((n) => `${n}=${encode(values[n] ?? '')}`);
      return pairs.length ? `${operator}${pairs.join('&')}` : '';
    }
    return names.map((n) => encode(values[n] ?? '')).join(',');
  });
