import {
  extractReferences,
  type Injection,
  type PackageSpec,
  parseServerSpec,
  type RemoteSpec,
  type ServerSpec,
  secretRef,
  serverSpecTemplates,
  varRef,
} from '@bastion-mcp/core';
import { ZodError } from 'zod';
import { RegistryMappingError } from './errors';
import type {
  ServerJson,
  ServerJsonArgument,
  ServerJsonKeyValue,
  ServerJsonPackage,
  ServerJsonRemote,
  ServerJsonVariable,
} from './server-json';

/** `server.json` to `ServerSpec` (11.6 mapping table). */

export type RuntimeKind = 'remote' | 'npm' | 'pypi';
export type Prefer = 'remote' | 'package';

export type FormVariable = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  default?: string;
  choices?: string[];
};
export type FormSecret = { name: string; label: string; description?: string };

/** What the install form must ask for (11.4): plain variables and per-user secrets. */
export type InstallForm = { variables: FormVariable[]; secrets: FormSecret[] };

export type MappingResult =
  | {
      installable: true;
      runtime: RuntimeKind;
      spec: ServerSpec;
      form: InstallForm;
      warnings: string[];
      /** Runtimes the entry could also be installed with (the importer can switch). */
      alternatives: RuntimeKind[];
    }
  | {
      installable: false;
      reason: 'unsupported runtime' | 'no runtime';
      detail: string;
      registryTypes: string[];
    };

// --- Helpers --------------------------------------------------------------------------------------------------------

const PLACEHOLDER_SOURCE = '\\{([A-Za-z_][A-Za-z0-9_.-]*)\\}';

/** Includes `key` only when `value` is defined, keeping optional properties absent rather than `undefined`. */
const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);

/** Like `optional`, and also drops the empty string. */
const optionalText = <K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> => optional(key, value === '' ? undefined : value);

/** Template reference names must match `[A-Za-z_][A-Za-z0-9_]*`. */
export const sanitizeVariableName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
};

type Collector = {
  variables: Map<string, FormVariable>;
  secrets: Map<string, FormSecret>;
  warnings: string[];
  /** Registry name to template name, so one registry name always maps to the same reference. */
  names: Map<string, string>;
  taken: Set<string>;
};

const newCollector = (): Collector => ({
  variables: new Map(),
  secrets: new Map(),
  warnings: [],
  names: new Map(),
  taken: new Set(),
});

/**
 * The template name for a registry name. Distinct registry names that sanitize alike (`a-b`, `a_b`) get
 * distinct names: the first keeps the plain form, later ones get `_2`, `_3`, in order of appearance.
 */
const nameFor = (c: Collector, raw: string): string => {
  const known = c.names.get(raw);
  if (known !== undefined) return known;
  const base = sanitizeVariableName(raw);
  let name = base;
  for (let n = 2; c.taken.has(name); n += 1) name = `${base}_${n}`;
  c.taken.add(name);
  c.names.set(raw, name);
  return name;
};

type VariableMeta = {
  description?: string | undefined;
  isRequired?: boolean | undefined;
  default?: string | undefined;
  choices?: string[] | undefined;
};

const addVariable = (c: Collector, name: string, def: VariableMeta | undefined): void => {
  if (c.variables.has(name)) return;
  c.variables.set(name, {
    name,
    label: name,
    required: def?.isRequired ?? def?.default === undefined,
    ...optionalText('description', def?.description),
    ...optional('default', def?.default),
    ...optional('choices', def?.choices),
  });
};

const addSecret = (c: Collector, name: string, description: string | undefined): void => {
  if (c.secrets.has(name)) return;
  c.secrets.set(name, { name, label: name, ...optionalText('description', description) });
};

/** The `variables` entry of a RemoteSpec for a form variable. */
const formVariableToSpec = (v: FormVariable): Record<string, unknown> => ({
  name: v.name,
  ...optionalText('description', v.description),
  isRequired: v.required,
  ...optional('default', v.default),
  ...optional('choices', v.choices),
});

/**
 * Rewrites registry `{placeholder}` markers to `{{var.NAME}}` or `{{secret.NAME}}` and records them.
 * `forceSecret` is set for values the registry marks `isSecret`.
 */
const convertPlaceholders = (
  value: string,
  variables: Record<string, ServerJsonVariable> | undefined,
  c: Collector,
  forceSecret = false,
): string =>
  value.replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), (_match, raw: string) => {
    const name = nameFor(c, raw);
    const def = variables?.[raw];
    if (forceSecret || def?.isSecret) {
      addSecret(c, name, def?.description);
      return secretRef(name);
    }
    addVariable(c, name, def);
    return varRef(name);
  });

const hasPlaceholder = (value: string | undefined): value is string =>
  value !== undefined && new RegExp(PLACEHOLDER_SOURCE).test(value);

/** True when a placeholder in `value` refers to a variable the registry marks secret. */
const referencesSecretVariable = (
  value: string,
  variables: Record<string, ServerJsonVariable> | undefined,
): boolean =>
  [...value.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))].some(
    (m) => variables?.[m[1] ?? '']?.isSecret === true,
  );

const hasSecretRef = (template: string): boolean => template.includes('{{secret.');

const formatZodError = (error: ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      if (/(^|\.)version$/.test(path)) {
        return `${path}: version must be exact (no range, tag or "latest"); pin an exact version`;
      }
      return `${path || 'spec'}: ${issue.message}`;
    })
    .join('; ');

const validateSpec = (candidate: unknown): ServerSpec => {
  try {
    return parseServerSpec(candidate);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RegistryMappingError(`server.json cannot be mapped: ${formatZodError(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
};

// --- Runtime selection ----------------------------------------------------------------------------------------------

type SupportedPackage = ServerJsonPackage & { registryType: 'npm' | 'pypi' };

const supportedPackage = (pkg: ServerJsonPackage): pkg is SupportedPackage =>
  (pkg.registryType === 'npm' || pkg.registryType === 'pypi') && pkg.transport.type === 'stdio';

/** Every way the entry can run, for policy checks and the importer's switch (11.6). */
export const availableRuntimes = (serverJson: ServerJson): RuntimeKind[] => {
  const out = new Set<RuntimeKind>();
  if ((serverJson.remotes ?? []).length > 0) out.add('remote');
  for (const pkg of serverJson.packages ?? []) {
    if (supportedPackage(pkg)) out.add(pkg.registryType);
  }
  return [...out];
};

export const runtimeOfSpec = (spec: ServerSpec): RuntimeKind =>
  spec.type === 'remote' ? 'remote' : spec.runtime;

// --- Packages -------------------------------------------------------------------------------------------------------

type ArgumentSpec = NonNullable<PackageSpec['packageArguments']>[number];

const mapArguments = (
  args: readonly ServerJsonArgument[],
  c: Collector,
  inject: Injection[],
): ArgumentSpec[] => {
  const out: ArgumentSpec[] = [];
  let positionalIndex = 0;
  args.forEach((arg, index) => {
    const named = arg.type === 'named';
    const isPositional = !named;
    const position = isPositional ? positionalIndex : undefined;
    if (isPositional) positionalIndex += 1;
    const description = arg.description;
    const base = {
      type: named ? ('named' as const) : ('positional' as const),
      ...(named ? optionalText('name', arg.name) : {}),
      ...optionalText('description', description),
      ...optional('isRequired', arg.isRequired),
    };
    const hintName = nameFor(c, arg.valueHint ?? arg.name?.replace(/^-+/, '') ?? `arg${index}`);

    if (arg.isSecret) {
      addSecret(c, hintName, description);
      inject.push({
        to: 'arg',
        ...optional('position', position),
        ...(named ? optionalText('flag', arg.name) : {}),
        value: secretRef(hintName),
      });
      return;
    }
    if (arg.value !== undefined) {
      out.push({ ...base, value: convertPlaceholders(arg.value, arg.variables, c) });
      return;
    }
    if (arg.default !== undefined && !arg.isRequired) {
      out.push({ ...base, value: convertPlaceholders(arg.default, arg.variables, c) });
      return;
    }
    if (arg.valueHint || (isPositional && arg.isRequired)) {
      addVariable(c, hintName, arg);
      if (arg.isRequired || arg.default !== undefined) {
        out.push({ ...base, value: varRef(hintName) });
      }
      return;
    }
    // A required named flag without a value is a bare switch such as `--stdio`.
    if (named && arg.isRequired) out.push({ ...base, value: '' });
  });
  return out;
};

type EnvSpec = NonNullable<PackageSpec['environmentVariables']>[number];

const mapEnvironment = (
  vars: readonly ServerJsonKeyValue[],
  c: Collector,
  inject: Injection[],
): EnvSpec[] => {
  const out: EnvSpec[] = [];
  for (const ev of vars) {
    if (ev.name === '') continue; // the real registry has entries with a nameless variable
    const meta = {
      ...optionalText('description', ev.description),
      ...optional('isRequired', ev.isRequired),
    };
    if (hasPlaceholder(ev.value)) {
      const converted = convertPlaceholders(ev.value, ev.variables, c, ev.isSecret === true);
      if (hasSecretRef(converted)) inject.push({ to: 'env', name: ev.name, value: converted });
      else out.push({ name: ev.name, ...meta, value: converted });
      continue;
    }
    if (ev.isSecret) {
      const field = nameFor(c, ev.name);
      addSecret(c, field, ev.description);
      inject.push({ to: 'env', name: ev.name, value: secretRef(field) });
      continue;
    }
    if (ev.value !== undefined) {
      out.push({ name: ev.name, ...meta, value: ev.value });
      continue;
    }
    const field = nameFor(c, ev.name);
    addVariable(c, field, ev);
    out.push({
      name: ev.name,
      ...meta,
      value: varRef(field),
      ...optional('default', ev.default),
      ...optional('choices', ev.choices),
    });
  }
  return out;
};

const authFrom = (c: Collector, inject: Injection[]): PackageSpec['auth'] =>
  c.secrets.size > 0
    ? { mode: 'userSecret', fields: [...c.secrets.values()], inject }
    : { mode: 'none' };

const mapPackage = (pkg: ServerJsonPackage, c: Collector): unknown => {
  if (pkg.runtimeArguments && pkg.runtimeArguments.length > 0) {
    c.warnings.push(
      'runtimeArguments are not supported for npm and pypi packages and were ignored',
    );
  }
  const inject: Injection[] = [];
  const packageArguments = mapArguments(pkg.packageArguments ?? [], c, inject);
  const environmentVariables = mapEnvironment(pkg.environmentVariables ?? [], c, inject);
  return {
    type: 'package',
    runtime: pkg.registryType,
    identifier: pkg.identifier,
    version: pkg.version,
    ...(packageArguments.length > 0 ? { packageArguments } : {}),
    ...(environmentVariables.length > 0 ? { environmentVariables } : {}),
    auth: authFrom(c, inject),
  };
};

// --- Remotes --------------------------------------------------------------------------------------------------------

const mapRemote = (remote: ServerJsonRemote, c: Collector): unknown => {
  const inject: Injection[] = [];
  const headers: NonNullable<RemoteSpec['headers']> = [];
  const url = convertPlaceholders(remote.url, remote.variables, c);
  if (hasSecretRef(url)) c.warnings.push('a secret is embedded in the remote URL');

  for (const h of remote.headers ?? []) {
    if (h.name === '') continue; // the real registry has entries with a nameless header
    const field = nameFor(c, h.name);
    const value = h.value === '' ? undefined : h.value;
    if (h.isSecret || (hasPlaceholder(value) && referencesSecretVariable(value, h.variables))) {
      const template = hasPlaceholder(value)
        ? convertPlaceholders(value, h.variables, c, h.isSecret === true)
        : secretRef(field);
      if (!hasPlaceholder(value)) addSecret(c, field, h.description);
      inject.push({ to: 'header', name: h.name, value: template });
      continue;
    }
    const meta = {
      name: h.name,
      ...optionalText('description', h.description),
      ...optional('isRequired', h.isRequired),
    };
    if (value !== undefined) {
      headers.push({ ...meta, value: convertPlaceholders(value, h.variables, c) });
    } else {
      addVariable(c, field, h);
      headers.push({ ...meta, value: varRef(field) });
    }
  }

  const variables = Object.fromEntries(
    [...c.variables.values()].map((v) => [v.name, formVariableToSpec(v)]),
  );
  return {
    type: 'remote',
    transport: remote.type,
    url,
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    ...(headers.length > 0 ? { headers } : {}),
    auth: authFrom(c, inject),
  };
};

// --- Entry point ----------------------------------------------------------------------------------------------------

/**
 * Maps a `server.json` to a ServerSpec (11.6). Remote is preferred when the entry has both; pass
 * `prefer: 'package'` to switch. Unsupported runtimes return `installable: false`; an unmappable or
 * non-exact version throws `RegistryMappingError`.
 */
export const serverJsonToSpec = (
  serverJson: ServerJson,
  options: { prefer?: Prefer } = {},
): MappingResult => {
  const prefer = options.prefer ?? 'remote';
  const remotes = serverJson.remotes ?? [];
  const packages = (serverJson.packages ?? []).filter(supportedPackage);
  const registryTypes = [...new Set((serverJson.packages ?? []).map((p) => p.registryType))];
  const remote = remotes[0];
  const pkg = packages[0];

  const asRemote = remote ? (c: Collector) => mapRemote(remote, c) : undefined;
  const asPackage = pkg ? (c: Collector) => mapPackage(pkg, c) : undefined;
  const mapper = prefer === 'remote' ? (asRemote ?? asPackage) : (asPackage ?? asRemote);

  if (mapper === undefined) {
    if ((serverJson.packages ?? []).length > 0) {
      const detail = `registry types ${registryTypes.join(', ')} cannot be run by Bastion`;
      return { installable: false, reason: 'unsupported runtime', detail, registryTypes };
    }
    return {
      installable: false,
      reason: 'no runtime',
      detail: 'the entry has no packages and no remotes',
      registryTypes,
    };
  }

  const collector = newCollector();
  const candidate = mapper(collector);
  const spec = validateSpec(candidate);
  return {
    installable: true,
    runtime: runtimeOfSpec(spec),
    spec,
    form: deriveInstallForm(spec),
    warnings: collector.warnings,
    alternatives: availableRuntimes(serverJson).filter((r) => r !== runtimeOfSpec(spec)),
  };
};

// --- Install form ---------------------------------------------------------------------------------------------------

/** The variables and secrets an install form must collect, derived from the spec alone (11.4). */
export const deriveInstallForm = (spec: ServerSpec): InstallForm => {
  const hints = new Map<string, Omit<FormVariable, 'name' | 'label'>>();
  const hint = (name: string, meta: Omit<FormVariable, 'name' | 'label'>): void => {
    if (!hints.has(name)) hints.set(name, meta);
  };

  if (spec.type === 'remote') {
    for (const [key, v] of Object.entries(spec.variables ?? {})) {
      hint(key, {
        required: v.isRequired ?? v.default === undefined,
        ...optionalText('description', v.description),
        ...optional('default', v.default),
        ...optional('choices', v.choices),
      });
    }
    for (const h of spec.headers ?? []) {
      const ref = h.value ? extractReferences(h.value) : [];
      if (ref.length === 1 && ref[0]?.startsWith('var.')) {
        hint(ref[0].slice(4), {
          required: h.isRequired ?? false,
          ...optionalText('description', h.description),
        });
      }
    }
  } else {
    for (const ev of spec.environmentVariables ?? []) {
      const refs = ev.value ? extractReferences(ev.value) : [];
      if (refs.length === 1 && refs[0]?.startsWith('var.')) {
        hint(refs[0].slice(4), {
          required: ev.isRequired ?? ev.default === undefined,
          ...optionalText('description', ev.description),
          ...optional('default', ev.default),
          ...optional('choices', ev.choices),
        });
      }
    }
    for (const arg of spec.packageArguments ?? []) {
      for (const ref of extractReferences(arg.value)) {
        if (!ref.startsWith('var.')) continue;
        hint(ref.slice(4), {
          required: arg.isRequired ?? true,
          ...optionalText('description', arg.description),
        });
      }
    }
  }

  const variables: FormVariable[] = [];
  const seen = new Set<string>();
  const addReferences = (template: string): void => {
    for (const ref of extractReferences(template)) {
      if (!ref.startsWith('var.')) continue;
      const name = ref.slice(4);
      if (seen.has(name)) continue;
      seen.add(name);
      variables.push({ name, label: name, required: true, ...hints.get(name) });
    }
  };
  for (const template of serverSpecTemplates(spec)) addReferences(template);
  // `serverSpecTemplates` does not cover a remote's URL, which can reference variables too.
  if (spec.type === 'remote') addReferences(spec.url);

  const secrets: FormSecret[] =
    spec.auth.mode === 'userSecret'
      ? spec.auth.fields.map((f) => ({
          name: f.name,
          label: f.label,
          ...optionalText('description', f.description),
        }))
      : [];
  return { variables, secrets };
};
