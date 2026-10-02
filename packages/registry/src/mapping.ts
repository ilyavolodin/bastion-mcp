import {
  extractReferences,
  type Injection,
  type PackageSpec,
  parseServerSpec,
  type RemoteSpec,
  type ServerSpec,
  serverSpecTemplates,
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

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/** Template reference names must match `[A-Za-z_][A-Za-z0-9_]*`. */
export const sanitizeVariableName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
};

type Collector = {
  variables: Map<string, FormVariable>;
  secrets: Map<string, FormSecret>;
  warnings: string[];
};

const newCollector = (): Collector => ({
  variables: new Map(),
  secrets: new Map(),
  warnings: [],
});

const addVariable = (c: Collector, name: string, def: ServerJsonVariable | undefined): void => {
  if (c.variables.has(name)) return;
  c.variables.set(name, {
    name,
    label: name,
    required: def?.isRequired ?? def?.default === undefined,
    ...(def?.description ? { description: def.description } : {}),
    ...(def?.default !== undefined ? { default: def.default } : {}),
    ...(def?.choices ? { choices: def.choices } : {}),
  });
};

const addSecret = (c: Collector, name: string, description: string | undefined): void => {
  if (c.secrets.has(name)) return;
  c.secrets.set(name, { name, label: name, ...(description ? { description } : {}) });
};

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
  value.replace(PLACEHOLDER, (_match, raw: string) => {
    const name = sanitizeVariableName(raw);
    const def = variables?.[raw];
    if (forceSecret || def?.isSecret) {
      addSecret(c, name, def?.description);
      return `{{secret.${name}}}`;
    }
    addVariable(c, name, def);
    return `{{var.${name}}}`;
  });

const hasPlaceholder = (value: string | undefined): value is string =>
  value !== undefined && /\{[A-Za-z_][A-Za-z0-9_.-]*\}/.test(value);

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

const supportedPackage = (pkg: ServerJsonPackage): boolean =>
  (pkg.registryType === 'npm' || pkg.registryType === 'pypi') && pkg.transport.type === 'stdio';

/** Every way the entry can run, for policy checks and the importer's switch (11.6). */
export const availableRuntimes = (serverJson: ServerJson): RuntimeKind[] => {
  const out = new Set<RuntimeKind>();
  if ((serverJson.remotes ?? []).length > 0) out.add('remote');
  for (const pkg of serverJson.packages ?? []) {
    if (supportedPackage(pkg)) out.add(pkg.registryType as 'npm' | 'pypi');
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
      type: arg.type,
      ...(named && arg.name ? { name: arg.name } : {}),
      ...(description ? { description } : {}),
      ...(arg.isRequired !== undefined ? { isRequired: arg.isRequired } : {}),
    };
    const hintName = sanitizeVariableName(
      arg.valueHint ?? arg.name?.replace(/^-+/, '') ?? `arg${index}`,
    );

    if (arg.isSecret) {
      addSecret(c, hintName, description);
      inject.push({
        to: 'arg',
        ...(position !== undefined ? { position } : {}),
        ...(named && arg.name ? { flag: arg.name } : {}),
        value: `{{secret.${hintName}}}`,
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
      addVariable(c, hintName, {
        ...(description ? { description } : {}),
        ...(arg.isRequired !== undefined ? { isRequired: arg.isRequired } : {}),
        ...(arg.default !== undefined ? { default: arg.default } : {}),
        ...(arg.choices ? { choices: arg.choices } : {}),
      });
      if (arg.isRequired || arg.default !== undefined) {
        out.push({ ...base, value: `{{var.${hintName}}}` });
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
    const meta = {
      ...(ev.description ? { description: ev.description } : {}),
      ...(ev.isRequired !== undefined ? { isRequired: ev.isRequired } : {}),
    };
    if (hasPlaceholder(ev.value)) {
      const converted = convertPlaceholders(ev.value, ev.variables, c, ev.isSecret === true);
      if (hasSecretRef(converted)) inject.push({ to: 'env', name: ev.name, value: converted });
      else out.push({ name: ev.name, ...meta, value: converted });
      continue;
    }
    if (ev.isSecret) {
      const field = sanitizeVariableName(ev.name);
      addSecret(c, field, ev.description);
      inject.push({ to: 'env', name: ev.name, value: `{{secret.${field}}}` });
      continue;
    }
    if (ev.value !== undefined) {
      out.push({ name: ev.name, ...meta, value: ev.value });
      continue;
    }
    const field = sanitizeVariableName(ev.name);
    addVariable(c, field, ev);
    out.push({
      name: ev.name,
      ...meta,
      value: `{{var.${field}}}`,
      ...(ev.default !== undefined ? { default: ev.default } : {}),
      ...(ev.choices ? { choices: ev.choices } : {}),
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
    const field = sanitizeVariableName(h.name);
    const hasValue = h.value !== undefined && h.value !== '';
    const templated = hasValue && hasPlaceholder(h.value);
    const probe = templated
      ? convertPlaceholders(h.value as string, h.variables, newCollector())
      : '';
    if (h.isSecret || hasSecretRef(probe)) {
      const template = templated
        ? convertPlaceholders(h.value as string, h.variables, c, h.isSecret === true)
        : `{{secret.${field}}}`;
      if (!templated) addSecret(c, field, h.description);
      inject.push({ to: 'header', name: h.name, value: template });
      continue;
    }
    const meta = {
      name: h.name,
      ...(h.description ? { description: h.description } : {}),
      ...(h.isRequired !== undefined ? { isRequired: h.isRequired } : {}),
    };
    if (hasValue) {
      headers.push({ ...meta, value: convertPlaceholders(h.value as string, h.variables, c) });
    } else {
      addVariable(c, field, h);
      headers.push({ ...meta, value: `{{var.${field}}}` });
    }
  }

  const variables: Record<string, Record<string, unknown>> = {};
  for (const v of c.variables.values()) {
    variables[v.name] = {
      name: v.name,
      ...(v.description ? { description: v.description } : {}),
      isRequired: v.required,
      ...(v.default !== undefined ? { default: v.default } : {}),
      ...(v.choices ? { choices: v.choices } : {}),
    };
  }
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

  const choice =
    prefer === 'remote'
      ? remote
        ? 'remote'
        : pkg
          ? 'package'
          : undefined
      : pkg
        ? 'package'
        : remote
          ? 'remote'
          : undefined;

  if (choice === undefined) {
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
  const candidate =
    choice === 'remote' && remote
      ? mapRemote(remote, collector)
      : mapPackage(pkg as ServerJsonPackage, collector);
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
        ...(v.description ? { description: v.description } : {}),
        ...(v.default !== undefined ? { default: v.default } : {}),
        ...(v.choices ? { choices: v.choices } : {}),
      });
    }
    for (const h of spec.headers ?? []) {
      const ref = h.value ? extractReferences(h.value) : [];
      if (ref.length === 1 && ref[0]?.startsWith('var.')) {
        hint(ref[0].slice(4), {
          required: h.isRequired ?? false,
          ...(h.description ? { description: h.description } : {}),
        });
      }
    }
  } else {
    for (const ev of spec.environmentVariables ?? []) {
      const refs = ev.value ? extractReferences(ev.value) : [];
      if (refs.length === 1 && refs[0]?.startsWith('var.')) {
        hint(refs[0].slice(4), {
          required: ev.isRequired ?? ev.default === undefined,
          ...(ev.description ? { description: ev.description } : {}),
          ...(ev.default !== undefined ? { default: ev.default } : {}),
          ...(ev.choices ? { choices: ev.choices } : {}),
        });
      }
    }
    for (const arg of spec.packageArguments ?? []) {
      for (const ref of extractReferences(arg.value)) {
        if (!ref.startsWith('var.')) continue;
        hint(ref.slice(4), {
          required: arg.isRequired ?? true,
          ...(arg.description ? { description: arg.description } : {}),
        });
      }
    }
  }

  const variables: FormVariable[] = [];
  const seen = new Set<string>();
  for (const template of serverSpecTemplates(spec)) {
    for (const ref of extractReferences(template)) {
      if (!ref.startsWith('var.')) continue;
      const name = ref.slice(4);
      if (seen.has(name)) continue;
      seen.add(name);
      variables.push({ name, label: name, required: true, ...hints.get(name) });
    }
  }
  // Variables declared on a remote but referenced only through its URL are covered above only when the
  // URL is a template of the spec; include declared ones that nothing else reached.
  if (spec.type === 'remote') {
    for (const ref of extractReferences(spec.url)) {
      if (!ref.startsWith('var.') || seen.has(ref.slice(4))) continue;
      seen.add(ref.slice(4));
      variables.push({
        name: ref.slice(4),
        label: ref.slice(4),
        required: true,
        ...hints.get(ref.slice(4)),
      });
    }
  }

  const secrets: FormSecret[] =
    spec.auth.mode === 'userSecret'
      ? spec.auth.fields.map((f) => ({
          name: f.name,
          label: f.label,
          ...(f.description ? { description: f.description } : {}),
        }))
      : [];
  return { variables, secrets };
};
